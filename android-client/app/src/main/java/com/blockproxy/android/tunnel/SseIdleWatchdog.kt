package com.blockproxy.android.tunnel

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal class SseIdleWatchdog(
    private val scope: CoroutineScope,
    private val timeoutMs: Long,
    private val onTimeout: () -> Unit,
) {
    private var job: Job? = null

    fun start() {
        markActivity()
    }

    fun markActivity() {
        job?.cancel()
        if (timeoutMs <= 0) return
        job = scope.launch {
            delay(timeoutMs)
            onTimeout()
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }
}
