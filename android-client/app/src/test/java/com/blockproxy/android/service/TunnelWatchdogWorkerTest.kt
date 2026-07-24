package com.blockproxy.android.service

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the [TunnelWatchdogWorker.shouldRestart] decision logic.
 *
 * The [shouldRestart] companion method is a pure function that determines
 * whether the watchdog should restart the VPN service. It returns true only
 * when all conditions are met:
 * 1. A server config is persisted
 * 2. The user persisted the tunnel as enabled
 * 3. The service is not currently running
 */
class TunnelWatchdogWorkerTest {

    // ── Test: Worker returns success (decision logic tests) ──────────────

    @Test
    fun `shouldRestart returns true when config exists, tunnel is enabled, and service not running`() {
        assertTrue(
            TunnelWatchdogWorker.shouldRestart(
                hasConfig = true,
                tunnelEnabled = true,
                isServiceRunning = false,
            )
        )
    }

    // ── Test: No config saved → do NOT start service ─────────────────────

    @Test
    fun `shouldRestart returns false when no config exists regardless of status`() {
        assertFalse(
            TunnelWatchdogWorker.shouldRestart(
                hasConfig = false,
                tunnelEnabled = true,
                isServiceRunning = false,
            )
        )
    }

    // ── Test: Persisted tunnel disabled → do NOT start service ───────────

    @Test
    fun `shouldRestart returns false when tunnel is disabled`() {
        assertFalse(
            TunnelWatchdogWorker.shouldRestart(
                hasConfig = true,
                tunnelEnabled = false,
                isServiceRunning = false,
            )
        )
    }

    // ── Test: Service already running → do nothing ───────────────────────

    @Test
    fun `shouldRestart returns false when service is already running`() {
        assertFalse(
            TunnelWatchdogWorker.shouldRestart(
                hasConfig = true,
                tunnelEnabled = true,
                isServiceRunning = true,
            )
        )
    }

    // ── Test: Edge cases ─────────────────────────────────────────────────

    @Test
    fun `shouldRestart returns false when all conditions are bad`() {
        // No config, bad status, service running
        assertFalse(
            TunnelWatchdogWorker.shouldRestart(
                hasConfig = false,
                tunnelEnabled = false,
                isServiceRunning = true,
            )
        )
    }

    @Test
    fun `shouldRestart returns false when no config even if service not running`() {
        assertFalse(
            TunnelWatchdogWorker.shouldRestart(
                hasConfig = false,
                tunnelEnabled = true,
                isServiceRunning = false,
            )
        )
    }
}
