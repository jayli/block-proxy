package com.blockproxy.android.routing

import com.blockproxy.android.config.RoutingConfig

/**
 * Decides whether a connection should go DIRECT or through the PROXY tunnel.
 *
 * Resolution order:
 * 1. If config is disabled → PROXY (all traffic goes through tunnel)
 * 2. Check directRules first (priority over proxyRules)
 * 3. Check proxyRules
 * 4. Fallback → DIRECT
 *
 * Rule format: "type:code" where type is "domain" or "geosite".
 * Lines starting with # or empty/blank lines are ignored.
 */
class RoutingEngine(
    private val config: RoutingConfig,
    private val geositeMatcher: GeositeMatcher,
) {
    fun resolve(targetHost: String, domain: String?): RouteDecision {
        // 1. Disabled → all traffic proxied
        if (!config.enabled) return RouteDecision.PROXY

        val matchTarget = domain ?: targetHost

        // 2. Check direct rules first (higher priority)
        for (rule in config.directRules) {
            if (matchesRule(rule, matchTarget)) return RouteDecision.DIRECT
        }

        // 3. Check proxy rules
        for (rule in config.proxyRules) {
            if (matchesRule(rule, matchTarget)) return RouteDecision.PROXY
        }

        // 4. Fallback → DIRECT
        return RouteDecision.DIRECT
    }

    /**
     * Check if a single rule string matches the given [host].
     * Returns false for comments, empty lines, or malformed rules.
     */
    private fun matchesRule(rule: String, host: String): Boolean {
        val trimmed = rule.trim()
        // Skip comments and empty lines
        if (trimmed.isEmpty() || trimmed.startsWith("#")) return false

        val colonIndex = trimmed.indexOf(':')
        if (colonIndex < 0) return false // malformed: no colon

        val type = trimmed.substring(0, colonIndex).lowercase()
        val code = trimmed.substring(colonIndex + 1)

        return when (type) {
            "domain" -> matchDomain(code, host)
            "geosite" -> geositeMatcher.matches(code, host)
            else -> false // unknown rule type
        }
    }

    /**
     * Domain suffix matching: matches exact domain and subdomains.
     * e.g. "example.com" matches "example.com", "sub.example.com", "a.b.example.com"
     * but NOT "notexample.com" or "example.com.evil.com"
     */
    private fun matchDomain(pattern: String, host: String): Boolean {
        val lowerPattern = pattern.lowercase()
        val lowerHost = host.lowercase()
        return lowerHost == lowerPattern || lowerHost.endsWith(".$lowerPattern")
    }
}
