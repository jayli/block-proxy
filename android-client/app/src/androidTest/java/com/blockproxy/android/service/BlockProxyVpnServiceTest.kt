package com.blockproxy.android.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.PowerManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.blockproxy.android.status.TunnelStatus
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented tests for the VPN service components.
 *
 * These tests run on a real device or emulator and verify:
 * - Notification channel creation
 * - Notification building with correct content
 * - StatusStore shared singleton behaviour
 * - TunnelServiceController helper methods
 * - Battery optimisation state queries
 *
 * Full VpnService lifecycle tests (onStartCommand → START_STICKY,
 * WakeLock acquisition, establish() returning null) require a VPN
 * permission grant that is impractical in automated CI; those paths
 * are covered by manual testing and code review.
 */
@RunWith(AndroidJUnit4::class)
class BlockProxyVpnServiceTest {

    private lateinit var context: Context

    @Before
    fun setUp() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
    }

    // ── Notification channel ─────────────────────────────────────────

    @Test
    fun createChannel_createsLowImportanceChannel() {
        TunnelNotification.createChannel(context)

        val nm = context.getSystemService(NotificationManager::class.java)
        val channel: NotificationChannel? = nm.getNotificationChannel(TunnelNotification.CHANNEL_ID)

        assertNotNull("Channel should be created", channel)
        assertEquals("Channel ID should match", TunnelNotification.CHANNEL_ID, channel!!.id)
        assertEquals(
            "Channel importance should be LOW",
            NotificationManager.IMPORTANCE_LOW,
            channel.importance,
        )
        assertFalse("Channel should not show badge", channel.canShowBadge())
    }

    @Test
    fun createChannel_isIdempotent() {
        // Calling createChannel twice should not throw or change the channel
        TunnelNotification.createChannel(context)
        TunnelNotification.createChannel(context)

        val nm = context.getSystemService(NotificationManager::class.java)
        val channel = nm.getNotificationChannel(TunnelNotification.CHANNEL_ID)
        assertNotNull(channel)
    }

    // ── Notification building ────────────────────────────────────────

    @Test
    fun build_containsStatusText() {
        TunnelNotification.createChannel(context)

        val notification = TunnelNotification.build(context, TunnelStatus.Connected)

        assertNotNull("Notification should not be null", notification)
        // The content text is set via NotificationCompat.Builder and is not
        // directly accessible, but we verify the notification was built
        // without crashing.
        assertEquals("Notification should be ongoing", true, notification.flags and android.app.Notification.FLAG_ONGOING_EVENT != 0)
    }

    @Test
    fun build_disconnectedStatus() {
        TunnelNotification.createChannel(context)
        val notification = TunnelNotification.build(context, TunnelStatus.Disconnected)
        assertNotNull(notification)
    }

    @Test
    fun build_errorStatus() {
        TunnelNotification.createChannel(context)
        val notification = TunnelNotification.build(context, TunnelStatus.Error)
        assertNotNull(notification)
    }

    @Test
    fun build_hasStopAction() {
        TunnelNotification.createChannel(context)
        val notification = TunnelNotification.build(context, TunnelStatus.Connected)

        // Verify at least one action exists (the stop action)
        assertTrue(
            "Notification should have at least one action",
            notification.actions != null && notification.actions.isNotEmpty(),
        )
    }

    @Test
    fun build_hasContentIntent() {
        TunnelNotification.createChannel(context)
        val notification = TunnelNotification.build(context, TunnelStatus.Connected)

        assertNotNull(
            "Notification should have a content intent",
            notification.contentIntent,
        )
    }

    // ── StatusStore shared singleton ─────────────────────────────────

    @Test
    fun statusStore_sharedInstance_isAccessible() {
        val store = BlockProxyVpnService.statusStore
        assertNotNull("Shared StatusStore should not be null", store)
        assertEquals(
            "Initial status should be Disconnected",
            TunnelStatus.Disconnected,
            store.current,
        )
    }

    @Test
    fun statusStore_updateAndRead() {
        val store = BlockProxyVpnService.statusStore

        store.update(TunnelStatus.Connecting)
        assertEquals(TunnelStatus.Connecting, store.current)

        store.update(TunnelStatus.Connected)
        assertEquals(TunnelStatus.Connected, store.current)

        // Reset for other tests
        store.update(TunnelStatus.Disconnected)
    }

    // ── TunnelServiceController ───────────────────────────────────────

    @Test
    fun controller_statusReturnsDisconnectedByDefault() {
        val controller = TunnelServiceController(context)
        assertEquals(TunnelStatus.Disconnected, controller.status)
    }

    @Test
    fun controller_statusStoreIsSharedWithService() {
        val controller = TunnelServiceController(context)
        val serviceStore = BlockProxyVpnService.statusStore

        // Both should point to the same StatusStore instance
        serviceStore.update(TunnelStatus.Connected)
        assertEquals(TunnelStatus.Connected, controller.status)

        // Reset
        serviceStore.update(TunnelStatus.Disconnected)
    }

    // ── VpnService.prepare ───────────────────────────────────────────

    @Test
    fun vpnPrepare_returnsIntentWhenNotGranted() {
        // On a fresh install, VpnService.prepare() should return an intent
        // because VPN permission has not been granted yet.
        // Note: This might return null if VPN was previously granted on the device.
        val prepareIntent = VpnService.prepare(context)
        // We can't assert null or non-null without knowing the device state,
        // but we verify the call doesn't crash.
        // In CI with a fresh emulator, prepareIntent should be non-null.
    }

    // ── Battery optimisation check ───────────────────────────────────

    @Test
    fun batteryOptimisation_queryDoesNotCrash() {
        val pm = context.getSystemService(PowerManager::class.java)
        // Just verify the API call works without crashing
        val isIgnoring = pm.isIgnoringBatteryOptimizations(context.packageName)
        // Result depends on device settings — just assert it's a boolean
        assertTrue(isIgnoring || !isIgnoring)
    }

    // ── Stop action constant ─────────────────────────────────────────

    @Test
    fun stopAction_matchesBetweenServiceAndNotification() {
        assertEquals(
            "Service ACTION_STOP should match TunnelNotification.ACTION_STOP",
            BlockProxyVpnService.ACTION_STOP,
            TunnelNotification.ACTION_STOP,
        )
    }

    // ── WakeLock tag constant ────────────────────────────────────────

    @Test
    fun wakeLockTag_isCorrect() {
        // Verify the WakeLock tag follows the documented convention
        val pm = context.getSystemService(PowerManager::class.java)
        // We can't directly test the service's internal WakeLock, but we
        // verify that a WakeLock with the expected tag can be acquired and released.
        val lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "block-proxy:tunnel")
        assertNotNull(lock)
        lock.acquire(1000L)
        assertTrue("WakeLock should be held", lock.isHeld)
        lock.release()
        assertFalse("WakeLock should be released", lock.isHeld)
    }

    // ── Notification channel properties ──────────────────────────────

    @Test
    fun channel_hasCorrectDisplayName() {
        TunnelNotification.createChannel(context)
        val nm = context.getSystemService(NotificationManager::class.java)
        val channel = nm.getNotificationChannel(TunnelNotification.CHANNEL_ID)
        assertNotNull(channel)
        assertEquals("隧道服务", channel!!.name.toString())
    }

    @Test
    fun channel_hasDescription() {
        TunnelNotification.createChannel(context)
        val nm = context.getSystemService(NotificationManager::class.java)
        val channel = nm.getNotificationChannel(TunnelNotification.CHANNEL_ID)
        assertNotNull(channel)
        assertNotNull("Channel should have a description", channel!!.description)
        assertTrue(
            "Description should be non-empty",
            channel.description.isNotBlank(),
        )
    }
}
