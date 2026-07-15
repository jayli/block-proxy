package com.blockproxy.android.tunnel

object TunnelEndpoint {
    const val DEFAULT_H2_PATH = "/h2-tunnel"

    fun h2Url(host: String, port: Int, path: String = DEFAULT_H2_PATH): String {
        val normalizedPath = if (path.startsWith("/")) path else "/$path"
        return "https://$host:$port$normalizedPath"
    }
}
