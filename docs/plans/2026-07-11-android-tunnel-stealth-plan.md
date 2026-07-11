# Android 客户端隧道隐匿改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 Android 隧道客户端从 TLS 原始 Socket + 双连接补充模型改造为 OkHttp WebSocket + 单活跃连接轮换模型，与 Python 端行为完全一致。

**Architecture:** OkHttp WebSocket 替代原始 TLS Socket 作为传输层，单活跃 WS + 定期轮换 + drain 机制替代原有双连接补充模型。WebSocket binary message 承载现有 tunnel 完整 frame（`length(2) + payload`），协议格式保持不变，仅 PING/PONG payload 兼容 Python/服务端的新行为。

**Tech Stack:** Kotlin + OkHttp 4.x WebSocket + Coroutines + Jetpack DataStore

---

### Task 1: 修改 Frame.kt — PING/PONG 支持 payload

**Files:**
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/Frame.kt`

**Step 1: 修改 Frame 类定义**

将 `Ping` / `Pong` 从 `object` 改为 `data class`，支持 payload：

```kotlin
// 修改前:
data object Ping : Frame()
data object Pong : Frame()

// 修改后:
data class Ping(val payload: ByteArray) : Frame() {
    override fun equals(other: Any?): Boolean =
        other is Ping && payload.contentEquals(other.payload)
    override fun hashCode(): Int = payload.contentHashCode()
}
data class Pong(val payload: ByteArray) : Frame() {
    override fun equals(other: Any?): Boolean =
        other is Pong && payload.contentEquals(other.payload)
    override fun hashCode(): Int = payload.contentHashCode()
}
```

**Step 2: 验证编译**

运行: `cd android-client && ./gradlew :app:compileDebugKotlin 2>&1 | tail -5`

---

### Task 2: 修改 FrameCodec.kt — PING/PONG 编解码支持 payload

**Files:**
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/FrameCodec.kt`

**Step 1: 修改 encodePayload 中 PING/PONG 处理**

```kotlin
// 修改前:
is Frame.Ping -> byteArrayOf(FrameType.PING.code.toByte())
is Frame.Pong -> byteArrayOf(FrameType.PONG.code.toByte())

// 修改后:
is Frame.Ping -> {
    val payload = frame.payload
    val result = ByteArray(1 + payload.size)
    result[0] = FrameType.PING.code.toByte()
    System.arraycopy(payload, 0, result, 1, payload.size)
    result
}
is Frame.Pong -> {
    val payload = frame.payload
    val result = ByteArray(1 + payload.size)
    result[0] = FrameType.PONG.code.toByte()
    System.arraycopy(payload, 0, result, 1, payload.size)
    result
}
```

**Step 2: 修改 decodePayload 中 PING/PONG 解码**

```kotlin
// 修改前:
FrameType.PING.code -> {
    if (payload.size != 1) throw IllegalArgumentException(...)
    Frame.Ping
}
FrameType.PONG.code -> {
    if (payload.size != 1) throw IllegalArgumentException(...)
    Frame.Pong
}

// 修改后:
FrameType.PING.code -> {
    Frame.Ping(payload.copyOfRange(1, payload.size))
}
FrameType.PONG.code -> {
    Frame.Pong(payload.copyOfRange(1, payload.size))
}
```

**Step 3: 更新 FrameCodecTest.kt**

修改测试中所有 `Frame.Ping` / `Frame.Pong` 引用为 `Frame.Ping(byteArrayOf())` / `Frame.Pong(byteArrayOf())`，并新增 payload roundtrip 测试。

**Step 4: 验证编译和测试**

运行: `cd android-client && ./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.tunnel.FrameCodecTest" 2>&1 | tail -10`

---

### Task 3: 添加 OkHttp 依赖 + 配置

**Files:**
- Modify: `android-client/app/build.gradle.kts`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/config/ServerConfig.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/config/ConfigRepository.kt`

**Step 1: 添加 OkHttp 依赖**

在 `build.gradle.kts` 的 `dependencies` 块中添加：

```kotlin
implementation("com.squareup.okhttp3:okhttp:4.12.0")
```

**Step 2: 扩展 ServerConfig**

```kotlin
data class ServerConfig(
    val serverHost: String,
    val serverPort: Int = DEFAULT_PORT,
    val useTls: Boolean = true,
    val allowInsecure: Boolean = true,
    // 新增
    val wsPath: String = "/ws",
    val httpDisguise: Boolean = true,
    val customHeaders: Map<String, String> = emptyMap(),
) { ... }
```

语义约束：
- 生产连接固定使用 `wss://`；`useTls` 作为旧配置兼容字段保留，但 WebSocket tunnel 实现默认忽略它并在代码注释中说明。
- 如果后续测试确实需要明文 `ws://`，必须显式增加测试专用配置，不要让 UI 的 `useTls=false` 静默改变生产行为。

