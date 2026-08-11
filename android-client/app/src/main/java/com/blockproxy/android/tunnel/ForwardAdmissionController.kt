package com.blockproxy.android.tunnel

import kotlinx.coroutines.sync.Semaphore
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.ConcurrentHashMap

/**
 * Admission control for Android-initiated forward CONNECT sessions.
 *
 * This limits only client -> server forward proxy sessions. Reverse tunnel
 * sessions and transport control frames do not pass through this controller.
 * When capacity is full, callers suspend instead of failing or dropping data.
 */
class ForwardAdmissionController(
    maxActive: Int = DEFAULT_MAX_ACTIVE,
    private val maxActivePerTarget: Int = DEFAULT_MAX_ACTIVE_PER_TARGET,
) {
    companion object {
        const val DEFAULT_MAX_ACTIVE = 12
        const val DEFAULT_MAX_ACTIVE_PER_TARGET = 4
    }

    private val globalPermits = Semaphore(maxActive.coerceAtLeast(1))
    private val targetPermits = ConcurrentHashMap<String, Semaphore>()

    suspend fun acquire(host: String, port: Int): ForwardAdmissionPermit {
        val targetKey = "${host.lowercase()}:$port"
        val perTarget = targetPermits.computeIfAbsent(targetKey) {
            Semaphore(maxActivePerTarget.coerceAtLeast(1))
        }
        globalPermits.acquire()
        try {
            perTarget.acquire()
        } catch (t: Throwable) {
            globalPermits.release()
            throw t
        }
        return ForwardAdmissionPermit(
            onRelease = {
                perTarget.release()
                globalPermits.release()
            }
        )
    }

    suspend fun <T> withPermit(host: String, port: Int, block: suspend () -> T): T {
        val permit = acquire(host, port)
        return try {
            block()
        } finally {
            permit.release()
        }
    }
}

class ForwardAdmissionPermit internal constructor(
    private val onRelease: () -> Unit,
) {
    private val released = AtomicBoolean(false)

    fun release() {
        if (released.compareAndSet(false, true)) {
            onRelease()
        }
    }
}
