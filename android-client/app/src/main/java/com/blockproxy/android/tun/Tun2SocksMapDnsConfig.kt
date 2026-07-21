package com.blockproxy.android.tun

/**
 * Native hev-socks5-tunnel mapped DNS settings.
 *
 * DNS queries sent to [dnsAddress] are answered inside tun2socks with fake
 * IPv4 addresses from [fakeNetwork]/[fakeNetmask]. Later TCP connections to
 * those fake IPs are converted back to SOCKS5 domain CONNECT requests by hev.
 */
object Tun2SocksMapDnsConfig {
    const val dnsAddress: String = "10.255.0.1"
    const val dnsPort: Int = 53
    const val fakeNetwork: String = "198.18.0.0"
    const val fakeNetmask: String = "255.254.0.0"
    const val cacheSize: Int = 10_000
}
