package com.blockproxy.android.socks

import org.junit.Assert.*
import org.junit.Test

class SocksProtocolTest {

    // ── parseGreeting ───────────────────────────────────────────────────

    @Test
    fun `parseGreeting with NO_AUTH only`() {
        // VER=5, NMETHODS=1, METHODS=[0x00]
        val data = byteArrayOf(0x05, 0x01, 0x00)
        val greeting = SocksProtocol.parseGreeting(data)
        assertEquals(listOf(0x00), greeting.methods)
        assertTrue(greeting.hasNoAuth())
    }

    @Test
    fun `parseGreeting with NO_AUTH among multiple methods`() {
        // VER=5, NMETHODS=3, METHODS=[0x02, 0x01, 0x00]
        val data = byteArrayOf(0x05, 0x03, 0x02, 0x01, 0x00)
        val greeting = SocksProtocol.parseGreeting(data)
        assertEquals(listOf(0x02, 0x01, 0x00), greeting.methods)
        assertTrue(greeting.hasNoAuth())
    }

    @Test
    fun `parseGreeting without NO_AUTH`() {
        // VER=5, NMETHODS=1, METHODS=[0x02] (username/password only)
        val data = byteArrayOf(0x05, 0x01, 0x02)
        val greeting = SocksProtocol.parseGreeting(data)
        assertEquals(listOf(0x02), greeting.methods)
        assertFalse(greeting.hasNoAuth())
    }

    @Test(expected = SocksProtocolException::class)
    fun `parseGreeting with wrong version throws`() {
        val data = byteArrayOf(0x04, 0x01, 0x00)
        SocksProtocol.parseGreeting(data)
    }

    @Test(expected = SocksProtocolException::class)
    fun `parseGreeting with empty input throws`() {
        SocksProtocol.parseGreeting(byteArrayOf())
    }

    @Test(expected = SocksProtocolException::class)
    fun `parseGreeting with too short input throws`() {
        // Only VER, missing NMETHODS
        SocksProtocol.parseGreeting(byteArrayOf(0x05))
    }

    @Test(expected = SocksProtocolException::class)
    fun `parseGreeting with NMETHODS exceeding data length throws`() {
        // VER=5, NMETHODS=3, but only 1 method byte
        SocksProtocol.parseGreeting(byteArrayOf(0x05, 0x03, 0x00))
    }

    @Test
    fun `parseGreeting with zero methods`() {
        // VER=5, NMETHODS=0
        val data = byteArrayOf(0x05, 0x00)
        val greeting = SocksProtocol.parseGreeting(data)
        assertTrue(greeting.methods.isEmpty())
        assertFalse(greeting.hasNoAuth())
    }

    // ── buildGreetingResponse ───────────────────────────────────────────

    @Test
    fun `buildGreetingResponse accept NO_AUTH`() {
        val response = SocksProtocol.buildGreetingResponse(acceptNoAuth = true)
        assertArrayEquals(byteArrayOf(0x05, 0x00), response)
    }

    @Test
    fun `buildGreetingResponse reject no acceptable method`() {
        val response = SocksProtocol.buildGreetingResponse(acceptNoAuth = false)
        assertArrayEquals(byteArrayOf(0x05, 0xFF.toByte()), response)
    }

    // ── parseRequest CONNECT IPv4 ───────────────────────────────────────

    @Test
    fun `parseRequest CONNECT IPv4`() {
        // VER=5, CMD=0x01(CONNECT), RSV=0x00, ATYP=0x01(IPv4)
        // IP=192.168.1.1, PORT=8080(0x1F90)
        val data = byteArrayOf(
            0x05, 0x01, 0x00, 0x01,
            192.toByte(), 168.toByte(), 0x01, 0x01,
            0x1F, 0x90.toByte()
        )
        val request = SocksProtocol.parseRequest(data)
        assertTrue(request is SocksRequest.Connect)
        val connect = request as SocksRequest.Connect
        assertEquals("192.168.1.1", connect.host)
        assertEquals(8080, connect.port)
        assertEquals(SocksAddressType.IPV4, connect.addressType)
    }

    @Test
    fun `parseRequest CONNECT IPv4 port 443`() {
        // IP=10.0.0.1, PORT=443(0x01BB)
        val data = byteArrayOf(
            0x05, 0x01, 0x00, 0x01,
            0x0A, 0x00, 0x00, 0x01,
            0x01, 0xBB.toByte()
        )
        val request = SocksProtocol.parseRequest(data)
        assertTrue(request is SocksRequest.Connect)
        val connect = request as SocksRequest.Connect
        assertEquals("10.0.0.1", connect.host)
        assertEquals(443, connect.port)
    }