**Step 3: 更新 DataStoreConfigDataSource**

添加新 key 的序列化/反序列化：

```kotlin
private companion object {
    val KEY_HOST = stringPreferencesKey("server_host")
    val KEY_PORT = intPreferencesKey("server_port")
    val KEY_USE_TLS = booleanPreferencesKey("use_tls")
    val KEY_ALLOW_INSECURE = booleanPreferencesKey("allow_insecure")
    val KEY_WS_PATH = stringPreferencesKey("ws_path")
    val KEY_HTTP_DISGUISE = booleanPreferencesKey("http_disguise")
}

// observe() 中读取:
wsPath = prefs[KEY_WS_PATH] ?: "/ws",
httpDisguise = prefs[KEY_HTTP_DISGUISE] ?: true,

// save() 中写入:
prefs[KEY_WS_PATH] = config.wsPath
prefs[KEY_HTTP_DISGUISE] = config.httpDisguise
```

注意：`customHeaders` 暂不持久化到 DataStore（使用频率低，先在代码中硬编码，后续如有需要再用 JSON string 持久化）。设计文档和实现必须保持这个语义一致。

**Step 4: 验证编译**

运行: `cd android-client && ./gradlew :app:compileDebugKotlin 2>&1 | tail -5`

---

### Task 4: 新增 TunnelWebSocket.kt — OkHttp WebSocket 封装

**Files:**
- Create: `android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelWebSocket.kt`

**说明：** 这个文件封装 OkHttp WebSocket 的生命周期（连接、认证、帧收发、断连回调），相当于原 `TunnelConnection` 的职责 + OkHttp WebSocket 的适配。

**Step 1: 编写 OkHttpClient 工厂方法**

```kotlin
package com.blockproxy.android.tunnel

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.*
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.IOException
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/** 帧发送结果接口，TunnelClient 通过此接口向 WebSocket 发送帧 */
interface FrameSender {
    /** 发送二进制帧，返回是否成功 */
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
 * @param url             wss://host:port/path
 * @param authPayload     AUTH 帧的编码字节
 * @param customHeaders   自定义 HTTP headers (可为空)
 * @param onAuthSuccess   认证成功回调 (ws, sender) -> Unit
 * @param onFrame         认证后帧回调
 * @param onDisconnect    断连回调 (error: Throwable?) -> Unit
 */
class TunnelWebSocket(
    private val url: String,
    private val authPayload: ByteArray,
    private val customHeaders: Map<String, String>,
    private val onAuthSuccess: (FrameSender) -> Unit,
    private val onFrame: (ByteArray) -> Unit,
    private val onDisconnect: (Throwable?) -> Unit,
) : FrameSender {

    private val sendMutex = Mutex()
    
    @Volatile private var webSocket: WebSocket? = null
    @Volatile override var isOpen: Boolean = false
        private set

    /** 是否为 authenticated 状态（认证已通过） */
    @Volatile private var authenticated: Boolean = false
}
```

**Step 2: 实现 OkHttpClient 创建（trust-all SSL + VPN protect）**

