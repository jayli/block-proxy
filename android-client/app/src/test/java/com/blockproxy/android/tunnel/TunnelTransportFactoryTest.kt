package com.blockproxy.android.tunnel

import com.blockproxy.android.cdn.CfIpSelector
import com.blockproxy.android.cdn.CfIpSnapshot
import com.blockproxy.android.config.ServerConfig
import org.junit.Assert.assertEquals
import org.junit.Test

class TunnelTransportFactoryTest {

    @Test
    fun `utls options use selected cf ip only for dial host`() {
        val selector = CfIpSelector(CfIpSnapshot(listOf("104.16.4.14"), 0)) {}
        val config = ServerConfig(
            serverHost = "yc.perf.qzz.io",
            serverPort = 443,
            allowInsecure = false,
            cfCdnEnabled = true,
            transportMode = TunnelTransportMode.CHROME_UTLS,
        )

        val options = TunnelTransportFactory.buildUtlsOptions(
            config = config,
            authPayload = byteArrayOf(1, 2, 3),
            cfIpSelector = selector,
        )

        assertEquals("104.16.4.14", options.dialHost)
        assertEquals("yc.perf.qzz.io", options.serverName)
        assertEquals("yc.perf.qzz.io", options.hostHeader)
    }

    @Test
    fun `utls options include non default port in host header`() {
        val config = ServerConfig(
            serverHost = "yc.perf.qzz.io",
            serverPort = 8003,
            allowInsecure = true,
            transportMode = TunnelTransportMode.CHROME_UTLS,
            customHeaders = linkedMapOf("User-Agent" to "Chrome"),
        )

        val options = TunnelTransportFactory.buildUtlsOptions(
            config = config,
            authPayload = byteArrayOf(1),
            cfIpSelector = null,
        )

        assertEquals("yc.perf.qzz.io", options.dialHost)
        assertEquals("yc.perf.qzz.io", options.serverName)
        assertEquals("yc.perf.qzz.io:8003", options.hostHeader)
        assertEquals(listOf("User-Agent" to "Chrome"), options.headers)
    }

    @Test
    fun `utls options preserve websocket path and auth payload`() {
        val authPayload = byteArrayOf(9, 8, 7)
        val config = ServerConfig(
            serverHost = "example.com",
            serverPort = 8443,
            wsPath = "custom-ws",
            transportMode = TunnelTransportMode.CHROME_UTLS,
        )

        val options = TunnelTransportFactory.buildUtlsOptions(
            config = config,
            authPayload = authPayload,
            cfIpSelector = null,
        )

        assertEquals("wss://example.com:8443/custom-ws", options.url)
        assertEquals(authPayload.toList(), options.initialMessage.toList())
    }
}
