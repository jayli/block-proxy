package com.blockproxy.android.tunnel

import android.util.Log
import com.blockproxy.android.cdn.CfIpDns
import com.blockproxy.android.cdn.CfIpSelector
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
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
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
    private val cfIpDns: CfIpDns? = null,
    private val cfIpSelector: CfIpSelector? = null,
    private val onCfIpChanged: (String?) -> Unit = {},
) {
    companion object {
        const val INITIAL_BACKOFF_MS = 1_000L
        const val MAX_BACKOFF_MS = 60_000L
        private const val DEFAULT_ROTATION_MIN_MS = 600_000L   // 10 min
        private const val DEFAULT_ROTATION_MAX_MS = 1_800_000L // 30 min
        private const val DEFAULT_DRAIN_TIMEOUT_MS = 10_000L   // 10 s
        private const val DEFAULT_DRAIN_IDLE_TIMEOUT_MS = 20_000L // 20 s
    }

    private val _status = MutableStateFlow<TunnelStatus>(TunnelStatus.Disconnected)
    val status: StateFlow<TunnelStatus> = _status.asStateFlow()

    private val paddingInjector = PaddingInjector(
        clientScope,
        PaddingConfig(
            enabled = config.paddingEnabled,
            probability = config.paddingProbability,
            minBytes = config.paddingMinBytes,
            maxBytes = config.paddingMaxBytes,
            intervalMinMs = config.paddingIntervalMinMs,
            intervalMaxMs = config.paddingIntervalMaxMs,
        ),
    )

    private val handler = ReverseConnectHandler(clientScope, targetSocketFactory, paddingInjector = paddingInjector)
    private val forwardRegistry = ForwardSessionRegistry(clientScope, paddingInjector = paddingInjector)

    private val okHttpClient = TunnelWebSocket.createOkHttpClient(
        allowInsecure = config.allowInsecure,
        protect = protect,
    )

    // WebSocket state
    @Volatile private var activeWs: FrameSender? = null
    @Volatile private var candidateWs: FrameSender? = null
    @Volatile private var drainingWs: FrameSender? = null

    @Volatile private var stopped = true
    @Volatile private var connected = false

    private var mainJob: Job? = null
    private var rotationJob: Job? = null

    private val stateMutex = Mutex()

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
        cfIpSelector?.markStoppedCleanly()
        onCfIpChanged(null)
        mainJob?.cancel()
        mainJob = null
        paddingInjector.stopPeriodic()

        // Close all active/draining/candidate senders
        for (sender in listOfNotNull(activeWs, candidateWs, drainingWs)) {
            closeSender(sender)
        }
        activeWs = null
        candidateWs = null
        drainingWs = null

        // Close any remaining channels/jobs (safety net)
        for ((_, ch) in frameChannels) {
            ch.close()
        }
        for ((_, job) in senderReadJobs) {
            job.cancel()
        }
        frameChannels.clear()
        senderReadJobs.clear()

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

        // Channel was pre-created by establishConnection() and registered in onAuthSuccess
        val frameChannel = frameChannels[sender]
            ?: throw IllegalStateException("Frame channel not registered for sender")

        // Start rotation first, then set as active atomically via stateMutex
        rotationJob = clientScope.launch { rotationLoop() }

        stateMutex.withLock {
            activeWs?.let { old ->
                Log.w(TAG, "Replacing existing active WS during establish")
                drainingWs = old
            }
            activeWs = sender
            candidateWs = null
        }

        connected = true
        _status.value = TunnelStatus.Connected
        paddingInjector.startPeriodic(sender)

        // Start frame handling for this sender
        val readJob = clientScope.launch { handleFrames(sender, frameChannel) }
        senderReadJobs[sender] = readJob

        // Auto-cleanup when this sender's read job completes (normal disconnection or cancellation)
        clientScope.launch {
            readJob.join()
            Log.i(TAG, "handleFrames exited for sender, closing sender")
            closeSender(sender)
        }

        // Wait until stopped, or until the active connection is lost and needs reconnecting.
        // When rotation replaces this sender, closeSender() sets drainingWs=null but
        // activeWs is set to the candidate — so activeWs stays non-null and we keep waiting.
        // When the active sender genuinely disconnects, closeSender() sets activeWs=null
        // and this loop exits, triggering a reconnect in mainLoop().
        try {
            while (clientScope.isActive && !stopped && activeWs != null) {
                delay(500)
            }
            Log.i(TAG, "Poll loop exited: stopped=$stopped, activeWs=$activeWs, isActive=${clientScope.isActive}")
        } finally {
            connected = false
            rotationJob?.cancel()
            rotationJob = null
            paddingInjector.stopPeriodic()
        }
    }

    private suspend fun establishConnection(): FrameSender {
        val addr = config.serverHost
        val port = config.serverPort
        val wsClient = connectionClient()

        Log.i(TAG, "Connecting to tunnel $addr:$port")

        // HTTP disguise
        if (config.httpDisguise) {
            performHttpDisguise(addr, port, wsClient)
        }

        // WebSocket URL
        val wsPath = config.wsPath.let { if (it.startsWith("/")) it else "/$it" }
        val wsUrl = "wss://$addr:$port$wsPath"

        // Encode AUTH payload
        val authPayload = FrameCodec.encode(Frame.Auth(credentials.username, credentials.password))

        // Pre-create frame channel — registered in onAuthSuccess before any post-auth frame arrives.
        // OkHttp serializes onMessage callbacks on a single thread, so by the time the first
        // post-auth onFrame fires, the channel is already registered.
        val frameChannel = Channel<ByteArray>(Channel.UNLIMITED)

        val tunnelWs = TunnelWebSocket(
            url = wsUrl,
            authPayload = authPayload,
            customHeaders = config.customHeaders,
            onAuthSuccess = { sender ->
                frameChannels[sender] = frameChannel
                cfIpSelector?.markConnected()
                onCfIpChanged(cfIpDns?.getCurrentIp())
            },
            onFrame = { sender, frameBytes ->
                frameChannels[sender]?.trySend(frameBytes)
            },
            onDisconnect = { sender, error ->
                frameChannels[sender]?.close()
                handleCfDisconnect(sender)
            },
        )

        return try {
            tunnelWs.connect(wsClient)
        } catch (e: Exception) {
            frameChannel.close()
            cfIpSelector?.markCandidateFailed()
            throw e
        }
    }

    private fun connectionClient(): OkHttpClient {
        return if (cfIpDns != null) {
            okHttpClient.newBuilder().dns(cfIpDns).build()
        } else {
            okHttpClient
        }
    }

    private fun handleCfDisconnect(sender: FrameSender) {
        val selector = cfIpSelector ?: return
        if (stopped) return
        when {
            sender === drainingWs -> Unit
            sender === activeWs -> selector.markActiveDisconnectedUnexpectedly()
            else -> selector.markCandidateFailed()
        }
    }

    private suspend fun performHttpDisguise(addr: String, port: Int, client: OkHttpClient) {
        val base = "https://$addr:$port"
        val disguiseClient = client.newBuilder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(5, TimeUnit.SECONDS)
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
                        // Server heartbeat: reply with same payload as PONG
                        try {
                            sender.sendFrame(FrameCodec.encode(Frame.Pong(frame.payload)))
                        } catch (_: Exception) {}
                    }
                    is Frame.Pong -> { /* server response to its own PING, no client-side tracking */ }
                    is Frame.Padding -> { /* silently discard */ }
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

        cfIpSelector?.forceNextOnNextLookup()

        // Establish candidate connection (channel pre-created and registered in onAuthSuccess)
        val candidate = try {
            establishConnection()
        } catch (e: Exception) {
            Log.w(TAG, "Rotation candidate failed: ${e.message}")
            return
        }

        val candidateChannel = frameChannels[candidate]
            ?: run {
                Log.w(TAG, "Rotation candidate channel not registered")
                try { candidate.close(1000, "no channel") } catch (_: Exception) {}
                return
            }

        // Start frame handling for candidate with auto-cleanup
        val candidateReadJob = clientScope.launch { handleFrames(candidate, candidateChannel) }
        senderReadJobs[candidate] = candidateReadJob

        clientScope.launch {
            candidateReadJob.join()
            closeSender(candidate)
        }

        // Atomic switch: old → draining, candidate → active
        stateMutex.withLock {
            candidateWs = null
            // If a previous draining ws is still lingering, close it now
            drainingWs?.let { prior ->
                clientScope.launch { closeSender(prior) }
            }
            drainingWs = oldWs
            activeWs = candidate
            paddingInjector.updateSender(candidate)
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
        handler.closeSessionsFor(sender)
        forwardRegistry.closeSessionsFor(sender)

        stateMutex.withLock {
            if (activeWs === sender) activeWs = null
            if (drainingWs === sender) drainingWs = null
            if (candidateWs === sender) candidateWs = null
        }

        try { sender.close(1000, "done") } catch (_: Exception) {}
    }
}
