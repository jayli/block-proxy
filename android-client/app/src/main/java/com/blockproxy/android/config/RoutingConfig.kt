package com.blockproxy.android.config

/**
 * Routing configuration for forward-proxy mode.
 *
 * When [enabled] is true, the VPN routing engine consults [directRules] and
 * [proxyRules] to decide how each connection should be handled:
 *   - direct rules match first → connection goes directly to the destination
 *   - proxy rules match second → connection is forwarded through the tunnel
 *   - fallback → direct
 *
 * When [enabled] is false, all SOCKS5 CONNECT traffic is sent through the proxy.
 *
 * Rules are plain text patterns (domain globs, CIDR ranges, geosite/geoip tags,
 * etc.) interpreted by the routing engine in later tasks.
 *
 * @property enabled     Whether routing rules are active.
 * @property directRules Rules whose matching traffic should bypass the proxy.
 * @property proxyRules  Rules whose matching traffic should go through the proxy.
 */
data class RoutingConfig(
    val enabled: Boolean = false,
    val directRules: List<String> = emptyList(),
    val proxyRules: List<String> = emptyList(),
)
