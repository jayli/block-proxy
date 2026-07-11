# Android 客户端隧道隐匿改造实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 Android 隧道客户端从 TLS 原始 Socket + 双连接补充模型改造为 OkHttp WebSocket + 单活跃连接轮换模型，与 Python 端行为完全一致。

**Architecture:** OkHttp WebSocket 替代原始 TLS Socket 作为传输层，单活跃 WS + 定期轮换 + drain 机制替代原有双连接补充模型，帧协议保持不变。

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

注意：`customHeaders` 暂不持久化到 DataStore（使用频率低，先在代码中硬编码，后续如有需要再加 UI）。

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
}

/**
 * OkHttp WebSocket 连接封装。
 *
 * @param url             wss://host:port/path
 * @param authPayload     AUTH 帧的编码字节
 * @param headers         自定义 HTTP headers (可为空)
 * @param allowInsecure   是否信任自签证书
 * @param onAuthSuccess   认证成功回调 (ws, sender) -> Unit
 * @param onFrame         认证后帧回调
 * @param onDisconnect    断连回调 (error: Throwable?) -> Unit
 */
class TunnelWebSocket(
    private val url: String,
    private val authPayload: ByteArray,
    private val headers: Map<String, String>,
    private val allowInsecure: Boolean,
    private val onAuthSuccess: (FrameSender) -> Unit,
    private val onFrame: (ByteArray) -> Unit,
    private val onDisconnect: (Throwable?) -> Unit,
) : FrameSender {

    private val authCompleted = CompletableDeferred<Unit>()
    private val sendMutex = Mutex()
    
    @Volatile private var webSocket: WebSocket? = null
    @Volatile var isOpen: Boolean = false
        private set

    /** 是否为 authenticated 状态（认证已通过） */
    val isAuthenticated: Boolean get() = authCompleted.isCompleted
}
```

**Step 2: 实现 OkHttpClient 创建（trust-all SSL）**

```kotlin
    companion object {
        fun createOkHttpClient(allowInsecure: Boolean): OkHttpClient {
            val builder = OkHttpClient.Builder()
                .pingInterval(null) // 不用 OkHttp 内置 ping
                .readTimeout(0, TimeUnit.MILLISECONDS) // 无超时，由应用层心跳管理
                .writeTimeout(30, TimeUnit.SECONDS)
                .connectTimeout(10, TimeUnit.SECONDS)

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
```

**Step 3: 实现 connect() 和 WebSocketListener**

```kotlin
    suspend fun connect(client: OkHttpClient) {
        val requestBuilder = Request.Builder().url(url)
        headers.forEach { (k, v) -> requestBuilder.addHeader(k, v) }
        val request = requestBuilder.build()

        val deferred = CompletableDeferred<Unit>()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                // 立即发送 AUTH 帧
                ws.send(ByteString.of(*authPayload))
            }

            override fun onMessage(ws: WebSocket, text: String) {
                // 不接受文本帧
                ws.close(1003, "binary frames required")
            }

            override fun onMessage(ws: WebSocket, bytes: ByteString) {
                val frameBytes = bytes.toByteArray()
                if (!isAuthenticated) {
                    handleAuthResponse(frameBytes)
                } else {
                    onFrame(frameBytes)
                }
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                ws.close(code, reason)
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                isOpen = false
                if (!authCompleted.isCompleted) {
                    authCompleted.completeExceptionally(IOException("Connection closed before auth"))
                }
                onDisconnect(null)
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                isOpen = false
                if (!authCompleted.isCompleted) {
                    authCompleted.completeExceptionally(t)
                }
                onDisconnect(t)
            }
        })

        // 等待认证完成
        deferred.await() // 实际由 handleAuthResponse 完成
    }
