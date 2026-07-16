package com.blockproxy.android.tunnel

import com.blockproxy.android.config.ServerConfig
import com.blockproxy.android.config.TunnelCredentials
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class SseControlClientTest {
    private lateinit var server: SimpleHttpServer
    private var responseCode = 200
    private var contentType = "text/event-stream"
    private var responseBody = "event: wake\ndata: {}\n\n"

    @Before
    fun setup() {
        server = SimpleHttpServer { responseCode to (contentType to responseBody) }
    }

    @After
    fun tearDown() {
        server.close()
    }

    @Test
    fun `connectAndRead returns Wake when wake event arrives`() = runBlocking {
        responseBody = "retry: 5000\n\nevent: wake\ndata: {}\n\n"

        assertEquals(SseControlResult.Wake, client().connectAndRead())
    }

    @Test
    fun `connectAndRead returns Disconnected when stream ends without wake`() = runBlocking {
        responseBody = ": keepalive\n\n"

        assertEquals(SseControlResult.Disconnected, client().connectAndRead())
    }

    @Test
    fun `connectAndRead returns AuthFailed on 401`() = runBlocking {
        responseCode = 401
        contentType = "application/json"
        responseBody = """{"error":"invalid token"}"""

        assertEquals(SseControlResult.AuthFailed, client().connectAndRead())
    }

    @Test
    fun `connectAndRead returns NotSupported on 404`() = runBlocking {
        responseCode = 404
        contentType = "text/plain"
        responseBody = "not found"

        assertEquals(SseControlResult.NotSupported, client().connectAndRead())
    }

    @Test
    fun `connectAndRead returns Failed when 200 is not event stream`() = runBlocking {
        contentType = "text/html"
        responseBody = "<html></html>"

        assertEquals(SseControlResult.Failed, client().connectAndRead())
    }

    private fun client(): SseControlClient {
        return SseControlClient(
            config = ServerConfig(
                serverHost = "unused.example",
                useTls = false,
                sseHost = "127.0.0.1",
                ssePort = server.port,
                ssePath = "/api/v1/events",
            ),
            credentials = TunnelCredentials("admin", "secret"),
            okHttpClient = OkHttpClient.Builder().build(),
            dispatcher = Dispatchers.IO,
        )
    }

    private class SimpleHttpServer(
        private val response: () -> Pair<Int, Pair<String, String>>,
    ) : AutoCloseable {
        private val socket = ServerSocket(0)
        private val ready = CountDownLatch(1)
        val port: Int = socket.localPort
        private val thread = Thread {
            ready.countDown()
            while (!socket.isClosed) {
                try {
                    val client = socket.accept()
                    client.getInputStream().bufferedReader().readLine()
                    val (code, content) = response()
                    val (contentType, body) = content
                    val bytes = body.toByteArray(Charsets.UTF_8)
                    val status = if (code == 200) "OK" else "ERR"
                    val headers = "HTTP/1.1 $code $status\r\n" +
                        "Content-Type: $contentType\r\n" +
                        "Content-Length: ${bytes.size}\r\n" +
                        "Connection: close\r\n\r\n"
                    client.getOutputStream().use {
                        it.write(headers.toByteArray(Charsets.US_ASCII))
                        it.write(bytes)
                    }
                    client.close()
                } catch (_: Exception) {
                    if (!socket.isClosed) throw RuntimeException("test server failed")
                }
            }
        }

        init {
            thread.isDaemon = true
            thread.start()
            ready.await(1, TimeUnit.SECONDS)
        }

        override fun close() {
            socket.close()
        }
    }
}
