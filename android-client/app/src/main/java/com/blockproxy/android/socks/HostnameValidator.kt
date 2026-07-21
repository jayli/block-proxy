package com.blockproxy.android.socks

internal object HostnameValidator {
    fun normalizeDomain(value: String): String? {
        val host = value.trim().trimEnd('.').lowercase()
        if (host.isEmpty() || host.length > 253) return null
        if (isIpv4Literal(host)) return null
        if (host.contains(':')) return null
        val labels = host.split('.')
        if (labels.size < 2) return null
        for (label in labels) {
            if (label.isEmpty() || label.length > 63) return null
            if (label.first() == '-' || label.last() == '-') return null
            if (!label.all { it in 'a'..'z' || it in '0'..'9' || it == '-' }) return null
        }
        return host
    }

    private fun isIpv4Literal(host: String): Boolean {
        val parts = host.split('.')
        if (parts.size != 4) return false
        return parts.all { part ->
            part.isNotEmpty() && part.length <= 3 && part.all { it in '0'..'9' } && part.toIntOrNull() in 0..255
        }
    }
}
