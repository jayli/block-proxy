package com.blockproxy.android.tunnel

import org.junit.Assert.assertTrue
import org.junit.Test
import okio.Buffer

class OkHttpH2TunnelStreamTest {
    @Test
    fun streamingRequestBodyIsDuplexForBidirectionalHttp2Tunnel() {
        val body = OkHttpH2TunnelStream.createStreamingRequestBodyForTest(
            authPayload = byteArrayOf(0x00, 0x00)
        )

        assertTrue(body.isDuplex())
        assertTrue(body.isOneShot())
    }

    @Test
    fun duplexRequestBodyWriteToReturnsWithoutWaitingForFutureFrames() {
        val body = OkHttpH2TunnelStream.createStreamingRequestBodyForTest(
            authPayload = byteArrayOf(0x00, 0x00)
        )
        val writer = Thread {
            body.writeTo(Buffer())
        }

        writer.start()
        writer.join(300)

        assertTrue("writeTo must return so OkHttp can read response headers", !writer.isAlive)
    }
}
