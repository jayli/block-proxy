package com.blockproxy.android.service

import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.blockproxy.android.config.ConfigRepository
import com.blockproxy.android.config.DataStoreConfigDataSource
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
 * 2. The persisted tunnel-enabled flag says the user intended the tunnel to
 *    stay active across process/device restarts.
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
         * @param tunnelEnabled   Whether the user persisted the tunnel as enabled.
         * @param isServiceRunning Whether [BlockProxyVpnService] is currently alive.
         */
        fun shouldRestart(
            hasConfig: Boolean,
            tunnelEnabled: Boolean,
            isServiceRunning: Boolean,
        ): Boolean {
            return hasConfig &&
                tunnelEnabled &&
                !isServiceRunning
        }
    }

    override suspend fun doWork(): Result {
        val configRepo = ConfigRepository(DataStoreConfigDataSource(applicationContext))
        val config = try {
            configRepo.observe().first()
        } catch (_: Exception) {
            null
        }
        val tunnelEnabled = try {
            configRepo.observeTunnelEnabled().first()
        } catch (_: Exception) {
            false
        }

        val isRunning = BlockProxyVpnService.isRunning

        if (shouldRestart(config != null, tunnelEnabled, isRunning)) {
            val intent = Intent(applicationContext, BlockProxyVpnService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                applicationContext.startForegroundService(intent)
            } else {
                applicationContext.startService(intent)
            }
        }

        return Result.success()
    }
}
