package com.blockproxy.android.cdn

import okhttp3.Dns
import java.net.InetAddress

class CfIpDns(
    private val serverHost: String,
    private val selector: CfIpSelector,
    private val delegate: Dns = Dns.SYSTEM,
) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        if (!hostname.equals(serverHost, ignoreCase = true)) {
            return delegate.lookup(hostname)
        }

        val selectedIp = selector.selectForLookup()
        if (selectedIp.isNullOrBlank()) {
            return delegate.lookup(hostname)
        }

        return runCatching {
            val ipBytes = InetAddress.getByName(selectedIp).address
            listOf(InetAddress.getByAddress(hostname, ipBytes))
        }.getOrElse {
            delegate.lookup(hostname)
        }
    }

    fun getCurrentIp(): String? = selector.currentIp()

    fun cronetHostResolverRule(): String? {
        val selectedIp = selector.selectForLookup()
        if (selectedIp.isNullOrBlank()) return null

        return runCatching {
            InetAddress.getByName(selectedIp)
            "MAP $serverHost $selectedIp"
        }.getOrNull()
    }
}
