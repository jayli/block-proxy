package com.blockproxy.android.tunnel

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean

class NativeUtlsWebSocket(
    private val options: UtlsWsOptions,
    private val nativeClient: UtlsWsNativeClient,
    private val onAuthSuccess: (FrameSender) -> Unit,
    private val onFrame: (FrameSender, ByteArray) -> Unit,
    private val onDisconnect: (FrameSender, Throwable?) -> Unit,
) : FrameSender {
    private val sendMutex = Mutex()
    private val stateLock = Any()
    private val disconnectEmitted = AtomicBoolean(false)

    @Volatile private var nativeConnection: UtlsWsConnection? = null
    @Volatile private var authenticated = false
    @Volatile override var isOpen: Boolean = false
        private set

    suspend fun connect(): FrameSender {
        val deferred = CompletableDeferred<FrameSender>()
        val listener = object : UtlsWsListener {
            override fun onOpen() {
                // AUTH is sent natively before this callback.
            }

            override fun onBinaryMessage(data: ByteArray) {
                handleBinary(data.copyOf(), deferred)
            }

            override fun onClosed(code: Int, reason: String) {
                isOpen = false
                if (!deferred.isCompleted) {
                    deferred.completeExceptionally(IOException("Closed before auth: $code $reason"))
                }
                emitDisconnect(null)
                nativeConnection = null
            }

            override fun onFailure(message: String) {
                val error = IOException(message)
                isOpen = false
                if (!deferred.isCompleted) {
                    deferred.completeExceptionally(error)
                }
                emitDisconnect(error)
                nativeConnection = null
            }
        }

        try {
            nativeConnection = nativeClient.connect(options, listener)
        } catch (t: Throwable) {
            nativeConnection = null
            if (!deferred.isCompleted) deferred.completeExceptionally(t)
        }
        return deferred.await()
    }

    private fun handleBinary(frameBytes: ByteArray, deferred: CompletableDeferred<FrameSender>) {
        if (authenticated) {
            onFrame(this, frameBytes)
            return
        }

        val frame = try {
            FrameCodec.decode(frameBytes)
        } catch (t: Throwable) {
            failAuth(deferred, TunnelProtocolException(t.message ?: "Bad auth frame"))
            return
        }

        when (frame) {
            is Frame.AuthOk -> {
                synchronized(stateLock) {
                    authenticated = true
                    isOpen = true
                }
                onAuthSuccess(this)
                if (!deferred.isCompleted) deferred.complete(this)
            }
            is Frame.AuthFail -> failAuth(deferred, TunnelAuthFailedException("Authentication failed"))
            is Frame.Error -> failAuth(deferred, TunnelOccupiedException(frame.message))
            is Frame.Ping -> {
                nativeConnection?.sendBinary(FrameCodec.encode(Frame.Pong(frame.payload)))
            }
            is Frame.Padding -> Unit
            else -> failAuth(
                deferred,
                TunnelProtocolException("Unexpected frame during auth: ${frame::class.simpleName}"),
            )
        }
    }

    private fun failAuth(deferred: CompletableDeferred<FrameSender>, throwable: Throwable) {
        if (!deferred.isCompleted) deferred.completeExceptionally(throwable)
        close(1002, throwable.message ?: "auth failed")
    }

    override suspend fun sendFrame(encoded: ByteArray): Boolean {
        return sendMutex.withLock {
            val connection = nativeConnection ?: return@withLock false
            if (!isOpen) return@withLock false
            connection.sendBinary(encoded.copyOf())
        }
    }

    override fun close(code: Int, reason: String) {
        isOpen = false
        val connection = nativeConnection
        nativeConnection = null
        connection?.close(code, reason)
    }

    private fun emitDisconnect(error: Throwable?) {
        if (disconnectEmitted.compareAndSet(false, true)) {
            onDisconnect(this, error)
        }
    }
}