    // ── parseRequest CONNECT domain ─────────────────────────────────────

    @Test
    fun `parseRequest CONNECT domain`() {
        // VER=5, CMD=0x01, RSV=0x00, ATYP=0x03(DOMAIN)
        // LEN=11, DOMAIN="example.com", PORT=443(0x01BB)
        val domain = "example.com"
        val domainBytes = domain.toByteArray(Charsets.US_ASCII)
        val data = byteArrayOf(0x05, 0x01, 0x00, 0x03, domainBytes.size.toByte()) +
            domainBytes + byteArrayOf(0x01, 0xBB.toByte())
        val request = SocksProtocol.parseRequest(data)
        assertTrue(request is SocksRequest.Connect)
        val connect = request as SocksRequest.Connect
        assertEquals("example.com", connect.host)
        assertEquals(443, connect.port)
        assertEquals(SocksAddressType.DOMAIN, connect.addressType)
    }

    @Test
    fun `parseRequest CONNECT domain with subdomain`() {
        val domain = "www.google.com"
        val domainBytes = domain.toByteArray(Charsets.US_ASCII)
        val data = byteArrayOf(0x05, 0x01, 0x00, 0x03, domainBytes.size.toByte()) +
            domainBytes + byteArrayOf(0x00, 0x50)
        val request = SocksProtocol.parseRequest(data)
        assertTrue(request is SocksRequest.Connect)
        val connect = request as SocksRequest.Connect
        assertEquals("www.google.com", connect.host)
        assertEquals(80, connect.port)
    }

    // ── parseRequest CONNECT IPv6 ───────────────────────────────────────

    @Test
    fun `parseRequest CONNECT IPv6 returns unsupported address type`() {
        // VER=5, CMD=0x01, RSV=0x00, ATYP=0x04(IPv6)
        // 16 bytes of IPv6 address (::1), PORT=80
        val data = byteArrayOf(0x05, 0x01, 0x00, 0x04) +
            ByteArray(15) { 0x00 } + byteArrayOf(0x01) +
            byteArrayOf(0x00, 0x50)
        val request = SocksProtocol.parseRequest(data)
        assertTrue(request is SocksRequest.UnsupportedAddressType)
    }

    // ── parseRequest UDP ASSOCIATE ──────────────────────────────────────

    @Test
    fun `parseRequest UDP ASSOCIATE returns unsupported command`() {
        // VER=5, CMD=0x03(UDP), RSV=0x00, ATYP=0x01, IP=0.0.0.0, PORT=0
        val data = byteArrayOf(
            0x05, 0x03, 0x00, 0x01,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00
        )
        val request = SocksProtocol.parseRequest(data)
        assertTrue(request is SocksRequest.UnsupportedCommand)
        assertEquals(0x03, (request as SocksRequest.UnsupportedCommand).command)
    }

    // ── parseRequest BIND ───────────────────────────────────────────────

    @Test
    fun `parseRequest BIND returns unsupported command`() {
        // VER=5, CMD=0x02(BIND), RSV=0x00, ATYP=0x01, IP=0.0.0.0, PORT=0
        val data = byteArrayOf(
            0x05, 0x02, 0x00, 0x01,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00
        )
        val request = SocksProtocol.parseRequest(data)
        assertTrue(request is SocksRequest.UnsupportedCommand)
        assertEquals(0x02, (request as SocksRequest.UnsupportedCommand).command)
    }

    // ── parseRequest malformed ──────────────────────────────────────────

    @Test
    fun `parseRequest with wrong version returns malformed`() {
        val data = byteArrayOf(0x04, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x50)
        val request = SocksProtocol.parseRequest(data)
        assertTrue(request is SocksRequest.Malformed)
    }

    @Test
    fun `parseRequest with empty input returns malformed`() {
        val request = SocksProtocol.parseRequest(byteArrayOf())
        assertTrue(request is SocksRequest.Malformed)
    }

    @Test
    fun `parseRequest with too short input returns malformed`() {
        // Only VER + CMD, missing RSV + ATYP + address + port
        val request = SocksProtocol.parseRequest(byteArrayOf(0x05, 0x01))
        assertTrue(request is SocksRequest.Malformed)
    }

    @Test
    fun `parseRequest with unknown address type returns malformed`() {
        // VER=5, CMD=0x01, RSV=0x00, ATYP=0x05(unknown)
        val data = byteArrayOf(0x05, 0x01, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x50)
        val request = SocksProtocol.parseRequest(data)
        assertTrue(request is SocksRequest.Malformed)
    }

