package com.blockproxy.android.socks

import com.blockproxy.android.routing.RouteDecision
import com.blockproxy.android.routing.RoutingEngine
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.ClosedReceiveChannelException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Manages a single SOCKS5 client connection lifecycle.
 *
 * Lifecycle:
 * 1. Read greeting → send greeting response (NO AUTH only)
 * 2. Read CONNECT request → parse target endpoint
 * 3. Resolve endpoint via DomainMappingStore (handles fake IP → domain mapping)
 * 4. Route via RoutingEngine → DIRECT or PROXY
 * 5. Establish connection (direct socket via DirectConnector or ForwardSession via ForwardConnector)
 * 6. Relay data bidirectionally
 * 7. Clean up on disconnect/error
 *
 * This class does NOT own the client socket — [close] is idempotent and safe
 * from any coroutine. The [run] method is suspending and completes when the
 * session ends (either normally or due to error/cancellation).
 *
 * @param clientSocket     The accepted TCP socket from the SOCKS5 client (tun2socks)
 * @param domainMappingStore Store for IP→domain resolution (fake DNS)
 * @param routingEngine    Engine for routing decisions (DIRECT vs PROXY)
 * @param directConnector  Factory for protected direct TCP connections
 * @param forwardConnector Factory for tunnel forward sessions
 * @param scope            Coroutine scope for relay jobs
 */
