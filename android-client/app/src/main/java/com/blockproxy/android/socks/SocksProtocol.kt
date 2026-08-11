package com.blockproxy.android.socks

/**
 * Exception thrown when SOCKS5 protocol data is malformed.
 */
class SocksProtocolException(message: String) : Exception(message)

/**
 * Address type in a SOCKS5 request.
 */
enum class SocksAddressType(val code: Int) {
    IPV4(0x01),
    DOMAIN(0x03),
    IPV6(0x04),
}

/**
 * SOCKS5 reply codes (RFC 1928 section 6).
 */
enum class SocksReply(val code: Int) {
    SUCCESS(0x00),
    GENERAL_FAILURE(0x01),
    CONNECTION_NOT_ALLOWED(0x02),
    NETWORK_UNREACHABLE(0x03),
    HOST_UNREACHABLE(0x04),
    CONNECTION_REFUSED(0x05),
    TTL_EXPIRED(0x06),
    COMMAND_NOT_SUPPORTED(0x07),
    ADDRESS_TYPE_NOT_SUPPORTED(0x08),
}

/**
 * Source of domain information for a resolved endpoint.
 */
enum class DomainSource {
    /** Domain came directly from the SOCKS5 CONNECT request. */
    SOCKS5_DOMAIN,
    /** Domain was resolved via IP-to-domain mapping store (fake DNS). */
    DOMAIN_MAPPING,
    /** Domain was recovered from the first TCP payload (HTTP Host or TLS SNI). */
    FIRST_PAYLOAD,
    /** No domain available, only raw IP. */
    NONE,
}

/**
 * Parsed SOCKS5 client greeting (RFC 1928 section 3).
 */
data class SocksGreeting(val methods: List<Int>) {
    /** Returns true if NO AUTHENTICATION REQUIRED (0x00) is among the offered methods. */
    fun hasNoAuth(): Boolean = 0x00 in methods
}

/**
 * Parsed SOCKS5 requests.
 */
sealed class SocksRequest {
    /** Valid CONNECT request with target host, port, and address type. */
    data class Connect(
        val host: String,
        val port: Int,
        val addressType: SocksAddressType,
    ) : SocksRequest()

    /** Client requested BIND or UDP ASSOCIATE, which are not supported. */
    data class UnsupportedCommand(val command: Int) : SocksRequest()

    /** Client requested IPv6, which is not supported in this version. */
    data object UnsupportedAddressType : SocksRequest()

    /** Request was malformed (wrong version, truncated, unknown address type). */
    data object Malformed : SocksRequest()
}

/**
 * SOCKS5 protocol parser and builder.
 *
 * Parses and builds SOCKS5 protocol messages as byte arrays.
 * Does NOT open sockets — only pure data transformation.
 *
 * Reference: RFC 1928 (SOCKS Protocol Version 5)
 */
object SocksProtocol {

    private const val VERSION: Byte = 0x05
    private const val CMD_CONNECT: Int = 0x01
    private const val CMD_BIND: Int = 0x02
    private const val CMD_UDP: Int = 0x03
    private const val METHOD_NO_AUTH: Int = 0x00

    // ── Greeting ────────────────────────────────────────────────────────

    /**
     * Parse client greeting (section 3).
     *
     * Format: +----+----------+----------+
     *         |VER | NMETHODS | METHODS  |
     *         +----+----------+----------+
     *         | 1  |    1     | 1 to 255 |
     *         +----+----------+----------+
     *
     * @throws SocksProtocolException if version is not 5 or data is truncated
     */
    fun parseGreeting(data: ByteArray): SocksGreeting {
        if (data.size < 2) throw SocksProtocolException("Greeting too short")
        if (data[0] != VERSION) throw SocksProtocolException("Unsupported SOCKS version: ${data[0]}")

        val nMethods = data[1].toInt() and 0xFF
        if (data.size < 2 + nMethods) {
            throw SocksProtocolException("Greeting truncated: expected ${2 + nMethods} bytes, got ${data.size}")
        }

        val methods = (0 until nMethods).map { data[2 + it].toInt() and 0xFF }
        return SocksGreeting(methods)
    }

