package com.blockproxy.android.tun

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Unit tests for Tun2Socks Kotlin wrapper logic and TunnelStats data class.
 *
 * Note: These tests verify the pure-Kotlin logic (state management, data classes,
 * guard conditions). The actual JNI native calls cannot be tested in a JVM unit
 * test environment because the native library (libtun2socks.so) is an Android
 * NDK binary that requires the Android runtime.
 *
 * JNI integration tests belong in androidTest/ and require a device/emulator
 * with the native library loaded.
 */
class Tun2SocksTest {

    // ── TunnelStats data class ──────────────────────────────────────────

    @Test
    fun tunnelStats_correctValues() {
        val stats = TunnelStats(
            txPackets = 100,
            txBytes = 50_000,
            rxPackets = 200,
            rxBytes = 100_000,
        )

        assertEquals(100L, stats.txPackets)
        assertEquals(50_000L, stats.txBytes)
        assertEquals(200L, stats.rxPackets)
        assertEquals(100_000L, stats.rxBytes)
    }

    @Test
    fun tunnelStats_equality() {
        val stats1 = TunnelStats(1, 2, 3, 4)
        val stats2 = TunnelStats(1, 2, 3, 4)
        val stats3 = TunnelStats(5, 6, 7, 8)

        assertEquals(stats1, stats2)
        assertNotEquals(stats1, stats3)
    }

    @Test
    fun tunnelStats_copy() {
        val original = TunnelStats(10, 20, 30, 40)
        val copy = original.copy(txBytes = 99)

        assertEquals(10L, copy.txPackets)
        assertEquals(99L, copy.txBytes)
        assertEquals(30L, copy.rxPackets)
        assertEquals(40L, copy.rxBytes)
    }

    @Test
    fun tunnelStats_toString() {
        val stats = TunnelStats(1, 2, 3, 4)
        val str = stats.toString()

        // data class toString includes all properties
        assertTrue(str.contains("txPackets=1"))
        assertTrue(str.contains("txBytes=2"))
        assertTrue(str.contains("rxPackets=3"))
        assertTrue(str.contains("rxBytes=4"))
    }

    @Test
    fun tunnelStats_zeroValues() {
        val stats = TunnelStats(0, 0, 0, 0)

        assertEquals(0L, stats.txPackets)
        assertEquals(0L, stats.txBytes)
        assertEquals(0L, stats.rxPackets)
        assertEquals(0L, stats.rxBytes)
    }

    @Test
    fun tunnelStats_largeValues() {
        // Verify Long range (not Int) for byte counters
        val stats = TunnelStats(
            txPackets = Long.MAX_VALUE,
            txBytes = 1_000_000_000_000L,  // 1 TB
            rxPackets = 42,
            rxBytes = 999_999_999_999L,
        )

        assertEquals(Long.MAX_VALUE, stats.txPackets)
        assertEquals(1_000_000_000_000L, stats.txBytes)
        assertEquals(999_999_999_999L, stats.rxBytes)
    }

    // ── Tun2Socks state management ──────────────────────────────────────

    @Test
    fun isRunning_falseByDefault() {
        // Tun2Socks is a singleton; isRunning should be false unless
        // start() was called successfully (which requires native lib).
        // In JVM test, native lib is not loaded, so isRunning stays false.
        // Note: if a previous test called start() (which would fail in JVM),
        // the state might be unexpected. This test documents the expected
        // initial state.
        assertFalse(Tun2Socks.isRunning)
    }

    @Test
    fun getStats_returnsNullWhenNotRunning() {
        // getStats() should return null when the tunnel is not running
        assertNull(Tun2Socks.getStats())
    }

    @Test
    fun stop_safeWhenNotRunning() {
        // stop() should be a no-op when the tunnel is not running.
        // Must not throw or change state.
        Tun2Socks.stop()
        assertFalse(Tun2Socks.isRunning)
    }
}
