package com.blockproxy.android.service

import kotlinx.coroutines.delay

object TunnelStartupDelay {
    const val DEFAULT_DELAY_MS = 700L

    suspend fun waitForVpnNetworkSettle(delayFn: suspend (Long) -> Unit = { delay(it) }) {
        delayFn(DEFAULT_DELAY_MS)
    }
}
