package com.blockproxy.android.socks

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.InputStream

data class SniffResult(
    val domain: String?,
    val bufferedBytes: ByteArray,
    val source: SniffSource,
)

enum class SniffSource {
    TLS_SNI,
    HTTP_HOST,
    NONE,
    TIMEOUT,
    TOO_LARGE,
    UNSUPPORTED,
}

class TrafficSniffer(
    private val timeoutMs: Int = 500,
    private val maxBytes: Int = 16 * 1024,
) {
    suspend fun sniff(endpoint: ResolvedEndpoint, input: InputStream): SniffResult {
        if (endpoint.domain != null || endpoint.source != DomainSource.NONE) {
            return SniffResult(null, ByteArray(0), SniffSource.UNSUPPORTED)
        }
        if (endpoint.port != 80 && endpoint.port != 443) {
            return SniffResult(null, ByteArray(0), SniffSource.UNSUPPORTED)
        }

        return withContext(Dispatchers.IO) {
            val buffer = ByteArrayOutputStream()
            val chunk = ByteArray(minOf(2048, maxBytes))
            var source = SniffSource.NONE

            while (buffer.size() < maxBytes) {
                val readSize = minOf(chunk.size, maxBytes - buffer.size())
                val n = try {
                    input.read(chunk, 0, readSize)
                } catch (_: java.net.SocketTimeoutException) {
                    source = SniffSource.TIMEOUT
                    break
                }
                if (n <= 0) break
                buffer.write(chunk, 0, n)

                val bytes = buffer.toByteArray()
                val domain = when (endpoint.port) {
                    443 -> TlsClientHelloParser.parseSni(bytes)
                    80 -> HttpHostParser.parseHost(bytes)
                    else -> null
                }
                if (domain != null) {
                    return@withContext SniffResult(
                        domain = domain,
                        bufferedBytes = bytes,
                        source = if (endpoint.port == 443) SniffSource.TLS_SNI else SniffSource.HTTP_HOST,
                    )
                }

                if (endpoint.port == 80 && bytes.containsHttpHeaderEnd()) break
                if (endpoint.port == 443 && bytes.size >= 5) {
                    val recordLength = ((bytes[3].toInt() and 0xFF) shl 8) or (bytes[4].toInt() and 0xFF)
                    if (bytes.size >= 5 + recordLength) break
                }
            }

            if (buffer.size() >= maxBytes) source = SniffSource.TOO_LARGE
            SniffResult(null, buffer.toByteArray(), source)
        }
    }

    fun timeoutMs(): Int = timeoutMs

    private fun ByteArray.containsHttpHeaderEnd(): Boolean {
        for (i in 0..size - 4) {
            if (
                this[i] == '\r'.code.toByte() &&
                this[i + 1] == '\n'.code.toByte() &&
                this[i + 2] == '\r'.code.toByte() &&
                this[i + 3] == '\n'.code.toByte()
            ) return true
        }
        return false
    }
}
