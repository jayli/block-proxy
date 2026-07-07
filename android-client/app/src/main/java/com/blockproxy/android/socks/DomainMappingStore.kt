package com.blockproxy.android.socks

import java.util.concurrent.ConcurrentHashMap

/**
 * In-memory cache for IP-to-domain mapping.
 *
 * Thread-safe. May be fed by fakeDNS or local resolver in later tasks.
 * When tun2socks sends a CONNECT with a fake IP (e.g. 198.18.x.x),
 * this store maps it back to the original domain for routing decisions.
 */
class DomainMappingStore {
    private val map = ConcurrentHashMap<String, String>()

    /** Store a domain mapping for the given IP. Overwrites any previous mapping. */
    fun put(ip: String, domain: String) {
        map[ip] = domain
    }

    /** Look up the domain for the given IP. Returns null if not mapped. */
    fun get(ip: String): String? = map[ip]

    /** Remove all mappings. */
    fun clear() {
        map.clear()
    }
}

/**
 * Result of resolving a SOCKS5 CONNECT target against the domain mapping store.
 *
 * - [originalHost]: what the SOCKS5 client sent (IP or domain)
 * - [connectHost]: what to actually connect to (domain if fake IP mapped, otherwise originalHost)
 * - [port]: target port
 * - [domain]: domain if available (from SOCKS5 or mapping), null otherwise
 * - [source]: where the domain information came from
 *
 * **Critical**: When [source] is [DomainSource.DOMAIN_MAPPING], [connectHost] is the
 * mapped domain, NOT the fake IP. This prevents forwarding fake IPs to direct sockets
 * or the Forward CONNECT tunnel.
 */
data class ResolvedEndpoint(
    val originalHost: String,
    val connectHost: String,
    val port: Int,
    val domain: String?,
    val source: DomainSource,
) {
    companion object {
        /**
         * Resolve a SOCKS5 CONNECT request against the domain mapping store.
         */
        fun resolve(request: SocksRequest.Connect, store: DomainMappingStore): ResolvedEndpoint {
            return when (request.addressType) {
                SocksAddressType.DOMAIN -> ResolvedEndpoint(
                    originalHost = request.host,
                    connectHost = request.host,
                    port = request.port,
                    domain = request.host,
                    source = DomainSource.SOCKS5_DOMAIN,
                )
                else -> {
                    val mappedDomain = store.get(request.host)
                    ResolvedEndpoint(
                        originalHost = request.host,
                        connectHost = mappedDomain ?: request.host,
                        port = request.port,
                        domain = mappedDomain,
                        source = if (mappedDomain != null) DomainSource.DOMAIN_MAPPING else DomainSource.NONE,
                    )
                }
            }
        }
    }
}
