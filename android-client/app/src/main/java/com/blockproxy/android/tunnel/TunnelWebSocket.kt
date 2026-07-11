package com.blockproxy.android.tunnel

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.IOException
import java.security.SecureRandom
import java.time.Duration
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/** 帧发送接口，TunnelClient 通过此接口向 WebSocket 发送帧 */
interface FrameSender {
    /** 发送二进制帧（完整 encoded frame），返回是否成功 */
    suspend fun sendFrame(encoded: ByteArray): Boolean
    /** 关闭 WebSocket */
    fun close(code: Int, reason: String)
    /** 当前连接是否可发送 */
    val isOpen: Boolean
}

/** Thrown when the server responds with AUTH_FAIL. */
class TunnelAuthFailedException(message: String) : Exception(message)

/** Thrown when the server responds with ERROR during the authentication phase. */
class TunnelOccupiedException(message: String) : Exception(message)

/** Thrown when an unexpected or malformed frame is received during authentication. */
class TunnelProtocolException(message: String) : Exception(message)

/**
 * OkHttp WebSocket 连接封装。
 *
 * 负责 WebSocket 生命周期（连接、AUTH 认证、帧收发、断连回调）。
 * 所有帧通过 OkHttp WebSocket binary message 承载，每个 message 是完整的
 * tunnel 协议 frame（2-byte length + payload），解码使用 FrameCodec.decode()。
 *
 * WebSocketListener 在 OkHttp 后台线程回调，认证结果通过 CompletableDeferred
 * 传回 connect() 调用方。
 *
 * @param url             wss://host:port/path
 * @param authPayload     预编码的 AUTH 帧
 * @param customHeaders   自定义 HTTP headers (可为空)
 * @param onAuthSuccess   认证成功回调
 * @param onFrame         认证后的帧回调（完整 encoded frame bytes）
 * @param onDisconnect    断连回调 (error != null 表示异常断开)
 */
class TunnelWebSocket(
    private val url: String,
    private val authPayload: ByteArray,
    private val customHeaders: Map<String, String>,
    private val onAuthSuccess: (FrameSender) -> Unit,
    private val onFrame: (ByteArray) -> Unit,
    private val onDisconnect: (FrameSender, Throwable?) -> Unit,
) : FrameSender {

    private val sendMutex = Mutex()

    @Volatile private var webSocket: WebSocket? = null
    @Volatile override var isOpen: Boolean = false
        private set

    /** 是否为 authenticated 状态（认证已通过） */
    @Volatile private var authenticated: Boolean = false

    companion object {
        fun createOkHttpClient(
            allowInsecure: Boolean,
            protect: ((java.net.Socket) -> Boolean)?,
        ): OkHttpClient {
            val builder = OkHttpClient.Builder()
                .pingInterval(Duration.ZERO) // 不用 OkHttp 内置 ping
                .readTimeout(Duration.ZERO) // 无超时，由应用层心跳管理
                .writeTimeout(Duration.ofSeconds(30))
                .connectTimeout(Duration.ofSeconds(10))

            if (protect != null) {
                builder.socketFactory(ProtectedSocketFactory(protect))
            }

            if (allowInsecure) {
                val trustAllCerts = arrayOf<TrustManager>(object : X509TrustManager {
                    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                    override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
                })
                val sslContext = SSLContext.getInstance("TLS").apply {
                    init(null, trustAllCerts, SecureRandom())
                }
                builder.sslSocketFactory(sslContext.socketFactory, trustAllCerts[0] as X509TrustManager)
                builder.hostnameVerifier { _, _ -> true }
            }
            return builder.build()
        }
    }

    suspend fun connect(client: OkHttpClient): FrameSender {
        val deferred = CompletableDeferred<FrameSender>()

        val requestBuilder = Request.Builder().url(url)
        customHeaders.forEach { (k, v) -> requestBuilder.addHeader(k, v) }
        val request = requestBuilder.build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                ws.send(ByteString.of(*authPayload))
            }

            override fun onMessage(ws: WebSocket, text: String) {
                ws.close(1003, "binary frames required")
            }

            override fun onMessage(ws: WebSocket, bytes: ByteString) {
                val frameBytes = bytes.toByteArray()
                if (!authenticated) {
                    handleAuthResponse(frameBytes, deferred)
                    return
                }
                try {
                    onFrame(frameBytes)
                } catch (t: Throwable) {
                    ws.close(1002, "bad frame")
                    onDisconnect(this@TunnelWebSocket, t)
                }
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                ws.close(code, reason)
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                isOpen = false
                if (!deferred.isCompleted) {
                    deferred.completeExceptionally(IOException("Closed before auth: $code $reason"))
                }
                onDisconnect(this@TunnelWebSocket, null)
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                isOpen = false
                if (!deferred.isCompleted) {
                    deferred.completeExceptionally(t)
                }
                onDisconnect(this@TunnelWebSocket, t)
            }
        })

        return deferred.await()
    }

    private fun handleAuthResponse(
        frameBytes: ByteArray,
        deferred: CompletableDeferred<FrameSender>,
    ) {
        val ws = webSocket
        val frame = try {
            FrameCodec.decode(frameBytes)
        } catch (t: Throwable) {
            ws?.close(1002, "bad auth frame")
            if (!deferred.isCompleted) {
                deferred.completeExceptionally(
                    TunnelProtocolException(t.message ?: "Bad auth frame")
                )
            }
            return
        }

        when (frame) {
            is Frame.AuthOk -> {
                authenticated = true
                isOpen = true
                onAuthSuccess(this@TunnelWebSocket)
                if (!deferred.isCompleted) deferred.complete(this@TunnelWebSocket)
            }
            is Frame.AuthFail -> {
                ws?.close(1008, "auth failed")
                if (!deferred.isCompleted) {
                    deferred.completeExceptionally(
                        TunnelAuthFailedException("Authentication failed")
                    )
                }
            }
            is Frame.Error -> {
                ws?.close(1008, "connection rejected")
                if (!deferred.isCompleted) {
                    deferred.completeExceptionally(TunnelOccupiedException(frame.message))
                }
            }
            is Frame.Ping -> {
                ws?.send(ByteString.of(*FrameCodec.encode(Frame.Pong(frame.payload))))
            }
            else -> {
                ws?.close(1002, "unexpected auth frame")
                if (!deferred.isCompleted) {
                    deferred.completeExceptionally(
                        TunnelProtocolException(
                            "Unexpected frame during auth: ${frame::class.simpleName}"
                        )
                    )
                }
            }
        }
    }

    override suspend fun sendFrame(encoded: ByteArray): Boolean {
        val ws = webSocket ?: return false
        return sendMutex.withLock {
            if (!isOpen) return@withLock false
            ws.send(ByteString.of(*encoded))
            true
        }
    }

    override fun close(code: Int, reason: String) {
        val ws = webSocket
        if (ws != null && isOpen) {
            isOpen = false
            ws.close(code, reason)
        }
    }
}

