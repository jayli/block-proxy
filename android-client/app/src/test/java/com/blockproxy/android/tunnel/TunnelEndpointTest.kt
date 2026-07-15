package com.blockproxy.android.tunnel

import org.junit.Assert.assertEquals
import org.junit.Test

class TunnelEndpointTest {
    @Test
    fun `builds fixed http2 tunnel url`() {
        assertEquals(
            "https://yc.perf.qzz.io:8003/h2-tunnel",
            TunnelEndpoint.h2Url("yc.perf.qzz.io", 8003),
        )
    }

    @Test
    fun `normalizes custom http2 path`() {
        assertEquals(
            "https://example.com:9443/custom-h2",
            TunnelEndpoint.h2Url("example.com", 9443, "custom-h2"),
        )
    }
}
