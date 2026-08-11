package com.blockproxy.android.tunnel

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
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
            clientId = "client-a",
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

    @Test
    fun `explicit server close posts session close with token`() = runTest {
        var method: String? = null
        var path: String? = null
        val client = OkHttpClient.Builder()
            .addInterceptor { chain ->
                method = chain.request().method
                path = chain.request().url.encodedPath + "?" + chain.request().url.encodedQuery
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body("{}".toResponseBody())
                    .build()
            }
            .build()

        val transport = XhttpTransport(
            baseUrl = "http://example.test/xhttp",
            sessionId = "session-1",
            token = "token-1",
            clientId = "client-a",
            sseHttpClient = client,
            uploadClient = object : XhttpUploadClient {
                override suspend fun postFrame(
                    url: String,
                    body: ByteArray,
                    headers: Map<String, String>,
                ): Boolean = false
            },
        )

        transport.closeSessionOnServer()

        assertEquals("POST", method)
        assertEquals("/xhttp/close/session-1?token=token-1", path)
    }

    @Test
    fun `passive SSE disconnect retries stream with same session id and client id`() = runTest {
        val requestPaths = mutableListOf<String>()
        val attempts = AtomicInteger(0)
        val client = OkHttpClient.Builder()
            .addInterceptor { chain ->
                requestPaths.add(chain.request().url.encodedPath + "?" + chain.request().url.encodedQuery)
                val attempt = attempts.incrementAndGet()
                val code = if (attempt == 1) 200 else 404
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(code)
                    .message(if (code == 200) "OK" else "Not Found")
                    .header("Content-Type", "text/event-stream")
                    .body("".toResponseBody())
                    .build()
            }
            .build()

        val transport = XhttpTransport(
            baseUrl = "http://example.test/xhttp",
            sessionId = "session-1",
            token = "token-1",
            clientId = "client-a",
            sseHttpClient = client,
            uploadClient = object : XhttpUploadClient {
                override suspend fun postFrame(
                    url: String,
                    body: ByteArray,
                    headers: Map<String, String>,
                ): Boolean = false
            },
        )

        val notified = AtomicBoolean(false)
        transport.onSseDisconnected = { notified.set(true) }
        transport.start()
        Thread.sleep(800)

        assertTrue(notified.get())
        assertTrue(requestPaths.size >= 2)
        assertEquals("/xhttp/stream?token=token-1&sessionId=session-1&clientId=client-a", requestPaths[0])
        assertEquals("/xhttp/stream?token=token-1&sessionId=session-1&clientId=client-a", requestPaths[1])
    }
}