```kotlin
    companion object {
        fun createOkHttpClient(
            allowInsecure: Boolean,
            protect: ((java.net.Socket) -> Boolean)?,
        ): OkHttpClient {
            val builder = OkHttpClient.Builder()
                .pingInterval(null) // 不用 OkHttp 内置 ping
                .readTimeout(0, TimeUnit.MILLISECONDS) // 无超时，由应用层心跳管理
                .writeTimeout(30, TimeUnit.SECONDS)
                .connectTimeout(10, TimeUnit.SECONDS)

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

class ProtectedSocketFactory(
    private val protect: (java.net.Socket) -> Boolean,
) : javax.net.SocketFactory() {
    private val delegate = javax.net.SocketFactory.getDefault()

    private fun protectSocket(socket: java.net.Socket): java.net.Socket {
        val ok = protect(socket)
        if (!ok) {
            android.util.Log.w("TunnelWebSocket", "VpnService.protect() returned false; continuing with app-level VPN exclusion")
        }
        return socket
    }

    override fun createSocket(): java.net.Socket = protectSocket(delegate.createSocket())
    override fun createSocket(host: String, port: Int): java.net.Socket =
        protectSocket(delegate.createSocket()).apply { connect(java.net.InetSocketAddress(host, port)) }
    override fun createSocket(host: String, port: Int, localHost: java.net.InetAddress, localPort: Int): java.net.Socket =
        protectSocket(delegate.createSocket()).apply {
            bind(java.net.InetSocketAddress(localHost, localPort))
            connect(java.net.InetSocketAddress(host, port))
        }
    override fun createSocket(host: java.net.InetAddress, port: Int): java.net.Socket =
        protectSocket(delegate.createSocket()).apply { connect(java.net.InetSocketAddress(host, port)) }
    override fun createSocket(address: java.net.InetAddress, port: Int, localAddress: java.net.InetAddress, localPort: Int): java.net.Socket =
        protectSocket(delegate.createSocket()).apply {
            bind(java.net.InetSocketAddress(localAddress, localPort))
            connect(java.net.InetSocketAddress(address, port))
        }
}
```

`ProtectedSocketFactory.createSocket()` 是 OkHttp 常用路径；其它 overload 是兼容实现。关键约束是 raw socket 必须在 connect 前调用 `VpnService.protect()`，保留旧 `RealTunnelSocket` 的防自捕获行为。

**Step 3: 实现 connect() 和 WebSocketListener**

```kotlin
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
                // 不接受文本帧
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
                    onDisconnect(t)
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
                onDisconnect(null)
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                isOpen = false
                if (!deferred.isCompleted) {
                    deferred.completeExceptionally(t)
                }
                onDisconnect(t)
            }
        })

        // 等待认证完成
        return deferred.await()
    }

    private fun handleAuthResponse(
        frameBytes: ByteArray,
        deferred: CompletableDeferred<FrameSender>,
    ) {
        val ws = webSocket
        val frame = try {
            // WebSocket message carries a complete tunnel frame: length(2) + payload.
            FrameCodec.decode(frameBytes)
        } catch (t: Throwable) {
            ws?.close(1002, "bad auth frame")
            if (!deferred.isCompleted) deferred.completeExceptionally(TunnelProtocolException(t.message ?: "Bad auth frame"))
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
                if (!deferred.isCompleted) deferred.completeExceptionally(TunnelAuthFailedException("Authentication failed"))
            }
            is Frame.Error -> {
                ws?.close(1008, "connection rejected")
                if (!deferred.isCompleted) deferred.completeExceptionally(TunnelOccupiedException(frame.message))
            }
            is Frame.Ping -> {
                webSocket?.send(ByteString.of(*FrameCodec.encode(Frame.Pong(frame.payload))))
            }
            else -> {
                ws?.close(1002, "unexpected auth frame")
                if (!deferred.isCompleted) {
                    deferred.completeExceptionally(
                        TunnelProtocolException("Unexpected frame during auth: ${frame::class.simpleName}")
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
        }
    }

    override fun close(code: Int, reason: String) {
        val ws = webSocket
        if (ws != null && isOpen) {
            isOpen = false
            ws.close(code, reason)
        }
    }
```

**Step 4: 验证编译**

运行: `cd android-client && ./gradlew :app:compileDebugKotlin 2>&1 | tail -5`

---

### Task 5: 修改 ForwardSession.kt — 适配 FrameSender

**Files:**
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/ForwardSession.kt`

**Step 1: 将 `TunnelConnection` 引用改为 `FrameSender`**

```kotlin
// 修改前:
internal val connection: TunnelConnection,
...
connection.send(Frame.Data(reqid, data))

// 修改后:
internal val sender: FrameSender,
...
sender.sendFrame(FrameCodec.encode(Frame.Data(reqid, data)))
```

同样修改 `sendClose` 方法中的 `connection.send(Frame.Close(reqid))` 为 `sender.sendFrame(FrameCodec.encode(Frame.Close(reqid)))`。

**Step 2: 验证编译**

运行: `cd android-client && ./gradlew :app:compileDebugKotlin 2>&1 | tail -5`

---

### Task 6: 修改 ForwardSessionRegistry.kt — 适配 FrameSender

**Files:**
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/ForwardSessionRegistry.kt`

