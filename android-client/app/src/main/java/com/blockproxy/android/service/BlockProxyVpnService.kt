package com.blockproxy.android.service

import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.Build
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.os.PowerManager
import java.net.Socket
import com.blockproxy.android.config.ConfigRepository
import com.blockproxy.android.config.DataStoreConfigDataSource
import com.blockproxy.android.config.DataStoreCredentialDataSource
import com.blockproxy.android.config.CredentialStore
import com.blockproxy.android.config.ServerConfig
import com.blockproxy.android.config.TunnelCredentials
import com.blockproxy.android.status.StatusStore
import com.blockproxy.android.status.TunnelStatus
import com.blockproxy.android.tunnel.RealTargetSocketFactory
import com.blockproxy.android.tunnel.RealTunnelSocket
import com.blockproxy.android.tunnel.TunnelClient
import com.blockproxy.android.tunnel.TunnelSocket
import com.blockproxy.android.tunnel.TunnelSocketFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Android VpnService that maintains the tunnel connection lifecycle.
 *
 * The VPN interface is established only to signal to the system that a VPN
 * is active — it does **not** route traffic through the TUN interface.
 * All actual proxy traffic flows through the [TunnelClient]'s TLS connections.
 *
 * Key design decisions:
 * - `START_STICKY` so the system restarts the service after OOM kills.
 * - `PARTIAL_WAKE_LOCK` prevents the CPU from entering deep sleep.
 * - The notification is shown immediately via `startForeground` to satisfy
 *   foreground-service requirements.
 * - If configuration or credentials are missing the service enters
 *   [TunnelStatus.Error], releases resources, and calls `stopSelf()`.
 * - If `VpnService.Builder.establish()` returns null (user denied VPN
 *   permission), the service enters [TunnelStatus.Disconnected] and stops.
 */
class BlockProxyVpnService : VpnService() {

    companion object {
        /** Shared [StatusStore] singleton accessible from UI and service. */
        val statusStore = StatusStore()

        /** Intent action to stop the service from outside. */
        const val ACTION_STOP = TunnelNotification.ACTION_STOP

        private const val WAKELOCK_TAG = "block-proxy:tunnel"
        private const val STOP_TIMEOUT_MS = 5_000L
    }

    private var serviceScope: CoroutineScope? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var vpnInterface: ParcelFileDescriptor? = null
    private var tunnelClient: TunnelClient? = null

    private lateinit var configRepository: ConfigRepository
    private lateinit var credentialStore: CredentialStore

    // ── Lifecycle ─────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        TunnelNotification.createChannel(this)
        configRepository = ConfigRepository(DataStoreConfigDataSource(this))
        credentialStore = CredentialStore(DataStoreCredentialDataSource(this))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Handle stop action
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        // Immediately show foreground notification
        val initialNotification = TunnelNotification.build(this, TunnelStatus.Preparing)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                TunnelNotification.NOTIFICATION_ID,
                initialNotification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
            )
        } else {
            startForeground(TunnelNotification.NOTIFICATION_ID, initialNotification)
        }

        // Acquire WakeLock
        val pm = getSystemService(PowerManager::class.java)
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG).apply {
            acquire(24 * 60 * 60 * 1000L) // 24h safety cap
        }

        // Create coroutine scope
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        serviceScope = scope

        // Launch the tunnel setup in the service scope
        scope.launch {
            setupTunnel()
        }

        return START_STICKY
    }

    override fun onDestroy() {
        // Cancel the service scope
        serviceScope?.cancel()
        serviceScope = null

        // Stop tunnel client with timeout
        val client = tunnelClient
        if (client != null) {
            runBlocking {
                withTimeoutOrNull(STOP_TIMEOUT_MS) {
                    client.stop()
                }
            }
            tunnelClient = null
        }

        // Release WakeLock
        try {
            wakeLock?.let {
                if (it.isHeld) it.release()
            }
        } catch (_: Exception) { /* best effort */ }
        wakeLock = null

        // Close VPN interface
        try {
            vpnInterface?.close()
        } catch (_: Exception) { /* best effort */ }
        vpnInterface = null

        // Update status
        statusStore.update(TunnelStatus.Disconnected)

        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ── Tunnel setup ──────────────────────────────────────────────────

    private suspend fun setupTunnel() {
        statusStore.update(TunnelStatus.Preparing)

        // Load config
        val config: ServerConfig? = try {
            configRepository.observe().first()
        } catch (_: Exception) {
            null
        }

        if (config == null) {
            enterErrorAndStop("缺少服务器配置")
            return
        }

        // Load credentials
        val credentials: TunnelCredentials? = try {
            credentialStore.observe().first()
        } catch (_: Exception) {
            null
        }

        if (credentials == null) {
            enterErrorAndStop("缺少认证凭据")
            return
        }

        // Establish minimal VPN interface
        val pfd = establishVpnInterface()
        if (pfd == null) {
            // User denied VPN permission or establish() failed
            releaseWakeLock()
            statusStore.update(TunnelStatus.Error)
            updateNotification(TunnelStatus.Error)
            stopSelf()
            return
        }
        vpnInterface = pfd

        // Create socket factories with VPN protect
        val protectCallback: (Socket) -> Unit = { socket -> protect(socket) }

        val tunnelSocketFactory = object : TunnelSocketFactory {
            override fun create(): TunnelSocket {
                return RealTunnelSocket(
                    useTls = config.useTls,
                    allowInsecure = config.allowInsecure,
                    protect = protectCallback,
                )
            }
        }

        val targetSocketFactory = RealTargetSocketFactory(protect = protectCallback)

        // Create and start TunnelClient
        val scope = serviceScope ?: return
        val client = TunnelClient(
            config = config,
            credentials = credentials,
            socketFactory = tunnelSocketFactory,
            targetSocketFactory = targetSocketFactory,
            clientScope = scope,
        )
        tunnelClient = client

        // Observe client status and update notification
        scope.launch {
            client.status.collect { status ->
                statusStore.update(status)
                updateNotification(status)
            }
        }

        // Start the tunnel
        statusStore.update(TunnelStatus.Connecting)
        updateNotification(TunnelStatus.Connecting)
        client.start()
    }

    /**
     * Establishes a minimal VPN interface.
     * Returns null if the user denied VPN permission or the system refused.
     */
    private fun establishVpnInterface(): ParcelFileDescriptor? {
        return try {
            Builder()
                .addAddress("10.255.0.2", 32)
                .setSession("BlockProxy")
                .setMtu(1500)
                .establish()
        } catch (_: Exception) {
            null
        }
    }

    private fun enterErrorAndStop(reason: String) {
        statusStore.update(TunnelStatus.Error)
        updateNotification(TunnelStatus.Error)
        releaseWakeLock()
        stopSelf()
    }

    private fun releaseWakeLock() {
        try {
            wakeLock?.let {
                if (it.isHeld) it.release()
            }
        } catch (_: Exception) { /* best effort */ }
        wakeLock = null
    }

    private fun updateNotification(status: TunnelStatus) {
        try {
            val notification = TunnelNotification.build(this, status)
            val nm = getSystemService(android.app.NotificationManager::class.java)
            nm.notify(TunnelNotification.NOTIFICATION_ID, notification)
        } catch (_: Exception) { /* best effort */ }
    }
}