/**
 * 在 connect() 前调用 VpnService.protect() 的 SocketFactory 适配器。
 *
 * OkHttp 创建 socket 时，通过该工厂在 connect 前注入 protect 调用，
 * 避免 WebSocket 连接被自身 VPN TUN 捕获形成路由回环。
 */
class ProtectedSocketFactory(
    private val protect: (java.net.Socket) -> Boolean,
) : SocketFactory() {
    private val delegate = SocketFactory.getDefault()

    private fun protectSocket(socket: java.net.Socket): java.net.Socket {
        val ok = protect(socket)
        if (!ok) {
            android.util.Log.w(
                "ProtectedSocketFactory",
                "VpnService.protect() returned false; continuing with app-level VPN exclusion"
            )
        }
        return socket
    }

    override fun createSocket(): java.net.Socket =
        protectSocket(delegate.createSocket())

    override fun createSocket(host: String, port: Int): java.net.Socket =
        protectSocket(delegate.createSocket()).apply {
            connect(java.net.InetSocketAddress(host, port))
        }

    override fun createSocket(
        host: String, port: Int, localHost: java.net.InetAddress, localPort: Int,
    ): java.net.Socket =
        protectSocket(delegate.createSocket()).apply {
            bind(java.net.InetSocketAddress(localHost, localPort))
            connect(java.net.InetSocketAddress(host, port))
        }

    override fun createSocket(host: java.net.InetAddress, port: Int): java.net.Socket =
        protectSocket(delegate.createSocket()).apply {
            connect(java.net.InetSocketAddress(host, port))
        }

    override fun createSocket(
        address: java.net.InetAddress, port: Int,
        localAddress: java.net.InetAddress, localPort: Int,
    ): java.net.Socket =
        protectSocket(delegate.createSocket()).apply {
            bind(java.net.InetSocketAddress(localAddress, localPort))
            connect(java.net.InetSocketAddress(address, port))
        }
}