**Step 1: 移除多连接选择逻辑**

```kotlin
// 删除 round-robin 连接选择，改为接受单个 FrameSender + 发送帧回调
class ForwardSessionRegistry(
    private val scope: kotlinx.coroutines.CoroutineScope,
    private val connectTimeoutMs: Long = 10_000L,
    private val reqidMin: Int = FORWARD_REQID_MIN,
    private val reqidMax: Int = FORWARD_REQID_MAX,
    private val inboundCapacity: Int = DEFAULT_INBOUND_CAPACITY,
) {
    // 删除: rrIndex, selectConnection()
    
    // 改为单个 sender，在 open() 时由 TunnelClient 提供
    suspend fun open(
        host: String,
        port: Int,
        sender: FrameSender,
    ): ForwardSession { ... }
    
    // closeSessionsFor 改为按 FrameSender 匹配
    fun closeSessionsFor(sender: FrameSender) { ... }
    
    // 新增: drain 状态查询
    fun getDrainState(sender: FrameSender): DrainState {
        var activeCount = 0
        var lastActivityAt = 0L
        for (session in sessions.values) {
            if (session.sender === sender) {
                activeCount++
                lastActivityAt = maxOf(lastActivityAt, session.lastActivityAt)
            }
        }
        return DrainState(activeCount, lastActivityAt)
    }
}

data class DrainState(val activeCount: Int, val lastActivityAt: Long)
```

**Step 2: ForwardSession 添加 lastActivityAt**

在 `ForwardSession` 中添加 `@Volatile var lastActivityAt: Long = System.currentTimeMillis()`，在 `deliverData` 和 `sendData` 中更新。

**Step 3: 验证编译**

运行: `cd android-client && ./gradlew :app:compileDebugKotlin 2>&1 | tail -5`

---

### Task 7: 修改 ReverseConnectHandler.kt — 适配 FrameSender + drain 状态

**Files:**
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/ReverseConnectHandler.kt`

**Step 1: 将 `TunnelConnection` 引用改为 `FrameSender`**

与 Task 6 类似，`handleFrame` 接受的参数从 `connection: TunnelConnection` 改为 `sender: FrameSender`：

```kotlin
suspend fun handleFrame(sender: FrameSender, frame: Frame) { ... }
fun closeSessionsFor(sender: FrameSender) { ... }
fun getDrainState(sender: FrameSender): DrainState { ... }
```

`RequestSession.internal` 将 `connection` 字段改为 `sender`，发送帧通过 `sender.sendFrame(FrameCodec.encode(frame))`。

**Step 2: 验证编译**

运行: `cd android-client && ./gradlew :app:compileDebugKotlin 2>&1 | tail -5`

---

### Task 8: 删除废弃文件

**Files:**
- Delete: `android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelConnection.kt`
- Delete: `android-client/app/src/main/java/com/blockproxy/android/tunnel/FrameExtractor.kt`
- Delete: `android-client/app/src/main/java/com/blockproxy/android/tunnel/SendQueue.kt`

**Step 1: 删除文件**

```bash
rm android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelConnection.kt
rm android-client/app/src/main/java/com/blockproxy/android/tunnel/FrameExtractor.kt
rm android-client/app/src/main/java/com/blockproxy/android/tunnel/SendQueue.kt
```

**Step 2: 清理相关引用**

检查 `ReverseConnectHandler.kt` 中是否还有 `TunnelSocket` / `TargetSocketFactory` / `RealTargetSocket` 的使用。`RealTargetSocket`（纯 TCP 连接，用于客户端→目标服务器的连接）仍然保留，因为反向 CONNECT 仍然需要连接目标服务器。但它不能再 `implements TunnelSocket`，因为旧 `TunnelSocket` 会随 `TunnelConnection.kt` 删除。

实际上 `TunnelSocket` 接口目前被两个用途共用：
- 隧道连接（`RealTunnelSocket` — TLS）→ 改为 OkHttp WebSocket，**删除**
- 目标连接（`RealTargetSocket` — 纯 TCP）→ 从旧 `TunnelSocket` 中拆出来，继续用于反向 CONNECT

因此需要：
1. 把旧 `TunnelSocket` 拆分为 tunnel 传输和 target 连接两个概念。
2. tunnel 传输改为 `FrameSender` / `TunnelWebSocket`。
3. target 连接保留独立的 `RealTargetSocket` 及其工厂，继续服务反向 CONNECT；不要保留旧 `TunnelSocket` 名称。

**实际方案：** 将隧道传输侧的 `TunnelSocketFactory` / `RealTunnelSocket` / `TunnelConnection` 删除。目标连接侧不要删除，并做如下迁移：

1. `RealTargetSocket` 改为独立类，不再实现旧 `TunnelSocket`。为保持现有测试注入能力，可以新增 target-only 接口，例如：

```kotlin
interface TargetSocket {
    suspend fun connect(host: String, port: Int, timeoutMs: Long)
    suspend fun read(buffer: ByteArray): Int
    suspend fun write(bytes: ByteArray)
    fun close()
}
```

2. `RealTargetSocket` 可以实现 `TargetSocket`，但不能实现旧 `TunnelSocket`；继续在 connect 前调用 `protect(socket)`。
3. `TargetSocketFactory.create()` 返回 `TargetSocket`。
4. `ReverseConnectHandler` 和测试只依赖 `TargetSocket`，不再依赖旧的 `TunnelSocket`。
5. `TunnelAuthFailedException` / `TunnelOccupiedException` / `TunnelProtocolException` 从 `TunnelConnection.kt` 迁移到 `TunnelWebSocket.kt`，因为认证阶段异常由 WebSocket 封装触发。

**Step 3: 触摸编译，修复引用**

运行: `cd android-client && ./gradlew :app:compileDebugKotlin 2>&1 | tail -20`

根据编译错误逐文件修复引用。

---

### Task 9: 重写 TunnelClient.kt — 核心逻辑

**Files:**
- Rewrite: `android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelClient.kt`

**Step 1: 编写完整 TunnelClient**

完全重写，参照 Python `tunnel_client.py`，使用 Kotlin 协程实现：

```kotlin
package com.blockproxy.android.tunnel

