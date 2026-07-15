package com.blockproxy.android.service

import com.blockproxy.android.tunnel.TunnelTransportMode
import org.junit.Assert.assertEquals
import org.junit.Test

class TransportModePolicyTest {
    @Test
    fun `okhttp remains okhttp when app exclusion fails`() {
        assertEquals(
            TunnelTransportMode.OKHTTP,
            effectiveTransportMode(TunnelTransportMode.OKHTTP, appExclusionSucceeded = false),
        )
    }

    @Test
    fun `chrome utls remains enabled when app exclusion succeeds`() {
        assertEquals(
            TunnelTransportMode.CHROME_UTLS,
            effectiveTransportMode(TunnelTransportMode.CHROME_UTLS, appExclusionSucceeded = true),
        )
    }

    @Test
    fun `chrome utls falls back to okhttp when app exclusion fails`() {
        assertEquals(
            TunnelTransportMode.OKHTTP,
            effectiveTransportMode(TunnelTransportMode.CHROME_UTLS, appExclusionSucceeded = false),
        )
    }
}
