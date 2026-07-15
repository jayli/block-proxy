package com.blockproxy.android.tunnel

object TunnelEndpoint {
    const val DEFAULT_H2_PATH = "/h2-tunnel"
    const val DEFAULT_GRPC_PATH = "/blockproxy.tunnel.TunnelService/Connect"

    fun h2Url(host: String, port: Int, path: String = DEFAULT_H2_PATH): String {
        val normalizedPath = if (path.startsWith("/")) path else "/$path"
        return "https://$host:$port$normalizedPath"
    }

    fun grpcUrl(host: String, port: Int, path: String = DEFAULT_GRPC_PATH): String {
        val normalizedPath = if (path.startsWith("/")) path else "/$path"
        return "https://$host:$port$normalizedPath"
    }
}
