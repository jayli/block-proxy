package com.blockproxy.android

import android.content.Intent
import android.os.Bundle
import android.os.PowerManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.blockproxy.android.config.DataStoreRoutingConfigDataSource
import com.blockproxy.android.config.RoutingConfigRepository
import com.blockproxy.android.service.TunnelServiceController
import com.blockproxy.android.ui.AboutScreen
import com.blockproxy.android.ui.ConfigScreen
import com.blockproxy.android.ui.MainScreen
import com.blockproxy.android.ui.RoutingScreen
import com.blockproxy.android.ui.RoutingViewModel
import com.blockproxy.android.ui.TunnelViewModel
import kotlinx.coroutines.launch

/**
 * Main activity for the BlockProxy Android client.
 *
 * Manages the VPN consent flow (battery optimization check + VpnService.prepare)
 * and hosts the Compose UI with bottom-tab navigation between
 * [MainScreen], [ConfigScreen], and [AboutScreen].
 */
class MainActivity : ComponentActivity() {

    private val viewModel: TunnelViewModel by viewModels()
    private lateinit var controller: TunnelServiceController
    private lateinit var routingViewModel: RoutingViewModel

    /** Whether the routing sub-screen is shown within the Config tab. */
    private var showRouting by mutableStateOf(false)

    private val vpnPrepareLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            controller.startServiceInternal()
        }
    }

    private val batteryOptimizationLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { _ ->
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        val granted = pm.isIgnoringBatteryOptimizations(packageName)
        viewModel.refreshBatteryExemptionState(granted)
        requestVpnPermission()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        controller = TunnelServiceController(this)

        val routingRepo = RoutingConfigRepository(
            DataStoreRoutingConfigDataSource(applicationContext)
        )
        val factory = viewModelFactory {
            initializer { RoutingViewModel(routingRepo) }
        }
        routingViewModel = ViewModelProvider(this, factory)[RoutingViewModel::class.java]

        setContent {
            MaterialTheme {
                val status by viewModel.tunnelStatus.collectAsState()
                val config by viewModel.configUiState.collectAsState()
                val batteryState by viewModel.batteryExemptionState.collectAsState()
                val routingState by routingViewModel.uiState.collectAsState()

                var selectedTab by remember { mutableIntStateOf(0) }

                Scaffold(
                    bottomBar = {
                        NavigationBar {
                            NavigationBarItem(
                                selected = selectedTab == 0,
                                onClick = { selectedTab = 0 },
                                icon = {
                                    Icon(Icons.Default.Home, contentDescription = "首页")
                                },
                                label = { Text("首页") },
                            )
                            NavigationBarItem(
                                selected = selectedTab == 1,
                                onClick = {
                                    selectedTab = 1
                                    showRouting = false
                                },
                                icon = {
                                    Icon(Icons.Default.Settings, contentDescription = "配置")
                                },
                                label = { Text("配置") },
                            )
                            NavigationBarItem(
                                selected = selectedTab == 2,
                                onClick = { selectedTab = 2 },
                                icon = {
                                    Icon(Icons.Default.Info, contentDescription = "关于")
                                },
                                label = { Text("关于") },
                            )
                        }
                    },
                ) { innerPadding ->
                    val modifier = Modifier.padding(innerPadding).fillMaxSize()

                    when (selectedTab) {
                        0 -> MainScreen(
                            status = status,
                            isConfigValid = viewModel.isConfigValid(),
                            batteryExempted = batteryState.isExempt,
                            onStart = { onConnectClicked() },
                            onStop = { controller.stop() },
                            onBatterySettingsClick = {
                                startActivity(viewModel.createBatterySettingsIntent())
                            },
                            modifier = modifier,
                        )

                        1 -> {
                            if (showRouting) {
                                RoutingScreen(
                                    viewModel = routingViewModel,
                                    onNavigateBack = { showRouting = false },
                                    modifier = modifier,
                                )
                            } else {
                                ConfigScreen(
                                    config = config,
                                    batteryExempted = batteryState.isExempt,
                                    onNavigateToHome = { selectedTab = 0 },
                                    onUpdateHost = viewModel::updateHost,
                                    onUpdatePort = viewModel::updatePort,
                                    onUpdateUsername = viewModel::updateUsername,
                                    onUpdatePassword = viewModel::updatePassword,
                                    onSave = viewModel::saveConfig,
                                    onBatterySettingsClick = {
                                        startActivity(viewModel.createBatterySettingsIntent())
                                    },
                                    routingEnabled = routingState.enabled,
                                    onNavigateToRouting = { showRouting = true },
                                    modifier = modifier,
                                )
                            }
                        }

                        2 -> AboutScreen(
                                onNavigateToHome = { selectedTab = 0 },
                                modifier = modifier,
                            )
                    }
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
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            val isExempt = pm.isIgnoringBatteryOptimizations(packageName)

            if (!isExempt) {
                if (viewModel.shouldRequestBatteryExemption()) {
                    requestBatteryOptimizationExemption()
                    return@launch
                }

                if (viewModel.shouldShowBatteryWarning()) {
                    requestVpnPermission()
                    return@launch
                }
            }

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
