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
 * When [enabled] is false, SOCKS5 CONNECT traffic falls back to direct.
 *
 * Rules are plain text patterns interpreted by the routing engine.
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
