package com.blockproxy.android.tunnel

import com.blockproxy.android.cdn.CfIpSelector
import com.blockproxy.android.cdn.CfIpSnapshot
import com.blockproxy.android.config.ServerConfig
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeUtlsXhttpUploadClientTest {
    private class FakeNativePostClient(
        private val fail: Boolean = false,
    ) : NativeUtlsPostClient {
        val options = mutableListOf<NativeUtlsPostOptions>()
        val bodies = mutableListOf<ByteArray>()
        var closed = false

        override fun postPacket(options: NativeUtlsPostOptions, body: ByteArray) {
            if (fail) error("native failed")
            this.options += options
            this.bodies += body
        }

        override fun close() {
            closed = true
        }
    }

    private class FakeFallbackUploadClient : XhttpUploadClient {
        var calls = 0
        var lastHeaders: Map<String, String> = emptyMap()

        override suspend fun postFrame(url: String, body: ByteArray, headers: Map<String, String>): Boolean {
            calls++
            lastHeaders = headers
            return true
        }
    }

    @Test
    fun `native upload uses selected cdn ip as dial host`() = runTest {
        val native = FakeNativePostClient()
        val fallback = FakeFallbackUploadClient()
        val selector = CfIpSelector(
            initialSnapshot = CfIpSnapshot(listOf("1.1.1.1", "2.2.2.2"), 0),
            randomIndex = { 0 },
            persistCursor = {},
        )
        val client = NativeUtlsXhttpUploadClient(
            config = ServerConfig(serverHost = "origin.example.com", serverPort = 443),
            selector = selector,
            nativeClient = native,
            fallback = fallback,
        )

        assertTrue(client.postFrame("https://origin.example.com:443/xhttp/upload/s/0", byteArrayOf(1), mapOf("X-Padding" to "abc")))

        assertEquals(1, native.options.size)
        assertEquals("2.2.2.2", native.options.single().dialHost)
        assertEquals("origin.example.com", native.options.single().serverName)
        assertEquals("origin.example.com", native.options.single().hostHeader)
        assertEquals(listOf("Cache-Control" to "no-store", "X-Padding" to "abc"), native.options.single().headers)
        assertEquals(0, fallback.calls)
    }

    @Test
    fun `native upload falls back to okhttp when native fails`() = runTest {
        val native = FakeNativePostClient(fail = true)
        val fallback = FakeFallbackUploadClient()
        val client = NativeUtlsXhttpUploadClient(
            config = ServerConfig(serverHost = "origin.example.com", serverPort = 8443),
            selector = null,
            nativeClient = native,
            fallback = fallback,
        )

        assertTrue(client.postFrame("https://origin.example.com:8443/xhttp/upload/s/0", byteArrayOf(1), mapOf("X-Padding" to "abc")))

        assertEquals(1, fallback.calls)
        assertEquals(mapOf("X-Padding" to "abc"), fallback.lastHeaders)
    }

    @Test
    fun `close closes native client`() {
        val native = FakeNativePostClient()
        val client = NativeUtlsXhttpUploadClient(
            config = ServerConfig(serverHost = "origin.example.com"),
            selector = null,
            nativeClient = native,
            fallback = FakeFallbackUploadClient(),
        )

        client.close()

        assertTrue(native.closed)
    }
}