import com.blockproxy.android.config.ServerConfig
import com.blockproxy.android.status.TunnelStatus
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.OkHttpClient
import okio.ByteString.Companion.toByteString
import java.io.IOException
import java.security.SecureRandom

class TunnelClient(
    private val config: ServerConfig,
    private val credentials: TunnelCredentials,
    private val clientScope: CoroutineScope,
    private val targetSocketFactory: TargetSocketFactory,
    private val protect: ((java.net.Socket) -> Boolean)? = null,
) {
    companion object {
        const val INITIAL_BACKOFF_MS = 1_000L
        const val MAX_BACKOFF_MS = 60_000L
        const val IDLE_TIMEOUT_MS = 60_000L
        const val CONNECT_TIMEOUT_MS = 30_000L
        const val FORWARD_REQID_START = 0x8000
        private const val DEFAULT_ROTATION_MIN_S = 600L
        private const val DEFAULT_ROTATION_MAX_S = 1800L
        private const val DEFAULT_HEARTBEAT_MIN_S = 15L
        private const val DEFAULT_HEARTBEAT_MAX_S = 40L
        private const val DEFAULT_DRAIN_TIMEOUT_S = 10L
        private const val DEFAULT_DRAIN_IDLE_TIMEOUT_S = 20L
    }

    private val _status = MutableStateFlow<TunnelStatus>(TunnelStatus.Disconnected)
    val status: StateFlow<TunnelStatus> = _status.asStateFlow()

    private val handler = ReverseConnectHandler(clientScope, targetSocketFactory)
    private val forwardRegistry = ForwardSessionRegistry(clientScope)

    private val okHttpClient = TunnelWebSocket.createOkHttpClient(
        allowInsecure = config.allowInsecure,
        protect = protect,
    )
    private val secureRandom = SecureRandom()

    // WebSocket 状态
    @Volatile private var activeWs: FrameSender? = null
    @Volatile private var candidateWs: FrameSender? = null
    @Volatile private var drainingWs: FrameSender? = null

    @Volatile private var stopped = true
    @Volatile private var connected = false

    private var mainJob: Job? = null
    private var heartbeatJob: Job? = null
    private var rotationJob: Job? = null

    private val stateMutex = Mutex()
    private val heartbeatStates = java.util.concurrent.ConcurrentHashMap<FrameSender, HeartbeatState>()

    // ── Public API ───────────────

    fun start() { ... }
    suspend fun stop(timeoutMs: Long = 5_000L) { ... }
    suspend fun openForwardSession(host: String, port: Int): ForwardSession { ... }
    fun measureLatency(): Long? { ... }
    fun isConnected(): Boolean = connected

    // ── 连接管理 ─────────────────

    private suspend fun mainLoop() { ... }       // 指数退避重连
    private suspend fun establishConnection(): FrameSender { ... }  // HTTP disguise → wss:// → AUTH
    private suspend fun performHttpDisguise(host: String, port: Int) { ... }

    // ── 轮换 ────────────────────

    private suspend fun rotationLoop() { ... }
    private suspend fun rotationCycle() { ... }

    // ── 帧处理 ──────────────────

    private suspend fun handleFrames(sender: FrameSender) { ... }

    // ── 心跳 ────────────────────

    private suspend fun heartbeatLoop() { ... }

    // ── Drain 状态 ──────────────

    private fun getDrainState(sender: FrameSender): DrainState { ... }
    private fun hasActiveRequests(sender: FrameSender): Boolean { ... }
    private fun isStillDraining(sender: FrameSender, idleTimeoutS: Long): Boolean { ... }
}

