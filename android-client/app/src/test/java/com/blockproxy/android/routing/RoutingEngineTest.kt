package com.blockproxy.android.routing

import com.blockproxy.android.config.RoutingConfig
import org.junit.Assert.assertEquals
import org.junit.Test

class RoutingEngineTest {

    private fun emptyMatcher() = GeositeMatcher(emptyMap())

    private fun matcherWith(vararg entries: Pair<String, List<DomainRule>>): GeositeMatcher {
        val data = mutableMapOf<String, List<DomainRule>>()
        for ((tag, rules) in entries) {
            data[tag] = rules
        }
        return GeositeMatcher(data)
    }

    private fun rules(vararg pairs: Pair<DomainType, String>): List<DomainRule> =
        pairs.map { (type, value) -> DomainRule(type, value) }

    // ── Disabled config ─────────────────────────────────────────────────

    @Test
    fun `disabled config falls back to DIRECT`() {
        val config = RoutingConfig(enabled = false)
        val engine = RoutingEngine(config, emptyMatcher())
        assertEquals(RouteDecision.DIRECT, engine.resolve("example.com", "example.com"))
        assertEquals(RouteDecision.DIRECT, engine.resolve("1.2.3.4", null))
    }

    // ── Enabled with empty rules ────────────────────────────────────────

    @Test
    fun `enabled with empty rules falls back to DIRECT`() {
        val config = RoutingConfig(enabled = true, directRules = emptyList(), proxyRules = emptyList())
        val engine = RoutingEngine(config, emptyMatcher())
        assertEquals(RouteDecision.DIRECT, engine.resolve("example.com", "example.com"))
    }

    // ── Direct rules take priority ──────────────────────────────────────

    @Test
    fun `direct rule wins over proxy rule`() {
        val config = RoutingConfig(
            enabled = true,
            directRules = listOf("domain:example.com"),
            proxyRules = listOf("domain:example.com"),
        )
        val engine = RoutingEngine(config, emptyMatcher())
        assertEquals(RouteDecision.DIRECT, engine.resolve("example.com", "example.com"))
    }

    @Test
    fun `direct domain rule matches subdomain`() {
        val config = RoutingConfig(
            enabled = true,
            directRules = listOf("domain:example.com"),
        )
        val engine = RoutingEngine(config, emptyMatcher())
        assertEquals(RouteDecision.DIRECT, engine.resolve("sub.example.com", "sub.example.com"))
    }

    // ── Proxy rules ─────────────────────────────────────────────────────

    @Test
    fun `proxy domain rule matches`() {
        val config = RoutingConfig(
            enabled = true,
            proxyRules = listOf("domain:google.com"),
        )
        val engine = RoutingEngine(config, emptyMatcher())
        assertEquals(RouteDecision.PROXY, engine.resolve("www.google.com", "www.google.com"))
    }

    @Test
    fun `proxy rule no match falls back to DIRECT`() {
        val config = RoutingConfig(
            enabled = true,
            proxyRules = listOf("domain:google.com"),
        )
        val engine = RoutingEngine(config, emptyMatcher())
        assertEquals(RouteDecision.DIRECT, engine.resolve("example.com", "example.com"))
    }

    // ── Geosite delegation ──────────────────────────────────────────────

    @Test
    fun `geosite direct rule delegates to matcher`() {
        val matcher = matcherWith("cn" to rules(DomainType.DOMAIN to "baidu.com"))
        val config = RoutingConfig(
            enabled = true,
            directRules = listOf("geosite:cn"),
        )
        val engine = RoutingEngine(config, matcher)
        assertEquals(RouteDecision.DIRECT, engine.resolve("www.baidu.com", "www.baidu.com"))
    }

    @Test
    fun `geosite proxy rule delegates to matcher`() {
        val matcher = matcherWith("google" to rules(DomainType.DOMAIN to "google.com"))
        val config = RoutingConfig(
            enabled = true,
            proxyRules = listOf("geosite:google"),
        )
        val engine = RoutingEngine(config, matcher)
        assertEquals(RouteDecision.PROXY, engine.resolve("www.google.com", "www.google.com"))
    }

    @Test
    fun `geosite rule no match falls back`() {
        val matcher = matcherWith("cn" to rules(DomainType.DOMAIN to "baidu.com"))
        val config = RoutingConfig(
            enabled = true,
            directRules = listOf("geosite:cn"),
        )
        val engine = RoutingEngine(config, matcher)
        assertEquals(RouteDecision.DIRECT, engine.resolve("google.com", "google.com"))
    }

    // ── Comments and empty lines ────────────────────────────────────────

    @Test
    fun `comments and empty lines are ignored`() {
        val config = RoutingConfig(
            enabled = true,
            directRules = listOf("# this is a comment", "", "  ", "domain:example.com"),
        )
        val engine = RoutingEngine(config, emptyMatcher())
        assertEquals(RouteDecision.DIRECT, engine.resolve("example.com", "example.com"))
    }

    // ── domain null fallback ─────────────────────────────────────────────

    @Test
    fun `null domain uses targetHost for matching`() {
        val config = RoutingConfig(
            enabled = true,
            directRules = listOf("domain:192.168.1.1"),
        )
        val engine = RoutingEngine(config, emptyMatcher())
        assertEquals(RouteDecision.DIRECT, engine.resolve("192.168.1.1", null))
    }

    // ── Malformed rules ─────────────────────────────────────────────────

    @Test
    fun `malformed rule without colon is skipped`() {
        val config = RoutingConfig(
            enabled = true,
            directRules = listOf("invalidrule"),
            proxyRules = listOf("domain:google.com"),
        )
        val engine = RoutingEngine(config, emptyMatcher())
        // "invalidrule" has no colon, should be skipped → no direct match
        // "domain:google.com" proxy rule should match
        assertEquals(RouteDecision.PROXY, engine.resolve("google.com", "google.com"))
    }

    @Test
    fun `unknown rule type is skipped`() {
        val config = RoutingConfig(
            enabled = true,
            directRules = listOf("unknown:something"),
        )
        val engine = RoutingEngine(config, emptyMatcher())
        assertEquals(RouteDecision.DIRECT, engine.resolve("example.com", "example.com"))
    }

    // ── Mixed rule types ────────────────────────────────────────────────

    @Test
    fun `mixed domain and geosite rules`() {
        val matcher = matcherWith("cn" to rules(DomainType.DOMAIN to "baidu.com"))
        val config = RoutingConfig(
            enabled = true,
            directRules = listOf("domain:local.net", "geosite:cn"),
            proxyRules = listOf("domain:google.com"),
        )
        val engine = RoutingEngine(config, matcher)
        assertEquals(RouteDecision.DIRECT, engine.resolve("local.net", "local.net"))
        assertEquals(RouteDecision.DIRECT, engine.resolve("www.baidu.com", "www.baidu.com"))
        assertEquals(RouteDecision.PROXY, engine.resolve("www.google.com", "www.google.com"))
        assertEquals(RouteDecision.DIRECT, engine.resolve("other.com", "other.com"))
    }
}
