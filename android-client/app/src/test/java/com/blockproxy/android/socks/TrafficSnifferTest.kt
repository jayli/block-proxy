package com.blockproxy.android.socks

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream

@OptIn(ExperimentalCoroutinesApi::class)
class TrafficSnifferTest {

    @Test
    fun `port 80 reads first bytes and returns HTTP Host`() = runTest {
        val payload = "GET / HTTP/1.1\r\nHost: ip.cn\r\n\r\nbody".toByteArray()
        val result = TrafficSniffer(timeoutMs = 100, maxBytes = 1024).sniff(
            endpoint = ipEndpoint(port = 80),
            input = ByteArrayInputStream(payload),
        )

        assertEquals("ip.cn", result.domain)
        assertEquals(SniffSource.HTTP_HOST, result.source)
        assertArrayEquals(payload, result.bufferedBytes)
    }

    @Test
    fun `unsupported port returns without reading`() = runTest {
        val input = CountingInputStream("hello".toByteArray())
        val result = TrafficSniffer(timeoutMs = 100, maxBytes = 1024).sniff(
            endpoint = ipEndpoint(port = 22),
            input = input,
        )

        assertNull(result.domain)
        assertEquals(SniffSource.UNSUPPORTED, result.source)
        assertEquals(0, input.readCount)
        assertEquals(0, result.bufferedBytes.size)
    }

    @Test
    fun `parser failure returns buffered bytes with no domain`() = runTest {
        val payload = "GET / HTTP/1.1\r\nUser-Agent: test\r\n\r\n".toByteArray()
        val result = TrafficSniffer(timeoutMs = 100, maxBytes = 1024).sniff(
            endpoint = ipEndpoint(port = 80),
            input = ByteArrayInputStream(payload),
        )

        assertNull(result.domain)
        assertEquals(SniffSource.NONE, result.source)
        assertArrayEquals(payload, result.bufferedBytes)
    }

    @Test
    fun `large first payload caps buffered bytes`() = runTest {
        val payload = ByteArray(32) { 'a'.code.toByte() }
        val result = TrafficSniffer(timeoutMs = 100, maxBytes = 8).sniff(
            endpoint = ipEndpoint(port = 80),
            input = ByteArrayInputStream(payload),
        )

        assertNull(result.domain)
        assertEquals(SniffSource.TOO_LARGE, result.source)
        assertEquals(8, result.bufferedBytes.size)
    }

    private fun ipEndpoint(port: Int): ResolvedEndpoint =
        ResolvedEndpoint(
            originalHost = "1.2.3.4",
            connectHost = "1.2.3.4",
            port = port,
            domain = null,
            source = DomainSource.NONE,
        )

    private class CountingInputStream(private val bytes: ByteArray) : InputStream() {
        var readCount = 0
            private set

        private val delegate = ByteArrayInputStream(bytes)

        override fun read(): Int {
            readCount++
            return delegate.read()
        }

        override fun read(buffer: ByteArray, off: Int, len: Int): Int {
            readCount++
            return delegate.read(buffer, off, len)
        }
    }
}
