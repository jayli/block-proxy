package com.blockproxy.android.cdn

import okhttp3.Dns
import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.InetAddress

private class FakeDns : Dns {
    val lookups = mutableListOf<String>()

    override fun lookup(hostname: String): List<InetAddress> {
        lookups += hostname
        return listOf(InetAddress.getByName("203.0.113.10"))
    }
}

class CfIpDnsTest {

    @Test
    fun `non-server host delegates to delegate dns`() {
        val delegate = FakeDns()
        val selector = CfIpSelector(CfIpSnapshot(listOf("104.16.4.14"), 0)) {}
        val dns = CfIpDns("tunnel.example.com", selector, delegate)

        val result = dns.lookup("other.example.com")

        assertEquals(listOf("other.example.com"), delegate.lookups)
        assertEquals("203.0.113.10", result.single().hostAddress)
    }

    @Test
    fun `server host resolves selected cf ip`() {
        val delegate = FakeDns()
        val selector = CfIpSelector(CfIpSnapshot(listOf("104.16.4.14"), 0)) {}
        val dns = CfIpDns("tunnel.example.com", selector, delegate)

        val result = dns.lookup("tunnel.example.com")

        assertEquals(emptyList<String>(), delegate.lookups)
        assertEquals("104.16.4.14", result.single().hostAddress)
        assertEquals("tunnel.example.com", result.single().hostName)
        assertEquals("104.16.4.14", dns.getCurrentIp())
    }

    @Test
    fun `server host builds cronet host resolver rule for selected cf ip`() {
        val delegate = FakeDns()
        val selector = CfIpSelector(CfIpSnapshot(listOf("104.16.4.14"), 0)) {}
        val dns = CfIpDns("tunnel.example.com", selector, delegate)

        assertEquals("MAP tunnel.example.com 104.16.4.14", dns.cronetHostResolverRule())
        assertEquals("104.16.4.14", dns.getCurrentIp())
    }

    @Test
    fun `server host comparison is case-insensitive`() {
        val delegate = FakeDns()
        val selector = CfIpSelector(CfIpSnapshot(listOf("104.16.4.14"), 0)) {}
        val dns = CfIpDns("Tunnel.Example.Com", selector, delegate)

        val result = dns.lookup("tunnel.example.com")

        assertEquals(emptyList<String>(), delegate.lookups)
        assertEquals("104.16.4.14", result.single().hostAddress)
    }

    @Test
    fun `empty selector falls back to delegate dns`() {
        val delegate = FakeDns()
        val selector = CfIpSelector(CfIpSnapshot(emptyList(), 0)) {}
        val dns = CfIpDns("tunnel.example.com", selector, delegate)

        val result = dns.lookup("tunnel.example.com")

        assertEquals(listOf("tunnel.example.com"), delegate.lookups)
        assertEquals("203.0.113.10", result.single().hostAddress)
        assertEquals(null, dns.cronetHostResolverRule())
    }

    @Test
    fun `invalid selected ip falls back to delegate dns`() {
        val delegate = FakeDns()
        val selector = CfIpSelector(CfIpSnapshot(listOf("not an ip"), 0)) {}
        val dns = CfIpDns("tunnel.example.com", selector, delegate)

        val result = dns.lookup("tunnel.example.com")

        assertEquals(listOf("tunnel.example.com"), delegate.lookups)
        assertEquals("203.0.113.10", result.single().hostAddress)
        assertEquals(null, dns.cronetHostResolverRule())
    }
}
