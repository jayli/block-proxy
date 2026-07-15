package com.blockproxy.android.tunnel

import android.content.Context
import android.util.Log
import com.blockproxy.android.cdn.CfIpDns
import com.blockproxy.android.cdn.CfIpSelector
import com.blockproxy.android.config.ServerConfig
import com.blockproxy.android.config.TunnelCredentials
import com.blockproxy.android.status.TunnelStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
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
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.max
import kotlin.math.min
import kotlin.random.Random

private const val TAG = "TunnelClient"

class TunnelClient(
    private val context: Context,
    private val config: ServerConfig,
    private val credentials: TunnelCredentials,
    private val targetSocketFactory: TargetSocketFactory,
    private val clientScope: CoroutineScope,
    private val protect: ((java.net.Socket) -> Boolean)? = null,
    private val cfIpDns: CfIpDns? = null,
    private val cfIpSelector: CfIpSelector? = null,
    private val onCfIpChanged: (String?) -> Unit = {},
    private val onTransportChanged: (String?) -> Unit = {},
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
        ),
    )

    private val handler = ReverseConnectHandler(clientScope, targetSocketFactory, paddingInjector = paddingInjector)
    private val forwardRegistry = ForwardSessionRegistry(clientScope, paddingInjector = paddingInjector)

    // Tunnel stream state
    @Volatile private var activeStream: FrameSender? = null
    @Volatile private var candidateStream: FrameSender? = null
    @Volatile private var drainingStream: FrameSender? = null

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
        // Close all active/draining/candidate senders
        for (sender in listOfNotNull(activeStream, candidateStream, drainingStream)) {
            closeSender(sender)
        }
        activeStream = null
        candidateStream = null
        drainingStream = null
        onTransportChanged(null)

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
        val sender = activeStream
            ?: throw IllegalStateException("No active tunnel connection")
        return forwardRegistry.open(host, port, sender)
    }

    /** Measures tunnel RTT in milliseconds. Returns null on failure. */
    suspend fun measureLatency(): Long? {
        val sender = activeStream ?: return null
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
            activeStream?.let { old ->
                Log.w(TAG, "Replacing existing active stream during establish")
                drainingStream = old
            }
            activeStream = sender
            candidateStream = null
        }

        connected = true
        onTransportChanged(sender.transportLabel)
        _status.value = TunnelStatus.Connected

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
        // When rotation replaces this sender, closeSender() sets drainingStream=null but
        // activeStream is set to the candidate — so activeStream stays non-null and we keep waiting.
        // When the active sender genuinely disconnects, closeSender() sets activeStream=null
        // and this loop exits, triggering a reconnect in mainLoop().
        try {
            while (clientScope.isActive && !stopped && activeStream != null) {
                delay(500)
            }
            Log.i(TAG, "Poll loop exited: stopped=$stopped, activeStream=$activeStream, isActive=${clientScope.isActive}")
        } finally {
            connected = false
            rotationJob?.cancel()
            rotationJob = null
        }
    }

    private suspend fun establishConnection(): FrameSender {
        val addr = config.serverHost
        val port = config.serverPort

        Log.i(TAG, "Connecting to HTTP/2 tunnel $addr:$port")
        if (protect != null) {
            Log.w(TAG, "Cronet tunnel transport cannot use the OkHttp SocketFactory protect hook")
        }

        // Encode AUTH payload
        val authCapabilities = if (config.paddingEnabled) listOf(FrameCodec.CAP_PADDING) else emptyList()
        val authPayload = FrameCodec.encode(
            Frame.Auth(credentials.username, credentials.password, authCapabilities)
        )

        // Pre-create frame channel — registered in onAuthSuccess before any post-auth frame arrives.
        val frameChannel = Channel<ByteArray>(Channel.UNLIMITED)

        val tunnelUrl = TunnelEndpoint.grpcUrl(addr, port, TunnelEndpoint.DEFAULT_GRPC_PATH)
        val tunnelStream = CronetTunnelStream(
            context = context,
            url = tunnelUrl,
            allowInsecure = config.allowInsecure,
            cfIpDns = cfIpDns,
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
            tunnelStream.connect()
        } catch (e: Exception) {
            if (cfIpDns == null && InsecureH2Fallback.shouldFallback(config.allowInsecure, e)) {
                Log.w(TAG, "Cronet certificate validation failed; retrying with insecure OkHttp HTTP/2 transport")
                val fallbackStream = OkHttpH2TunnelStream(
                    url = tunnelUrl,
                    authPayload = authPayload,
                    customHeaders = config.customHeaders,
                    allowInsecure = true,
                    protect = protect,
                    onAuthSuccess = { sender ->
                        frameChannels[sender] = frameChannel
                        cfIpSelector?.markConnected()
                        onCfIpChanged(null)
                    },
                    onFrame = { sender, frameBytes ->
                        frameChannels[sender]?.trySend(frameBytes)
                    },
                    onDisconnect = { sender, error ->
                        frameChannels[sender]?.close()
                        handleCfDisconnect(sender)
                    },
                )
                return fallbackStream.connect()
            }
            frameChannel.close()
            cfIpSelector?.markCandidateFailed()
            throw e
        }
    }

    private fun handleCfDisconnect(sender: FrameSender) {
        val selector = cfIpSelector ?: return
        if (stopped) return
        when {
            sender === drainingStream -> Unit
            sender === activeStream -> selector.markActiveDisconnectedUnexpectedly()
            else -> selector.markCandidateFailed()
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
                    is Frame.Capabilities -> {
                        paddingInjector.setNegotiated(
                            sender,
                            frame.capabilities.contains(FrameCodec.CAP_PADDING)
                        )
                    }
                    is Frame.Padding -> { /* silently discard */ }
                    is Frame.Connect -> {
                        if (sender === drainingStream) {
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
        val oldStream = activeStream ?: return
        if (!oldStream.isOpen) return

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
            candidateStream = null
            // If a previous draining stream is still lingering, close it now
            drainingStream?.let { prior ->
                clientScope.launch { closeSender(prior) }
            }
            drainingStream = oldStream
            activeStream = candidate
        }

        Log.i(TAG, "Rotation: new active HTTP/2 stream, old draining")

        // Wait drain timeout, then poll until idle
        try {
            delay(DEFAULT_DRAIN_TIMEOUT_MS)
            while (isStillDraining(oldStream, DEFAULT_DRAIN_IDLE_TIMEOUT_MS)) {
                delay(1000)
                if (stopped) break
            }
        } catch (_: CancellationException) {
            // Continue to cleanup
        } finally {
            stateMutex.withLock {
                if (drainingStream === oldStream) {
                    drainingStream = null
                }
            }
            closeSender(oldStream)
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
        paddingInjector.clearNegotiation(sender)
        senderReadJobs.remove(sender)?.cancel()
        frameChannels.remove(sender)?.close()
        handler.closeSessionsFor(sender)
        forwardRegistry.closeSessionsFor(sender)

        stateMutex.withLock {
            if (activeStream === sender) activeStream = null
            if (drainingStream === sender) drainingStream = null
            if (candidateStream === sender) candidateStream = null
        }

        try { sender.close(1000, "done") } catch (_: Exception) {}
    }
}
