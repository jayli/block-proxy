package com.blockproxy.android.tunnel

import org.junit.Assert.assertEquals
import org.junit.Test

class TunnelRotationPolicyTest {
    @Test
    fun `default rotation interval is between one and two hours`() {
        assertEquals(3_600_000L, TunnelRotationPolicy.DEFAULT_MIN_MS)
        assertEquals(7_200_000L, TunnelRotationPolicy.DEFAULT_MAX_MS)
    }
}
