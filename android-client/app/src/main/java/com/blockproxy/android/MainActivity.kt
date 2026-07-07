package com.blockproxy.android

import android.content.Intent
import android.os.Bundle
import android.os.PowerManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import com.blockproxy.android.service.TunnelServiceController
import com.blockproxy.android.ui.ConfigScreen
import com.blockproxy.android.ui.MainScreen
import com.blockproxy.android.ui.TunnelViewModel
import kotlinx.coroutines.launch

/**
 * Main activity for the BlockProxy Android client.
 *
 * Manages the VPN consent flow (battery optimization check + VpnService.prepare)
 * and hosts the Compose UI with simple state-based navigation between
 * [MainScreen] and [ConfigScreen].
 */
class MainActivity : ComponentActivity() {

    private val viewModel: TunnelViewModel by viewModels()
    private lateinit var controller: TunnelServiceController

    /** Simple navigation state: "main" or "config" */
    private var currentScreen by mutableStateOf("main")

    private val vpnPrepareLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            // VPN permission granted - start the service
            controller.startServiceInternal()
        }
    }

    private val batteryOptimizationLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { _ ->
        // Check if the user granted the exemption
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        val granted = pm.isIgnoringBatteryOptimizations(packageName)
        viewModel.refreshBatteryExemptionState(granted)
        // Now proceed to start VPN
        requestVpnPermission()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        controller = TunnelServiceController(this)

        setContent {
            MaterialTheme {
                val status by viewModel.tunnelStatus.collectAsState()
                val config by viewModel.configUiState.collectAsState()
                val batteryState by viewModel.batteryExemptionState.collectAsState()

                when (currentScreen) {
                    "main" -> MainScreen(
                        status = status,
                        isConfigValid = viewModel.isConfigValid(),
                        batteryExempted = batteryState.isExempt,
                        onStart = { onConnectClicked() },
                        onStop = { controller.stop() },
                        onNavigateToConfig = { currentScreen = "config" },
                        onBatterySettingsClick = {
                            startActivity(viewModel.createBatterySettingsIntent())
                        },
                    )

                    "config" -> ConfigScreen(
                        config = config,
                        batteryExempted = batteryState.isExempt,
                        onNavigateBack = { currentScreen = "main" },
                        onUpdateHost = viewModel::updateHost,
                        onUpdatePort = viewModel::updatePort,
                        onUpdateUseTls = viewModel::updateUseTls,
                        onUpdateAllowInsecure = viewModel::updateAllowInsecure,
                        onUpdateUsername = viewModel::updateUsername,
                        onUpdatePassword = viewModel::updatePassword,
                        onUpdateTunnelHost = viewModel::updateTunnelHost,
                        onUpdateTunnelPort = viewModel::updateTunnelPort,
                        onSave = viewModel::saveConfig,
                        onBatterySettingsClick = {
                            startActivity(viewModel.createBatterySettingsIntent())
                        },
                    )
                }
            }
        }
    }

    /**
     * Handles the connect button click.
     *
     * Flow:
     * 1. Check battery optimization exemption
     * 2. If not exempt and never requested, request exemption
     * 3. If not exempt but already requested, show warning and proceed
     * 4. If exempt, proceed to VPN permission
     */
    private fun onConnectClicked() {
        lifecycleScope.launch {
            // Check battery optimization exemption first
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            val isExempt = pm.isIgnoringBatteryOptimizations(packageName)

            if (!isExempt) {
                // Check if we should request exemption for the first time
                if (viewModel.shouldRequestBatteryExemption()) {
                    requestBatteryOptimizationExemption()
                    return@launch
                }

                // Check if we should show warning (already requested but not granted)
                if (viewModel.shouldShowBatteryWarning()) {
                    // The warning dialog is handled in the MainScreen composable
                    // Just proceed to VPN permission after the user dismisses the dialog
                    requestVpnPermission()
                    return@launch
                }
            }

            // Battery check passed - request VPN permission
            requestVpnPermission()
        }
    }

    private fun requestBatteryOptimizationExemption() {
        val intent = viewModel.createBatteryExemptionIntent()
        batteryOptimizationLauncher.launch(intent)
    }

    private fun requestVpnPermission() {
        val prepareIntent = controller.start()
        if (prepareIntent != null) {
            vpnPrepareLauncher.launch(prepareIntent)
        }
    }
}
