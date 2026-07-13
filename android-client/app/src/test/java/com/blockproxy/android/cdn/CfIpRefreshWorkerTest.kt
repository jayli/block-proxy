package com.blockproxy.android.cdn

import androidx.work.NetworkType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar

class CfIpRefreshWorkerTest {

    @Test
    fun `one-time request includes server port and connected network constraint`() {
        val request = CfIpRefreshWorker.createOneTimeRequest(serverPort = 8443)

        assertEquals(8443, request.workSpec.input.getInt(CfIpRefreshWorker.KEY_SERVER_PORT, -1))
        assertEquals(NetworkType.CONNECTED, request.workSpec.constraints.requiredNetworkType)
    }

    @Test
    fun `periodic request includes server port and connected network constraint`() {
        val request = CfIpRefreshWorker.createPeriodicRequest(serverPort = 443, initialDelayMs = 1_000L)

        assertEquals(443, request.workSpec.input.getInt(CfIpRefreshWorker.KEY_SERVER_PORT, -1))
        assertEquals(NetworkType.CONNECTED, request.workSpec.constraints.requiredNetworkType)
        assertEquals(1_000L, request.workSpec.initialDelay)
    }

    @Test
    fun `calculateDelayToNext4Am returns delay later same day before 4am`() {
        val now = Calendar.getInstance().apply {
            set(2026, Calendar.JULY, 13, 3, 30, 0)
            set(Calendar.MILLISECOND, 0)
        }

        assertEquals(30 * 60 * 1000L, CfIpRefreshWorker.calculateDelayToNext4Am(now.timeInMillis))
    }

    @Test
    fun `calculateDelayToNext4Am returns next day after 4am`() {
        val now = Calendar.getInstance().apply {
            set(2026, Calendar.JULY, 13, 4, 30, 0)
            set(Calendar.MILLISECOND, 0)
        }

        val delay = CfIpRefreshWorker.calculateDelayToNext4Am(now.timeInMillis)

        assertTrue(delay > 0)
        assertEquals((23L * 60 + 30) * 60 * 1000L, delay)
    }
}
