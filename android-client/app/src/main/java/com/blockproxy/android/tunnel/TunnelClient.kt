package com.blockproxy.android.tunnel

import android.util.Log
import com.blockproxy.android.diagnostics.TunnelDiagnosticsLog
import com.blockproxy.android.cdn.CfIpDns
import com.blockproxy.android.cdn.CfIpSelector
import com.blockproxy.android.config.ServerConfig
import com.blockproxy.android.config.TunnelCredentials
import com.blockproxy.android.status.TunnelStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import kotlin.math.max
import kotlin.math.min
import kotlin.random.Random
import kotlin.random.nextLong

private const val TAG = "TunnelClient"

/**
 * 隧道客户端：管理 xhttp 传输层的生命周期。
 *
 * 使用 xhttp 模式（按需 POST 上行 + SSE 下行），替代原有的 WebSocket 双向隧道。
 */
class TunnelClient(
    private val config: ServerConfig,
    private val credentials: TunnelCredentials,
    private val targetSocketFactory: TargetSocketFactory,
    private val clientScope: CoroutineScope,
    private val protect: ((java.net.Socket) -> Boolean)? = null,
    private val sseCfIpDns: CfIpDns? = null,
    private val sseCfIpSelector: CfIpSelector? = null,
    private val uploadCfIpDns: CfIpDns? = null,
    private val uploadCfIpSelector: CfIpSelector? = null,
    private val nativeUtlsUploadEnabled: Boolean = true,
    private val nativePostClientFactory: () -> NativeUtlsPostClient? = { GomobileUtlsPostClient.createOrNull() },
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
        ),
    )

    private val handler = ReverseConnectHandler(clientScope, targetSocketFactory, paddingInjector = paddingInjector)
    private val forwardRegistry = ForwardSessionRegistry(clientScope, paddingInjector = paddingInjector)

    private val sseOkHttpClient = XhttpTransport.createOkHttpClient(
        allowInsecure = config.allowInsecure,
        protect = protect,
    )

    private val uploadOkHttpClient = XhttpTransport.createOkHttpClient(
        allowInsecure = config.allowInsecure,
        protect = protect,
    )

    // xhttp transport state
    @Volatile private var activeTransport: XhttpTransport? = null
    @Volatile private var candidateTransport: XhttpTransport? = null
    @Volatile private var drainingTransport: XhttpTransport? = null

    @Volatile private var stopped = true
    @Volatile private var connected = false
    @Volatile private var lastActivityAt = System.currentTimeMillis()

    private var mainJob: Job? = null
    private var rotationJob: Job? = null
    private var readJob: Job? = null

    private val stateMutex = Mutex()

    // ── Public API ──────────────────────────────────────────────────────

    fun isConnected(): Boolean = connected

    fun globalLastActivityAt(): Long = lastActivityAt

    suspend fun awaitConnected(timeoutMs: Long): Boolean {
        return withTimeoutOrNull(timeoutMs) {
            status.first {
                it == TunnelStatus.Connected ||
                    it == TunnelStatus.AuthFailed ||
                    it == TunnelStatus.Occupied
            }
        }?.let { it == TunnelStatus.Connected } ?: false
    }

    fun start() {
        if (!stopped) return
        stopped = false
        TunnelDiagnosticsLog.write(
            "tunnel.start",
            "host=${config.serverHost} port=${config.serverPort} cfCdn=${config.cfCdnEnabled}"
        )
        _status.value = TunnelStatus.Connecting
        mainJob = clientScope.launch { mainLoop() }
    }

    suspend fun stop(timeoutMs: Long = 5_000L) {
        stopped = true
        TunnelDiagnosticsLog.write("tunnel.stop", "timeoutMs=$timeoutMs")
        sseCfIpSelector?.markStoppedCleanly()
        uploadCfIpSelector?.markStoppedCleanly()
        onCfIpChanged(null)
        mainJob?.cancel()
        mainJob = null
        readJob?.cancel()
        readJob = null

        for (transport in listOfNotNull(activeTransport, candidateTransport, drainingTransport)) {
            closeTransport(transport)
        }
        activeTransport = null
        candidateTransport = null
        drainingTransport = null

        forwardRegistry.stop()
        _status.value = TunnelStatus.Disconnected
    }

    suspend fun openForwardSession(host: String, port: Int): ForwardSession {
        val transport = activeTransport
            ?: throw IllegalStateException("No active tunnel connection")
        lastActivityAt = System.currentTimeMillis()
        return forwardRegistry.open(host, port, transport)
    }

    suspend fun measureLatency(): Long? {
        val transport = activeTransport ?: return null
        val start = System.currentTimeMillis()
        val session = try {
            forwardRegistry.open("127.0.0.1", 80, transport)
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
                TunnelDiagnosticsLog.write("tunnel.auth_failed", "message=${e.message ?: ""}")
                Log.e(TAG, "Tunnel authentication failed", e)
                break
            } catch (e: TunnelOccupiedException) {
                terminalStatus = TunnelStatus.Occupied
                _status.value = TunnelStatus.Occupied
                TunnelDiagnosticsLog.write("tunnel.occupied", "message=${e.message ?: ""}")
                Log.e(TAG, "Tunnel occupied", e)
                break
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "Tunnel connection failed: ${e.message}")
                _status.value = TunnelStatus.Reconnecting
                TunnelDiagnosticsLog.write(
                    "tunnel.connection_failed",
                    "type=${e::class.java.simpleName} message=${e.message ?: ""} nextBackoffMs=$backoff"
                )
                try { delay(backoff) } catch (_: CancellationException) { break }
                backoff = min(backoff * 2, MAX_BACKOFF_MS)
            }
        }

        if (terminalStatus == null) {
            _status.value = TunnelStatus.Disconnected
            TunnelDiagnosticsLog.write("tunnel.disconnected", "stopped=$stopped")
        }
    }

    // ── Connection lifecycle ────────────────────────────────────────────

    private suspend fun establishAndServe() {
        val transport = establishConnection()

        rotationJob = clientScope.launch { rotationLoop() }

        stateMutex.withLock {
            activeTransport?.let { old ->
                Log.w(TAG, "Replacing existing active transport during establish")
                drainingTransport = old
            }
            activeTransport = transport
            candidateTransport = null
        }

        connected = true
        lastActivityAt = System.currentTimeMillis()
        _status.value = TunnelStatus.Connected
        TunnelDiagnosticsLog.write(
            "tunnel.connected",
            "session=${transport.sessionDebugId()} cfIp=${sseCfIpSelector?.currentIp() ?: sseCfIpDns?.getCurrentIp() ?: ""}"
        )
        sseCfIpSelector?.markConnected()
        onCfIpChanged(sseCfIpSelector?.currentIp() ?: sseCfIpDns?.getCurrentIp())

        readJob = clientScope.launch { handleFrames(transport) }

        // Set SSE disconnected callback
        transport.onSseDisconnected = {
            Log.w(TAG, "SSE disconnected, triggering reconnect")
            TunnelDiagnosticsLog.write(
                "tunnel.sse_disconnected_callback",
                "session=${transport.sessionDebugId()}"
            )
            clientScope.launch { closeTransport(transport) }
        }

        clientScope.launch {
            readJob?.join()
            Log.i(TAG, "handleFrames exited for transport")
            TunnelDiagnosticsLog.write(
                "tunnel.handle_frames_exited",
                "session=${transport.sessionDebugId()}"
            )
            closeTransport(transport)
        }

        // Wait until stopped or active connection lost
        try {
            while (clientScope.isActive && !stopped && activeTransport != null) {
                delay(500)
            }
        } finally {
            connected = false
            TunnelDiagnosticsLog.write(
                "tunnel.serve_exited",
                "session=${transport.sessionDebugId()} stopped=$stopped active=${activeTransport != null}"
            )
            rotationJob?.cancel()
            rotationJob = null
        }
    }

    private suspend fun establishConnection(): XhttpTransport {
        Log.i(TAG, "Connecting to tunnel ${config.serverHost}:${config.serverPort}")
        TunnelDiagnosticsLog.write(
            "tunnel.connecting",
            "host=${config.serverHost} port=${config.serverPort}"
        )

        val transportFactory = TunnelTransportFactory(
            config = config,
            credentials = credentials,
            sseHttpClient = sseConnectionClient(),
            uploadClient = uploadClient(),
            protect = protect,
        )

        return try {
            transportFactory.connect()
        } catch (e: Exception) {
            sseCfIpSelector?.markCandidateFailed()
            TunnelDiagnosticsLog.write(
                "tunnel.establish_failed",
                "type=${e::class.java.simpleName} message=${e.message ?: ""}"
            )
            throw e
        }
    }

    private fun sseConnectionClient(): OkHttpClient {
        return if (sseCfIpDns != null) {
            Log.i(TAG, "Using CF DNS override for SSE/create session")
            sseOkHttpClient.newBuilder().dns(sseCfIpDns).build()
        } else {
            Log.i(TAG, "Using system DNS for SSE/create session")
            sseOkHttpClient
        }
    }

    private fun uploadConnectionClient(): OkHttpClient {
        return if (uploadCfIpDns != null) {
            uploadOkHttpClient.newBuilder().dns(uploadCfIpDns).build()
        } else {
            uploadOkHttpClient
        }
    }

    private fun uploadClient(): XhttpUploadClient {
        val fallback = OkHttpXhttpUploadClient(uploadConnectionClient())
        if (!nativeUtlsUploadEnabled || !config.useTls) {
            return fallback
        }
        val native = nativePostClientFactory() ?: return fallback
        return NativeUtlsXhttpUploadClient(
            config = config,
            selector = uploadCfIpSelector,
            nativeClient = native,
            fallback = fallback,
        )
    }

    // ── Frame handling ──────────────────────────────────────────────────

    private suspend fun handleFrames(transport: XhttpTransport) {
        try {
            while (transport.isOpen && clientScope.isActive) {
                val frameBytes = transport.readFrame() ?: break

                val frame = try {
                    FrameCodec.decode(frameBytes)
                } catch (t: Throwable) {
                    Log.w(TAG, "Failed to decode frame: ${t.message}")
                    continue
                }

                if (frame is Frame.Connect || frame is Frame.Data || frame is Frame.Close) {
                    lastActivityAt = System.currentTimeMillis()
                }

                when (frame) {
                    is Frame.Ping -> {
                        try {
                            transport.sendFrame(FrameCodec.encode(Frame.Pong(frame.payload)))
                        } catch (_: Exception) {}
                    }
                    is Frame.Pong -> { }
                    is Frame.Capabilities -> {
                        paddingInjector.setNegotiated(
                            transport,
                            frame.capabilities.contains(FrameCodec.CAP_PADDING)
                        )
                    }
                    is Frame.Padding -> { }
                    is Frame.Connect -> {
                        if (transport === drainingTransport) {
                            try {
                                transport.sendFrame(FrameCodec.encode(Frame.ConnectFailed(frame.reqid)))
                            } catch (_: Exception) {}
                        } else {
                            handler.handleFrame(transport, frame)
                        }
                    }
                    is Frame.ConnectOk -> {
                        if (forwardRegistry.isForwardReqid(frame.reqid)) {
                            forwardRegistry.handleFrame(frame)
                        } else {
                            handler.handleFrame(transport, frame)
                        }
                    }
                    is Frame.ConnectFailed -> {
                        if (forwardRegistry.isForwardReqid(frame.reqid)) {
                            forwardRegistry.handleFrame(frame)
                        } else {
                            handler.handleFrame(transport, frame)
                        }
                    }
                    is Frame.Data -> {
                        if (forwardRegistry.isForwardReqid(frame.reqid)) {
                            forwardRegistry.handleFrame(frame)
                        } else {
                            handler.handleFrame(transport, frame)
                        }
                    }
                    is Frame.Close -> {
                        if (forwardRegistry.isForwardReqid(frame.reqid)) {
                            forwardRegistry.handleFrame(frame)
                        } else {
                            handler.handleFrame(transport, frame)
                        }
                    }
                    else -> { }
                }
            }
        } catch (_: CancellationException) {
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
        val oldTransport = activeTransport ?: return
        if (!oldTransport.isOpen) return

        sseCfIpSelector?.forceNextOnNextLookup()
        TunnelDiagnosticsLog.write("rotation.start", "oldSession=${oldTransport.sessionDebugId()}")

        val candidate = try {
            establishConnection()
        } catch (e: Exception) {
            Log.w(TAG, "Rotation candidate failed: ${e.message}")
            TunnelDiagnosticsLog.write(
                "rotation.candidate_failed",
                "type=${e::class.java.simpleName} message=${e.message ?: ""}"
            )
            return
        }

        val candidateReadJob = clientScope.launch { handleFrames(candidate) }

        clientScope.launch {
            candidateReadJob.join()
            closeTransport(candidate)
        }

        stateMutex.withLock {
            candidateTransport = null
            drainingTransport?.let { prior ->
                clientScope.launch { closeTransport(prior) }
            }
            drainingTransport = oldTransport
            activeTransport = candidate
        }

        Log.i(TAG, "Rotation: new active transport, old draining")
        TunnelDiagnosticsLog.write(
            "rotation.switched",
            "oldSession=${oldTransport.sessionDebugId()} newSession=${candidate.sessionDebugId()}"
        )

        try {
            delay(DEFAULT_DRAIN_TIMEOUT_MS)
            while (isStillDraining(oldTransport, DEFAULT_DRAIN_IDLE_TIMEOUT_MS)) {
                delay(1000)
                if (stopped) break
            }
        } catch (_: CancellationException) {
        } finally {
            stateMutex.withLock {
                if (drainingTransport === oldTransport) {
                    drainingTransport = null
                }
            }
            closeTransport(oldTransport)
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

    private suspend fun closeTransport(transport: FrameSender) {
        TunnelDiagnosticsLog.write(
            "tunnel.close_transport",
            "sender=${transport.debugName()}"
        )
        paddingInjector.clearNegotiation(transport)
        handler.closeSessionsFor(transport)
        forwardRegistry.closeSessionsFor(transport)

        stateMutex.withLock {
            if (activeTransport === transport) activeTransport = null
            if (drainingTransport === transport) drainingTransport = null
            if (candidateTransport === transport) candidateTransport = null
        }

        try { transport.close(1000, "done") } catch (_: Exception) {}
    }

    private fun FrameSender.debugName(): String {
        return if (this is XhttpTransport) "xhttp:${sessionDebugId()}" else this::class.java.simpleName
    }
}
