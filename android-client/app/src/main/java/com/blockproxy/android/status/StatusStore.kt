package com.blockproxy.android.status

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Observable, thread-safe holder for the current [TunnelStatus].
 *
 * UI components and services both read and observe [status];
 * the tunnel service writes new values via [update].
 */
class StatusStore(initial: TunnelStatus = TunnelStatus.Disconnected) {

    private val _status = MutableStateFlow(initial)

    /** Current tunnel status, observable as a [StateFlow]. */
    val status: StateFlow<TunnelStatus> = _status.asStateFlow()

    private val _currentCfIp = MutableStateFlow<String?>(null)

    /** Current CF CDN peer IP, or null when CF mode is inactive or disconnected. */
    val currentCfIp: StateFlow<String?> = _currentCfIp.asStateFlow()

    /** Replace the current status. Triggers a StateFlow emission when the value changes. */
    fun update(newStatus: TunnelStatus) {
        _status.value = newStatus
    }

    /** Update the current CF CDN peer IP displayed by the UI. */
    fun updateCfIp(ip: String?) {
        _currentCfIp.value = ip
    }

    /** Convenience: returns the current value without subscribing. */
    val current: TunnelStatus get() = _status.value
}
