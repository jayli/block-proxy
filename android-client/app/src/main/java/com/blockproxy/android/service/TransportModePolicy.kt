package com.blockproxy.android.service

import com.blockproxy.android.tunnel.TunnelTransportMode

internal fun effectiveTransportMode(
    requested: TunnelTransportMode,
    appExclusionSucceeded: Boolean,
): TunnelTransportMode {
    return if (requested == TunnelTransportMode.CHROME_UTLS && !appExclusionSucceeded) {
        TunnelTransportMode.OKHTTP
    } else {
        requested
    }
}
