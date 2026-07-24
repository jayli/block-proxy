package com.blockproxy.android.tunnel

import org.junit.Assert.assertEquals
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
}
