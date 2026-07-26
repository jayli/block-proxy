package com.blockproxy.android.tunnel

import com.blockproxy.android.config.ServerConfig
import com.blockproxy.android.config.TunnelCredentials
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class XhttpSessionTest {
    @Test
    fun `parses create response capabilities when present`() {
        val created = XhttpSession.parseCreateSessionResponse(
            """{"sessionId":"sid","capabilities":["upload-batch-v1"]}"""
        )

        assertEquals("sid", created.sessionId)
        assertEquals(listOf(FrameCodec.CAP_UPLOAD_BATCH), created.capabilities)
    }

    @Test
    fun `parses legacy create response without capabilities`() {
        val created = XhttpSession.parseCreateSessionResponse("""{"sessionId":"sid"}""")

        assertEquals("sid", created.sessionId)
        assertEquals(emptyList<String>(), created.capabilities)
    }

    @Test
    fun `builds auth frame with persistent client id`() {
        val frameBytes = XhttpSession.buildAuthFrame(
            config = ServerConfig(serverHost = "example.test", paddingEnabled = true),
            credentials = TunnelCredentials(username = "admin", password = "pass"),
            uploadH2Enabled = true,
            clientId = "client-a",
        )

        val decoded = FrameCodec.decode(frameBytes)
        assertTrue(decoded is Frame.Auth)
        val auth = decoded as Frame.Auth
        assertEquals("admin", auth.username)
        assertEquals("pass", auth.password)
        assertEquals(listOf(FrameCodec.CAP_PADDING, FrameCodec.CAP_UPLOAD_BATCH, FrameCodec.CAP_UPLOAD_H2), auth.capabilities)
        assertEquals("client-a", auth.clientId)
    }
}