private data class HeartbeatState(
    @Volatile var pendingPayload: ByteArray? = null,
    @Volatile var lastPongAt: Long = System.currentTimeMillis(),
)
```

**关键实现要点（对照 Python client/tunnel_client.py）**:

1. **`mainLoop()`** (对应 `_run_loop`): 循环调用 `establishConnection()`，成功后进入 `handleFrames()`；断开后指数退避重连；AUTH_FAIL/Occupied 永久终止。

2. **`establishConnection()`** (对应 `_establish_connection`): 
   - 若 `config.httpDisguise` → 调用 `performHttpDisguise()`
   - 构建 `wss://host:port/path` URL；生产路径固定使用 `wss://`
   - `TunnelWebSocket.connect(okHttpClient)` → 等待认证完成
   - 认证成功后为该 sender 初始化 `heartbeatStates[sender]`
   - 返回 `FrameSender`

3. **`performHttpDisguise()`** (对应 `_perform_http_disguise`):
   - `withContext(Dispatchers.IO)` { okHttpClient.newCall(getRequest).execute() }
   - `delay(random(500, 2000))`
   - `withContext(Dispatchers.IO)` { okHttpClient.newCall(faviconRequest).execute() }
   - `delay(random(500, 2000))`

4. **`handleFrames()`** (对应 `_handle_requests`):
   - 通过 `TunnelWebSocket.onFrame` 回调接收帧
   - 使用 `Channel<ByteArray>` 桥接回调到协程循环
   - 每个 `ByteArray` 必须使用 `FrameCodec.decode(frameBytes)` 解码完整 tunnel frame
   - 分发 FRAME_CONNECT / CONNECT_OK / CONNECT_FAILED / DATA / CLOSE / PING / PONG
   - 收到 PING：立即在同一 sender 上发送 `Frame.Pong(frame.payload)`
   - 收到 PONG：读取 `heartbeatStates[sender].pendingPayload`，payload 匹配时更新 `lastPongAt` 并清空 pending；不匹配时忽略，不要错误更新健康状态
   - 收到 CONNECT：如果 `sender === drainingWs`，发送 `CONNECT_FAILED` 并拒绝新反向请求；否则交给 `ReverseConnectHandler`

5. **`rotationLoop()`** (对应 `_rotation_loop`):
   - `delay(random(600000, 1800000))` → 调用 `rotationCycle()`

6. **`rotationCycle()`** (对应 `_rotation_cycle`):
   - 建立新候选连接 → `candidateWs`
   - 在 `stateMutex` 内原子切换：旧 `activeWs` → `drainingWs`，新候选 → `activeWs`
   - `delay(drain_timeout * 1000)` →
   - 轮询 `isStillDraining(drainingWs, drainIdleTimeoutS)` → 等待排空
   - 关闭 `drainingWs`，清理其 heartbeat state 和 session

