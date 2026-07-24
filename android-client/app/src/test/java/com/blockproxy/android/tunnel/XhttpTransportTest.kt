package com.blockproxy.android.tunnel

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.Protocol
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.TimeUnit

class XhttpTransportTest {
    @Test
    fun `default xhttp client keeps reusable upload connections`() {
        XhttpTransport.createOkHttpClient(
            allowInsecure = false,
            protect = null,
        )

        assertEquals(4, XHTTP_CONNECTION_POOL_SIZE)
        assertEquals(60L, XHTTP_CONNECTION_KEEPALIVE_SECONDS)
    }

    @Test
    fun `h1 client pins HTTP 1_1`() {
        val client = XhttpTransport.createOkHttpClient(
            allowInsecure = false,
            protect = null,
            preferHttp2 = false,
        )

        assertEquals(listOf(Protocol.HTTP_1_1), client.protocols)
    }

    @Test
    fun `h2 preferred client allows HTTP 2 with HTTP 1_1 fallback`() {
        val client = XhttpTransport.createOkHttpClient(
            allowInsecure = false,
            protect = null,
            preferHttp2 = true,
        )

        assertTrue(client.protocols.contains(Protocol.HTTP_2))
        assertTrue(client.protocols.contains(Protocol.HTTP_1_1))
    }

    @Test
    fun `late SSE disconnected callback is invoked when transport already closed`() = runTest {
        val transport = XhttpTransport(
            baseUrl = "http://127.0.0.1:1/xhttp",
            sessionId = "session",
            token = "token",
            sseHttpClient = OkHttpClient.Builder()
                .connectTimeout(100, TimeUnit.MILLISECONDS)
                .readTimeout(100, TimeUnit.MILLISECONDS)
                .build(),
            uploadClient = object : XhttpUploadClient {
                override suspend fun postFrame(
                    url: String,
                    body: ByteArray,
                    headers: Map<String, String>,
                ): Boolean = false
            },
        )

        transport.start()
        Thread.sleep(500)

        val notified = AtomicBoolean(false)
        transport.onSseDisconnected = { notified.set(true) }

        assertTrue(notified.get())
    }
}
