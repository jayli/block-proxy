package com.blockproxy.android.socks

object HttpHostParser {
    private val methodRegex = Regex("^[A-Z]+\\s+\\S+\\s+HTTP/1\\.[01]$")

    fun parseHost(bytes: ByteArray): String? {
        val end = findHeaderEnd(bytes) ?: return null
        val text = bytes.copyOfRange(0, end).toString(Charsets.ISO_8859_1)
        val lines = text.split("\r\n")
        if (lines.isEmpty() || !methodRegex.matches(lines.first())) return null

        for (line in lines.drop(1)) {
            val colon = line.indexOf(':')
            if (colon <= 0) continue
            if (!line.substring(0, colon).equals("host", ignoreCase = true)) continue
            val value = line.substring(colon + 1).trim()
            return HostnameValidator.normalizeDomain(stripPort(value))
        }
        return null
    }

    private fun findHeaderEnd(bytes: ByteArray): Int? {
        for (i in 0..bytes.size - 4) {
            if (
                bytes[i] == '\r'.code.toByte() &&
                bytes[i + 1] == '\n'.code.toByte() &&
                bytes[i + 2] == '\r'.code.toByte() &&
                bytes[i + 3] == '\n'.code.toByte()
            ) {
                return i
            }
        }
        return null
    }

    private fun stripPort(value: String): String {
        val colon = value.lastIndexOf(':')
        if (colon <= 0) return value
        val port = value.substring(colon + 1)
        return if (port.all { it in '0'..'9' }) value.substring(0, colon) else value
    }
}
