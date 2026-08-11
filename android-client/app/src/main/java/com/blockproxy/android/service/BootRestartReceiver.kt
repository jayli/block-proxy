package com.blockproxy.android.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import com.blockproxy.android.config.ConfigRepository
import com.blockproxy.android.config.DataStoreConfigDataSource
import com.blockproxy.android.diagnostics.TunnelDiagnosticsLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class BootRestartReceiver : BroadcastReceiver() {

    companion object {
        fun shouldStartOnBoot(
            hasConfig: Boolean,
            tunnelEnabled: Boolean,
            isServiceRunning: Boolean,
        ): Boolean {
            return hasConfig && tunnelEnabled && !isServiceRunning
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        val pendingResult = goAsync()
        val appContext = context.applicationContext
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                val configRepository = ConfigRepository(DataStoreConfigDataSource(appContext))
                val hasConfig = try {
                    configRepository.observe().first() != null
                } catch (_: Exception) {
                    false
                }
                val tunnelEnabled = try {
                    configRepository.observeTunnelEnabled().first()
                } catch (_: Exception) {
                    false
                }

                if (shouldStartOnBoot(hasConfig, tunnelEnabled, BlockProxyVpnService.isRunning)) {
                    TunnelDiagnosticsLog.write("boot.restart_service")
                    val serviceIntent = Intent(appContext, BlockProxyVpnService::class.java).apply {
                        putExtra(BlockProxyVpnService.EXTRA_BOOT_RESTORE, true)
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        appContext.startForegroundService(serviceIntent)
                    } else {
                        appContext.startService(serviceIntent)
                    }
                } else {
                    TunnelDiagnosticsLog.write(
                        "boot.skip_restart",
                        "hasConfig=$hasConfig tunnelEnabled=$tunnelEnabled running=${BlockProxyVpnService.isRunning}"
                    )
                }
            } finally {
                pendingResult.finish()
            }
        }
    }
}
