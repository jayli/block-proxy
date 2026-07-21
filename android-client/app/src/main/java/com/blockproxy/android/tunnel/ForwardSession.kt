package com.blockproxy.android.tunnel

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "ForwardSession"

/**
 * A single forward CONNECT session binding a remote target (host:port) to a
 * specific [TunnelConnection].
 *
 * Lifecycle:
 * 1. Created by [ForwardSessionRegistry.open] and registered immediately.
 * 2. CONNECT frame is sent; session waits for CONNECT_OK / CONNECT_FAILED.
 * 3. After open completes, inbound DATA frames are delivered to [inboundData]
 *    and outbound data is sent via [sendData].
 * 4. When the remote sends CLOSE (or [sendClose] is called locally), the
 *    session is cleaned up.
 *
 * Thread-safety: [close] and [sendClose] are idempotent and safe from any coroutine.
 */
class ForwardSession internal constructor(
    val reqid: Int,
    val host: String,
    val port: Int,
    internal val sender: FrameSender,
    /** Completed when CONNECT_OK arrives; failed on CONNECT_FAILED / disconnect / stop. */
    internal val openResult: CompletableDeferred<Unit>,
    inboundCapacity: Int,
    private val paddingInjector: PaddingInjector? = null,
    private val onEnd: (ForwardSession) -> Unit,
) {
    private val closed = AtomicBoolean(false)

    /** Whether this session has been closed. */
    val isClosed: Boolean get() = closed.get()

    /** Timestamp of last activity (DATA sent/received), used for drain tracking. */
    @Volatile
    internal var lastActivityAt: Long = System.currentTimeMillis()

    /**
     * Bounded channel for inbound DATA from the tunnel server.
     *
     * The consumer (e.g. LocalSocksServer) reads from this channel and writes
     * to the downstream SOCKS client.  When the session is closed the channel
     * is closed too, so the consumer's `receive()` will throw
     * [ClosedReceiveChannelException] / return null.
     */
    val inboundData: Channel<ByteArray> = Channel(inboundCapacity)

    /**
     * Sends a DATA frame through the bound tunnel connection.
     * Silently does nothing if the session is already closed.
     */
    suspend fun sendData(data: ByteArray) {
        if (closed.get()) return
        lastActivityAt = System.currentTimeMillis()
        val sent = sender.sendFrame(FrameCodec.encode(Frame.Data(reqid, data)))
        if (sent) paddingInjector?.onDataSent(sender)
    }

    /**
     * Sends a CLOSE frame to the tunnel server and cleans up the session.
     * Idempotent — only the first call has effect.
     */
    suspend fun sendClose() {
        if (!closed.compareAndSet(false, true)) return
        try { sender.sendFrame(FrameCodec.encode(Frame.Close(reqid))) } catch (_: Exception) { /* best effort */ }
        inboundData.close()
        onEnd(this)
    }

    /**
     * Closes the session locally without sending CLOSE to the server.
     * Used when the server already sent CLOSE, or when the connection
     * disconnected.  Idempotent.
     */
    fun close() {
        if (!closed.compareAndSet(false, true)) return
        // Also complete openResult in case we're still waiting for CONNECT_OK
        openResult.completeExceptionally(IOException("Session closed"))
        inboundData.close()
        onEnd(this)
    }

    /**
     * Delivers inbound DATA from the tunnel server into the [inboundData] channel.
     * Suspends when the channel is full so tunnel input applies back-pressure
     * instead of dropping bytes.
     */
    internal suspend fun deliverData(data: ByteArray) {
        if (closed.get()) return
        lastActivityAt = System.currentTimeMillis()
        inboundData.send(data)
    }
}
