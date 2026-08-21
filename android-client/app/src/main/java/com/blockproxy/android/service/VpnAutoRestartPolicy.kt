package com.blockproxy.android.service

/**
 * Shared decision logic for automatic VPN service restarts (boot receiver and
 * watchdog).
 *
 * Besides the existing intent conditions, the VPN must be prepared for the
 * current boot session: Android resets the prepared VPN owner after reboot,
 * and [android.net.VpnService.establish] silently fails until the app is
 * prepared again.
 */
object VpnAutoRestartPolicy {

    /**
     * Returns true when the tunnel service should be auto-started.
     *
     * @param hasConfig       Whether a server configuration is persisted.
     * @param tunnelEnabled   Whether the user persisted the tunnel as enabled.
     * @param isServiceRunning Whether [BlockProxyVpnService] is currently alive.
     * @param vpnPrepared     Whether [android.net.VpnService.prepare] returned
     *                        null for this boot session.
     */
    fun shouldStartService(
        hasConfig: Boolean,
        tunnelEnabled: Boolean,
        isServiceRunning: Boolean,
        vpnPrepared: Boolean,
    ): Boolean {
        return hasConfig && tunnelEnabled && !isServiceRunning && vpnPrepared
    }
}
