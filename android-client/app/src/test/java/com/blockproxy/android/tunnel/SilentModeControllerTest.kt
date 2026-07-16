package com.blockproxy.android.tunnel

import com.blockproxy.android.config.ServerConfig
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SilentModeControllerTest {

    private val dispatcher = StandardTestDispatcher()
    private val scope = TestScope(dispatcher)

    @Test
    fun `starts tunnel directly when silent mode disabled`() = scope.runTest {
        val tunnel = FakeTunnelLifecycle()
        val sse = FakeSseLoop()
        val controller = SilentModeController(
            config = ServerConfig(serverHost = "example.com", silentModeEnabled = false),
            tunnel = tunnel,
            sseLoop = sse,
            scope = this,
            randomDelayMs = { 3_000L },
        )

        controller.start()
        runCurrent()

        assertEquals(1, tunnel.starts)
        assertEquals(SilentModeState.Disabled, controller.state.value)
    }

    @Test
    fun `enters sleeping after idle timeout and starts sse loop`() = scope.runTest {
        var now = 0L
        val tunnel = FakeTunnelLifecycle { now }
        val sse = FakeSseLoop(SseControlResult.Disconnected)
        val controller = SilentModeController(
            config = ServerConfig(
                serverHost = "example.com",
                silentModeEnabled = true,
                silentIdleTimeoutMs = 1_000L,
            ),
            tunnel = tunnel,
            sseLoop = sse,
            scope = this,
            checkIntervalMs = 100L,
            randomDelayMs = { 3_000L },
            nowMs = { now },
        )

        controller.start()
        runCurrent()
        now = 1_200L
        advanceTimeBy(1_200L)
        runCurrent()

        assertEquals(1, tunnel.silentDisconnects)
        assertEquals(SilentModeState.Sleeping, controller.state.value)
        assertEquals(1, sse.connects)
        controller.stop()
    }

    @Test
    fun `wake starts tunnel and returns active when connected`() = scope.runTest {
        var now = 0L
        val tunnel = FakeTunnelLifecycle { now }
        val sse = FakeSseLoop(SseControlResult.Wake)
        val controller = SilentModeController(
            config = ServerConfig(serverHost = "example.com", silentModeEnabled = true, silentIdleTimeoutMs = 1_000L),
            tunnel = tunnel,
            sseLoop = sse,
            scope = this,
            checkIntervalMs = 100L,
            randomDelayMs = { 3_000L },
            nowMs = { now },
        )

        controller.start()
        runCurrent()
        now = 1_200L
        advanceTimeBy(1_200L)
        runCurrent()

        assertEquals(2, tunnel.starts)
        assertEquals(SilentModeState.Active, controller.state.value)
        controller.stop()
    }

    @Test
    fun `sse rotation reconnects immediately without retry delay`() = scope.runTest {
        var now = 0L
        val tunnel = FakeTunnelLifecycle { now }
        val sse = FakeSseLoop(SseControlResult.Rotated, SseControlResult.Disconnected)
        val controller = SilentModeController(
            config = ServerConfig(serverHost = "example.com", silentModeEnabled = true, silentIdleTimeoutMs = 1_000L),
            tunnel = tunnel,
            sseLoop = sse,
            scope = this,
            checkIntervalMs = 100L,
            randomDelayMs = { 3_000L },
            nowMs = { now },
        )

        controller.start()
        runCurrent()
        now = 1_200L
        advanceTimeBy(1_200L)
        runCurrent()

        assertEquals(2, sse.connects)
        assertEquals(SilentModeState.Sleeping, controller.state.value)
        controller.stop()
    }

    private class FakeTunnelLifecycle(
        private val nowMs: () -> Long = { 0L },
    ) : SilentModeTunnelLifecycle {
        var starts = 0
        var silentDisconnects = 0
        private var activity = 0L

        override fun start() {
            starts += 1
            activity = nowMs()
        }

        override suspend fun stop() = Unit

        override suspend fun disconnectForSilentMode() {
            silentDisconnects += 1
        }

        override suspend fun awaitConnected(timeoutMs: Long): Boolean = true

        override fun lastActivityAt(): Long = activity
    }

    private class FakeSseLoop(vararg results: SseControlResult) : SilentModeSseLoop {
        private val results = ArrayDeque(results.toList())
        var connects = 0

        override suspend fun connectAndRead(): SseControlResult {
            connects += 1
            return results.removeFirstOrNull() ?: SseControlResult.Disconnected
        }

        override fun stop() = Unit
    }
}
