package com.blockproxy.android.tunnel

import com.blockproxy.android.config.ServerConfig
import com.blockproxy.android.config.TunnelCredentials
import com.blockproxy.android.status.TunnelStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException

/**
 * Factory for creating [TunnelSocket] instances used by [TunnelClient]
 * to connect to the tunnel server.
 *
 * Production code creates real TLS sockets; tests inject fakes.
 */
interface TunnelSocketFactory {
    fun create(): TunnelSocket
}

/**
 * Manages up to [MAX_CONNECTIONS] simultaneous tunnel connections with
 * automatic reconnection and dual-connection replenishment.
 *
 * Reconnect model:
 * - First connection success → Connected
 * - Second connection attempted asynchronously (up to [MAX_CONNECTIONS])
 * - Any disconnect → close sessions for that connection, attempt replenishment
 * - All connections lost → full reconnect with exponential backoff (1s, 2s, 4s, ... 60s cap)
 * - AUTH_FAIL on primary → AuthFailed (permanent, stops retrying)
 * - Auth-stage ERROR on primary → Occupied (permanent, stops retrying)
 * - Post-auth ERROR → logged and ignored (connection stays alive, handled by TunnelConnection)
 *
 * Replenishment model (dual → single degradation):
 * - Wait 1s before first attempt
 * - At most 3 attempts with waits of 2s, 4s between failures
 * - If all 3 fail → keep single connection, stop replenishing
 * - If remaining connection also disconnects → enter full reconnect
 */
