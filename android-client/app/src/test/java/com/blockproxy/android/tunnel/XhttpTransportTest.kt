package com.blockproxy.android.tunnel

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.TimeUnit

class XhttpTransportTest {
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
