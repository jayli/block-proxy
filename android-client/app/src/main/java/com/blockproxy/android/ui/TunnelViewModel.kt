package com.blockproxy.android.ui

import android.app.Application
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.preferencesDataStore
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.blockproxy.android.cdn.CfIpRefreshWorker
import com.blockproxy.android.config.ConfigRepository
import com.blockproxy.android.config.CredentialStore
import com.blockproxy.android.config.DataStoreConfigDataSource
import com.blockproxy.android.config.DataStoreCredentialDataSource
import com.blockproxy.android.config.ServerConfig
import com.blockproxy.android.config.TunnelCredentials
import com.blockproxy.android.service.BlockProxyVpnService
import com.blockproxy.android.status.TunnelStatus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

sealed class CfIpRefreshState {
    data object Idle : CfIpRefreshState()
    data class Refreshing(val tested: Int = 0, val total: Int = 0) : CfIpRefreshState()
    data class Done(val count: Int, val appliedToRunningTunnel: Boolean) : CfIpRefreshState()
    data class Error(val message: String) : CfIpRefreshState()
}

/**
 * UI state for the configuration form.
 */
data class ConfigUiState(
    val host: String = "",
    val port: String = "8003",
    val useTls: Boolean = true,
    val allowInsecure: Boolean = true,
    val username: String = "",
    val password: String = "",
    val isSaved: Boolean = false,
    val cfCdnEnabled: Boolean = false,
)

/**
 * UI state for battery optimization exemption.
 */
data class BatteryExemptionState(
    val isExempt: Boolean = false,
    val wasRequested: Boolean = false,
)

/**
 * ViewModel for the tunnel configuration and status.
 *
 * Owns the config editing state, observes tunnel status from [BlockProxyVpnService.statusStore],
 * and exposes methods for starting/stopping the tunnel service.
 */
class TunnelViewModel(application: Application) : AndroidViewModel(application) {

    private val context: Context = application.applicationContext

    // Config editing state
    private val _configUiState = MutableStateFlow(ConfigUiState())
    val configUiState: StateFlow<ConfigUiState> = _configUiState.asStateFlow()

    // Tunnel status from the service
    val tunnelStatus: StateFlow<TunnelStatus> = BlockProxyVpnService.statusStore.status
    val currentCfIp: StateFlow<String?> = BlockProxyVpnService.statusStore.currentCfIp

    // Battery exemption state
    private val _batteryExemptionState = MutableStateFlow(BatteryExemptionState())
    val batteryExemptionState: StateFlow<BatteryExemptionState> = _batteryExemptionState.asStateFlow()

    private val _cfIpRefreshState = MutableStateFlow<CfIpRefreshState>(CfIpRefreshState.Idle)
    val cfIpRefreshState: StateFlow<CfIpRefreshState> = _cfIpRefreshState.asStateFlow()

    // Repositories
    private val configRepository = ConfigRepository(DataStoreConfigDataSource(context))
    private val credentialStore = CredentialStore(DataStoreCredentialDataSource(context))

    // Battery prefs DataStore
    private val batteryPrefs = context.batteryPrefs

    init {
        loadConfig()
        loadBatteryState()
    }

    /**
     * Loads persisted config into the UI state.
     */
    private fun loadConfig() {
        viewModelScope.launch {
            configRepository.observe().collect { config ->
                config?.let { cfg ->
                    _configUiState.value = _configUiState.value.copy(
                        host = cfg.serverHost,
                        port = cfg.serverPort.toString(),
                        useTls = cfg.useTls,
                        allowInsecure = cfg.allowInsecure,
                        cfCdnEnabled = cfg.cfCdnEnabled,
                        isSaved = true,
                    )
                }
            }
        }
        viewModelScope.launch {
            credentialStore.observe().collect { creds ->
                creds?.let { c ->
                    _configUiState.value = _configUiState.value.copy(
                        username = c.username,
                        password = c.password,
                    )
                }
            }
        }
    }

    /**
     * Loads battery exemption state from DataStore and system settings.
     */
    private fun loadBatteryState() {
        viewModelScope.launch {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            val isExempt = pm.isIgnoringBatteryOptimizations(context.packageName)

            val prefs = batteryPrefs.data.first()
            val wasRequested = prefs[KEY_BATTERY_EXEMPTION_REQUESTED] ?: false

            _batteryExemptionState.value = BatteryExemptionState(
                isExempt = isExempt,
                wasRequested = wasRequested,
            )
        }
    }

    /**
     * Updates the battery exemption state after the user returns from settings.
     */
    fun refreshBatteryExemptionState(granted: Boolean) {
        viewModelScope.launch {
            batteryPrefs.edit { prefs ->
                prefs[KEY_BATTERY_EXEMPTION_REQUESTED] = true
                prefs[KEY_BATTERY_EXEMPTION_GRANTED] = granted
            }
            _batteryExemptionState.value = _batteryExemptionState.value.copy(
                isExempt = granted,
                wasRequested = true,
            )
        }
    }

    /**
     * Checks if battery exemption should be requested before starting VPN.
     * Returns true if we should show the battery exemption request flow.
     */
    suspend fun shouldRequestBatteryExemption(): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val isExempt = pm.isIgnoringBatteryOptimizations(context.packageName)

        if (isExempt) return false

        val prefs = batteryPrefs.data.first()
        val alreadyRequested = prefs[KEY_BATTERY_EXEMPTION_REQUESTED] ?: false