class TunnelClient(
    private val config: ServerConfig,
    private val credentials: TunnelCredentials,
    private val socketFactory: TunnelSocketFactory,
    private val targetSocketFactory: TargetSocketFactory,
    private val clientScope: CoroutineScope,
    private val idleTimeoutMs: Long = TunnelConnection.DEFAULT_IDLE_TIMEOUT_MS,
) {
    companion object {
        const val MAX_CONNECTIONS = 2
        const val INITIAL_BACKOFF_MS = 1_000L
        const val MAX_BACKOFF_MS = 60_000L
        const val REPLENISH_INITIAL_DELAY_MS = 1_000L
        const val REPLENISH_MAX_ATTEMPTS = 3
    }

    private val _status = MutableStateFlow(TunnelStatus.Disconnected)
    val status: StateFlow<TunnelStatus> = _status.asStateFlow()

    private val handler = ReverseConnectHandler(clientScope, targetSocketFactory)
    private val forwardRegistry = ForwardSessionRegistry(clientScope)

    private val connectionsMutex = Mutex()
    private val connections = mutableListOf<TunnelConnection>()

    @Volatile
    private var stopped = true

    private var reconnectJob: Job? = null
    private var replenishJob: Job? = null

    @Volatile
    private var isReplenishing = false

    @Volatile
    private var consecutiveFailures = 0

    // ── Public API ──────────────────────────────────────────────────

    fun start() {
        if (!stopped) return  // Already started — guard against double-start
        stopped = false
        reconnectJob = clientScope.launch { mainLoop() }
    }

    /**
     * Opens a forward CONNECT session to the specified host and port.
     *
     * This method is called by LocalSocksServer to establish a tunnel for
     * client-initiated connections. The session will use one of the active
     * tunnel connections (round-robin selection).
     *
     * @param host Target hostname or IP address
     * @param port Target port number
     * @return ForwardSession representing the tunnel connection
     * @throws IOException if no connections are available or connection fails
     */
    suspend fun openForwardSession(host: String, port: Int): ForwardSession {
        val conns = connectionsMutex.withLock { connections.toList() }
        if (conns.isEmpty()) {
            throw IOException("No tunnel connections available")
        }
        return forwardRegistry.open(host, port, conns)
    }

    suspend fun stop(timeoutMs: Long = 5_000L) {
        stopped = true

        // Cancel reconnect loop
        reconnectJob?.cancel()
        try { reconnectJob?.join() } catch (_: CancellationException) {}
        reconnectJob = null

        // Cancel replenishment
        replenishJob?.cancel()
        try { replenishJob?.join() } catch (_: CancellationException) {}
        replenishJob = null
        isReplenishing = false

        // Stop forward sessions before closing connections
        forwardRegistry.stop()

        // Close all connections (with timeout to avoid hanging on stuck I/O)
        kotlinx.coroutines.withTimeoutOrNull(timeoutMs) {
            connectionsMutex.withLock {
                for (conn in connections.toList()) {
                    handler.closeSessionsFor(conn)
                    conn.close()
                }
                connections.clear()
            }
        }

        _status.value = TunnelStatus.Disconnected
    }

    // ── Main loop ───────────────────────────────────────────────────

    private suspend fun mainLoop() {
        // Establish first connection
        try {
            _status.value = TunnelStatus.Connecting
            val first = establishConnection()
            addConnection(first)
            _status.value = TunnelStatus.Connected
            consecutiveFailures = 0
            replenishConnection()
        } catch (e: CancellationException) {
            throw e
        } catch (e: TunnelAuthFailedException) {
            _status.value = TunnelStatus.AuthFailed
            // Permanent: stop retrying
        } catch (e: TunnelOccupiedException) {
            _status.value = TunnelStatus.Occupied
            // Permanent: stop retrying
        } catch (_: Exception) {
            _status.value = TunnelStatus.Reconnecting
            startReconnectLoop()
        }
    }

    private suspend fun startReconnectLoop() {
        while (!stopped) {
            val backoff = calculateBackoff()
            try {
                kotlinx.coroutines.delay(backoff)
            } catch (e: CancellationException) {
                throw e
            }

            try {
                _status.value = TunnelStatus.Connecting
                val conn = establishConnection()
                addConnection(conn)
                _status.value = TunnelStatus.Connected
                consecutiveFailures = 0
                replenishConnection()
                return
            } catch (e: CancellationException) {
                throw e
            } catch (e: TunnelAuthFailedException) {
                _status.value = TunnelStatus.AuthFailed
                return  // Permanent: stop retrying
            } catch (e: TunnelOccupiedException) {
                _status.value = TunnelStatus.Occupied
                return  // Permanent: stop retrying
            } catch (_: Exception) {
                consecutiveFailures++
                _status.value = TunnelStatus.Reconnecting
            }
        }
    }

    private fun calculateBackoff(): Long {
        val backoff = INITIAL_BACKOFF_MS * (1L shl consecutiveFailures.coerceAtMost(6))
        return backoff.coerceAtMost(MAX_BACKOFF_MS)
    }

    // ── Connection establishment ────────────────────────────────────

    /**
     * Creates a socket, connects it, performs authentication, and returns
     * the authenticated [TunnelConnection].
     *
     * @throws TunnelAuthFailedException if the server responds with AUTH_FAIL
     * @throws TunnelOccupiedException if the server responds with ERROR during auth
     * @throws Exception for any other connection or protocol failure
     * @throws CancellationException if the coroutine scope is cancelled
     */
    private suspend fun establishConnection(): TunnelConnection {
        val socket = socketFactory.create()

        val authCompleted = CompletableDeferred<Unit>()

        // Use a nullable var for self-reference: the lambdas are invoked
        // only after the constructor returns and connRef is assigned.
        var connRef: TunnelConnection? = null

        val conn = TunnelConnection(
            id = "tunnel-${System.identityHashCode(socket)}",
            socket = socket,
            username = credentials.username,
            password = credentials.password,
            scope = clientScope,
            idleTimeoutMs = idleTimeoutMs,
            onFrame = { frame ->
                when {
                    frame is Frame.AuthOk -> {
                        authCompleted.complete(Unit)
                    }
                    // Server-initiated reverse CONNECT
                    frame is Frame.Connect -> {
                        val c = connRef
                        if (c != null) {
                            clientScope.launch { handler.handleFrame(c, frame) }
                        }
                    }
                    // Forward session responses (client-initiated)
                    frame is Frame.ConnectOk || frame is Frame.ConnectFailed -> {
                        forwardRegistry.handleFrame(frame)
                    }
                    // Data/Close: route based on reqid range
                    frame is Frame.Data || frame is Frame.Close -> {
                        val reqid = when (frame) {
                            is Frame.Data -> frame.reqid
                            is Frame.Close -> frame.reqid
                            else -> -1
                        }
                        if (forwardRegistry.isForwardReqid(reqid)) {
                            forwardRegistry.handleFrame(frame)
                        } else {
                            val c = connRef
                            if (c != null) {
                                clientScope.launch { handler.handleFrame(c, frame) }
                            }
                        }
                    }
                    // Ping, Pong, Unknown, etc. — ignore (TunnelConnection
                    // handles PING→PONG internally)
                }
            },
            onDisconnect = { error ->
                // During the authentication phase, complete authCompleted so that
                // establishConnection() resumes.  After authentication the
                // connection is already in the registry and the deferred is
                // already completed, so these completeExceptionally calls are
                // no-ops (CompletableDeferred ignores duplicate completions).
                when (error) {
                    is TunnelAuthFailedException ->
                        authCompleted.completeExceptionally(error)
                    is TunnelOccupiedException ->
                        authCompleted.completeExceptionally(error)
                    is TunnelProtocolException ->
                        authCompleted.completeExceptionally(error)
                    null ->
                        authCompleted.completeExceptionally(
                            IOException("Connection closed during authentication"))
                    else ->
                        authCompleted.completeExceptionally(error)
                }
                val c = connRef
                if (c != null) {
                    handleDisconnect(c, error)
                }
            },
        )
        connRef = conn

        try {
            conn.connect(config.serverHost, config.serverPort)
            authCompleted.await()
            return conn
        } catch (e: CancellationException) {
            try { conn.close() } catch (_: Exception) {}
            throw e
        } catch (e: TunnelAuthFailedException) {
            try { conn.close() } catch (_: Exception) {}
            throw e
        } catch (e: TunnelOccupiedException) {
            try { conn.close() } catch (_: Exception) {}
            throw e
        } catch (e: Exception) {
            try { conn.close() } catch (_: Exception) {}
            throw e
        }
    }

    // ── Connection registry ─────────────────────────────────────────

    private suspend fun addConnection(conn: TunnelConnection) {
        connectionsMutex.withLock {
            connections.add(conn)
        }
    }

    private suspend fun removeConnection(conn: TunnelConnection): Pair<Boolean, List<TunnelConnection>> {
        return connectionsMutex.withLock {
            val removed = connections.remove(conn)
            removed to connections.toList()
        }
    }

    // ── Disconnect handling ─────────────────────────────────────────

    private fun handleDisconnect(conn: TunnelConnection, error: Throwable?) {
        if (stopped) return

        // Permanent auth failures during active connections:
        // These are unusual (auth happens during connect), but handle them.
        if (error is TunnelAuthFailedException || error is TunnelOccupiedException) {
            _status.value = if (error is TunnelAuthFailedException)
                TunnelStatus.AuthFailed else TunnelStatus.Occupied
            clientScope.launch {
                handler.closeSessionsFor(conn)
                forwardRegistry.closeSessionsFor(conn)
                removeConnection(conn)
            }
            return
        }

        clientScope.launch {
            // Close sessions owned by this connection
            handler.closeSessionsFor(conn)
            forwardRegistry.closeSessionsFor(conn)

            // Remove from registry and check if it was actually registered.
            // Connections that failed during authentication are never added
            // to the registry; their lifecycle is managed by establishConnection.
            val (wasRegistered, remaining) = removeConnection(conn)
            if (!wasRegistered) return@launch

            if (remaining.isNotEmpty()) {
                // At least one connection still alive → try replenishment
                // All replenishment launch logic under mutex to avoid race
                connectionsMutex.withLock {
                    if (replenishJob?.isActive != true && !isReplenishing) {
                        replenishJob = clientScope.launch { doReplenishment() }
                    }
                }
            } else {
                // All connections lost → full reconnect
                _status.value = TunnelStatus.Reconnecting
                consecutiveFailures = 0
                connectionsMutex.withLock {
                    replenishJob?.cancel()
                    replenishJob = null
                    isReplenishing = false
                }
                reconnectJob = clientScope.launch { startReconnectLoop() }
            }
        }
    }

    // ── Replenishment ───────────────────────────────────────────────

    private fun replenishConnection() {
        // Launch under mutex to coordinate with handleDisconnect
        clientScope.launch {
            connectionsMutex.withLock {
                if (replenishJob?.isActive != true && !isReplenishing) {
                    replenishJob = clientScope.launch { doReplenishment() }
                }
            }
        }
    }

    private suspend fun doReplenishment() {
        isReplenishing = true
        try {
            // Wait 1s before first attempt
            kotlinx.coroutines.delay(REPLENISH_INITIAL_DELAY_MS)

            for (attempt in 1..REPLENISH_MAX_ATTEMPTS) {
                if (stopped) return

                try {
                    val conn = establishConnection()
                    addConnection(conn)
                    _status.value = TunnelStatus.Connected
                    return  // Success
                } catch (e: CancellationException) {
                    throw e
                } catch (_: TunnelAuthFailedException) {
                    // Permanent auth error for secondary connection:
                    // keep the existing connection alive, stop replenishing.
                    return
                } catch (_: TunnelOccupiedException) {
                    // Permanent occupied error for secondary connection:
                    // keep the existing connection alive, stop replenishing.
                    return
                } catch (_: Exception) {
                    // Connection error — fall through to retry logic
                }

                // If no connections remain, abort replenishment.
                // The disconnect handler will start the full reconnect loop.
                val count = connectionsMutex.withLock { connections.size }
                if (count == 0) return

                // Wait before next attempt: 2s after 1st failure, 4s after 2nd
                if (attempt < REPLENISH_MAX_ATTEMPTS) {
                    val waitMs = (1L shl attempt) * 1000L  // 2s, 4s
                    kotlinx.coroutines.delay(waitMs)
                }
            }
            // All 3 attempts exhausted → keep single connection, stop replenishing
        } catch (e: CancellationException) {
            throw e
        } finally {
            isReplenishing = false
        }
    }
}
