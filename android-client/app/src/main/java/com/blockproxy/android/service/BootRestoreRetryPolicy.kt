package com.blockproxy.android.service

object BootRestoreRetryPolicy {
    private val retryDelaysMillis = longArrayOf(
        15_000L,
        30_000L,
        60_000L,
        120_000L,
        120_000L,
    )

    fun nextDelayMillis(bootRestore: Boolean, attempt: Int): Long? {
        if (!bootRestore) return null
        return retryDelaysMillis.getOrNull(attempt)
    }
}
