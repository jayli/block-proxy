package com.blockproxy.android.service

import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.Build
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.os.PowerManager
import android.util.Log
import java.net.Socket
import java.util.concurrent.TimeUnit
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.blockproxy.android.cdn.CfIpDns
import com.blockproxy.android.cdn.CfIpPool
import com.blockproxy.android.cdn.CfIpRefreshWorker
import com.blockproxy.android.cdn.CfIpRuntimeRegistry
import com.blockproxy.android.cdn.CfIpSelector
import com.blockproxy.android.config.ConfigRepository
import com.blockproxy.android.config.DataStoreConfigDataSource
import com.blockproxy.android.config.DataStoreCredentialDataSource
import com.blockproxy.android.config.CredentialStore
import com.blockproxy.android.config.RoutingConfig
import com.blockproxy.android.config.RoutingConfigRepository
import com.blockproxy.android.config.DataStoreRoutingConfigDataSource
import com.blockproxy.android.config.ServerConfig
import com.blockproxy.android.config.TunnelCredentials
import com.blockproxy.android.routing.GeositeLoader
import com.blockproxy.android.routing.GeositeMatcher
import com.blockproxy.android.routing.RoutingEngine
import com.blockproxy.android.socks.DomainMappingStore
import com.blockproxy.android.socks.LocalSocksServer
import com.blockproxy.android.socks.ProtectedDirectConnector
import com.blockproxy.android.socks.TunnelForwardConnector
import com.blockproxy.android.status.StatusStore
import com.blockproxy.android.status.TunnelStatus
import com.blockproxy.android.tun.Tun2Socks
import com.blockproxy.android.tunnel.RealTargetSocketFactory
import com.blockproxy.android.tunnel.TunnelClient
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
 * This service captures all device traffic via a TUN interface, bridges it
 * through tun2socks (native C library) to a local SOCKS5 server, which then
 * routes each connection either directly or through the remote tunnel server.
 *
 * Traffic flow:
 * ```
 * Device traffic → VpnService TUN fd → tun2socks (native) → LocalSocksServer
 *                                                                  ↓
 *                                                        RoutingEngine
 *                                                       ↓ DIRECT   ↓ PROXY
 *                                                  protected Socket  ForwardSession
 *                                                       ↓              ↓
 *                                                   target host   tunnel server
 * ```
 *
 * Key design decisions:
 * - `START_STICKY` so the system restarts the service after OOM kills.
 * - `PARTIAL_WAKE_LOCK` prevents the CPU from entering deep sleep.
 * - The notification is shown immediately via `startForeground` to satisfy
 *   foreground-service requirements.
 * - `addDisallowedApplication(packageName)` prevents our own sockets from
 *   being captured by the VPN (routing loop prevention).
 * - `VpnService.protect()` is used as defense-in-depth for per-socket bypass.
 * - The TUN fd is transferred to the native tun2socks library via `detachFd()`.
 * - If configuration or credentials are missing the service enters
 *   [TunnelStatus.Error], releases resources, and calls `stopSelf()`.
 */
class BlockProxyVpnService : VpnService() {

    companion object {
        private const val TAG = "BlockProxyVpnService"

        /** Shared [StatusStore] singleton accessible from UI and service. */
        val statusStore = StatusStore()

        /** Intent action to stop the service from outside. */
        const val ACTION_STOP = TunnelNotification.ACTION_STOP

        private const val WAKELOCK_TAG = "block-proxy:tunnel"
        private const val STOP_TIMEOUT_MS = 5_000L

        /** Whether the service instance is currently alive. */
        @Volatile
        var isRunning: Boolean = false
            private set
    }

    private var serviceScope: CoroutineScope? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var vpnInterface: ParcelFileDescriptor? = null
    private var tunnelClient: TunnelClient? = null
    private var localSocksServer: LocalSocksServer? = null
    @Volatile
    private var cfIpPool: CfIpPool? = null

    @Volatile
    private var cfIpSelector: CfIpSelector? = null

    @Volatile
    private var uploadCfIpSelector: CfIpSelector? = null

    /** True when the TUN fd was detached and handed to tun2socks. */
    private var vpnFdDetached = false

    private lateinit var configRepository: ConfigRepository
    private lateinit var credentialStore: CredentialStore
    private lateinit var routingConfigRepository: RoutingConfigRepository

    // ── Lifecycle ─────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        TunnelNotification.createChannel(this)
        configRepository = ConfigRepository(DataStoreConfigDataSource(this))
        credentialStore = CredentialStore(DataStoreCredentialDataSource(this))
        routingConfigRepository = RoutingConfigRepository(DataStoreRoutingConfigDataSource(this))

