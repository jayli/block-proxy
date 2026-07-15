package com.blockproxy.android.service

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TunnelStartupDelayTest {
    @Test
    fun `waitForVpnNetworkSettle waits default startup delay`() = runTest {
        val delays = mutableListOf<Long>()

        TunnelStartupDelay.waitForVpnNetworkSettle { millis ->
            delays += millis
        }

        assertEquals(listOf(TunnelStartupDelay.DEFAULT_DELAY_MS), delays)
        assertTrue(TunnelStartupDelay.DEFAULT_DELAY_MS >= 300L)
    }
}