7. **`heartbeatLoop()`** (对应 `_heartbeat_loop`):
   - `delay(random(15000, 40000))` →
   - 对 `activeWs` 和 `drainingWs` 分别执行：
     - 如果 `now - heartbeatStates[sender].lastPongAt > heartbeat_timeout`，关闭该 sender
     - 生成随机 8-40 字节 payload
     - 记录到该 sender 的 `HeartbeatState.pendingPayload`
     - `sender.sendFrame(FrameCodec.encode(Frame.Ping(payload)))`
   - 不使用全局 pending payload，避免 active/draining 同时心跳互相覆盖

8. **Drain 状态** (对应 `_get_ws_drain_state`):
   - 合并 `ReverseConnectHandler.getDrainState()` + `ForwardSessionRegistry.getDrainState()`
   - 返回活跃请求数 + 最大最后活动时间

**Step 2: 验证编译**

运行: `cd android-client && ./gradlew :app:compileDebugKotlin 2>&1 | tail -10`

---

### Task 10: 修改 BlockProxyVpnService.kt — 适配新 TunnelClient

**Files:**
- Modify: `android-client/app/src/main/java/com/blockproxy/android/service/BlockProxyVpnService.kt`

**Step 1: 更新 TunnelClient 构造**

```kotlin
// 修改前:
val client = TunnelClient(
    config = config,
    credentials = credentials,
    socketFactory = tunnelSocketFactory,
    targetSocketFactory = targetSocketFactory,
    clientScope = scope,
)

// 修改后:
val client = TunnelClient(
    config = config,
    credentials = credentials,
    clientScope = scope,
    targetSocketFactory = targetSocketFactory,
    protect = protectCallback,
)
```

删除 `tunnelSocketFactory` 相关代码（不再需要 `TunnelSocketFactory` / `RealTunnelSocket`）。

同时更新注释：`protectCallback` 不只用于 direct/target socket，也必须传入 OkHttp tunnel WebSocket 的 protected socket factory，保留旧 TLS tunnel connect 前 `VpnService.protect()` 的行为。

**Step 2: 验证编译**

运行: `cd android-client && ./gradlew :app:compileDebugKotlin 2>&1 | tail -10`

---

### Task 11: 更新单元测试

**Files:**
- Modify: `android-client/app/src/test/java/com/blockproxy/android/tunnel/FrameCodecTest.kt`
- Modify: `android-client/app/src/test/java/com/blockproxy/android/tunnel/TunnelClientTest.kt`
- Modify: `android-client/app/src/test/java/com/blockproxy/android/tunnel/ReverseConnectHandlerTest.kt`
- Modify: `android-client/app/src/test/java/com/blockproxy/android/tunnel/ForwardSessionRegistryTest.kt`
- Modify: `android-client/app/src/test/java/com/blockproxy/android/tunnel/TunnelConnectionTest.kt` → 重命名为 `TunnelWebSocketTest.kt`
- Delete: `android-client/app/src/test/java/com/blockproxy/android/tunnel/FrameExtractorTest.kt`
- Delete: `android-client/app/src/test/java/com/blockproxy/android/tunnel/SendQueueTest.kt`

**Step 1: 更新 FrameCodecTest.kt**

新增 PING/PONG payload roundtrip 测试：

```kotlin
@Test
fun pingWithPayloadRoundtrip() {
    val payload = byteArrayOf(0x01, 0x02, 0x03, 0x04)
    val encoded = FrameCodec.encode(Frame.Ping(payload))
    val decoded = FrameCodec.decode(encoded)
    assertTrue(decoded is Frame.Ping)
    assertArrayEquals(payload, (decoded as Frame.Ping).payload)
}

@Test
fun pongWithPayloadRoundtrip() {
    val payload = ByteArray(20) { it.toByte() }
    val encoded = FrameCodec.encode(Frame.Pong(payload))
    val decoded = FrameCodec.decode(encoded)
    assertTrue(decoded is Frame.Pong)
    assertArrayEquals(payload, (decoded as Frame.Pong).payload)
}

@Test
fun pingWithoutPayload() {
    val encoded = FrameCodec.encode(Frame.Ping(byteArrayOf()))
    val decoded = FrameCodec.decode(encoded)
    assertTrue(decoded is Frame.Ping)
    assertEquals(0, (decoded as Frame.Ping).payload.size)
}
```

**Step 2: 更新其他测试**

