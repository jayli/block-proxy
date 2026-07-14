package com.blockproxy.android.tunnel

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.security.SecureRandom

class PaddingInjector(
    private val scope: CoroutineScope,
    config: PaddingConfig,
) {
    private val secureRandom = SecureRandom()
    private val cfg = config.normalized()
    private var periodicJob: Job? = null

    @Volatile
    private var activeSender: FrameSender? = null

    fun onDataSent(sender: FrameSender) {
        if (!cfg.enabled) return
        if (secureRandom.nextFloat() >= cfg.probability) return
        scope.launch {
            sendPadding(sender)
        }
    }

    fun startPeriodic(sender: FrameSender) {
        if (!cfg.enabled || cfg.intervalMinMs <= 0) return
        activeSender = sender
        periodicJob?.cancel()
        periodicJob = scope.launch {
            while (isActive) {
                delay(randomIntervalMs())
                val current = activeSender ?: continue
                sendPadding(current)
            }
        }
    }

    fun updateSender(sender: FrameSender) {
        activeSender = sender
    }

    fun stopPeriodic() {
        periodicJob?.cancel()
        periodicJob = null
        activeSender = null
    }

    private suspend fun sendPadding(sender: FrameSender) {
        if (!sender.isOpen) return
        try {
            sender.sendFrame(FrameCodec.encode(Frame.Padding(randomBytes())))
        } catch (_: Exception) {
            // Padding is best-effort and must never affect real tunnel data.
        }
    }

    private fun randomBytes(): ByteArray {
        val size = cfg.minBytes + secureRandom.nextInt(cfg.maxBytes - cfg.minBytes + 1)
        val bytes = ByteArray(size)
        secureRandom.nextBytes(bytes)
        return bytes
    }

    private fun randomIntervalMs(): Long {
        if (cfg.intervalMinMs == cfg.intervalMaxMs) return cfg.intervalMinMs
        val spread = cfg.intervalMaxMs - cfg.intervalMinMs + 1
        return cfg.intervalMinMs + nextLong(spread)
    }

    private fun nextLong(bound: Long): Long {
        var bits: Long
        var value: Long
        do {
            bits = secureRandom.nextLong() ushr 1
            value = bits % bound
        } while (bits - value + (bound - 1) < 0L)
        return value
    }
}

data class PaddingConfig(
    val enabled: Boolean = true,
    val probability: Float = 0.3f,
    val minBytes: Int = 64,
    val maxBytes: Int = 512,
    val intervalMinMs: Long = 5000,
    val intervalMaxMs: Long = 15000,
) {
    fun normalized(): PaddingConfig {
        val normalizedMin = minBytes.coerceIn(0, 65534)
        val normalizedMax = maxBytes.coerceIn(normalizedMin, 65534)
        val normalizedIntervalMin = intervalMinMs.coerceAtLeast(0)
        val normalizedIntervalMax = intervalMaxMs.coerceAtLeast(normalizedIntervalMin)
        return copy(
            probability = probability.coerceIn(0.0f, 1.0f),
            minBytes = normalizedMin,
            maxBytes = normalizedMax,
            intervalMinMs = normalizedIntervalMin,
            intervalMaxMs = normalizedIntervalMax,
        )
    }
}
