package com.blockproxy.android.tunnel

import kotlin.random.Random

internal object TunnelRotationPolicy {
    const val DEFAULT_MIN_MS = 3_600_000L // 1 h
    const val DEFAULT_MAX_MS = 7_200_000L // 2 h

    fun nextIntervalMs(): Long = Random.nextLong(DEFAULT_MIN_MS, DEFAULT_MAX_MS)
}
