package com.blockproxy.android.socks

object TlsClientHelloParser {
    fun parseSni(bytes: ByteArray): String? {
        try {
            if (bytes.size < 9) return null
            if (u8(bytes, 0) != 0x16) return null
            val recordLength = u16(bytes, 3)
            if (bytes.size < 5 + recordLength) return null
            if (u8(bytes, 5) != 0x01) return null
            val handshakeLength = u24(bytes, 6)
            if (bytes.size < 9 + handshakeLength) return null

            var pos = 9
            if (pos + 34 > bytes.size) return null
            pos += 2 // client version
            pos += 32 // random

            if (pos + 1 > bytes.size) return null
            val sessionIdLength = u8(bytes, pos)
            pos += 1 + sessionIdLength

            if (pos + 2 > bytes.size) return null
            val cipherSuitesLength = u16(bytes, pos)
            pos += 2 + cipherSuitesLength

            if (pos + 1 > bytes.size) return null
            val compressionLength = u8(bytes, pos)
            pos += 1 + compressionLength

            if (pos + 2 > bytes.size) return null
            val extensionsLength = u16(bytes, pos)
            pos += 2
            val extensionsEnd = pos + extensionsLength
            if (extensionsEnd > bytes.size) return null

            while (pos + 4 <= extensionsEnd) {
                val type = u16(bytes, pos)
                val length = u16(bytes, pos + 2)
                pos += 4
                if (pos + length > extensionsEnd) return null
                if (type == 0x0000) return parseServerName(bytes, pos, length)
                pos += length
            }
        } catch (_: Exception) {
            return null
        }
        return null
    }

    private fun parseServerName(bytes: ByteArray, offset: Int, length: Int): String? {
        var pos = offset
        val end = offset + length
        if (pos + 2 > end) return null
        val listLength = u16(bytes, pos)
        pos += 2
        val listEnd = pos + listLength
        if (listEnd > end) return null
        while (pos + 3 <= listEnd) {
            val nameType = u8(bytes, pos)
            val nameLength = u16(bytes, pos + 1)
            pos += 3
            if (pos + nameLength > listEnd) return null
            if (nameType == 0) {
                val hostname = bytes.copyOfRange(pos, pos + nameLength).toString(Charsets.US_ASCII)
                return HostnameValidator.normalizeDomain(hostname)
            }
            pos += nameLength
        }
        return null
    }

    private fun u8(bytes: ByteArray, offset: Int): Int = bytes[offset].toInt() and 0xFF
    private fun u16(bytes: ByteArray, offset: Int): Int = (u8(bytes, offset) shl 8) or u8(bytes, offset + 1)
    private fun u24(bytes: ByteArray, offset: Int): Int =
        (u8(bytes, offset) shl 16) or (u8(bytes, offset + 1) shl 8) or u8(bytes, offset + 2)
}