- `TunnelClientTest.kt`：完全重写，使用 Mock WebSocket 或直接测试客户端行为
- `ReverseConnectHandlerTest.kt`：适配 FrameSender 接口
- `ForwardSessionRegistryTest.kt`：适配新 API
- 删除 `FrameExtractorTest.kt` 和 `SendQueueTest.kt`
- 重命名 `TunnelConnectionTest.kt` → `TunnelWebSocketTest.kt`
- 新增 `ProtectedSocketFactoryTest` 或等价测试：创建 socket 时会调用 protect callback，protect 返回 false 不抛异常但记录 warning
- 更新 `TunnelProtocolIntegrationTest.kt`：旧 plain TCP server 不再适用，改成 OkHttp MockWebServer WebSocket 或启动真实 Node `tunnel/server.js`

**Step 3: 新增协议兼容测试**

至少覆盖：

```kotlin
@Test
fun websocketMessageUsesFullTunnelFrame() {
    val encoded = FrameCodec.encode(Frame.Ping(byteArrayOf(1, 2, 3)))
    val decoded = FrameCodec.decode(encoded)
    assertTrue(decoded is Frame.Ping)
    assertArrayEquals(byteArrayOf(1, 2, 3), (decoded as Frame.Ping).payload)
}
```

并增加失败用例：认证阶段如果误用 `decodePayload(encoded)` 应抛错，防止回归到错误解码路径。

**Step 4: 新增 WebSocket 认证测试**

覆盖：
- server 返回 `AUTH_OK` → `connect()` 返回 sender 且 `isOpen=true`
- server 返回 `AUTH_FAIL` → `connect()` 抛 `TunnelAuthFailedException`
- server 返回 `ERROR` → `connect()` 抛 `TunnelOccupiedException`
- server 返回 malformed frame → `connect()` 抛 `TunnelProtocolException`
- server 发送文本帧 → Android 关闭连接，code 1003

**Step 5: 新增心跳测试**

覆盖：
- 收到服务端 `PING(payload)` 后，同一 sender 发送 `PONG(payload)`
- Android 主动发送 `PING(payload)` 后，收到匹配 `PONG(payload)` 才更新该 sender 的 `lastPongAt`
- active/draining 同时存在时，两个 sender 的 pending payload 互不覆盖
- 超过 `heartbeat_timeout` 未收到匹配 PONG 时，只关闭超时的 sender

**Step 6: 新增 rotation/drain 测试**

覆盖：
- rotation candidate 认证失败时，旧 active 保持可用
- candidate 认证成功后，新 forward CONNECT 使用新 active
- 旧 draining 上已有 reverse/forward session 的 DATA/CLOSE 继续路由
- draining 无活跃请求或 idle timeout 后关闭并清理 session
- draining 收到新 reverse CONNECT 时返回 CONNECT_FAILED

**Step 7: 运行测试**

运行: `cd android-client && ./gradlew :app:testDebugUnitTest 2>&1 | tail -20`

**Step 8: Android 手工验收**

1. 启动 block-proxy 服务端，启用 WebSocket tunnel server。
2. 安装 debug APK，配置 serverHost/serverPort/credentials。
3. 启动 VPN，确认 Android 状态进入 Connected，服务端日志显示 WebSocket client authenticated。
4. 访问一条 DIRECT 规则目标，确认不走 tunnel。
5. 访问一条 PROXY 规则目标，确认 forward CONNECT 通过 tunnel。
6. 在服务端触发 reverse CONNECT，确认 Android 能连接内网目标并回传数据。
7. 临时缩短 rotation interval，确认新连接认证、旧连接 drain、旧连接关闭全过程无请求中断。

---

### Task 12: 提交 — 隧道隐匿改造完成

**Commit:**

```bash
git add android-client/
git commit -m "feat(android): 隧道隐匿改造 — OkHttp WebSocket + 连接轮换 + HTTP伪装

- 传输层从原始 TLS Socket 改为 OkHttp WebSocket (wss://)
- 连接模型从双连接补充改为单活跃 WS + 定期轮换 + drain
- 新增 HTTP 伪装（GET 请求伪装浏览器访问）
- PING/PONG 支持可变长度 payload，主动随机心跳
- 删除 FrameExtractor / SendQueue / TunnelConnection（由 OkHttp 替代）
- 新增 TunnelWebSocket 封装 OkHttp WebSocket 生命周期
- 配置新增 wsPath / httpDisguise 字段

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```
