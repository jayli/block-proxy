package com.blockproxy.android.config

/**
 * Server connection configuration persisted by the app.
 *
 * [serverHost] / [serverPort] are the tunnel-server address that
 * [com.blockproxy.android.tunnel.TunnelClient] connects to directly.
 *
 * @property useTls       Whether to wrap the tunnel connection in TLS.
 * @property allowInsecure When [useTls] is true, whether to accept self-signed / untrusted certs.
 */
data class ServerConfig(
    val serverHost: String,
    val serverPort: Int = DEFAULT_PORT,
    val useTls: Boolean = true,
    val allowInsecure: Boolean = true,
    // WebSocket tunnel 新增
    val wsPath: String = "/websocket",
    val httpDisguise: Boolean = true,
    val customHeaders: Map<String, String> = emptyMap(),
    val cfCdnEnabled: Boolean = false,
    val paddingEnabled: Boolean = true,
    val paddingProbability: Float = 0.05f,
    val paddingMinBytes: Int = 64,
    val paddingMaxBytes: Int = 512,
) {
    companion object {
        /** Default tunnel server port (matches block-proxy tunnel server). */
        const val DEFAULT_PORT: Int = 8003
    }
}

/**
 * SOCKS5 / tunnel authentication credentials.
 *
 * Never persist this directly — use [CredentialStore] which encodes the
 * password before writing to disk.
 */
data class TunnelCredentials(
    val username: String,
    val password: String,
)
