package com.blockproxy.android.routing

/**
 * Domain matching rule types for geosite entries.
 * Matches the Xray/V2Ray protobuf enum values.
 */
enum class DomainType(val protoValue: Int) {
    PLAIN(0),
    REGEX(1),
    DOMAIN(2),
    FULL(3);

    companion object {
        fun fromProto(value: Int): DomainType =
            entries.firstOrNull { it.protoValue == value } ?: PLAIN
    }
}

/**
 * A single domain matching rule.
 * @property type the matching strategy
 * @property value the pattern to match against
 */
data class DomainRule(
    val type: DomainType,
    val value: String,
)
