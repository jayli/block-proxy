package com.blockproxy.android.tunnel

object InsecureH2Fallback {
    fun shouldFallback(allowInsecure: Boolean, error: Throwable): Boolean {
        if (!allowInsecure) return false
        return generateSequence(error) { it.cause }
            .mapNotNull { it.message }
            .any { message ->
                message.contains("ERR_CERT_", ignoreCase = true)
            }
    }
}