        // Register periodic watchdog
        val request = PeriodicWorkRequestBuilder<TunnelWatchdogWorker>(
            15, TimeUnit.MINUTES
        ).build()
        WorkManager.getInstance(applicationContext).enqueueUniquePeriodicWork(
            TunnelWatchdogWorker.WORK_NAME,
            ExistingPeriodicWorkPolicy.KEEP,
            request
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "onStartCommand: action=${intent?.action}, flags=$flags, startId=$startId")

        // Guard against double-start while tunnel is already running
        if (intent?.action != ACTION_STOP && tunnelClient != null) {
            Log.w(TAG, "Tunnel already running, ignoring start command")
            return START_STICKY
        }

        // Handle stop action
        if (intent?.action == ACTION_STOP) {
            Log.i(TAG, "Received ACTION_STOP, stopping service")
            WorkManager.getInstance(applicationContext)
                .cancelUniqueWork(TunnelWatchdogWorker.WORK_NAME)

            // Immediately update status so UI reflects disconnected state
            statusStore.update(TunnelStatus.Disconnected)
            cfIpSelector?.let { CfIpRuntimeRegistry.detach(it) }
            cfIpPool = null
            cfIpSelector = null
            uploadCfIpSelector = null
            statusStore.updateCfIp(null)

            // Cancel the service scope to abort setupTunnel() coroutine
            serviceScope?.cancel()
            serviceScope = null

            // Stop tun2socks and SOCKS server
            Tun2Socks.stop()
            Tun2Socks.setProtectCallback(null)
            localSocksServer?.stop()
            localSocksServer = null

            // Stop tunnel client
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

            // Explicitly close VPN interface to tear down VPN immediately
            // (onDestroy may not be called synchronously by the system)
            if (vpnFdDetached) {
                // fd was handed to tun2socks, already closed by Tun2Socks.stop()
                vpnFdDetached = false
            } else {
                try {
                    vpnInterface?.close()
                } catch (_: Exception) { /* best effort */ }
            }
            vpnInterface = null

            // Remove foreground and stop service
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
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
        isRunning = false

        // Cancel the service scope
        serviceScope?.cancel()
        serviceScope = null

        // Stop tun2socks first — signals the native library to quit and
        // closes the TUN fd that was transferred via detachFd().
        Tun2Socks.stop()
        Tun2Socks.setProtectCallback(null)

        // Stop local SOCKS server
        localSocksServer?.stop()
        localSocksServer = null

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

        // Close VPN interface (only if fd was NOT detached to tun2socks).
        // When vpnFdDetached is true, the native library owns the fd and
        // closes it during tun2socks shutdown.
        if (!vpnFdDetached) {
            try {
                vpnInterface?.close()
            } catch (_: Exception) { /* best effort */ }
        }
        vpnInterface = null
        vpnFdDetached = false

        // Update status
        statusStore.update(TunnelStatus.Disconnected)
        cfIpSelector?.let { CfIpRuntimeRegistry.detach(it) }
        cfIpPool = null
        cfIpSelector = null
        uploadCfIpSelector = null
        statusStore.updateCfIp(null)

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

        // Load routing config and create routing components
        val routingConfig: RoutingConfig = try {
            routingConfigRepository.observe().first()
        } catch (_: Exception) {
            RoutingConfig()
        }
        val geositeData = GeositeLoader().load(applicationContext)
        val geositeMatcher = GeositeMatcher(geositeData)
        val routingEngine = RoutingEngine(routingConfig, geositeMatcher)
        val domainMappingStore = DomainMappingStore()

        // Create protect callback for direct connections and tunnel sockets.
        // Primary loop prevention is addDisallowedApplication() in the VPN builder;
        // protect() is defense-in-depth for per-socket bypass.
        val protectCallback: (Socket) -> Boolean = { socket ->
            val ok = protect(socket)
            Log.i(TAG, "VpnService.protect(${socket.hashCode()}) = $ok")
            ok
        }
        // Establish VPN interface with routes and DNS
        val vpnResult = establishVpnInterface()
        if (vpnResult == null) {
            // User denied VPN permission or establish() failed
            releaseWakeLock()
            statusStore.update(TunnelStatus.Error)
            updateNotification(TunnelStatus.Error)
            stopSelf()
            return
        }
        val pfd = vpnResult.descriptor
        vpnInterface = pfd

        val targetSocketFactory = RealTargetSocketFactory(protect = protectCallback)

        cfIpPool = if (config.cfCdnEnabled) CfIpPool(applicationContext) else null
        cfIpSelector = cfIpPool?.let { pool ->
            val snapshot = pool.loadSnapshot()
            CfIpSelector(snapshot) { cursor ->
                serviceScope?.launch { pool.saveCursor(cursor) }
            }
        }
        uploadCfIpSelector = cfIpPool?.let { pool ->
            CfIpSelector(pool.loadSnapshot()) { }
        }
        val sseCfIpDns = cfIpSelector?.let { selector ->
            CfIpDns(config.serverHost, selector, rotateOnLookup = true)
        }
        val uploadCfIpDns = uploadCfIpSelector?.let { selector ->
            CfIpDns(config.serverHost, selector, rotateOnLookup = true)
        }
        if (cfIpPool != null && cfIpSelector != null && uploadCfIpSelector != null) {
            CfIpRuntimeRegistry.attach(cfIpPool!!, listOf(cfIpSelector!!, uploadCfIpSelector!!), protectCallback)
            CfIpRefreshWorker.schedule(applicationContext, config.serverPort)
        } else {
            CfIpRefreshWorker.cancelSchedule(applicationContext)
            statusStore.updateCfIp(null)
        }

        // Create TunnelClient (needed by TunnelForwardConnector for LocalSocksServer)
        val scope = serviceScope ?: return
        val client = TunnelClient(
            config = config,
            credentials = credentials,
            targetSocketFactory = targetSocketFactory,
            clientScope = scope,
            protect = protectCallback,
            sseCfIpDns = sseCfIpDns,
            sseCfIpSelector = cfIpSelector,
            uploadCfIpDns = uploadCfIpDns,
            uploadCfIpSelector = uploadCfIpSelector,
            nativeUtlsUploadEnabled = vpnResult.appExclusionSucceeded,
            onCfIpChanged = statusStore::updateCfIp,
        )
        tunnelClient = client

        // Start local SOCKS5 server on loopback.
        // tun2socks will forward TUN traffic to this server, which applies
        // routing rules to decide DIRECT vs PROXY for each connection.
        val socksServer = LocalSocksServer(
            domainMappingStore = domainMappingStore,
            routingEngine = routingEngine,
            directConnector = ProtectedDirectConnector(protect = protectCallback),
            forwardConnector = TunnelForwardConnector(client),
            scope = scope,
        )
        val socksPort = try {
            socksServer.start()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start local SOCKS server", e)
            enterErrorAndStop("SOCKS 服务器启动失败")
            return
        }
        localSocksServer = socksServer
        Log.i(TAG, "Local SOCKS server listening on 127.0.0.1:$socksPort")

        // Start tun2socks — bridges TUN fd to local SOCKS5 server.
        // The TUN fd ownership is transferred to the native library via detachFd().
        Tun2Socks.setProtectCallback(this)
        val tunStarted = Tun2Socks.start(pfd, "127.0.0.1", socksPort)
        if (!tunStarted) {
            Log.e(TAG, "Failed to start tun2socks")
            socksServer.stop()
            localSocksServer = null
            enterErrorAndStop("tun2socks 启动失败")
            return
        }
        vpnFdDetached = true  // fd ownership transferred to native code
        Log.i(TAG, "tun2socks bridging TUN → 127.0.0.1:$socksPort")

        // Observe client status and update notification
        scope.launch {
            client.status.collect { status ->
                statusStore.update(status)
                updateNotification(status)
            }
        }

        // Start the tunnel client (establishes TLS connections to remote server)
        statusStore.update(TunnelStatus.Connecting)
        updateNotification(TunnelStatus.Connecting)
        client.start()
    }

