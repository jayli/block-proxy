package com.blockproxy.android.cdn

import okhttp3.Dns
import java.net.InetAddress

class CfIpDns(
    private val serverHost: String,
    private val selector: CfIpSelector,
    private val delegate: Dns = Dns.SYSTEM,
    private val rotateOnLookup: Boolean = false,
) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        if (!hostname.equals(serverHost, ignoreCase = true)) {
            return delegate.lookup(hostname)
        }

        val selectedIp = if (rotateOnLookup) {
            selector.selectDifferentForLookup()
        } else {
            selector.selectForLookup()
        }
        if (selectedIp.isNullOrBlank()) {
            return delegate.lookup(hostname)
        }

        return runCatching {
            listOf(InetAddress.getByName(selectedIp))
        }.getOrElse {
            delegate.lookup(hostname)
        }
    }

    fun getCurrentIp(): String? = selector.currentIp()
}
