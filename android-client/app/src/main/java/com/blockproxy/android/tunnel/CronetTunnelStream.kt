package com.blockproxy.android.tunnel

import android.content.Context
import android.util.Log
import com.blockproxy.android.cdn.CfIpDns
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import org.chromium.base.CommandLine
import org.chromium.net.BidirectionalStream
import org.chromium.net.CronetEngine
import org.chromium.net.CronetException
import org.chromium.net.ExperimentalCronetEngine
import org.chromium.net.UrlResponseInfo
import java.io.IOException
import java.nio.ByteBuffer
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class CronetTunnelStream(
    private val context: Context,
    private val url: String,
    private val allowInsecure: Boolean,
    private val cfIpDns: CfIpDns? = null,
    private val authPayload: ByteArray,
    private val customHeaders: Map<String, String>,
    private val onAuthSuccess: (FrameSender) -> Unit,
    private val onFrame: (FrameSender, ByteArray) -> Unit,
    private val onDisconnect: (FrameSender, Throwable?) -> Unit,
) : FrameSender {

    private val executor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "CronetTunnelStream").apply { isDaemon = true }
    }
    private val sendMutex = Mutex()

    @Volatile private var stream: BidirectionalStream? = null
    @Volatile override var isOpen: Boolean = false
        private set
    override val transportLabel: String = "Cronet/Chrome"
    @Volatile private var engine: CronetEngine? = null
    @Volatile private var authenticated = false
    @Volatile private var readBuffer = ByteArray(0)
    @Volatile private var pendingWrite: CompletableDeferred<Boolean>? = null

    suspend fun connect(): FrameSender {
        val deferred = CompletableDeferred<FrameSender>()
        engine = buildEngine(context)
        val bidirectionalBuilder = engine!!.newBidirectionalStreamBuilder(url, callback(deferred), executor)
            .setHttpMethod("POST")
            .addHeader("content-type", "application/octet-stream")
            .addHeader("cache-control", "no-store")
            .delayRequestHeadersUntilFirstFlush(false)

        customHeaders.forEach { (name, value) -> bidirectionalBuilder.addHeader(name, value) }

        stream = bidirectionalBuilder.build().also { it.start() }
        return deferred.await()
    }

    override suspend fun sendFrame(encoded: ByteArray): Boolean {
        return sendMutex.withLock {
            val current = stream ?: return@withLock false
            if (!isOpen || current.isDone) return@withLock false

            val writeDone = CompletableDeferred<Boolean>()
            pendingWrite = writeDone
            try {
                current.write(directBuffer(encoded), false)
                current.flush()
            } catch (t: Throwable) {
                pendingWrite = null
                return@withLock false
            }
            writeDone.await()
        }
    }

    override fun close(code: Int, reason: String) {
        isOpen = false
        try {
            stream?.cancel()
        } catch (_: Exception) {
        } finally {
            shutdown()
        }
    }

    private fun callback(deferred: CompletableDeferred<FrameSender>) =
        object : BidirectionalStream.Callback() {
            override fun onStreamReady(stream: BidirectionalStream) {
                writeAuth(stream, deferred)
            }

            override fun onResponseHeadersReceived(
                stream: BidirectionalStream,
                info: UrlResponseInfo,
            ) {
                if (info.httpStatusCode != 200) {
                    val error = IOException("HTTP/2 tunnel status ${info.httpStatusCode}")
                    if (!deferred.isCompleted) deferred.completeExceptionally(error)
                    stream.cancel()
                    return
                }
                stream.read(ByteBuffer.allocateDirect(64 * 1024))
            }

            override fun onReadCompleted(
                stream: BidirectionalStream,
                info: UrlResponseInfo?,
                byteBuffer: ByteBuffer,
                endOfStream: Boolean,
            ) {
                byteBuffer.flip()
                val chunk = ByteArray(byteBuffer.remaining())
                byteBuffer.get(chunk)
                handleIncoming(chunk, deferred)

                if (endOfStream) {
                    handleClosed(deferred, null)
                    return
                }
                byteBuffer.clear()
                stream.read(byteBuffer)
            }

            override fun onWriteCompleted(
                stream: BidirectionalStream,
                info: UrlResponseInfo?,
                byteBuffer: ByteBuffer,
                endOfStream: Boolean,
            ) {
                pendingWrite?.complete(true)
                pendingWrite = null
            }

            override fun onSucceeded(stream: BidirectionalStream, info: UrlResponseInfo?) {
                handleClosed(deferred, null)
            }

            override fun onFailed(
                stream: BidirectionalStream,
                info: UrlResponseInfo?,
                error: CronetException,
            ) {
                Log.e(TAG, "Cronet tunnel failed: ${error.message}", error)
                pendingWrite?.complete(false)
                pendingWrite = null
                handleClosed(deferred, error)
            }

            override fun onCanceled(stream: BidirectionalStream, info: UrlResponseInfo?) {
                pendingWrite?.complete(false)
                pendingWrite = null
                handleClosed(deferred, null)
            }
        }

    private fun writeAuth(stream: BidirectionalStream, deferred: CompletableDeferred<FrameSender>) {
        try {
            stream.write(directBuffer(authPayload), false)
            stream.flush()
        } catch (t: Throwable) {
            if (!deferred.isCompleted) deferred.completeExceptionally(t)
            stream.cancel()
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
                authenticated = true
                isOpen = true
                onAuthSuccess(this)
                if (!deferred.isCompleted) deferred.complete(this)
            }
            is Frame.AuthFail -> {
                failAuth(deferred, TunnelAuthFailedException("Authentication failed"))
            }
            is Frame.Error -> {
                failAuth(deferred, TunnelOccupiedException(frame.message))
            }
            is Frame.Ping -> {
                val pong = FrameCodec.encode(Frame.Pong(frame.payload))
                stream?.write(directBuffer(pong), false)
                stream?.flush()
            }
            is Frame.Padding -> Unit
            null -> Unit
            else -> {
                failAuth(
                    deferred,
                    TunnelProtocolException("Unexpected frame during auth: ${frame::class.simpleName}"),
                )
            }
        }
    }

    private fun decodeAuthFrame(
        frameBytes: ByteArray,
        deferred: CompletableDeferred<FrameSender>,
    ): Frame? {
        return try {
            FrameCodec.decode(frameBytes)
        } catch (t: Throwable) {
            failAuth(deferred, TunnelProtocolException(t.message ?: "Bad auth frame"))
            null
        }
    }

    private fun failAuth(deferred: CompletableDeferred<FrameSender>, throwable: Throwable) {
        if (!deferred.isCompleted) deferred.completeExceptionally(throwable)
        try { stream?.cancel() } catch (_: Exception) {}
    }

    private fun handleClosed(deferred: CompletableDeferred<FrameSender>, error: Throwable?) {
        val wasOpen = isOpen
        isOpen = false
        if (!deferred.isCompleted) {
            deferred.completeExceptionally(error ?: IOException("Closed before auth"))
        }
        if (wasOpen || error != null) onDisconnect(this, error)
        shutdown()
    }

    private fun buildEngine(context: Context): CronetEngine {
        if (allowInsecure) {
            if (!CommandLine.isInitialized()) {
                CommandLine.init(arrayOf("cronet", "--ignore-certificate-errors"))
            } else {
                CommandLine.getInstance().appendSwitch("ignore-certificate-errors")
            }
        }
        val builder = ExperimentalCronetEngine.Builder(context.applicationContext)
        builder.enableHttp2(true)
        builder.enableQuic(false)
        builder.enableBrotli(true)

        cfIpDns?.cronetHostResolverRule()?.let { rule ->
            val options = JSONObject()
                .put(
                    "HostResolverRules",
                    JSONObject().put("host_resolver_rules", rule),
                )
                .toString()
            Log.i(TAG, "Using Cronet host resolver rule: $rule")
            builder.setExperimentalOptions(options)
        }

        return builder.build()
    }

    private fun shutdown() {
        try { engine?.shutdown() } catch (_: Exception) {}
        engine = null
        executor.shutdown()
    }

    private fun directBuffer(bytes: ByteArray): ByteBuffer {
        return ByteBuffer.allocateDirect(bytes.size).apply {
            put(bytes)
            flip()
        }
    }

    private companion object {
        const val TAG = "CronetTunnel"
    }
}
