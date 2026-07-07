package com.blockproxy.android.config

/**
 * Server connection configuration persisted by the app.
 *
 * [serverHost] / [serverPort] are the primary tunnel-server address.
 * [tunnelHost] / [tunnelPort] are optional overrides that take effect when
 * present and non-blank (see [effectiveHost] / [effectivePort]).
 *
 * @property useTls       Whether to wrap the tunnel connection in TLS.
 * @property allowInsecure When [useTls] is true, whether to accept self-signed / untrusted certs.
 */
data class ServerConfig(
    val serverHost: String,
    val serverPort: Int = DEFAULT_PORT,
    val useTls: Boolean = true,
    val allowInsecure: Boolean = true,
    val tunnelHost: String? = null,
    val tunnelPort: Int? = null,
) {
    /** The host the tunnel client should actually connect to. */
    val effectiveHost: String
        get() = tunnelHost?.takeIf { it.isNotBlank() } ?: serverHost

    /** The port the tunnel client should actually connect to. */
    val effectivePort: Int
        get() = tunnelPort ?: serverPort

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
