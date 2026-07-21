package com.blockproxy.android.tun

import android.os.ParcelFileDescriptor
import android.util.Log

/**
 * JNI wrapper for the hev-socks5-tunnel native library.
 *
 * This class bridges the Android VPN TUN interface to the local SOCKS5 proxy
 * server via the hev-socks5-tunnel C library. The native library parses raw
 * IP packets from the TUN fd, implements a userspace TCP/IP stack (lwip),
 * and converts each TCP/UDP connection into a SOCKS5 CONNECT request.
 *
 * Architecture:
 * ```
 * Device traffic → VpnService TUN fd → tun2socks (native) → 127.0.0.1:socksPort
 *                                                                  ↓
 *                                                          LocalSocksServer
 *                                                                  ↓
 *                                                        RoutingEngine decision
 *                                                         ↓ DIRECT    ↓ PROXY
 *                                                   protected Socket  ForwardSession
 *                                                         ↓              ↓
 *                                                     target host   tunnel server
 * ```
 *
 * Lifecycle:
 * 1. [start] is called after the VPN interface is established and the local
 *    SOCKS server is listening. It transfers TUN fd ownership to the native
 *    library via [ParcelFileDescriptor.detachFd].
 * 2. The JNI bridge spawns a single native pthread that runs the tunnel.
 *    Inside that thread, hev-socks5-tunnel uses cooperative multitasking
 *    (hev-task-system) with lwIP's userspace TCP/IP stack — no additional
 *    OS threads are created. [start] returns immediately.
 * 3. [stop] calls `hev_socks5_tunnel_quit()` which sets a quit flag. The
 *    native thread's event loop exits asynchronously. The TUN fd is closed
 *    by the native library during shutdown.
 *
 * Thread safety:
 * - [start] and [stop] are safe to call from any thread.
 * - [isRunning] is volatile for cross-thread visibility.
 * - Double-start and double-stop are no-ops (idempotent).
 *
 * Socket protection:
 * The primary mechanism for preventing VPN routing loops is
 * `VpnService.Builder.addDisallowedApplication(packageName)`, which excludes
 * all of our app's sockets from the VPN at the kernel level.
 *
 * An additional defense-in-depth mechanism is available via [setProtectCallback],
 * which allows the native library to call `VpnService.protect()` on individual
 * sockets. This requires a patched version of hev-socks5-tunnel that supports
 * a protect callback hook.
 *
 * Native library: libtun2socks.so (JNI bridge) + libhev-socks5-tunnel.so (tunnel engine)
 */
object Tun2Socks {

    private const val TAG = "Tun2Socks"

    /** Whether the native tunnel is currently running. */
    @Volatile
    var isRunning: Boolean = false
        private set

    init {
        try {
            System.loadLibrary("tun2socks")
        } catch (e: UnsatisfiedLinkError) {
            // Native library not available (e.g., JVM unit test environment).
            // On a real Android device, the .so files in jniLibs are always available.
            try { Log.e(TAG, "Failed to load native library", e) } catch (_: Throwable) {}
        }
    }

    /**
     * Starts the tun2socks bridge.
     *
     * The [ParcelFileDescriptor]'s native fd is detached (ownership transferred
     * to the native library). After this call, the PFD should not be closed
     * by the caller — the native library will close the fd when [stop] is called.
     *
     * @param pfd        TUN interface from VpnService.Builder.establish()
     * @param socksHost  Local SOCKS5 server address (typically "127.0.0.1")
     * @param socksPort  Local SOCKS5 server port
     * @return true if the tunnel started successfully
     */
    fun start(pfd: ParcelFileDescriptor, socksHost: String, socksPort: Int): Boolean {
        if (isRunning) {
            Log.w(TAG, "start() called but tunnel is already running")
            return false
        }

        val fd = pfd.detachFd()
        Log.i(TAG, "Starting tun2socks: fd=$fd, socks=$socksHost:$socksPort")

        val ret = nativeStart(
            fd,
            socksHost,
            socksPort,
            Tun2SocksMapDnsConfig.dnsAddress,
            Tun2SocksMapDnsConfig.dnsPort,
            Tun2SocksMapDnsConfig.fakeNetwork,
            Tun2SocksMapDnsConfig.fakeNetmask,
            Tun2SocksMapDnsConfig.cacheSize,
        )
        if (ret == 0) {
            isRunning = true
            Log.i(TAG, "tun2socks started successfully")
            return true
        }

        Log.e(TAG, "nativeStart failed with code $ret")
        return false
    }

    /**
     * Stops the tun2socks bridge.
     *
     * Signals the native library to quit. The internal threads exit
     * asynchronously. Safe to call even if the tunnel is not running.
     */
    fun stop() {
        if (!isRunning) return

        Log.i(TAG, "Stopping tun2socks")
        nativeStop()
        isRunning = false
        Log.i(TAG, "tun2socks stopped")
    }

    /**
     * Returns current traffic statistics for the tunnel.
     *
     * @return [TunnelStats] with TX/RX packet and byte counts, or null if the
     *         tunnel is not running.
     */
    fun getStats(): TunnelStats? {
        if (!isRunning) return null

        val stats = nativeStats() ?: return null
        if (stats.size != 4) return null

        return TunnelStats(
            txPackets = stats[0],
            txBytes = stats[1],
            rxPackets = stats[2],
            rxBytes = stats[3],
        )
    }

    /**
     * Registers the VpnService instance for protect() callbacks.
     *
     * When set, the native JNI bridge will call `VpnService.protect(socketFd)`
     * on outbound sockets created by the tunnel, preventing them from being
     * routed back through the VPN (defense-in-depth alongside
     * addDisallowedApplication).
     *
     * Pass null to clear the callback (e.g., in VpnService.onDestroy()).
     *
     * @param vpnService The VpnService instance, or null to clear.
     */
    fun setProtectCallback(vpnService: android.net.VpnService?) {
        nativeSetProtect(vpnService)
    }

    // ── Native methods ──────────────────────────────────────────────────

    /**
     * Starts the native tunnel.
     * @param fd   TUN file descriptor (ownership transferred to native code)
     * @param host SOCKS5 server address
     * @param port SOCKS5 server port
     * @return 0 on success, negative on error
     */
    private external fun nativeStart(
        fd: Int,
        host: String,
        port: Int,
        mapDnsAddress: String,
        mapDnsPort: Int,
        mapDnsNetwork: String,
        mapDnsNetmask: String,
        mapDnsCacheSize: Int,
    ): Int

    /**
     * Signals the native tunnel to stop.
     */
    private external fun nativeStop()

    /**
     * Retrieves TX/RX statistics.
     * @return [txPackets, txBytes, rxPackets, rxBytes] or null
     */
    private external fun nativeStats(): LongArray?

    /**
     * Sets or clears the VpnService reference for protect() callbacks.
     * @param service VpnService instance or null
     */
    private external fun nativeSetProtect(service: android.net.VpnService?)
}

/**
 * Traffic statistics for the tun2socks tunnel.
 *
 * @property txPackets Outbound packets sent through the tunnel (TUN → SOCKS5)
 * @property txBytes   Outbound bytes sent through the tunnel
 * @property rxPackets Inbound packets received from the tunnel (SOCKS5 → TUN)
 * @property rxBytes   Inbound bytes received from the tunnel
 */
data class TunnelStats(
    val txPackets: Long,
    val txBytes: Long,
    val rxPackets: Long,
    val rxBytes: Long,
)
