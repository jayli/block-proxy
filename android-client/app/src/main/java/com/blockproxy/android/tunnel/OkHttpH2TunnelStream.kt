package com.blockproxy.android.tunnel

import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class OkHttpH2TunnelStream(
    private val url: String,
    private val authPayload: ByteArray,
    private val customHeaders: Map<String, String>,
    private val allowInsecure: Boolean,
    private val protect: ((java.net.Socket) -> Boolean)?,
    private val onAuthSuccess: (FrameSender) -> Unit,
    private val onFrame: (FrameSender, ByteArray) -> Unit,
    private val onDisconnect: (FrameSender, Throwable?) -> Unit,
) : FrameSender {
    private val executor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "OkHttpH2TunnelStream").apply { isDaemon = true }
    }
    private val sendMutex = Mutex()
    private val outbound = LinkedBlockingQueue<ByteArray>()
    private val closeMarker = ByteArray(0)
    private val requestBodyError = AtomicReference<Throwable?>(null)

    @Volatile private var call: Call? = null
    @Volatile override var isOpen: Boolean = false
        private set
    override val transportLabel: String = "OkHttp"
    @Volatile private var authenticated = false
    @Volatile private var readBuffer = ByteArray(0)

    suspend fun connect(): FrameSender {
        val deferred = CompletableDeferred<FrameSender>()
        val client = TunnelWebSocket.createOkHttpClient(allowInsecure, protect)
            .newBuilder()
            .protocols(listOf(Protocol.HTTP_2, Protocol.HTTP_1_1))
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()

        val body = StreamingRequestBody(authPayload, outbound, closeMarker) { error ->
            requestBodyError.compareAndSet(null, error)
            Log.e(TAG, "Fallback request body writer failed: ${error.message}", error)
            call?.cancel()
        }
        val requestBuilder = Request.Builder()
            .url(url)
            .post(body)
            .header("content-type", "application/octet-stream")
            .header("cache-control", "no-store")
        customHeaders.forEach { (name, value) -> requestBuilder.header(name, value) }

        call = client.newCall(requestBuilder.build())
        executor.execute { runCall(deferred) }
        return deferred.await()
    }

    override suspend fun sendFrame(encoded: ByteArray): Boolean {
        return sendMutex.withLock {
            if (!isOpen) return@withLock false
            outbound.offer(encoded)
        }
    }

    override fun close(code: Int, reason: String) {
        isOpen = false
        outbound.offer(closeMarker)
        call?.cancel()
        executor.shutdown()
    }

    private fun runCall(deferred: CompletableDeferred<FrameSender>) {
        var disconnectError: Throwable? = null
        try {
            Log.i(TAG, "Executing OkHttp HTTP/2 fallback call")
            call!!.execute().use { response ->
                Log.i(TAG, "Fallback response: code=${response.code}, protocol=${response.protocol}")
                if (response.code != 200) {
                    throw IOException("HTTP/2 tunnel status ${response.code}")
                }
                val source = response.body?.source() ?: throw IOException("Missing tunnel response body")
                val buffer = ByteArray(64 * 1024)
                while (!Thread.currentThread().isInterrupted) {
                    val read = source.read(buffer)
                    if (read == -1) break
                    Log.i(TAG, "Fallback read $read bytes")
                    handleIncoming(buffer.copyOf(read), deferred)
                }
            }
        } catch (t: Throwable) {
            disconnectError = t
            if (!deferred.isCompleted) deferred.completeExceptionally(t)
            Log.e(TAG, "OkHttp H2 tunnel failed: ${t.message}", t)
        } finally {
            val wasOpen = isOpen
            isOpen = false
            outbound.offer(closeMarker)
            executor.shutdown()
            if (wasOpen || disconnectError != null) onDisconnect(this, disconnectError)
        }
    }

    private fun handleIncoming(chunk: ByteArray, deferred: CompletableDeferred<FrameSender>) {
        readBuffer += chunk
        while (readBuffer.size >= 2) {
            val length = ((readBuffer[0].toInt() and 0xff) shl 8) or (readBuffer[1].toInt() and 0xff)
            if (readBuffer.size < 2 + length) return
            val frameBytes = readBuffer.copyOfRange(0, 2 + length)
            readBuffer = readBuffer.copyOfRange(2 + length, readBuffer.size)
            handleFrame(frameBytes, deferred)
        }
    }

    private fun handleFrame(frameBytes: ByteArray, deferred: CompletableDeferred<FrameSender>) {
        if (authenticated) {
            onFrame(this, frameBytes)
            return
        }

        when (val frame = decodeAuthFrame(frameBytes, deferred)) {
            is Frame.AuthOk -> {
                Log.i(TAG, "Fallback received AUTH_OK")
                authenticated = true
                isOpen = true
                onAuthSuccess(this)
                if (!deferred.isCompleted) deferred.complete(this)
            }
            is Frame.AuthFail -> failAuth(deferred, TunnelAuthFailedException("Authentication failed"))
            is Frame.Error -> failAuth(deferred, TunnelOccupiedException(frame.message))
            is Frame.Ping -> outbound.offer(FrameCodec.encode(Frame.Pong(frame.payload)))
            is Frame.Padding -> Unit
            null -> Unit
            else -> failAuth(
                deferred,
                TunnelProtocolException("Unexpected frame during auth: ${frame::class.simpleName}"),
            )
        }
    }

    private fun decodeAuthFrame(frameBytes: ByteArray, deferred: CompletableDeferred<FrameSender>): Frame? {
        return try {
            FrameCodec.decode(frameBytes)
        } catch (t: Throwable) {
            failAuth(deferred, TunnelProtocolException(t.message ?: "Bad auth frame"))
            null
        }
    }

    private fun failAuth(deferred: CompletableDeferred<FrameSender>, throwable: Throwable) {
        if (!deferred.isCompleted) deferred.completeExceptionally(throwable)
        close(1002, throwable.message ?: "auth failed")
    }

    internal class StreamingRequestBody(
        private val authPayload: ByteArray,
        private val outbound: LinkedBlockingQueue<ByteArray>,
        private val closeMarker: ByteArray,
        private val onWriteFailure: (Throwable) -> Unit = {},
    ) : RequestBody() {
        override fun contentType() = "application/octet-stream".toMediaType()
        override fun isDuplex() = true
        override fun isOneShot() = true
        override fun writeTo(sink: BufferedSink) {
            Thread {
                try {
                    sink.write(authPayload)
                    sink.flush()
                    while (true) {
                        val frame = outbound.take()
                        if (frame === closeMarker) return@Thread
                        sink.write(frame)
                        sink.flush()
                    }
                } catch (interrupted: InterruptedException) {
                    Thread.currentThread().interrupt()
                } catch (t: Throwable) {
                    onWriteFailure(t)
                }
            }.apply {
                name = "OkHttpH2TunnelWriter"
                isDaemon = true
                start()
            }
        }
    }

    companion object {
        const val TAG = "OkHttpH2Tunnel"

        internal fun createStreamingRequestBodyForTest(authPayload: ByteArray): RequestBody {
            val closeMarker = ByteArray(0)
            return StreamingRequestBody(authPayload, LinkedBlockingQueue(), closeMarker)
        }
    }
}
