package com.blockproxy.android.routing

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GeositeMatcherTest {

    private fun matcherWith(vararg entries: Pair<String, List<DomainRule>>): GeositeMatcher {
        val data = mutableMapOf<String, List<DomainRule>>()
        for ((tag, ruleList) in entries) {
            data[tag] = ruleList
        }
        return GeositeMatcher(data)
    }

    private fun rules(vararg pairs: Pair<DomainType, String>): List<DomainRule> =
        pairs.map { (type, value) -> DomainRule(type, value) }

    // ── full matching ───────────────────────────────────────────────────

    @Test
    fun `full match exact domain`() {
        val matcher = matcherWith("test" to rules(DomainType.FULL to "example.com"))
        assertTrue(matcher.matches("test", "example.com"))
    }

    @Test
    fun `full match is case insensitive`() {
        val matcher = matcherWith("test" to rules(DomainType.FULL to "Example.COM"))
        assertTrue(matcher.matches("test", "example.com"))
    }

    @Test
    fun `full does not match subdomain`() {
        val matcher = matcherWith("test" to rules(DomainType.FULL to "example.com"))
        assertFalse(matcher.matches("test", "sub.example.com"))
    }

    @Test
    fun `full does not match different domain`() {
        val matcher = matcherWith("test" to rules(DomainType.FULL to "example.com"))
        assertFalse(matcher.matches("test", "notexample.com"))
    }

    // ── domain matching ─────────────────────────────────────────────────

    @Test
    fun `domain matches exact`() {
        val matcher = matcherWith("test" to rules(DomainType.DOMAIN to "example.com"))
        assertTrue(matcher.matches("test", "example.com"))
    }

    @Test
    fun `domain matches subdomain`() {
        val matcher = matcherWith("test" to rules(DomainType.DOMAIN to "example.com"))
        assertTrue(matcher.matches("test", "sub.example.com"))
    }

    @Test
    fun `domain matches nested subdomain`() {
        val matcher = matcherWith("test" to rules(DomainType.DOMAIN to "example.com"))
        assertTrue(matcher.matches("test", "a.b.example.com"))
    }

    @Test
    fun `domain does not match suffix without dot`() {
        val matcher = matcherWith("test" to rules(DomainType.DOMAIN to "example.com"))
        assertFalse(matcher.matches("test", "notexample.com"))
    }

    @Test
    fun `domain does not match evil suffix`() {
        val matcher = matcherWith("test" to rules(DomainType.DOMAIN to "example.com"))
        assertFalse(matcher.matches("test", "example.com.evil.com"))
    }

    @Test
    fun `domain match is case insensitive`() {
        val matcher = matcherWith("test" to rules(DomainType.DOMAIN to "Example.COM"))
        assertTrue(matcher.matches("test", "sub.example.com"))
    }

    // ── plain matching ──────────────────────────────────────────────────

    @Test
    fun `plain matches substring`() {
        val matcher = matcherWith("test" to rules(DomainType.PLAIN to "example"))
        assertTrue(matcher.matches("test", "www.example.com"))
    }

    @Test
    fun `plain matches exact`() {
        val matcher = matcherWith("test" to rules(DomainType.PLAIN to "example.com"))
        assertTrue(matcher.matches("test", "example.com"))
    }

    @Test
    fun `plain is case insensitive`() {
        val matcher = matcherWith("test" to rules(DomainType.PLAIN to "Example"))
        assertTrue(matcher.matches("test", "www.example.com"))
    }

    @Test
    fun `plain does not match when absent`() {
        val matcher = matcherWith("test" to rules(DomainType.PLAIN to "foobar"))
        assertFalse(matcher.matches("test", "example.com"))
    }

    // ── regex matching ──────────────────────────────────────────────────

    @Test
    fun `regex matches pattern`() {
        val matcher = matcherWith("test" to rules(DomainType.REGEX to "^.*\\.google\\.com$"))
        assertTrue(matcher.matches("test", "www.google.com"))
    }

    @Test
    fun `regex does not match non-matching`() {
        val matcher = matcherWith("test" to rules(DomainType.REGEX to "^.*\\.google\\.com$"))
        assertFalse(matcher.matches("test", "www.bing.com"))
    }

    @Test
    fun `regex is case insensitive`() {
        val matcher = matcherWith("test" to rules(DomainType.REGEX to "^.*\\.Google\\.com$"))
        assertTrue(matcher.matches("test", "www.google.com"))
    }

    @Test
    fun `regex invalid pattern does not crash`() {
        val matcher = matcherWith("test" to rules(DomainType.REGEX to "[invalid("))
        assertFalse(matcher.matches("test", "anything.com"))
    }

    // ── Tag lookup ──────────────────────────────────────────────────────

    @Test
    fun `hasTag returns true for existing tag`() {
        val matcher = matcherWith("cn" to rules(DomainType.DOMAIN to "baidu.com"))
        assertTrue(matcher.hasTag("cn"))
    }

    @Test
    fun `hasTag is case insensitive`() {
        val matcher = matcherWith("cn" to rules(DomainType.DOMAIN to "baidu.com"))
        assertTrue(matcher.hasTag("CN"))
    }

    @Test
    fun `hasTag returns false for missing tag`() {
        val matcher = matcherWith("cn" to rules(DomainType.DOMAIN to "baidu.com"))
        assertFalse(matcher.hasTag("us"))
    }

    // ── matchesTag with multiple rules ──────────────────────────────────

    @Test
    fun `matchesTag returns true if any rule matches`() {
        val matcher = matcherWith(
            "test" to rules(
                DomainType.FULL to "exact.com",
                DomainType.DOMAIN to "example.com",
                DomainType.PLAIN to "adserver",
            )
        )
        assertTrue(matcher.matches("test", "exact.com"))
        assertTrue(matcher.matches("test", "sub.example.com"))
        assertTrue(matcher.matches("test", "adserver.evil.com"))
        assertFalse(matcher.matches("test", "other.com"))
    }

    @Test
    fun `matches returns false for unknown tag`() {
        val matcher = matcherWith("cn" to rules(DomainType.DOMAIN to "baidu.com"))
        assertFalse(matcher.matches("nonexistent", "baidu.com"))
    }
}