class SocksSession(
    private val clientSocket: Socket,
    private val domainMappingStore: DomainMappingStore,
    private val routingEngine: RoutingEngine,
    private val directConnector: DirectConnector,
    private val forwardConnector: ForwardConnector,
    private val scope: CoroutineScope,
) {
    companion object {
        private const val READ_BUFFER_SIZE = 8192
    }

    private val closed = AtomicBoolean(false)

    @Volatile
    private var relayJob1: Job? = null

    @Volatile
    private var relayJob2: Job? = null

    @Volatile
    private var forwardSession: ForwardSessionHandle? = null

    @Volatile
    private var targetSocket: Socket? = null

    /**
     * Runs the full SOCKS5 session lifecycle.
     * Completes when the session ends (cleanly or with error).
     *
     * Always cleans up resources in the finally block.
     */
    suspend fun run() {
        try {
            val clientIn = clientSocket.getInputStream()
            val clientOut = clientSocket.getOutputStream()

            // ── Step 1: Greeting ────────────────────────────────────
            val greeting = readGreeting(clientIn)
            if (!greeting.hasNoAuth()) {
                clientOut.write(SocksProtocol.buildGreetingResponse(acceptNoAuth = false))
                clientOut.flush()
                return
            }
            clientOut.write(SocksProtocol.buildGreetingResponse(acceptNoAuth = true))
            clientOut.flush()

            // ── Step 2: Read request ────────────────────────────────
            val request = readRequest(clientIn)

            // ── Step 3-6: Handle based on request type ──────────────
            when (request) {
                is SocksRequest.Connect -> handleConnect(request, clientIn, clientOut)
                is SocksRequest.UnsupportedCommand -> {
                    clientOut.write(SocksProtocol.buildResponse(SocksReply.COMMAND_NOT_SUPPORTED))
                    clientOut.flush()
                }
                is SocksRequest.UnsupportedAddressType -> {
                    clientOut.write(SocksProtocol.buildResponse(SocksReply.ADDRESS_TYPE_NOT_SUPPORTED))
                    clientOut.flush()
                }
                is SocksRequest.Malformed -> {
                    clientOut.write(SocksProtocol.buildResponse(SocksReply.GENERAL_FAILURE))
                    clientOut.flush()
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Protocol error, IO error, etc. — session ends silently
        } finally {
            close()
        }
    }

    /**
     * Closes the session and cleans up all resources.
     * Idempotent — safe to call multiple times from any coroutine.
     *
     * Cancels relay jobs, closes the client socket, closes any target socket,
     * and sends CLOSE on any active forward session.
     */
    fun close() {
        if (!closed.compareAndSet(false, true)) return

        // Cancel relay jobs
        relayJob1?.cancel()
        relayJob2?.cancel()

        // Close target socket (direct connection)
        try { targetSocket?.close() } catch (_: Exception) {}

        // Close forward session (tunnel connection)
        // Use non-suspend close() for cleanup; the session's close() is
        // idempotent and doesn't throw.
        try { forwardSession?.close() } catch (_: Exception) {}

        // Close client socket
        try { clientSocket.close() } catch (_: Exception) {}
    }

    // ── CONNECT handling ────────────────────────────────────────────────

    private suspend fun handleConnect(
        request: SocksRequest.Connect,
        clientIn: InputStream,
        clientOut: OutputStream,
    ) {
        // Resolve endpoint (handles fake IP → domain mapping)
        val endpoint = ResolvedEndpoint.resolve(request, domainMappingStore)

        // Make routing decision using connectHost and domain
        val decision = routingEngine.resolve(endpoint.connectHost, endpoint.domain)

        when (decision) {
            RouteDecision.DIRECT -> handleDirect(endpoint, clientIn, clientOut)
            RouteDecision.PROXY -> handleProxy(endpoint, clientIn, clientOut)
        }
    }

    private suspend fun handleDirect(
        endpoint: ResolvedEndpoint,
        clientIn: InputStream,
        clientOut: OutputStream,
    ) {
        val socket = try {
            directConnector.connect(endpoint.connectHost, endpoint.port)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            clientOut.write(SocksProtocol.buildResponse(SocksReply.HOST_UNREACHABLE))
            clientOut.flush()
            return
        }

        targetSocket = socket
        try {
            // Send success response before starting relay
            clientOut.write(SocksProtocol.buildResponse(SocksReply.SUCCESS))
            clientOut.flush()

            // Bidirectional relay: client ↔ target socket
            relaySockets(clientIn, clientOut, socket)
        } finally {
            try { socket.close() } catch (_: Exception) {}
        }
    }

    private suspend fun handleProxy(
        endpoint: ResolvedEndpoint,
        clientIn: InputStream,
        clientOut: OutputStream,
    ) {
        android.util.Log.i("SocksSession", "PROXY → ${endpoint.connectHost}:${endpoint.port} (domain=${endpoint.domain})")
        val session = try {
            forwardConnector.openForwardSession(endpoint.connectHost, endpoint.port)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            android.util.Log.e("SocksSession", "Forward CONNECT failed: ${endpoint.connectHost}:${endpoint.port}", e)
            clientOut.write(SocksProtocol.buildResponse(SocksReply.GENERAL_FAILURE))
            clientOut.flush()
            return
        }

        forwardSession = session
        try {
            // Send success response before starting relay
            clientOut.write(SocksProtocol.buildResponse(SocksReply.SUCCESS))
            clientOut.flush()

            // Bidirectional relay: client ↔ forward session
            relayTunnel(clientIn, clientOut, session)
        } finally {
            try { session.sendClose() } catch (_: Exception) {}
        }
    }

    // ── Relay ───────────────────────────────────────────────────────────

    /**
     * Bidirectional relay between client socket and direct target socket.
     * Completes when either side reaches EOF or an error occurs.
     */
    private suspend fun relaySockets(
        clientIn: InputStream,
        clientOut: OutputStream,
        target: Socket,
    ) {
        val targetIn = target.getInputStream()
        val targetOut = target.getOutputStream()
        val done = CompletableDeferred<Unit>()

        // Client → Target
        relayJob1 = scope.launch(Dispatchers.IO) {
            try {
                copyStream(clientIn, targetOut)
            } catch (_: Exception) {
                // EOF or write error
            } finally {
                done.complete(Unit)
            }
        }

        // Target → Client
        relayJob2 = scope.launch(Dispatchers.IO) {
            try {
                copyStream(targetIn, clientOut)
            } catch (_: Exception) {
                // EOF or write error
            } finally {
                done.complete(Unit)
            }
        }

        done.await()
        // Cancel the other direction so it doesn't stay blocked on I/O
        relayJob1?.cancel()
        relayJob2?.cancel()
    }

    /**
     * Bidirectional relay between client socket and tunnel ForwardSessionHandle.
     *
     * - Client → Tunnel: reads from client InputStream, sends via session.sendData()
     * - Tunnel → Client: receives from session.inboundData channel, writes to client OutputStream
     *
     * Completes when either the client reaches EOF, the tunnel channel closes,
     * or an error occurs.
     */
    private suspend fun relayTunnel(
        clientIn: InputStream,
        clientOut: OutputStream,
        session: ForwardSessionHandle,
    ) {
        val done = CompletableDeferred<Unit>()

        // Client → Tunnel
        relayJob1 = scope.launch(Dispatchers.IO) {
            try {
                val buffer = ByteArray(READ_BUFFER_SIZE)
                while (true) {
                    val n = withContext(Dispatchers.IO) { clientIn.read(buffer) }
                    if (n <= 0) break
                    session.sendData(buffer.copyOfRange(0, n))
                }
            } catch (_: Exception) {
                // EOF or send error
            } finally {
                done.complete(Unit)
            }
        }

        // Tunnel → Client
        relayJob2 = scope.launch(Dispatchers.IO) {
            try {
                while (true) {
                    val data = session.inboundData.receive()
                    withContext(Dispatchers.IO) {
                        clientOut.write(data)
                        clientOut.flush()
                    }
                }
            } catch (_: ClosedReceiveChannelException) {
                // Channel closed — tunnel session ended
            } catch (_: Exception) {
                // Write error
            } finally {
                done.complete(Unit)
            }
        }

        done.await()
        // Cancel the other direction so it doesn't stay blocked on I/O
        relayJob1?.cancel()
        relayJob2?.cancel()
    }

    /**
     * Copies bytes from [input] to [output] until EOF.
     * Must be called on Dispatchers.IO (blocking I/O).
     */
    private fun copyStream(input: InputStream, output: OutputStream) {
        val buffer = ByteArray(READ_BUFFER_SIZE)
        while (true) {
            val n = input.read(buffer)
            if (n <= 0) break
            output.write(buffer, 0, n)
            output.flush()
        }
    }

    // ── SOCKS5 protocol reading ─────────────────────────────────────────

    /**
     * Reads the SOCKS5 greeting from the client.
     * Format: VER(1) + NMETHODS(1) + METHODS(1-255)
     */
    private suspend fun readGreeting(input: InputStream): SocksGreeting {
        return withContext(Dispatchers.IO) {
            // Read VER + NMETHODS (2 bytes)
            val header = ByteArray(2)
            readFully(input, header)

            val nMethods = header[1].toInt() and 0xFF
            val methods = if (nMethods > 0) {
                val m = ByteArray(nMethods)
                readFully(input, m)
                m
            } else {
                ByteArray(0)
            }

            SocksProtocol.parseGreeting(header + methods)
        }
    }

    /**
     * Reads the SOCKS5 request from the client.
     * Format: VER(1) + CMD(1) + RSV(1) + ATYP(1) + DST.ADDR(variable) + DST.PORT(2)
     */
    private suspend fun readRequest(input: InputStream): SocksRequest {
        return withContext(Dispatchers.IO) {
            // Read VER + CMD + RSV + ATYP (4 bytes)
            val header = ByteArray(4)
            readFully(input, header)

            val atyp = header[3].toInt() and 0xFF
            val remaining = when (atyp) {
                SocksAddressType.IPV4.code -> {
                    // IPv4(4) + PORT(2) = 6 bytes
                    val addr = ByteArray(6)
                    readFully(input, addr)
                    addr
                }
                SocksAddressType.DOMAIN.code -> {
                    // LEN(1) + DOMAIN(LEN) + PORT(2)
                    val lenBuf = ByteArray(1)
                    readFully(input, lenBuf)
                    val len = lenBuf[0].toInt() and 0xFF
                    val domainAndPort = ByteArray(len + 2)
                    readFully(input, domainAndPort)
                    lenBuf + domainAndPort
                }
                SocksAddressType.IPV6.code -> {
                    // IPv6(16) + PORT(2) = 18 bytes
                    val addr = ByteArray(18)
                    readFully(input, addr)
                    addr
                }
                else -> {
                    // Unknown address type — return empty so parseRequest returns Malformed
                    ByteArray(0)
                }
            }

            SocksProtocol.parseRequest(header + remaining)
        }
    }

    /**
     * Reads exactly [buffer.size] bytes from the input stream.
     * @throws IOException if EOF is reached before the buffer is filled
     */
    private fun readFully(input: InputStream, buffer: ByteArray) {
        var offset = 0
        while (offset < buffer.size) {
            val n = input.read(buffer, offset, buffer.size - offset)
            if (n < 0) throw IOException("Unexpected EOF during SOCKS5 handshake")
            offset += n
        }
    }
}
