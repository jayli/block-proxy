package com.blockproxy.android.cdn

import android.util.Log
import okhttp3.Dns
import java.net.InetAddress

private const val TAG = "CfIpDns"

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
            Log.w(TAG, "No CF IP selected for $hostname; falling back to system DNS")
            return delegate.lookup(hostname)
        }

        return runCatching {
            val ipBytes = InetAddress.getByName(selectedIp).address
            listOf(InetAddress.getByAddress(hostname, ipBytes))
        }.getOrElse {
            Log.w(TAG, "Invalid CF IP $selectedIp for $hostname; falling back to system DNS")
            delegate.lookup(hostname)
        }
    }

    fun getCurrentIp(): String? = selector.currentIp()
}
