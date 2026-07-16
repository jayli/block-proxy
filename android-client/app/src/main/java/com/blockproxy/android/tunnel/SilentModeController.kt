package com.blockproxy.android.tunnel

import com.blockproxy.android.config.ServerConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.random.Random

enum class SilentModeState {
    Disabled,
    Active,
    Sleeping,
}

interface SilentModeTunnelLifecycle {
    fun start()
    suspend fun stop()
    suspend fun disconnectForSilentMode()
    suspend fun awaitConnected(timeoutMs: Long): Boolean
    fun lastActivityAt(): Long
}

interface SilentModeSseLoop {
    suspend fun connectAndRead(): SseControlResult
    fun stop()
}

class TunnelClientSilentLifecycle(private val client: TunnelClient) : SilentModeTunnelLifecycle {
    override fun start() = client.start()
    override suspend fun stop() = client.stop()
    override suspend fun disconnectForSilentMode() = client.stop()
    override suspend fun awaitConnected(timeoutMs: Long): Boolean = client.awaitConnected(timeoutMs)
    override fun lastActivityAt(): Long = client.globalLastActivityAt()
}

class SseControlLoop(private val client: SseControlClient) : SilentModeSseLoop {
    override suspend fun connectAndRead(): SseControlResult = client.connectAndRead()
    override fun stop() = client.stop()
}

class SilentModeController(
    private val config: ServerConfig,
    private val tunnel: SilentModeTunnelLifecycle,
    private val sseLoop: SilentModeSseLoop,
    private val scope: CoroutineScope,
    private val checkIntervalMs: Long = 60_000L,
    private val randomDelayMs: () -> Long = { Random.nextLong(3_000L, 8_001L) },
    private val nowMs: () -> Long = { System.currentTimeMillis() },
) {
    private val _state = MutableStateFlow(SilentModeState.Disabled)
    val state: StateFlow<SilentModeState> = _state.asStateFlow()

    private var job: Job? = null

    fun start() {
        if (!config.silentModeEnabled) {
            _state.value = SilentModeState.Disabled
            tunnel.start()
            return
        }

        job = scope.launch {
            _state.value = SilentModeState.Active
            tunnel.start()
            monitorIdle()
        }
    }

    suspend fun stop() {
        job?.cancel()
        job = null
        sseLoop.stop()
        tunnel.stop()
        _state.value = SilentModeState.Disabled
    }

    private suspend fun monitorIdle() {
        while (scope.isActive && _state.value != SilentModeState.Disabled) {
            delay(checkIntervalMs)
            if (_state.value != SilentModeState.Active) continue

            val idleMs = nowMs() - tunnel.lastActivityAt()
            if (idleMs >= config.silentIdleTimeoutMs) {
                enterSleeping()
                return
            }
        }
    }

    private suspend fun enterSleeping() {
        tunnel.disconnectForSilentMode()
        _state.value = SilentModeState.Sleeping

        while (scope.isActive && _state.value == SilentModeState.Sleeping) {
            when (sseLoop.connectAndRead()) {
                SseControlResult.Wake -> {
                    sseLoop.stop()
                    tunnel.start()
                    if (tunnel.awaitConnected(10_000L)) {
                        _state.value = SilentModeState.Active
                        monitorIdle()
                        return
                    }
                    _state.value = SilentModeState.Sleeping
                    delay(randomDelayMs())
                }
                SseControlResult.AuthFailed -> {
                    _state.value = SilentModeState.Disabled
                    return
                }
                SseControlResult.NotSupported -> {
                    _state.value = SilentModeState.Disabled
                    tunnel.start()
                    return
                }
                SseControlResult.Disconnected,
                SseControlResult.Failed -> {
                    delay(randomDelayMs())
                }
            }
        }
    }
}