    @Test
    fun `parseRequest domain with truncated data returns malformed`() {
        // VER=5, CMD=0x01, RSV=0x00, ATYP=0x03, LEN=10, but only 3 bytes of domain
        val data = byteArrayOf(0x05, 0x01, 0x00, 0x03, 0x0A, 0x61, 0x62, 0x63)
        val request = SocksProtocol.parseRequest(data)
        assertTrue(request is SocksRequest.Malformed)
    }

    @Test
    fun `parseRequest IPv4 with truncated address returns malformed`() {
        // VER=5, CMD=0x01, RSV=0x00, ATYP=0x01, but only 2 bytes of IPv4
        val data = byteArrayOf(0x05, 0x01, 0x00, 0x01, 0x0A, 0x00)
        val request = SocksProtocol.parseRequest(data)
        assertTrue(request is SocksRequest.Malformed)
    }

    // ── buildResponse ───────────────────────────────────────────────────

    @Test
    fun `buildResponse SUCCESS`() {
        val response = SocksProtocol.buildResponse(SocksReply.SUCCESS)
        // VER=5, REP=0x00, RSV=0x00, ATYP=0x01, BND.ADDR=0.0.0.0, BND.PORT=0
        assertEquals(10, response.size)
        assertEquals(0x05.toByte(), response[0])
        assertEquals(0x00.toByte(), response[1]) // SUCCESS
        assertEquals(0x00.toByte(), response[2]) // RSV
        assertEquals(0x01.toByte(), response[3]) // ATYP IPv4
        // 4 bytes of 0.0.0.0
        assertEquals(0x00.toByte(), response[4])
        assertEquals(0x00.toByte(), response[5])
        assertEquals(0x00.toByte(), response[6])
        assertEquals(0x00.toByte(), response[7])
        // 2 bytes of port 0
        assertEquals(0x00.toByte(), response[8])
        assertEquals(0x00.toByte(), response[9])
    }

    @Test
    fun `buildResponse GENERAL_FAILURE`() {
        val response = SocksProtocol.buildResponse(SocksReply.GENERAL_FAILURE)
        assertEquals(0x05.toByte(), response[0])
        assertEquals(0x01.toByte(), response[1])
    }

    @Test
    fun `buildResponse COMMAND_NOT_SUPPORTED`() {
        val response = SocksProtocol.buildResponse(SocksReply.COMMAND_NOT_SUPPORTED)
        assertEquals(0x05.toByte(), response[0])
        assertEquals(0x07.toByte(), response[1])
    }

    @Test
    fun `buildResponse ADDRESS_TYPE_NOT_SUPPORTED`() {
        val response = SocksProtocol.buildResponse(SocksReply.ADDRESS_TYPE_NOT_SUPPORTED)
        assertEquals(0x05.toByte(), response[0])
        assertEquals(0x08.toByte(), response[1])
    }

    // ── ResolvedEndpoint.resolve ────────────────────────────────────────

    @Test
    fun `resolve domain target returns SOCKS5_DOMAIN source`() {
        val store = DomainMappingStore()
        val request = SocksRequest.Connect("example.com", 443, SocksAddressType.DOMAIN)
        val endpoint = ResolvedEndpoint.resolve(request, store)

        assertEquals("example.com", endpoint.originalHost)
        assertEquals("example.com", endpoint.connectHost)
        assertEquals(443, endpoint.port)
        assertEquals("example.com", endpoint.domain)
        assertEquals(DomainSource.SOCKS5_DOMAIN, endpoint.source)
    }

    @Test
    fun `resolve IP with mapping returns DOMAIN_MAPPING and mapped domain as connectHost`() {
        val store = DomainMappingStore()
        store.put("198.18.0.5", "example.com")
        val request = SocksRequest.Connect("198.18.0.5", 443, SocksAddressType.IPV4)
        val endpoint = ResolvedEndpoint.resolve(request, store)

        assertEquals("198.18.0.5", endpoint.originalHost)
        assertEquals("example.com", endpoint.connectHost)
        assertEquals(443, endpoint.port)
        assertEquals("example.com", endpoint.domain)
        assertEquals(DomainSource.DOMAIN_MAPPING, endpoint.source)
    }

    @Test
    fun `resolve IP without mapping returns NONE and original IP as connectHost`() {
        val store = DomainMappingStore()
        val request = SocksRequest.Connect("1.2.3.4", 80, SocksAddressType.IPV4)
        val endpoint = ResolvedEndpoint.resolve(request, store)

        assertEquals("1.2.3.4", endpoint.originalHost)
        assertEquals("1.2.3.4", endpoint.connectHost)
        assertEquals(80, endpoint.port)
        assertNull(endpoint.domain)
        assertEquals(DomainSource.NONE, endpoint.source)
    }
}
