package com.blockproxy.android.doh

object DohConfig {
    const val DOH_HOST = "dns.alidns.com"
    const val DOH_URL = "https://dns.alidns.com/resolve"
    val BOOTSTRAP_IPS = listOf("223.5.5.5", "223.6.6.6")
    const val TIMEOUT_SECONDS = 8L
    const val CACHE_TTL_MS = 300_000L
}
