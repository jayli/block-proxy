package com.blockproxy.android.service

import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Build
import com.blockproxy.android.status.StatusStore
import com.blockproxy.android.status.TunnelStatus

/**
 * Helper for starting and stopping [BlockProxyVpnService] from UI components.
 *
 * Usage:
 * ```kotlin
 * val controller = TunnelServiceController(activity)
 * // In a button click:
 * controller.start(requestCode = 100)
 * // In onActivityResult:
 * if (requestCode == 100 && resultCode == RESULT_OK) {
 *     // VPN permission granted, service is starting
 * }
 * ```
 */
class TunnelServiceController(private val context: Context) {

    companion object {
        /** Default request code for VPN preparation. */
        const val VPN_PREPARE_REQUEST_CODE = 1001
    }

    /**
     * Checks whether the VPN service is prepared and starts it.
     *
     * If [VpnService.prepare] returns a non-null intent, the caller must
     * launch it via `startActivityForResult` and wait for the user to grant
     * VPN permission. Once granted, call [start] again (or the caller can
     * start the service directly).
     *
     * @return null if the VPN is already prepared and the service was started,
     *         or the prepare [Intent] that must be launched for user consent.
     */
    fun start(requestCode: Int = VPN_PREPARE_REQUEST_CODE): Intent? {
        val prepareIntent = VpnService.prepare(context)
        if (prepareIntent != null) {
            // User needs to grant VPN permission
            return prepareIntent
        }

        // VPN already prepared — start the service directly
        startServiceInternal()
        return null
    }

    /**
     * Starts the VPN service after the user has granted permission
     * (i.e., after [VpnService.prepare] returned null or the prepare
     * intent was completed with RESULT_OK).
     */
    fun startServiceInternal() {
        val intent = Intent(context, BlockProxyVpnService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
    }

    /**
     * Sends a stop action to the running VPN service.
     */
    fun stop() {
        val intent = Intent(context, BlockProxyVpnService::class.java).apply {
            action = BlockProxyVpnService.ACTION_STOP
        }
        context.startService(intent)
    }

    /**
     * Returns the current tunnel status from the shared [StatusStore].
     */
    val status: TunnelStatus
        get() = BlockProxyVpnService.statusStore.current

    /**
     * Returns the shared [StatusStore] for observing status changes.
     */
    val statusStore: StatusStore
        get() = BlockProxyVpnService.statusStore
}
