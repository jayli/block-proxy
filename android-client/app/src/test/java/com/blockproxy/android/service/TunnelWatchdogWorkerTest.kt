package com.blockproxy.android.service

import com.blockproxy.android.status.TunnelStatus
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the [TunnelWatchdogWorker.shouldRestart] decision logic.
 *
 * The [shouldRestart] companion method is a pure function that determines
 * whether the watchdog should restart the VPN service. It takes three boolean/status
 * inputs and returns true only when all conditions are met:
 * 1. A server config is persisted
 * 2. The last status was Connected or Reconnecting
 * 3. The service is not currently running
 */
class TunnelWatchdogWorkerTest {

    // ── Test: Worker returns success (decision logic tests) ──────────────

    @Test
    fun `shouldRestart returns true when config exists, status is Connected, and service not running`() {
        assertTrue(
            TunnelWatchdogWorker.shouldRestart(
                hasConfig = true,
                lastStatus = TunnelStatus.Connected,
                isServiceRunning = false,
            )
        )
    }

    @Test
    fun `shouldRestart returns true when config exists, status is Reconnecting, and service not running`() {
        assertTrue(
            TunnelWatchdogWorker.shouldRestart(
                hasConfig = true,
                lastStatus = TunnelStatus.Reconnecting,
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
                lastStatus = TunnelStatus.Connected,
                isServiceRunning = false,
            )
        )
    }

    @Test
    fun `shouldRestart returns false when no config and status is Reconnecting`() {
        assertFalse(
            TunnelWatchdogWorker.shouldRestart(
                hasConfig = false,
                lastStatus = TunnelStatus.Reconnecting,
                isServiceRunning = false,
            )
        )
    }

    // ── Test: Status is Disconnected → do NOT start service ──────────────

    @Test
    fun `shouldRestart returns false when status is Disconnected`() {
        assertFalse(
            TunnelWatchdogWorker.shouldRestart(
                hasConfig = true,
                lastStatus = TunnelStatus.Disconnected,
                isServiceRunning = false,
            )
        )
    }

    // ── Test: Status is AuthFailed → do NOT start service ────────────────

    @Test
    fun `shouldRestart returns false when status is AuthFailed`() {
        assertFalse(
            TunnelWatchdogWorker.shouldRestart(
                hasConfig = true,
                lastStatus = TunnelStatus.AuthFailed,
                isServiceRunning = false,
            )
        )
    }

    // ── Test: Service already running → do nothing ───────────────────────

    @Test
    fun `shouldRestart returns false when service is already running with Connected status`() {
        assertFalse(
            TunnelWatchdogWorker.shouldRestart(
                hasConfig = true,
                lastStatus = TunnelStatus.Connected,
                isServiceRunning = true,
            )
        )
    }

    @Test
    fun `shouldRestart returns false when service is already running with Reconnecting status`() {
        assertFalse(
            TunnelWatchdogWorker.shouldRestart(
                hasConfig = true,
                lastStatus = TunnelStatus.Reconnecting,
                isServiceRunning = true,
            )
        )
    }

    // ── Test: Other statuses → do NOT start service ──────────────────────

    @Test
    fun `shouldRestart returns false when status is Preparing`() {
        assertFalse(
            TunnelWatchdogWorker.shouldRestart(
                hasConfig = true,
                lastStatus = TunnelStatus.Preparing,
                isServiceRunning = false,
            )
        )
    }

    @Test
    fun `shouldRestart returns false when status is Connecting`() {
        assertFalse(
            TunnelWatchdogWorker.shouldRestart(
                hasConfig = true,
                lastStatus = TunnelStatus.Connecting,
                isServiceRunning = false,
            )
        )
    }

    @Test
    fun `shouldRestart returns false when status is Occupied`() {
        assertFalse(
            TunnelWatchdogWorker.shouldRestart(
                hasConfig = true,
                lastStatus = TunnelStatus.Occupied,
                isServiceRunning = false,
            )
        )
    }

    @Test
    fun `shouldRestart returns false when status is Error`() {
        assertFalse(
            TunnelWatchdogWorker.shouldRestart(
                hasConfig = true,
                lastStatus = TunnelStatus.Error,
                isServiceRunning = false,
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
                lastStatus = TunnelStatus.Error,
                isServiceRunning = true,
            )
        )
    }

    @Test
    fun `shouldRestart returns false when no config even if service not running`() {
        assertFalse(
            TunnelWatchdogWorker.shouldRestart(
                hasConfig = false,
                lastStatus = TunnelStatus.Disconnected,
                isServiceRunning = false,
            )
        )
    }
}