    /**
     * Establishes the VPN interface with routes and DNS configuration.
     *
     * The TUN interface captures all IPv4 (and optionally IPv6) traffic from
     * the device. tun2socks will process these raw IP packets and convert
     * them into SOCKS5 connections to the local server.
     *
     * `addDisallowedApplication` prevents our own app's traffic from being
     * captured by the VPN, avoiding routing loops (tunnel TLS connections
     * and local SOCKS connections bypass the TUN at the kernel level).
     *
     * Returns null if the user denied VPN permission or establish() failed.
     */
    private data class VpnInterfaceResult(
        val descriptor: ParcelFileDescriptor,
        val appExclusionSucceeded: Boolean,
    )

    private fun establishVpnInterface(): VpnInterfaceResult? {
        return try {
            val builder = Builder()
                .addAddress("10.255.0.2", 32)
                .addRoute("0.0.0.0", 0)           // Capture all IPv4 traffic
                // DNS queries use system default (not via VPN) since tun2socks
                // only handles TCP and UDP DNS would be dropped
                .setSession("BlockProxy")
                .setMtu(1500)

            // IPv6 support — tun2socks handles IPv6 packets via lwip
            try {
                builder.addAddress("fd00::1", 128)
                builder.addRoute("::", 0)
            } catch (e: Exception) {
                Log.w(TAG, "IPv6 routes not supported on this device", e)
            }

            // Exclude our app from VPN to prevent routing loops.
            // This ensures tunnel TLS connections and SOCKS server connections
            // bypass the TUN interface at the kernel level.
            val appExclusionSucceeded = try {
                builder.addDisallowedApplication(packageName)
                true
            } catch (e: Exception) {
                Log.e(TAG, "addDisallowedApplication failed; relying on per-socket protect()", e)
                false
            }

            builder.establish()?.let { descriptor ->
                VpnInterfaceResult(descriptor, appExclusionSucceeded)
            }
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
