package com.blockproxy.android.routing

/**
 * Matches domains against loaded geosite rules.
 * Implements the 4 domain matching strategies: full, domain, plain, regex.
 */
class GeositeMatcher(
    private val data: Map<String, List<DomainRule>>,
) {
    // Normalize keys to lowercase for case-insensitive tag lookup
    private val normalizedData: Map<String, List<DomainRule>> =
        data.mapKeys { it.key.lowercase() }

    /**
     * Check if a geosite tag exists.
     */
    fun hasTag(tag: String): Boolean = tag.lowercase() in normalizedData

    /**
     * Check if [host] matches any rule in the given [tag].
     * Returns false if the tag doesn't exist.
     */
    fun matches(tag: String, host: String): Boolean {
        val rules = normalizedData[tag.lowercase()] ?: return false
        val lowerHost = host.lowercase()
        return rules.any { rule -> matchesRule(rule, lowerHost) }
    }

    /**
     * Check if [host] matches a single [rule].
     */
    private fun matchesRule(rule: DomainRule, lowerHost: String): Boolean {
        return when (rule.type) {
            DomainType.FULL -> lowerHost == rule.value.lowercase()
            DomainType.DOMAIN -> {
                val lowerValue = rule.value.lowercase()
                lowerHost == lowerValue || lowerHost.endsWith(".$lowerValue")
            }
            DomainType.PLAIN -> lowerHost.contains(rule.value.lowercase())
            DomainType.REGEX -> {
                try {
                    Regex(rule.value, RegexOption.IGNORE_CASE).containsMatchIn(lowerHost)
                } catch (_: Exception) {
                    false
                }
            }
        }
    }
}
