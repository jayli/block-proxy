package com.blockproxy.android.tunnel

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

class PaddingInjector(
    private val scope: CoroutineScope,
    config: PaddingConfig,
) {
    private val secureRandom = SecureRandom()
    private val cfg = config.normalized()
    private val negotiatedSenders = ConcurrentHashMap.newKeySet<FrameSender>()

    fun onDataSent(sender: FrameSender) {
        if (!cfg.enabled) return
        if (!negotiatedSenders.contains(sender)) return
        if (secureRandom.nextFloat() >= cfg.probability) return
        scope.launch {
            sendPadding(sender)
        }
    }

    fun setNegotiated(sender: FrameSender, negotiated: Boolean) {
        if (negotiated) {
            negotiatedSenders.add(sender)
        } else {
            negotiatedSenders.remove(sender)
        }
    }

    fun clearNegotiation(sender: FrameSender) {
        negotiatedSenders.remove(sender)
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
}

data class PaddingConfig(
    val enabled: Boolean = true,
    val probability: Float = 0.05f,
    val minBytes: Int = 64,
    val maxBytes: Int = 512,
) {
    fun normalized(): PaddingConfig {
        val normalizedMin = minBytes.coerceIn(0, 65534)
        val normalizedMax = maxBytes.coerceIn(normalizedMin, 65534)
        return copy(
            probability = probability.coerceIn(0.0f, 1.0f),
            minBytes = normalizedMin,
            maxBytes = normalizedMax,
        )
    }
}