    /**
     * Build server greeting response (section 3).
     *
     * @param acceptNoAuth true to select NO AUTH (0x00), false to reject (0xFF)
     */
    fun buildGreetingResponse(acceptNoAuth: Boolean): ByteArray {
        val method = if (acceptNoAuth) METHOD_NO_AUTH else 0xFF
        return byteArrayOf(VERSION, method.toByte())
    }

    // ── Request ─────────────────────────────────────────────────────────

    /**
     * Parse SOCKS5 request (section 4).
     *
     * Format: +----+-----+-------+------+----------+----------+
     *         |VER | CMD |  RSV  | ATYP | DST.ADDR | DST.PORT |
     *         +----+-----+-------+------+----------+----------+
     *         | 1  |  1  | X'00' |  1   | Variable |    2     |
     *         +----+-----+-------+------+----------+----------+
     *
     * Returns a sealed [SocksRequest] subtype instead of throwing on bad input,
     * so the caller can send the appropriate error reply.
     */
    fun parseRequest(data: ByteArray): SocksRequest {
        // Minimum: VER(1) + CMD(1) + RSV(1) + ATYP(1) = 4 bytes
        if (data.size < 4) return SocksRequest.Malformed
        if (data[0] != VERSION) return SocksRequest.Malformed

        val cmd = data[1].toInt() and 0xFF

        // Only CONNECT is supported
        if (cmd != CMD_CONNECT) {
            return SocksRequest.UnsupportedCommand(cmd)
        }

        val atyp = data[3].toInt() and 0xFF
        return when (atyp) {
            SocksAddressType.IPV4.code -> parseIpv4(data)
            SocksAddressType.DOMAIN.code -> parseDomain(data)
            SocksAddressType.IPV6.code -> SocksRequest.UnsupportedAddressType
            else -> SocksRequest.Malformed
        }
    }

    private fun parseIpv4(data: ByteArray): SocksRequest {
        // VER(1) + CMD(1) + RSV(1) + ATYP(1) + IPv4(4) + PORT(2) = 10
        if (data.size < 10) return SocksRequest.Malformed
        val a = data[4].toInt() and 0xFF
        val b = data[5].toInt() and 0xFF
        val c = data[6].toInt() and 0xFF
        val d = data[7].toInt() and 0xFF
        val host = "$a.$b.$c.$d"
        val port = ((data[8].toInt() and 0xFF) shl 8) or (data[9].toInt() and 0xFF)
        return SocksRequest.Connect(host, port, SocksAddressType.IPV4)
    }

    private fun parseDomain(data: ByteArray): SocksRequest {
        // VER(1) + CMD(1) + RSV(1) + ATYP(1) + LEN(1) = 5 minimum before domain bytes
        if (data.size < 5) return SocksRequest.Malformed
        val len = data[4].toInt() and 0xFF
        // Need: 5 header + len domain + 2 port
        if (data.size < 5 + len + 2) return SocksRequest.Malformed
        val host = String(data, 5, len, Charsets.US_ASCII)
        val portOffset = 5 + len
        val port = ((data[portOffset].toInt() and 0xFF) shl 8) or
            (data[portOffset + 1].toInt() and 0xFF)
        return SocksRequest.Connect(host, port, SocksAddressType.DOMAIN)
    }

    // ── Response ────────────────────────────────────────────────────────

    /**
     * Build SOCKS5 reply (section 6).
     *
     * Uses IPv4 0.0.0.0:0 as the BND.ADDR/BND.PORT placeholder, which is
     * acceptable per RFC 1928 when the implementation does not use the field.
     */
    fun buildResponse(reply: SocksReply): ByteArray {
        return byteArrayOf(
            VERSION,
            reply.code.toByte(),
            0x00, // RSV
            SocksAddressType.IPV4.code.toByte(), // ATYP
            0x00, 0x00, 0x00, 0x00, // BND.ADDR = 0.0.0.0
            0x00, 0x00, // BND.PORT = 0
        )
    }
}
