package com.blockproxy.android.tunnel

import com.blockproxy.android.cdn.CfIpDns
import com.blockproxy.android.cdn.CfIpSelector
import com.blockproxy.android.config.ServerConfig
import okhttp3.OkHttpClient

class TunnelTransportFactory(
    private val config: ServerConfig,
    private val okHttpClient: OkHttpClient,
    private val cfIpDns: CfIpDns?,
    private val cfIpSelector: CfIpSelector?,
    private val nativeClient: UtlsWsNativeClient,
) {
    suspend fun connect(
        authPayload: ByteArray,
        customHeaders: Map<String, String>,
        onAuthSuccess: (FrameSender) -> Unit,
        onFrame: (FrameSender, ByteArray) -> Unit,
        onDisconnect: (FrameSender, Throwable?) -> Unit,
    ): FrameSender {
        return when (config.transportMode) {
            TunnelTransportMode.OKHTTP -> {
                val tunnelWs = TunnelWebSocket(
                    url = websocketUrl(config),
                    authPayload = authPayload,
                    customHeaders = customHeaders,
                    onAuthSuccess = onAuthSuccess,
                    onFrame = onFrame,
                    onDisconnect = onDisconnect,
                )
                tunnelWs.connect(connectionClient())
            }
            TunnelTransportMode.CHROME_UTLS -> {
                val tunnelWs = NativeUtlsWebSocket(
                    options = buildUtlsOptions(config, authPayload, cfIpSelector),
                    nativeClient = nativeClient,
                    onAuthSuccess = onAuthSuccess,
                    onFrame = onFrame,
                    onDisconnect = onDisconnect,
                )
                tunnelWs.connect()
            }
        }
    }

    private fun connectionClient(): OkHttpClient {
        return if (cfIpDns != null) {
            okHttpClient.newBuilder().dns(cfIpDns).build()
        } else {
            okHttpClient
        }
    }

    companion object {
        fun buildUtlsOptions(
            config: ServerConfig,
            authPayload: ByteArray,
            cfIpSelector: CfIpSelector?,
        ): UtlsWsOptions {
            val selectedIp = if (config.cfCdnEnabled) {
                cfIpSelector?.selectForLookup()
            } else {
                null
            }
            return UtlsWsOptions(
                url = websocketUrl(config),
                dialHost = selectedIp ?: config.serverHost,
                serverName = config.serverHost,
                hostHeader = hostAuthority(config.serverHost, config.serverPort),
                allowInsecure = config.allowInsecure,
                headers = config.customHeaders.map { it.key to it.value },
                initialMessage = authPayload.copyOf(),
            )
        }

        fun websocketUrl(config: ServerConfig): String {
            val wsPath = config.wsPath.let { if (it.startsWith("/")) it else "/$it" }
            return "wss://${config.serverHost}:${config.serverPort}$wsPath"
        }

        fun hostAuthority(host: String, port: Int): String {
            return if (port == 443) host else "$host:$port"
        }
    }
}
