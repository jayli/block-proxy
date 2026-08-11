package com.blockproxy.android.routing

/**
 * Routing decision for a connection.
 */
enum class RouteDecision {
    /** Connect directly to the destination. */
    DIRECT,
    /** Forward through the proxy tunnel. */
    PROXY,
}