```

**注意：** 上面的 `deferred` 是多余的。认证由 `handleAuthResponse` 通过 `authCompleted` 完成，`onAuthSuccess` 回调通知。需要简化为一个 `CompletableDeferred`。重写如下：

```kotlin
    suspend fun connect(client: OkHttpClient): Result<FrameSender> {
        val deferred = CompletableDeferred<Result<FrameSender>>()

        val requestBuilder = Request.Builder().url(url)
        headers.forEach { (k, v) -> requestBuilder.addHeader(k, v) }
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
                if (!isAuthenticated) {
                    val result = handleAuthResponse(frameBytes)
                    if (result != null) {
                        isOpen = true
                        onAuthSuccess(this@TunnelWebSocket)
                        deferred.complete(Result.success(this@TunnelWebSocket))
                    }
                } else {
                    onFrame(frameBytes)
                }
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                isOpen = false
                if (!deferred.isCompleted) {
                    deferred.complete(Result.failure(IOException("Closed: $code $reason")))
                }
                onDisconnect(null)
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                isOpen = false
                if (!deferred.isCompleted) {
                    deferred.complete(Result.failure(t))
                }
                onDisconnect(t)
            }
        })

        return deferred.await()
    }

    private fun handleAuthResponse(frameBytes: ByteArray): Unit? {
        val frame = FrameCodec.decodePayload(frameBytes)
        return when (frame) {
            is Frame.AuthOk -> Unit // 认证成功
            is Frame.AuthFail -> throw TunnelAuthFailedException("Authentication failed")
            is Frame.Error -> throw TunnelOccupiedException(frame.message)
            is Frame.Ping -> {
                webSocket?.send(ByteString.of(*FrameCodec.encode(Frame.Pong(frame.payload))))
                null // 还没认证完，继续等待
            }
            else -> throw TunnelProtocolException("Unexpected frame during auth: ${frame::class.simpleName}")
        }
    }

    override suspend fun sendFrame(encoded: ByteArray): Boolean {
        val ws = webSocket ?: return false
        return sendMutex.withLock {
            if (!isOpen || ws == null) return@withLock false
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

检查 `ReverseConnectHandler.kt` 中是否还有 `TunnelSocket` / `TargetSocketFactory` / `RealTargetSocket` 的使用。`RealTargetSocket`（纯 TCP 连接，用于客户端→目标服务器的连接）仍然保留，因为反向 CONNECT 仍然需要连接目标服务器。但需要把 `TunnelSocket` 接口用于目标连接的部分保留，只移除隧道连接的部分。

实际上 `TunnelSocket` 接口目前被两个用途共用：
- 隧道连接（`RealTunnelSocket` — TLS）→ 改为 OkHttp WebSocket，**删除**
- 目标连接（`RealTargetSocket` — 纯 TCP）→ 保留，用于反向 CONNECT

因此需要：
1. 把 `TunnelSocket` 重命名或拆分。更简单的做法：`ReverseConnectHandler` 中的目标连接直接用 `java.net.Socket` 或保留 `RealTargetSocket` 作为独立类（不实现 `TunnelSocket` 接口）。
2. 在 `ReverseConnectHandler` 中把目标连接改为直接用 Socket。

**实际方案：** 将 `TunnelSocket` 接口和 `RealTunnelSocket` 一起删除。`RealTargetSocket` 改为独立类，不再实现已删除的接口。`ReverseConnectHandler` 直接使用 `RealTargetSocket`。

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

    private val okHttpClient = TunnelWebSocket.createOkHttpClient(config.allowInsecure)
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

    // Forward reqid 分配
    @Volatile private var forwardReqidCounter = FORWARD_REQID_START

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

    // ── Forward ─────────────────

    private fun allocateForwardReqid(): Int { ... }

    // ── Drain 状态 ──────────────

    private fun getDrainState(sender: FrameSender): DrainState { ... }
    private fun hasActiveRequests(sender: FrameSender): Boolean { ... }
    private fun isStillDraining(sender: FrameSender, idleTimeoutS: Long): Boolean { ... }
}
```

**关键实现要点（对照 Python client/tunnel_client.py）**:

1. **`mainLoop()`** (对应 `_run_loop`): 循环调用 `establishConnection()`，成功后进入 `handleFrames()`；断开后指数退避重连；AUTH_FAIL/Occupied 永久终止。

2. **`establishConnection()`** (对应 `_establish_connection`): 
   - 若 `config.httpDisguise` → 调用 `performHttpDisguise()`
   - 构建 `wss://host:port/path` URL
   - `TunnelWebSocket.connect(okHttpClient)` → 等待认证完成
   - 返回 `FrameSender`

3. **`performHttpDisguise()`** (对应 `_perform_http_disguise`):
   - `withContext(Dispatchers.IO)` { okHttpClient.newCall(getRequest).execute() }
   - `delay(random(500, 2000))`
   - `withContext(Dispatchers.IO)` { okHttpClient.newCall(faviconRequest).execute() }
   - `delay(random(500, 2000))`

4. **`handleFrames()`** (对应 `_handle_requests`):
   - 通过 `TunnelWebSocket.onFrame` 回调接收帧
   - 使用 `Channel<ByteArray>` 桥接回调到协程循环
   - 分发 FRAME_CONNECT / CONNECT_OK / CONNECT_FAILED / DATA / CLOSE / PONG

5. **`rotationLoop()`** (对应 `_rotation_loop`):
   - `delay(random(600000, 1800000))` → 调用 `rotationCycle()`

6. **`rotationCycle()`** (对应 `_rotation_cycle`):
   - 建立新候选连接 → `candidateWs`
   - 旧 `activeWs` → `drainingWs`，新候选 → `activeWs`
   - `delay(drain_timeout * 1000)` →
   - 轮询 `isStillDraining(drainingWs, drainIdleTimeoutS)` → 等待排空
   - 关闭 `drainingWs`

7. **`heartbeatLoop()`** (对应 `_heartbeat_loop`):
   - `delay(random(15000, 40000))` →
   - 生成随机 8-40 字节 payload →
   - `activeWs?.sendFrame(encode(FRAME_PING, payload=payload))` →
   - 记录 `pendingPingPayload = payload`
   - 在 `handleFrames` 中收到 PONG 时校验 payload 匹配

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
)
```

删除 `tunnelSocketFactory` 相关代码（不再需要 `TunnelSocketFactory` / `RealTunnelSocket`）。

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

**Step 3: 运行测试**

运行: `cd android-client && ./gradlew :app:testDebugUnitTest 2>&1 | tail -20`

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
