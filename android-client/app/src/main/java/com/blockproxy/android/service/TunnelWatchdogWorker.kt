package com.blockproxy.android.service

import android.content.Context
import android.content.Intent
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.blockproxy.android.config.ConfigRepository
import com.blockproxy.android.config.DataStoreConfigDataSource
import com.blockproxy.android.status.TunnelStatus
import kotlinx.coroutines.flow.first

/**
 * Periodic worker that checks whether the VPN tunnel service should be
 * restarted after an unexpected process death.
 *
 * The worker runs every 15 minutes (registered as unique periodic work by
 * [BlockProxyVpnService]).  Its decision logic is intentionally extracted
 * into [shouldRestart] — a pure function — so that it can be unit-tested
 * without any Android framework dependencies.
 *
 * **Restart criteria (all must be true):**
 * 1. A server configuration is persisted (the user previously configured a tunnel).
 * 2. The last known status was [TunnelStatus.Connected] or
 *    [TunnelStatus.Reconnecting] (i.e., the user intended the tunnel to be active).
 * 3. The [BlockProxyVpnService] is **not** currently running.
 *
 * If any condition is false the worker does nothing.
 */
class TunnelWatchdogWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    companion object {
        /** Unique work name used when enrolling the periodic worker. */
        const val WORK_NAME = "tunnel-watchdog"

        /**
         * Pure decision function: should the watchdog restart the tunnel service?
         *
         * @param hasConfig       Whether a server configuration is persisted.
         * @param lastStatus      The last known [TunnelStatus] from [StatusStore].
         * @param isServiceRunning Whether [BlockProxyVpnService] is currently alive.
         */
        fun shouldRestart(
            hasConfig: Boolean,
            lastStatus: TunnelStatus,
            isServiceRunning: Boolean,
        ): Boolean {
            return hasConfig &&
                lastStatus in setOf(TunnelStatus.Connected, TunnelStatus.Reconnecting) &&
                !isServiceRunning
        }
    }

    override suspend fun doWork(): Result {
        val configRepo = ConfigRepository(DataStoreConfigDataSource(applicationContext))
        val statusStore = BlockProxyVpnService.statusStore

        val config = try {
            configRepo.observe().first()
        } catch (_: Exception) {
            null
        }

        val lastStatus = statusStore.current
        val isRunning = BlockProxyVpnService.isRunning

        if (shouldRestart(config != null, lastStatus, isRunning)) {
            val intent = Intent(applicationContext, BlockProxyVpnService::class.java)
            applicationContext.startForegroundService(intent)
        }

        return Result.success()
    }
}