        return !alreadyRequested
    }

    /**
     * Checks if battery exemption was previously requested but not granted.
     * Returns true if we should show the warning dialog.
     */
    suspend fun shouldShowBatteryWarning(): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val isExempt = pm.isIgnoringBatteryOptimizations(context.packageName)

        if (isExempt) return false

        val prefs = batteryPrefs.data.first()
        val alreadyRequested = prefs[KEY_BATTERY_EXEMPTION_REQUESTED] ?: false
        val wasGranted = prefs[KEY_BATTERY_EXEMPTION_GRANTED] ?: false

        return alreadyRequested && !wasGranted
    }

    /**
     * Creates an intent to request battery optimization exemption.
     */
    fun createBatteryExemptionIntent(): Intent {
        return Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:${context.packageName}")
        }
    }

    /**
     * Creates an intent to open battery optimization settings.
     */
    fun createBatterySettingsIntent(): Intent {
        return Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
    }

    /**
     * Checks if the config is valid and saved.
     */
    fun isConfigValid(): Boolean {
        val state = _configUiState.value
        return state.host.isNotBlank() &&
            state.port.toIntOrNull() in 1..65535 &&
            isCfConfigValid(state) &&
            state.username.isNotBlank() &&
            state.password.isNotBlank() &&
            state.isSaved
    }

    // ── Config field update methods ─────────────────────────────────────────

    fun updateHost(host: String) {
        _configUiState.value = _configUiState.value.copy(host = host, isSaved = false)
    }

    fun updatePort(port: String) {
        _configUiState.value = _configUiState.value.copy(port = port, isSaved = false)
    }

    fun updateUseTls(useTls: Boolean) {
        _configUiState.value = _configUiState.value.copy(useTls = useTls, isSaved = false)
    }

    fun updateAllowInsecure(allowInsecure: Boolean) {
        _configUiState.value = _configUiState.value.copy(allowInsecure = allowInsecure, isSaved = false)
    }

    fun updateUsername(username: String) {
        _configUiState.value = _configUiState.value.copy(username = username, isSaved = false)
    }

    fun updatePassword(password: String) {
        _configUiState.value = _configUiState.value.copy(password = password, isSaved = false)
    }

    fun updateCfCdnEnabled(enabled: Boolean) {
        _configUiState.value = _configUiState.value.copy(cfCdnEnabled = enabled, isSaved = false)
    }

    /**
     * Saves the current config and credentials to persistent storage.
     */
    fun saveConfig() {
        viewModelScope.launch {
            val state = _configUiState.value

            val config = ServerConfig(
                serverHost = state.host,
                serverPort = state.port.toIntOrNull() ?: ServerConfig.DEFAULT_PORT,
                useTls = state.useTls,
                allowInsecure = state.allowInsecure,
                cfCdnEnabled = state.cfCdnEnabled,
            )
            configRepository.save(config)

            val creds = TunnelCredentials(
                username = state.username,
                password = state.password,
            )
            credentialStore.save(creds)

            if (config.cfCdnEnabled) {
                CfIpRefreshWorker.schedule(context, config.serverPort)
            } else {
                CfIpRefreshWorker.cancelSchedule(context)
            }

            _configUiState.value = _configUiState.value.copy(isSaved = true)
        }
    }

    fun refreshCfIpPool() {
        val state = _configUiState.value
        val port = state.port.toIntOrNull()
        if (!state.cfCdnEnabled || port == null || !isCfConfigValid(state)) {
            _cfIpRefreshState.value = CfIpRefreshState.Error("请先启用 CF CDN 并使用支持的 HTTPS 端口")
            return
        }

        val id = CfIpRefreshWorker.refreshNow(context, port)
        viewModelScope.launch {
            WorkManager.getInstance(context)
                .getWorkInfoByIdFlow(id)
                .collectLatest { info ->
                    if (info == null) return@collectLatest
                    when (info.state) {
                        WorkInfo.State.ENQUEUED,
                        WorkInfo.State.BLOCKED,
                        WorkInfo.State.RUNNING -> {
                            _cfIpRefreshState.value = CfIpRefreshState.Refreshing(
                                tested = info.progress.getInt(CfIpRefreshWorker.KEY_TESTED, 0),
                                total = info.progress.getInt(CfIpRefreshWorker.KEY_TOTAL, 0),
                            )
                        }
                        WorkInfo.State.SUCCEEDED -> {
                            _cfIpRefreshState.value = CfIpRefreshState.Done(
                                count = info.outputData.getInt(CfIpRefreshWorker.KEY_SELECTED_COUNT, 0),
                                appliedToRunningTunnel = info.outputData.getBoolean(
                                    CfIpRefreshWorker.KEY_APPLIED_TO_RUNNING_TUNNEL,
                                    false,
                                ),
                            )
                        }
                        WorkInfo.State.FAILED -> {
                            _cfIpRefreshState.value = CfIpRefreshState.Error("刷新失败")
                        }
                        WorkInfo.State.CANCELLED -> {
                            _cfIpRefreshState.value = CfIpRefreshState.Idle
                        }
                    }
                }
        }
    }

    private fun isCfConfigValid(state: ConfigUiState): Boolean {
        if (!state.cfCdnEnabled) return true
        val port = state.port.toIntOrNull() ?: return false
        return state.useTls && port in CLOUDFLARE_HTTPS_PORTS
    }

    companion object {
        val CLOUDFLARE_HTTPS_PORTS = setOf(443, 2053, 2083, 2087, 2096, 8443)
        private val KEY_BATTERY_EXEMPTION_REQUESTED = booleanPreferencesKey("battery_exemption_requested")
        private val KEY_BATTERY_EXEMPTION_GRANTED = booleanPreferencesKey("battery_exemption_granted")
    }
}

/**
 * Application-level DataStore for battery exemption preferences.
 */
private val Context.batteryPrefs by preferencesDataStore(name = "battery_prefs")
