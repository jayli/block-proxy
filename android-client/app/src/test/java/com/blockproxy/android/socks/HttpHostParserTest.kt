package com.blockproxy.android.socks

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HttpHostParserTest {

    @Test
    fun `GET request with Host returns hostname`() {
        val request = "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n"

        assertEquals("example.com", HttpHostParser.parseHost(request.toByteArray()))
    }

    @Test
    fun `lowercase host header returns hostname`() {
        val request = "GET / HTTP/1.1\r\nhost: IP.CN\r\n\r\n"

        assertEquals("ip.cn", HttpHostParser.parseHost(request.toByteArray()))
    }

    @Test
    fun `Host port is stripped`() {
        val request = "GET / HTTP/1.1\r\nHost: example.com:8080\r\n\r\n"

        assertEquals("example.com", HttpHostParser.parseHost(request.toByteArray()))
    }

    @Test
    fun `malformed request returns null`() {
        assertNull(HttpHostParser.parseHost("not-http\r\nHost: example.com\r\n\r\n".toByteArray()))
    }

    @Test
    fun `incomplete headers return null`() {
        assertNull(HttpHostParser.parseHost("GET / HTTP/1.1\r\nHost: example.com\r\n".toByteArray()))
    }

    @Test
    fun `IP literal Host returns null`() {
        val request = "GET / HTTP/1.1\r\nHost: 1.2.3.4\r\n\r\n"

        assertNull(HttpHostParser.parseHost(request.toByteArray()))
    }
}
