package com.blockproxy.android.tun

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class Tun2SocksMapDnsConfigTest {

    @Test
    fun `mapdns uses VPN DNS address outside fake IP pool`() {
        assertEquals("10.255.0.1", Tun2SocksMapDnsConfig.dnsAddress)
        assertEquals(53, Tun2SocksMapDnsConfig.dnsPort)
        assertEquals("198.18.0.0", Tun2SocksMapDnsConfig.fakeNetwork)
        assertEquals("255.254.0.0", Tun2SocksMapDnsConfig.fakeNetmask)
        assertTrue(Tun2SocksMapDnsConfig.cacheSize > 0)
    }
}
