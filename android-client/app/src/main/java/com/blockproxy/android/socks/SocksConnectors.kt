package com.blockproxy.android.socks

import com.blockproxy.android.tunnel.ForwardSession
import com.blockproxy.android.tunnel.TunnelClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withContext
import java.net.InetSocketAddress
import java.net.Socket

/**
 * Abstraction for establishing direct TCP connections to target hosts.
 *
 * Production code creates protected sockets (VpnService.protect()) to avoid
 * routing through the VPN. Tests inject a fake implementation.
 */
interface DirectConnector {
    /**
     * Connects to [host]:[port] directly (bypassing VPN).
     * @throws java.io.IOException on connection failure
     */
    suspend fun connect(host: String, port: Int): Socket
}

/**
 * Handle to a forward tunnel session, providing bidirectional data flow.
 *
 * This abstraction allows [ForwardSession] (the real tunnel implementation)
 * and test fakes to be used interchangeably.
 *
 * - [sendData]: sends outbound data through the tunnel
 * - [inboundData]: channel for receiving inbound data from the tunnel
 * - [sendClose]: sends CLOSE to the server and cleans up
 * - [close]: local cleanup without sending CLOSE (e.g., on error)
 * - [isClosed]: whether the session has been closed
 */
interface ForwardSessionHandle {
    suspend fun sendData(data: ByteArray)
    val inboundData: Channel<ByteArray>
    suspend fun sendClose()
    fun close()
    val isClosed: Boolean
}

/**
 * Adapter that wraps a real [ForwardSession] as a [ForwardSessionHandle].
 */
class ForwardSessionAdapter(
    private val session: ForwardSession,
) : ForwardSessionHandle {
    override suspend fun sendData(data: ByteArray) = session.sendData(data)
    override val inboundData: Channel<ByteArray> = session.inboundData
    override suspend fun sendClose() = session.sendClose()
    override fun close() = session.close()
    override val isClosed: Boolean get() = session.isClosed
}

/**
 * Abstraction for opening forward tunnel sessions.
 *
 * Production code delegates to [TunnelClient] via [TunnelForwardConnector].
 * Tests inject a fake implementation.
 */
interface ForwardConnector {
    /**
     * Opens a forward CONNECT session to [host]:[port] through the tunnel.
     * @throws java.io.IOException if no tunnel connections available or connect fails
     */
    suspend fun openForwardSession(host: String, port: Int): ForwardSessionHandle
}

// ═══════════════════════════════════════════════════════════════════════
// Production adapters
// ═══════════════════════════════════════════════════════════════════════

/**
 * Production [DirectConnector] that creates plain TCP sockets protected
 * from VPN routing via [protect].
 *
 * The [protect] callback is typically `VpnService::protect` to ensure
 * direct connections bypass the VPN tunnel (preventing routing loops).
 *
 * @param protect   Called with the raw [Socket] before connecting
 * @param timeoutMs Connection timeout in milliseconds (default 10s)
 */
class ProtectedDirectConnector(
    private val protect: (Socket) -> Unit = {},
    private val timeoutMs: Int = 10_000,
) : DirectConnector {

    override suspend fun connect(host: String, port: Int): Socket {
        val socket = Socket()
        protect(socket)
        socket.tcpNoDelay = true
        withContext(Dispatchers.IO) {
            socket.connect(InetSocketAddress(host, port), timeoutMs)
        }
        return socket
    }
}

/**
 * Production [ForwardConnector] that delegates to [TunnelClient].
 *
 * @param tunnelClient The active tunnel client managing tunnel connections
 */
class TunnelForwardConnector(
    private val tunnelClient: TunnelClient,
) : ForwardConnector {

    override suspend fun openForwardSession(host: String, port: Int): ForwardSessionHandle {
        return ForwardSessionAdapter(tunnelClient.openForwardSession(host, port))
    }
}
