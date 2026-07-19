package com.blockproxy.android.tunnel

import com.blockproxy.android.config.ServerConfig
import com.blockproxy.android.config.TunnelCredentials
import okhttp3.OkHttpClient

/**
 * xhttp 传输工厂。
 *
 * 使用 XhttpSession 建立 xhttp 会话（POST create + SSE stream），
 * 返回 XhttpTransport 实例。
 */
class TunnelTransportFactory(
    private val config: ServerConfig,
    private val credentials: TunnelCredentials,
    private val sseHttpClient: OkHttpClient,
    private val uploadClient: XhttpUploadClient,
    private val protect: ((java.net.Socket) -> Boolean)? = null,
) {
    /**
     * 建立 xhttp 连接。
     *
     * @return XhttpTransport 实例（已启动 SSE，下行在线后按需 POST 上行）
     */
    suspend fun connect(): XhttpTransport {
        val session = XhttpSession(
            config = config,
            credentials = credentials,
            sseHttpClient = sseHttpClient,
            uploadClient = uploadClient,
            protect = protect,
        )
        return session.establish()
    }
}
