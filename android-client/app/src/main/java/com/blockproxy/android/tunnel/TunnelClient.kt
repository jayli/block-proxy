package com.blockproxy.android.tunnel

import android.util.Log
import com.blockproxy.android.config.ServerConfig
import com.blockproxy.android.config.TunnelCredentials
import com.blockproxy.android.status.TunnelStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.max
import kotlin.math.min
import kotlin.random.Random
import kotlin.random.nextLong

private const val TAG = "TunnelClient"

class TunnelClient(
    private val config: ServerConfig,
    private val credentials: TunnelCredentials,
    private val targetSocketFactory: TargetSocketFactory,
    private val clientScope: CoroutineScope,
    private val protect: ((java.net.Socket) -> Boolean)? = null,
) {
    companion object {
        const val INITIAL_BACKOFF_MS = 1_000L
        const val MAX_BACKOFF_MS = 60_000L
        private const val DEFAULT_ROTATION_MIN_MS = 600_000L   // 10 min
        private const val DEFAULT_ROTATION_MAX_MS = 1_800_000L // 30 min
        private const val DEFAULT_HEARTBEAT_MIN_MS = 15_000L   // 15 s
        private const val DEFAULT_HEARTBEAT_MAX_MS = 40_000L   // 40 s
        private const val DEFAULT_DRAIN_TIMEOUT_MS = 10_000L   // 10 s
        private const val DEFAULT_DRAIN_IDLE_TIMEOUT_MS = 20_000L // 20 s
        private const val HEARTBEAT_TIMEOUT_MS = 65_000L       // 2× heartbeat_max
    }

    private val _status = MutableStateFlow<TunnelStatus>(TunnelStatus.Disconnected)
    val status: StateFlow<TunnelStatus> = _status.asStateFlow()

    private val handler = ReverseConnectHandler(clientScope, targetSocketFactory)
    private val forwardRegistry = ForwardSessionRegistry(clientScope)

    private val okHttpClient = TunnelWebSocket.createOkHttpClient(
        allowInsecure = config.allowInsecure,
        protect = protect,
    )
    private val secureRandom = SecureRandom()

    // WebSocket state
    @Volatile private var activeWs: FrameSender? = null
    @Volatile private var candidateWs: FrameSender? = null
    @Volatile private var drainingWs: FrameSender? = null

    @Volatile private var stopped = true
    @Volatile private var connected = false

    private var mainJob: Job? = null
    private var heartbeatJob: Job? = null
    private var rotationJob: Job? = null

    private val stateMutex = Mutex()
    private val heartbeatStates = ConcurrentHashMap<FrameSender, HeartbeatState>()

    // Per-sender frame channels: bridge OkHttp callback → coroutine loop
    private val frameChannels = ConcurrentHashMap<FrameSender, Channel<ByteArray>>()
    // Per-sender read jobs for cancellation
    private val senderReadJobs = ConcurrentHashMap<FrameSender, Job>()

    // ── Public API ──────────────────────────────────────────────────────

    fun isConnected(): Boolean = connected

    fun start() {
        if (!stopped) return
        stopped = false
        _status.value = TunnelStatus.Connecting
        mainJob = clientScope.launch { mainLoop() }
    }

    suspend fun stop(timeoutMs: Long = 5_000L) {
        stopped = true
        connected = false
        mainJob?.cancel()
        heartbeatJob?.cancel()
        rotationJob?.cancel()
        mainJob = null
        heartbeatJob = null
        rotationJob = null

        // Close all WebSocket connections
        for (sender in listOfNotNull(activeWs, candidateWs, drainingWs)) {
            try { sender.close(1000, "client stopping") } catch (_: Exception) {}
        }
        activeWs = null
        candidateWs = null
        drainingWs = null

        // Clean up per-sender state
        for ((sender, ch) in frameChannels) {
            ch.close()
            senderReadJobs[sender]?.cancel()
        }
        frameChannels.clear()
        senderReadJobs.clear()
        heartbeatStates.clear()

        forwardRegistry.stop()
        _status.value = TunnelStatus.Disconnected
    }

    suspend fun openForwardSession(host: String, port: Int): ForwardSession {
        val sender = activeWs
            ?: throw IllegalStateException("No active tunnel connection")
        return forwardRegistry.open(host, port, sender)
    }

    /** Measures tunnel RTT in milliseconds. Returns null on failure. */
    suspend fun measureLatency(): Long? {
        val sender = activeWs ?: return null
        val start = System.currentTimeMillis()
        val session = try {
            forwardRegistry.open("127.0.0.1", 80, sender)
        } catch (_: Exception) {
            return null
        }
        val elapsed = System.currentTimeMillis() - start
        try { session.sendClose() } catch (_: Exception) {}
        return elapsed
    }

    // ── Main reconnect loop ─────────────────────────────────────────────

    private suspend fun mainLoop() {
        var backoff = INITIAL_BACKOFF_MS.toLong()
        var terminalStatus: TunnelStatus? = null

        while (!stopped) {
            try {
                _status.value = TunnelStatus.Connecting
                establishAndServe()
                backoff = INITIAL_BACKOFF_MS.toLong()
            } catch (e: TunnelAuthFailedException) {
                terminalStatus = TunnelStatus.AuthFailed
                _status.value = TunnelStatus.AuthFailed
                Log.e(TAG, "Tunnel authentication failed", e)
                break
            } catch (e: TunnelOccupiedException) {
                terminalStatus = TunnelStatus.Occupied
                _status.value = TunnelStatus.Occupied
                Log.e(TAG, "Tunnel occupied", e)
                break
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "Tunnel connection failed: ${e.message}")
                _status.value = TunnelStatus.Reconnecting
                try { delay(backoff) } catch (_: CancellationException) { break }
                backoff = min(backoff * 2, MAX_BACKOFF_MS)
            }
        }

        if (terminalStatus == null) {
            _status.value = TunnelStatus.Disconnected
        }
    }

    // ── Connection lifecycle ────────────────────────────────────────────

    private suspend fun establishAndServe() {
        val sender = establishConnection()

        // Start rotation first, then set as active atomically via stateMutex
        rotationJob = clientScope.launch { rotationLoop() }

        stateMutex.withLock {
            // If we already have an active ws (should not happen normally),
            // close the old one
            activeWs?.let { old ->
                Log.w(TAG, "Replacing existing active WS during establish")
                drainingWs = old
            }
            activeWs = sender
            candidateWs = null
        }

        connected = true
        _status.value = TunnelStatus.Connected

        // Start heartbeat (per-sender, uses heartbeatStates)
        heartbeatStates[sender] = HeartbeatState()
        heartbeatJob = clientScope.launch { heartbeatLoop() }

        // Start frame handling for this sender
        val frameChannel = Channel<ByteArray>(Channel.UNLIMITED)
        frameChannels[sender] = frameChannel
        val readJob = clientScope.launch { handleFrames(sender, frameChannel) }
        senderReadJobs[sender] = readJob

        try {
            readJob.join()
        } finally {
            // Connection ended — cleanup
            connected = false
            heartbeatJob?.cancel()
            heartbeatJob = null
            rotationJob?.cancel()
            rotationJob = null

            // Clean up this sender's state
            frameChannels.remove(sender)
            senderReadJobs.remove(sender)
            heartbeatStates.remove(sender)

            // Close forward/rev sessions on this sender
            handler.closeSessionsFor(sender)
            forwardRegistry.closeSessionsFor(sender)

            // Clean up ws references
            stateMutex.withLock {
                if (activeWs === sender) activeWs = null
                if (drainingWs === sender) drainingWs = null
                if (candidateWs === sender) candidateWs = null
            }

            try { sender.close(1000, "done") } catch (_: Exception) {}
        }
    }

    private suspend fun establishConnection(): FrameSender {
        val addr = config.serverHost
        val port = config.serverPort

        Log.i(TAG, "Connecting to tunnel $addr:$port")

        // HTTP disguise
        if (config.httpDisguise) {
            performHttpDisguise(addr, port)
        }

        // WebSocket URL
        val wsPath = config.wsPath.let { if (it.startsWith("/")) it else "/$it" }
        val wsUrl = "wss://$addr:$port$wsPath"

        // Encode AUTH payload
        val authPayload = FrameCodec.encode(Frame.Auth(credentials.username, credentials.password))

        // Channel for frame callback → coroutine bridge (used before auth completes)
        val preAuthChannel = Channel<ByteArray>(Channel.UNLIMITED)

        val tunnelWs = TunnelWebSocket(
            url = wsUrl,
            authPayload = authPayload,
            customHeaders = config.customHeaders,
            onAuthSuccess = { sender ->
                // Channel already created; pre-auth frames forwarded via same callback
                // After auth, frames are dispatched through the frame channel
            },
            onFrame = { frameBytes ->
                frameChannels.values.firstOrNull()?.trySend(frameBytes)
                preAuthChannel.trySend(frameBytes)
            },
            onDisconnect = { sender, error ->
                // Frame handling loop will detect channel close
                frameChannels[sender]?.close()
            },
        )

        return try {
            tunnelWs.connect(okHttpClient)
        } catch (e: Exception) {
            preAuthChannel.close()
            throw e
        }
    }

    private suspend fun performHttpDisguise(addr: String, port: Int) {
        val base = "https://$addr:$port"
        val disguiseClient = okHttpClient.newBuilder()
            .connectTimeout(java.time.Duration.ofSeconds(5))
            .readTimeout(java.time.Duration.ofSeconds(5))
            .build()

        try {
            withContext(Dispatchers.IO) {
                disguiseClient.newCall(Request.Builder().url(base + "/").build()).execute().close()
            }
            delay(Random.nextLong(500, 2000))
            withContext(Dispatchers.IO) {
                disguiseClient.newCall(Request.Builder().url(base + "/favicon.ico").build()).execute().close()
            }
            delay(Random.nextLong(500, 2000))
        } catch (_: Exception) {
            // HTTP disguise best-effort — continue regardless
            Log.d(TAG, "HTTP disguise request failed (non-fatal)")
        }
    }

    // ── Frame handling ──────────────────────────────────────────────────

    private suspend fun handleFrames(sender: FrameSender, channel: Channel<ByteArray>) {
        try {
            for (frameBytes in channel) {
                val frame = try {
                    FrameCodec.decode(frameBytes)
                } catch (t: Throwable) {
                    Log.w(TAG, "Failed to decode frame: ${t.message}")
                    continue
                }

                when (frame) {
                    is Frame.Ping -> {
                        try {
                            sender.sendFrame(FrameCodec.encode(Frame.Pong(frame.payload)))
                        } catch (_: Exception) {}
                    }
                    is Frame.Pong -> {
                        val state = heartbeatStates[sender] ?: continue
                        val pending = state.pendingPayload
                        if (pending != null && pending.contentEquals(frame.payload)) {
                            state.lastPongAt = System.currentTimeMillis()
                            state.pendingPayload = null
                        }
                        // Non-matching PONG: silently ignored (stale/different sender)
                    }
                    is Frame.Connect -> {
                        if (sender === drainingWs) {
                            // Reject new reverse requests on draining connection
                            try {
                                sender.sendFrame(FrameCodec.encode(Frame.ConnectFailed(frame.reqid)))
                            } catch (_: Exception) {}
                        } else {
                            handler.handleFrame(sender, frame)
                        }
                    }
                    is Frame.ConnectOk -> {
                        if (forwardRegistry.isForwardReqid(frame.reqid)) {
                            forwardRegistry.handleFrame(frame)
                        } else {
                            handler.handleFrame(sender, frame)
                        }
                    }
                    is Frame.ConnectFailed -> {
                        if (forwardRegistry.isForwardReqid(frame.reqid)) {
                            forwardRegistry.handleFrame(frame)
                        } else {
                            handler.handleFrame(sender, frame)
                        }
                    }
                    is Frame.Data -> {
                        if (forwardRegistry.isForwardReqid(frame.reqid)) {
                            forwardRegistry.handleFrame(frame)
                        } else {
                            handler.handleFrame(sender, frame)
                        }
                    }
                    is Frame.Close -> {
                        if (forwardRegistry.isForwardReqid(frame.reqid)) {
                            forwardRegistry.handleFrame(frame)
                        } else {
                            handler.handleFrame(sender, frame)
                        }
                    }
                    else -> { /* ignore */ }
                }
            }
        } catch (_: CancellationException) {
            // Expected on stop
        }
    }

    // ── Connection rotation ─────────────────────────────────────────────

    private suspend fun rotationLoop() {
        while (clientScope.isActive && !stopped) {
            val interval = Random.nextLong(DEFAULT_ROTATION_MIN_MS, DEFAULT_ROTATION_MAX_MS)
            try { delay(interval) } catch (_: CancellationException) { break }
            if (stopped) break
            try {
                rotationCycle()
            } catch (e: CancellationException) {
                break
            } catch (e: Exception) {
                Log.w(TAG, "Rotation cycle failed: ${e.message}")
            }
        }
    }

    private suspend fun rotationCycle() {
        val oldWs = activeWs ?: return
        if (!oldWs.isOpen) return

        val addr = config.serverHost
        val port = config.serverPort

        // Establish candidate connection
        val candidate = try {
            establishConnection()
        } catch (e: Exception) {
            Log.w(TAG, "Rotation candidate failed: ${e.message}")
            return
        }

        // Set up frame handling for candidate
        val candidateChannel = Channel<ByteArray>(Channel.UNLIMITED)
        frameChannels[candidate] = candidateChannel
        val candidateReadJob = clientScope.launch { handleFrames(candidate, candidateChannel) }
        senderReadJobs[candidate] = candidateReadJob

        // Initialize heartbeat state for candidate
        heartbeatStates[candidate] = HeartbeatState()

        // Atomic switch: old → draining, candidate → active
        stateMutex.withLock {
            candidateWs = null
            // If we already have a draining ws from a previous rotation, close it
            drainingWs?.let { old ->
                clientScope.launch { closeSender(old) }
            }
            drainingWs = oldWs
            activeWs = candidate
        }

        Log.i(TAG, "Rotation: new active WS, old draining")

        // Wait drain timeout, then poll until idle
        try {
            delay(DEFAULT_DRAIN_TIMEOUT_MS)
            while (isStillDraining(oldWs, DEFAULT_DRAIN_IDLE_TIMEOUT_MS)) {
                delay(1000)
                if (stopped) break
            }
        } catch (_: CancellationException) {
            // Continue to cleanup
        } finally {
            stateMutex.withLock {
                if (drainingWs === oldWs) {
                    drainingWs = null
                }
            }
            closeSender(oldWs)
        }
    }

    // ── Heartbeat ───────────────────────────────────────────────────────

    private suspend fun heartbeatLoop() {
        while (clientScope.isActive && !stopped) {
            val interval = Random.nextLong(DEFAULT_HEARTBEAT_MIN_MS, DEFAULT_HEARTBEAT_MAX_MS)
            try { delay(interval) } catch (_: CancellationException) { break }
            if (stopped) break

            // Send heartbeat on active and draining senders
            for (sender in listOfNotNull(activeWs, drainingWs)) {
                if (!sender.isOpen) continue

                val state = heartbeatStates[sender] ?: continue
                val now = System.currentTimeMillis()

                // Check if previous ping timed out
                if (state.pendingPayload != null &&
                    (now - state.lastPongAt) > HEARTBEAT_TIMEOUT_MS
                ) {
                    Log.w(TAG, "Heartbeat timeout for sender, closing")
                    try { sender.close(1001, "heartbeat timeout") } catch (_: Exception) {}
                    continue
                }

                // Send new ping
                val payloadSize = Random.nextInt(8, 40)
                val payload = ByteArray(payloadSize)
                secureRandom.nextBytes(payload)
                state.pendingPayload = payload
                try {
                    sender.sendFrame(FrameCodec.encode(Frame.Ping(payload)))
                } catch (_: Exception) {}
            }
        }
    }

    // ── Drain helpers ──────────────────────────────────────────────────

    private fun getDrainState(sender: FrameSender): DrainState {
        val rev = handler.getDrainState(sender)
        val fwd = forwardRegistry.getDrainState(sender)
        return DrainState(
            activeCount = rev.activeCount + fwd.activeCount,
            lastActivityAt = max(rev.lastActivityAt, fwd.lastActivityAt),
        )
    }

    private fun isStillDraining(sender: FrameSender, idleTimeoutMs: Long): Boolean {
        val state = getDrainState(sender)
        if (state.activeCount <= 0) return false
        return (System.currentTimeMillis() - state.lastActivityAt) < idleTimeoutMs
    }

    private suspend fun closeSender(sender: FrameSender) {
        senderReadJobs.remove(sender)?.cancel()
        frameChannels.remove(sender)?.close()
        heartbeatStates.remove(sender)
        handler.closeSessionsFor(sender)
        forwardRegistry.closeSessionsFor(sender)
        try { sender.close(1000, "rotation cleanup") } catch (_: Exception) {}
    }
}

private data class HeartbeatState(
    @Volatile var pendingPayload: ByteArray? = null,
    @Volatile var lastPongAt: Long = System.currentTimeMillis(),
)
