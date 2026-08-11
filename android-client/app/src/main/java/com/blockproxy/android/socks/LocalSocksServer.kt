package com.blockproxy.android.socks

import com.blockproxy.android.routing.RoutingEngine
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Accepts TCP connections on loopback and handles the SOCKS5 protocol,
 * routing each CONNECT request through either a direct connection or
 * the tunnel based on [RoutingEngine] decisions.
 *
 * Architecture:
 * ```
 * tun2socks → LocalSocksServer → RoutingEngine → decision
 *                                      ↓ DIRECT        ↓ PROXY
 *                                protected Socket    ForwardSession
 *                                      ↓                ↓
 *                                  target host      tunnel server
 * ```
 *
 * Lifecycle:
 * 1. [start] binds to 127.0.0.1:0 (random port), returns the selected port.
 * 2. The accept loop runs until [stop] is called or the scope is cancelled.
 * 3. Each accepted connection spawns a [SocksSession] in a child coroutine.
 * 4. [stop] cancels the accept loop and closes all active sessions.
 *
 * @param domainMappingStore Store for IP→domain resolution (fake DNS)
 * @param routingEngine      Engine for routing decisions
 * @param directConnector    Factory for protected direct TCP connections
 * @param forwardConnector   Factory for tunnel forward sessions
 * @param trafficSniffer     Recovers domain names from first TCP payload for IP-only requests
 * @param scope              Coroutine scope for the server and session jobs
 */
class LocalSocksServer(
    private val domainMappingStore: DomainMappingStore,
    private val routingEngine: RoutingEngine,
    private val directConnector: DirectConnector,
    private val forwardConnector: ForwardConnector,
    private val trafficSniffer: TrafficSniffer = TrafficSniffer(),
    private val scope: CoroutineScope,
) {
    private val started = AtomicBoolean(false)
    private val sessions = ConcurrentHashMap<SocksSession, Job>()

    @Volatile
    private var serverSocket: ServerSocket? = null

    @Volatile
    private var acceptJob: Job? = null

    /** The port the server is listening on, or -1 if not started. */
    val port: Int
        get() = serverSocket?.localPort ?: -1

    /** Whether the server is currently running. */
    val isRunning: Boolean
        get() = started.get()

    /**
     * Starts the SOCKS5 server on loopback (127.0.0.1) with a random port.
     *
     * @return The port the server is listening on.
     * @throws IllegalStateException if the server is already started.
     */
    fun start(): Int {
        if (!started.compareAndSet(false, true)) {
            throw IllegalStateException("LocalSocksServer is already started")
        }

        val socket = ServerSocket()
        socket.bind(InetSocketAddress("127.0.0.1", 0))
        socket.reuseAddress = true
        serverSocket = socket

        acceptJob = scope.launch(Dispatchers.IO) {
            acceptLoop(socket)
        }

        return socket.localPort
    }

    /**
     * Stops the server, cancels the accept loop, and closes all active sessions.
     *
     * Idempotent — safe to call multiple times.
     */
    fun stop() {
        if (!started.compareAndSet(true, false)) return

        // Close the server socket to unblock accept()
        try { serverSocket?.close() } catch (_: Exception) {}
        serverSocket = null

        // Cancel the accept loop
        acceptJob?.cancel()
        acceptJob = null

        // Snapshot both sessions and jobs before closing, then clear the map
        // to prevent the session's finally block from removing entries before
        // we can cancel their jobs.
        val entries = sessions.entries.toList()
        sessions.clear()
        for ((session, job) in entries) {
            session.close()
            job.cancel()
        }
    }

    // ── Internal ────────────────────────────────────────────────────────

    /**
     * Main accept loop. Runs on Dispatchers.IO.
     *
     * Accepts TCP connections and spawns a [SocksSession] for each one.
     * When the server is stopped (socket closed), accept() throws and the
     * loop exits cleanly.
     */
    private suspend fun acceptLoop(server: ServerSocket) {
        while (started.get()) {
            try {
                val clientSocket = withContext(Dispatchers.IO) {
                    server.accept()
                }

                // Spawn a session coroutine
                val session = SocksSession(
                    clientSocket = clientSocket,
                    domainMappingStore = domainMappingStore,
                    routingEngine = routingEngine,
                    directConnector = directConnector,
                    forwardConnector = forwardConnector,
                    trafficSniffer = trafficSniffer,
                    scope = scope,
                )

                val job = scope.launch {
                    try {
                        session.run()
                    } catch (e: CancellationException) {
                        session.close()
                        throw e
                    } catch (_: Exception) {
                        // Session handles its own cleanup
                    } finally {
                        sessions.remove(session)
                    }
                }

                sessions[session] = job

            } catch (e: CancellationException) {
                // Scope cancelled — exit loop
                break
            } catch (_: java.net.SocketException) {
                // Server socket closed (stop() called) — exit loop
                break
            } catch (_: Exception) {
                // Unexpected error — log and continue
            }
        }
    }
}
