package com.blockproxy.android.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.blockproxy.android.config.RoutingConfig
import com.blockproxy.android.config.RoutingConfigRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * UI state for the routing configuration screen.
 *
 * Rules are edited as raw multi-line text; conversion to/from [RoutingConfig]'s
 * `List<String>` happens at the boundary.
 *
 * @property enabled        Whether routing rules are active.
 * @property directRulesText Multi-line text for direct (bypass-proxy) rules.
 * @property proxyRulesText  Multi-line text for proxy (through-tunnel) rules.
 * @property selectedTab     Currently selected tab index (0 = direct, 1 = proxy).
 * @property isSaved         True once the user has saved changes.
 */
data class RoutingUiState(
    val enabled: Boolean = false,
    val directRulesText: String = "",
    val proxyRulesText: String = "",
    val selectedTab: Int = 0,
    val isSaved: Boolean = false,
)

/**
 * ViewModel for the routing configuration screen.
 *
 * Observes a [RoutingConfigRepository] to populate [uiState] and persists
 * changes when [save] is called.  Designed as a plain [ViewModel] (not
 * `AndroidViewModel`) so that it can be unit-tested without a Robolectric
 * or instrumented environment.
 */
class RoutingViewModel(
    private val repository: RoutingConfigRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(RoutingUiState())
    val uiState: StateFlow<RoutingUiState> = _uiState.asStateFlow()

    init {
        viewModelScope.launch {
            repository.observe().collect { config ->
                _uiState.value = _uiState.value.copy(
                    enabled = config.enabled,
                    directRulesText = config.directRules.joinToString("\n"),
                    proxyRulesText = config.proxyRules.joinToString("\n"),
                )
            }
        }
    }

    fun updateEnabled(enabled: Boolean) {
        _uiState.value = _uiState.value.copy(enabled = enabled, isSaved = false)
    }

    fun updateDirectRules(text: String) {
        _uiState.value = _uiState.value.copy(directRulesText = text, isSaved = false)
    }

    fun updateProxyRules(text: String) {
        _uiState.value = _uiState.value.copy(proxyRulesText = text, isSaved = false)
    }

    fun selectTab(index: Int) {
        _uiState.value = _uiState.value.copy(selectedTab = index)
    }

    /**
     * Persists the current UI state as a [RoutingConfig].
     *
     * Blank lines are silently stripped.  Sets [RoutingUiState.isSaved] on
     * success so the UI can show feedback.
     */
    fun save() {
        viewModelScope.launch {
            val state = _uiState.value
            repository.save(
                RoutingConfig(
                    enabled = state.enabled,
                    directRules = state.directRulesText
                        .split("\n")
                        .filter { it.isNotBlank() },
                    proxyRules = state.proxyRulesText
                        .split("\n")
                        .filter { it.isNotBlank() },
                )
            )
            _uiState.value = _uiState.value.copy(isSaved = true)
        }
    }
}
