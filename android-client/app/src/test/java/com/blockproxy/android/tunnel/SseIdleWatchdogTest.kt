package com.blockproxy.android.tunnel

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SseIdleWatchdogTest {
    @Test
    fun `watchdog fires after configured idle timeout`() = runTest {
        var timeouts = 0
        val watchdog = SseIdleWatchdog(
            scope = this,
            timeoutMs = 90_000L,
            onTimeout = { timeouts++ },
        )

        watchdog.start()

        advanceTimeBy(89_999L)
        runCurrent()
        assertEquals(0, timeouts)

        advanceTimeBy(1L)
        runCurrent()
        assertEquals(1, timeouts)
    }

    @Test
    fun `activity resets idle timeout`() = runTest {
        var timeouts = 0
        val watchdog = SseIdleWatchdog(
            scope = this,
            timeoutMs = 90_000L,
            onTimeout = { timeouts++ },
        )

        watchdog.start()
        advanceTimeBy(60_000L)
        watchdog.markActivity()
        advanceTimeBy(60_000L)
        runCurrent()
        assertEquals(0, timeouts)

        advanceTimeBy(30_000L)
        runCurrent()
        assertEquals(1, timeouts)
    }
}
