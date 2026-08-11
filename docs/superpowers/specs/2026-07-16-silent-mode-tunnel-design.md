# 高隐匿性双向隧道设计 — 静默模式规范

**版本**: 1.0
**日期**: 2026-07-16
**状态**: 设计完成，待实现

---

## 1. 概述

### 1.1 目标

在当前 WebSocket 双向隧道架构基础上，引入**静默模式（Silent Mode）**，实现：

- **按需驱动**：无业务流量时主动断开 WS 连接，消除持续性心跳特征
- **SSE 控制面唤醒**：静默期间通过 HTTP/1.1 Server-Sent Events 接收服务端唤醒信号
- **快速重建**：收到唤醒信号后立即重建 WS 隧道，缓冲期间请求不丢失
- **向后兼容**：服务端同时支持新旧两种模式，客户端可自主选择

### 1.2 设计原则

1. **状态机驱动**：客户端维护 ACTIVE ↔ SLEEPING 状态转换，服务端被动感知
2. **协议解耦**：控制面（HTTP/1.1 SSE）与数据面（WebSocket）分离
3. **零侵入**：静默模式关闭时，现有逻辑完全不受影响
4. **最小权限**：SSE 走系统网络栈，不经过 VPN，不需要证书校验

### 1.3 适用范围

本设计**仅适用于 Android 客户端**。macOS 客户端（`/client/`）暂不涉及。

---

## 2. 架构总览

### 2.1 服务端架构变化

```
                          ┌───────────────────────────────────────────┐
                          │        Server (Port 8003 TLS)             │
                          │                                           │
                          │  ┌─────────┐  ┌──────────┐  ┌─────────┐ │
  HTTPS GET ─────────────►│  │SSE       │  │WakeBuffer│  │TunnelMgr│ │
  <ssePath>?token=xxx     │  │ Handler  │─►│ (queue)  │──│(forward)│ │
                          │  └────┬─────┘  └──────────┘  └────┬────┘ │
                          │       │                           │      │
                          │       │  WAKE signal              │      │
                          │       ▼                           │      │
  WSS /websocket ────────►│  ┌─────────────────────────────┐  │      │
                          │  │      TunnelServer            │◄─┘      │
                          │  │  (heartbeat: 210-270s rand)  │         │
                          │  └─────────────────────────────┘         │
                          └───────────────────────────────────────────┘
```

### 2.2 客户端架构变化

```
                          ┌──────────────────────────────────┐
                          │    SilentModeController (新增)    │
                          │                                  │
                          │  ┌───────────┐ ┌─────────────┐  │
                          │  │SseControl │ │TunnelClient  │  │
                          │  │Client     │ │(现有)        │  │
                          │  └───────────┘ └─────────────┘  │
                          └──────────────────────────────────┘
```

---

## 3. 核心机制

### 3.1 心跳机制改造（全局生效）

**改造前**：
- 服务端每 15-40 秒随机发 PING
- 客户端回 PONG
- 60 秒无 PONG 则断开

**改造后**：
- 服务端每 **210-270 秒**随机发 PING（3.5-4.5 分钟）
- 客户端回 PONG
- **300 秒**无 PONG 则断开（5 分钟容忍窗口）

**参数变更表**：

| 参数 | 旧值 | 新值 | 理由 |
|------|------|------|------|
| `heartbeatMin` | 15s | 210s | 3.5 分钟最小间隔，DPI 稀疏 |
| `heartbeatMax` | 40s | 270s | 4.5 分钟最大间隔，+60s jitter 窗口 |
| `heartbeatTimeout` | 60s | 300s | 5 分钟容忍窗口（≥ max + 60s） |

**影响范围**：
- **全局生效**：无论客户端是否开启静默模式，所有连接统一使用新参数
- **旧客户端兼容**：旧客户端依然每 210-270 秒收到 PING 并回复，无感知
- **DPI 收益**：心跳频率从每 15-40 秒一次降低到每 3-4 分钟一次，流量特征显著稀疏

### 3.2 静默超时机制（仅静默模式客户端）

**触发条件**：
- 客户端 AUTH 帧携带 `silent_mode` capability
- 主路径由客户端按 **50 分钟**静默阈值检测业务空闲并主动断开 WS
- 服务端 50 分钟检测仅作为兜底资源保护，防止客户端未及时断开时遗留空闲 WS
- 50 分钟低于企业防火墙常见 1 小时空闲阈值，同时不会在工作时间频繁重连

**检测逻辑**：

**服务端**：
```javascript
// 在 record 中维护
record.lastDataActivityAt = Date.now(); // 仅 DATA 帧，不追踪 PING/PONG

// 每次 DATA 帧收发时更新
if (frame.type === FRAME_TYPES.DATA) {
  record.lastDataActivityAt = Date.now();
}

// 兜底检测静默超时（每 60 秒检查一次）
if (record.silentMode && Date.now() - record.lastDataActivityAt >= 3_000_000) {
  this._closeWs(record.ws, 1000, 'silent-timeout');
}
```

**客户端**：
```kotlin
// SilentModeController 每 60 秒检查一次
val idleMs = System.currentTimeMillis() - tunnelClient.globalLastActivityAt
if (idleMs >= 3_000_000) {
  tunnelClient.disconnect()
  state = SLEEPING
  startSseLoop()
}
```

**关键区分**：
- PING/PONG **不算**业务流量，不重置 `lastDataActivityAt`
- 只有 DATA/CONNECT/CLOSE 帧才更新活动时间
- 即使心跳正常，50 分钟无业务数据依然触发静默

### 3.3 连接轮换（Connection Rotation）

**规则**：
- 连接轮换**只针对 WS 隧道**，SSE 控制面不参与
- 无论是否开启静默模式，WS 隧道的 IP 轮换逻辑保持不变（每 10-30 分钟）
- 静默模式下的 Active 阶段，如果持续有流量（超过 50 分钟），连接依然会轮换

**理由**：
- 50 分钟静默超时已经限制了空闲连接寿命，但与轮换机制正交
- 轮换是为了防止长时间连接被标记，静默超时是为了减少心跳特征
- 两者独立运行，互不干扰

---

## 4. SSE 控制面协议

### 4.1 端点设计

| 路径 | 方法 | 用途 |
|------|------|------|
| `/` `/index.html` | GET | 伪装页面（已有） |
| `/favicon.ico` | GET | 伪装 favicon（可选） |
| `<ssePath>` | GET | SSE 控制面端点（新增，默认 `/api/v1/events`） |

所有端点共用 8003 端口，通过路径区分。控制面和数据面可以使用不同域名，但最终都指向同一个服务端、同一个端口；客户端只负责按配置中的 SSE host/path 发起请求，不规定域名长相。

### 4.2 SSE 请求格式

```http
GET <ssePath>?token=<token> HTTP/1.1
Host: <sse-host>
Accept: text/event-stream
Cache-Control: no-cache
```

**Token 生成**：
```
token = SHA256(username + ":" + password)
```

**安全考虑**：
- 客户端在 AUTH 帧中使用明文凭据，SSE 用哈希避免直接暴露密码
- 服务端用相同凭据计算并比对
- SSE 按用户要求**不校验证书**，使用独立 HTTP client 放行证书错误
- SSE 认证成功后，服务端将该 token 记录为“静默客户端在线”，用于服务端重启后重新感知睡眠客户端
- SSE 连接在线即表示该 token 当前处于客户端主动选择的静默监听状态；服务端不主动决定客户端是否开启静默模式

### 4.3 SSE 响应

**Case A — 建立 SSE 控制流**：
```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no

retry: 5000

```

**Case B — keepalive 心跳（35-45 秒随机）**：
```text
: keepalive

```
服务端在 SSE 连接上每 35-45 秒随机发送 comment keepalive，避免 CDN/代理关闭空闲 HTTP 流，并避免固定周期特征。

**Case C — 有唤醒需求**：
```text
event: wake
data: {}

```
客户端收到 `wake` 后关闭 SSE，立即发起 WS 连接。

**Case D — 认证失败**：
```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{"error":"invalid token"}
```
客户端停止 SSE，通知用户。

**Case E — 服务端不支持静默模式（旧版服务端）**：
```http
HTTP/1.1 404 Not Found
```
客户端降级为持续 WS 模式（回退到旧逻辑）。

### 4.4 客户端行为

```
SLEEPING loop:
  connect HTTPS GET <ssePath>?token=xxx with Accept: text/event-stream

  if connected:
    read SSE events until wake or disconnect

  if event == wake:
    close SSE
    start WS
    if WS connected:
      state = ACTIVE; reset idle timer
    else:
      state = SLEEPING; reconnect SSE after rand(3-8s)

  if SSE disconnected/network error:
    wait rand(3-8s)
    reconnect SSE

  if 401:
    停止 → 认证错误，通知用户

  if 404:
    降级 → 静默模式不可用，回退持续 WS 模式
```

**服务端重启场景**：
- 如果客户端已经在静默模式，服务端重启后没有 WS AUTH 记录。
- 客户端 SSE 重连成功后，服务端通过 token 验证并登记 sleeping token。
- 后续外部请求到达时，服务端可根据 active SSE 发送 wake；如果没有 active SSE，则返回 503。

**状态边界**：
- SSE 只在客户端本地确认 `silentMode=true && idleMs >= 3_000_000` 后启用。
- 其他所有 WS 断线或建连失败均沿用原有 WS 重连逻辑。
- 从 SSE `wake` 触发的 WS 建连失败，应回到 SLEEPING 并恢复 SSE 监听。

---

## 5. 服务端唤醒缓冲（WakeBuffer）

### 5.1 核心职责

当客户端处于静默模式（WS 已断开）时，如果有外部流量到达服务端需要走隧道：
1. 通过 SSE 控制面唤醒客户端
2. 缓冲等待期间的请求
3. 隧道重建后**立即转发**缓冲的请求（零延迟）
4. 超时未重建则返回 503

### 5.2 数据结构

```javascript
class WakeBuffer {
  constructor(config) {
    this._clientBuffers = new Map(); // clientToken → Buffer
    this._wakeTimeout = 10_000; // 单次唤醒等待 10 秒
    this._maxWakeAttempts = 3;
    this._retryIntervalMs = 3_000;
  }

  // 当 TunnelManager.forward() 发现 WS 不在线时调用
  async waitForTunnel(clientToken, host, port) {
    let buffer = this._clientBuffers.get(clientToken);
    if (!buffer) {
      buffer = {
        pendingRequests: [],
        wakePromise: null,
        timer: null
      };
      this._clientBuffers.set(clientToken, buffer);
    }

    // 创建或复用唤醒 Promise。并发请求共享同一个 Promise，不重复发送 wake。
    if (!buffer.wakePromise) {
      buffer.wakePromise = this._wakeWithRetry(clientToken, buffer).finally(() => {
        this._clientBuffers.delete(clientToken);
      });
    }

    return buffer.wakePromise;
  }

  async _wakeWithRetry(clientToken, buffer) {
    for (let attempt = 1; attempt <= this._maxWakeAttempts; attempt++) {
      const result = await this._tryWake(clientToken, buffer);
      if (result === 'ready') return;
      if (result === 'client-offline') throw new Error('client-offline'); // SSE 不在线，不重试

      if (attempt < this._maxWakeAttempts) {
        await delay(this._retryIntervalMs);
      }
    }
    throw new Error('wake-timeout after 3 attempts');
  }

  _tryWake(clientToken, buffer) {
    return new Promise((resolve, reject) => {
      buffer.resolve = () => resolve('ready');
      buffer.reject = reject;
      buffer.timer = setTimeout(() => resolve('timeout'), this._wakeTimeout);

      const woke = this._triggerWake(clientToken);
      if (!woke) {
        clearTimeout(buffer.timer);
        resolve('client-offline');
      }
    });
  }

  // 客户端 WS 重连后调用（由 TunnelManager 在 AUTH_OK 后触发）
  onTunnelReconnected(clientToken) {
    const buffer = this._clientBuffers.get(clientToken);
    if (buffer && buffer.resolve) {
      clearTimeout(buffer.timer);
      buffer.resolve(); // 立即放行，零延迟
    }
  }

  // 内部：通知 SSE handler 发送唤醒信号
  _triggerWake(clientToken) {
    return this._sseControlHandler.sendWakeSignal(clientToken);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### 5.3 与 TunnelManager 集成

```javascript
class TunnelManager {
  constructor(server, config) {
    // ...existing code...
    this._wakeBuffer = new WakeBuffer({ wakeTimeout: 10_000 });
    this._silentModeClients = new Set(); // 记录支持静默模式的 token
    this._sleepingClients = new Set(); // 记录当前处于 SSE 睡眠态的 token
  }

  // 原有 forward() 方法修改
  forward(host, port, callback) {
    // 1. 检查 WS 是否在线
    if (!this._connected) {
      // 2. 检查是否是静默模式客户端
      const clientToken = this._getSleepingClientToken();
      if (this._silentModeClients.has(clientToken)) {
        // 3. 等待唤醒
        return this._waitForTunnelAndForward(clientToken, host, port, callback);
      }

      // 非静默模式或客户端不在线 → 原有错误逻辑
      return createErrorStream('tunnel-disconnected');
    }

    // 原有逻辑
    // ...
  }

  async _waitForTunnelAndForward(clientToken, host, port, callback) {
    try {
      await this._wakeBuffer.waitForTunnel(clientToken, host, port);
      // 隧道已重建，立即转发（零延迟）
      return this._doForward(host, port, callback);
    } catch (err) {
      return createErrorStream(err.message === 'client-offline'
        ? 'tunnel-client-offline'
        : 'tunnel-wake-timeout');
    }
  }

  // 客户端 WS 连接成功后调用
  onClientConnected(ws, clientToken) {
    // ...existing code...
    this._sleepingClients.delete(clientToken);
    this._wakeBuffer.onTunnelReconnected(clientToken);
  }

  // 客户端 AUTH 帧携带 silent_mode capability 时调用
  markClientSilentMode(clientToken) {
    this._silentModeClients.add(clientToken);
  }

  // SSE 认证成功时调用，覆盖“服务端重启但客户端已睡眠”的场景
  markClientSleeping(clientToken) {
    this._sleepingClients.add(clientToken);
  }
}
```

重复 wake 的处理边界：
- 同一个 `clientToken` 在 WS 重建期间只存在一个 `WakeBuffer` promise。
- 后续外部请求复用该 promise，并在 WS 重建成功后一起放行，不再重复发送 `wake`。
- 如果 SSE 不在线，`sendWakeSignal()` 返回 `false`，立即返回 `client-offline`，不做 3 次重试。

### 5.4 超时降级响应

当 `waitForTunnel()` 抛出 `wake-timeout after 3 attempts` 时，返回 503：

```http
HTTP/1.1 503 Service Unavailable
Content-Type: text/html

<html>
<body>
<h1>Service Temporarily Unavailable</h1>
<p>The tunnel is currently in sleep mode and could not be woken up in time.</p>
</body>
</html>
```

---

## 6. 客户端状态机设计

### 6.1 状态定义

```
                    ┌──────────────────────────────────────────┐
                    │                                          │
                    ▼                                          │
         ┌──────────────┐    50m无流量    ┌──────────────┐    │
  start  │              │ ──────────────► │              │    │
───────► │   ACTIVE     │                 │  SLEEPING    │    │
         │              │ ◄────────────── │              │    │
         └──────────────┘   唤醒信号收到   └──────────────┘    │
              ▲   │                              │            │
              │   │ WS断开                       │ SSE        │
              │   │ (服务端重启等)                │ 失败重试   │
              │   ▼                              ▼            │
              │  ┌──────────────┐         ┌──────────────┐    │
              │  │ RECONNECTING │         │ SSE_CONTROL  │    │
              └──│ (指数退避)    │         │ (35-45s KA) │────┘
                 └──────────────┘         │ (3-8s重连)  │  成功
                                          └──────────────┘
```

| 状态 | 描述 | 触发条件 |
|------|------|---------|
| **ACTIVE** | WS 隧道在线，正常传输数据 | 初始启动 / 唤醒信号收到后建连成功 |
| **SLEEPING** | WS 已断开，SSE 控制面监听中 | Active 状态下 50 分钟无业务流量 |
| **RECONNECTING** | WS 断开后尝试重连（原逻辑） | Active 状态下 WS 意外断开 |
| **SSE_CONTROL** | 等同于 SLEEPING，SSE 连接活跃或重连中 | 强调 SSE 是 SLEEPING 的子行为 |

### 6.2 关键设计点

1. **静默模式关闭时**：`SilentModeController` 不激活，`TunnelClient` 完全按原逻辑运行
2. **静默模式开启时**：`SilentModeController` 接管 `TunnelClient` 的生命周期
3. **SLEEPING 内部循环**：建立 SSE → 接收 keepalive/wake → SSE 断线则 3-8s 后重连 → wake 后建 WS → WS 成功回 ACTIVE，失败则回 SLEEPING 并恢复 SSE
4. **WS 失败分支**：只有从 SLEEPING 的 SSE wake 触发的 WS 建连失败才回到 SSE；其他 WS 断线或建连失败仍走原有 WS 指数退避重连
5. **客户端启动策略**：不持久化静默状态；进程重启后始终先进入 ACTIVE 并建立 WS，之后再按 50 分钟无业务流量规则进入 SLEEPING

---

## 7. Android 客户端模块设计

### 7.1 `SilentModeController.kt`（新增）

**职责**：静默模式的状态机编排器，接管 `TunnelClient` 的生命周期。

```kotlin
class SilentModeController(
    private val tunnelClient: TunnelClient,
    private val sseControlClient: SseControlClient,
    private val config: SilentModeConfig,
    private val scope: CoroutineScope
) {
    enum class State { ACTIVE, SLEEPING, RECONNECTING, DISABLED }

    private val _state = MutableStateFlow<State>(State.DISABLED)
    val state: StateFlow<State> = _state

    fun start() {
        if (!config.silentEnabled) {
            _state.value = State.DISABLED
            tunnelClient.start()  // 原逻辑，完全不受影响
            return
        }

        scope.launch {
            _state.value = State.ACTIVE
            tunnelClient.start()
            monitorIdleTimeout()
        }
    }

    fun stop() {
        sseControlClient.stop()
        tunnelClient.stop()
        _state.value = State.DISABLED
    }

    private suspend fun monitorIdleTimeout() {
        while (isActive && _state.value != State.DISABLED) {
            delay(config.checkIntervalMs)

            if (_state.value != State.ACTIVE) continue

            val idleMs = System.currentTimeMillis() - tunnelClient.globalLastActivityAt
            if (idleMs >= config.idleTimeoutMs) {
                enterSleeping()
            }
        }
    }

    private suspend fun enterSleeping() {
        _state.value = State.SLEEPING
        tunnelClient.stop()  // 主动断开 WS
        startSseLoop()
    }

    private suspend fun startSseLoop() {
        while (isActive && _state.value == State.SLEEPING) {
            val result = sseControlClient.connectAndRead()

            when (result) {
                SseControlResult.Wake -> {
                    sseControlClient.stop()
                    _state.value = State.ACTIVE
                    tunnelClient.start()
                    if (!tunnelClient.awaitConnected(timeoutMs = 10_000)) {
                        _state.value = State.SLEEPING
                        delay(Random.nextLong(3_000, 8_001))
                        continue
                    }
                    monitorIdleTimeout()
                    return
                }
                SseControlResult.AuthFailed -> {
                    _state.value = State.DISABLED
                    return
                }
                SseControlResult.NotSupported -> {
                    _state.value = State.DISABLED
                    tunnelClient.start()
                    return
                }
                SseControlResult.Disconnected,
                SseControlResult.Failed -> {
                    delay(Random.nextLong(3_000, 8_001))
                    continue
                }
            }
        }
    }
}
```

### 7.2 `SseControlClient.kt`（新增）

**职责**：SSE 控制面连接、事件解析和断线重连结果上报。

```kotlin
class SseControlClient(
    private val config: ServerConfig,
    private val credentials: TunnelCredentials,
    private val okHttpClient: OkHttpClient  // 独立 OkHttpClient，无 VPN protect
) {
    private val token: String = sha256("${credentials.username}:${credentials.password}")
    private var currentCall: Call? = null

    fun connectAndRead(): SseControlResult {
        val url = buildUrl()  // https://<sseHost>:<port><ssePath>?token=xxx

        val request = Request.Builder()
            .url(url)
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
            .get()
            .build()

        return try {
            val call = okHttpClient.newCall(request)
            currentCall = call
            call.execute().use { response ->
                when (response.code) {
                    200 -> {
                        val contentType = response.header("Content-Type").orEmpty()
                        if (!contentType.startsWith("text/event-stream")) {
                            SseControlResult.Failed
                        } else {
                            readSseEvents(response.body?.byteStream())
                        }
                    }
                    401 -> SseControlResult.AuthFailed
                    404 -> SseControlResult.NotSupported
                    else -> SseControlResult.Failed
                }
            }
        } catch (e: IOException) {
            SseControlResult.Failed
        } catch (e: Exception) {
            SseControlResult.Failed
        } finally {
            currentCall = null
        }
    }

    fun stop() {
        currentCall?.cancel()
        currentCall = null
    }

    private fun readSseEvents(inputStream: InputStream?): SseControlResult {
        if (inputStream == null) return SseControlResult.Failed

        return try {
            val reader = BufferedReader(InputStreamReader(inputStream))
            var eventType: String? = null
            while (true) {
                val line = reader.readLine() ?: return SseControlResult.Disconnected
                when {
                    line.isEmpty() -> {
                        if (eventType == "wake") return SseControlResult.Wake
                        eventType = null
                    }
                    line.startsWith("event:") -> eventType = line.substringAfter("event:").trim()
                    line.startsWith(":") -> Unit // keepalive comment
                    line.startsWith("data:") -> Unit
                }
            }
        } catch (e: IOException) {
            SseControlResult.Disconnected
        } catch (e: Exception) {
            SseControlResult.Failed
        }
    }
}

enum class SseControlResult {
    Wake, Disconnected, AuthFailed, NotSupported, Failed
}
```

`SseControlResult` 语义：

| 场景 | 返回值 | 客户端行为 |
| --- | --- | --- |
| HTTP 请求失败（连接错误、超时、非 SSE 200 响应） | `Failed` | 3-8s 后重连 SSE |
| SSE 流建立后中途断开（EOF 或 `IOException`） | `Disconnected` | 3-8s 后重连 SSE |
| HTTP 401 | `AuthFailed` | 停止 SSE，通知用户认证错误 |
| HTTP 404 | `NotSupported` | 降级为持续 WS |

### 7.3 `TunnelClient.kt` 改动（最小侵入）

```kotlin
// 新增暴露的属性
val globalLastActivityAt: Long
    get() = maxOf(
        reverseConnectHandler.getLatestActivity(),
        forwardSessionRegistry.getLatestActivity()
    )

// 新增：支持外部主动断开
fun disconnect() {
    activeWs?.close(1000, "silent-timeout")
}

// 新增：供 SilentModeController 判断 SSE wake 后 WS 是否恢复成功
suspend fun awaitConnected(timeoutMs: Long): Boolean {
    return withTimeoutOrNull(timeoutMs) {
        status.first {
            it == TunnelStatus.Connected ||
                it == TunnelStatus.AuthFailed ||
                it == TunnelStatus.Occupied
        }
    }?.let { it == TunnelStatus.Connected } ?: false
}
```

### 7.4 `BlockProxyVpnService.kt` 集成改动

```kotlin
// setupTunnel() 中
val silentConfig = SilentModeConfig(
    silentEnabled = serverConfig.silentMode,
    idleTimeoutMs = 3_000_000,
    checkIntervalMs = 60_000
)

val sseControlClient = SseControlClient(serverConfig, credentials, okHttpClient)
val silentController = SilentModeController(
    tunnelClient, sseControlClient, silentConfig, clientScope
)

// 替代原来的 tunnelClient.start()
silentController.start()
```

### 7.5 OkHttpClient 配置

`SseControlClient` 使用**独立的 OkHttpClient**：

```kotlin
val sseOkHttpClient = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.MILLISECONDS) // SSE 长流，不设置读超时
    .writeTimeout(10, TimeUnit.SECONDS)
    // 无 VPN protect — 走正常系统网络栈
    // 不校验证书 — SSE 按用户要求放行证书错误
    .build()
```

**关键点**：
- SSE 请求**不经过 VPN**
- 不需要 `VpnService.protect()`
- 走系统 DNS 和网络栈
- 不校验 TLS 证书

---

## 8. 服务端模块设计

### 8.1 `tunnel/sseControl.js`（新增）

```javascript
class SseControlHandler {
  constructor(options = {}) {
    this._connections = new Map(); // token → { res, keepaliveTimer }
    this._credentials = null;
    this._path = options.path || '/api/v1/events';
    this._keepaliveMinMs = options.keepaliveMinMs || 35_000;
    this._keepaliveMaxMs = options.keepaliveMaxMs || 45_000;
    this._onAuthenticated = options.onAuthenticated || (() => {});
    this._onDisconnected = options.onDisconnected || (() => {});
  }

  setCredentials(credentials) {
    this._credentials = credentials;
  }

  handleRequest(req, res) {
    const url = new URL(req.url, 'https://localhost');

    if (url.pathname !== this._path) return false;
    if (req.method !== 'GET') {
      this._send(res, 405, { error: 'method not allowed' });
      return true;
    }

    const token = url.searchParams.get('token');
    if (!this._verifyToken(token)) {
      this._send(res, 401, { error: 'invalid token' });
      return true;
    }

    this._closeExistingConnection(token);
    this._onAuthenticated(token);

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 5000\n\n');

    const connection = { res, keepaliveTimer: null };
    this._connections.set(token, connection);
    this._scheduleKeepalive(token);

    req.on('close', () => {
      if (this._connections.get(token) === connection) {
        this._closeExistingConnection(token);
        this._onDisconnected(token);
      }
    });
    return true;
  }

  sendWakeSignal(token) {
    const connection = this._connections.get(token);
    if (!connection) return false;

    connection.res.write('event: wake\ndata: {}\n\n');
    return true;
  }

  hasActiveConnection(token) {
    return this._connections.has(token);
  }

  clearConnection(token) {
    this._closeExistingConnection(token);
  }

  _verifyToken(token) {
    if (!token || !this._credentials) return false;
    const crypto = require('crypto');
    const expected = crypto
      .createHash('sha256')
      .update(`${this._credentials.username}:${this._credentials.password}`)
      .digest('hex');
    return token === expected;
  }

  _scheduleKeepalive(token) {
    const connection = this._connections.get(token);
    if (!connection) return;

    const delay = this._keepaliveMinMs +
      Math.floor(Math.random() * (this._keepaliveMaxMs - this._keepaliveMinMs + 1));
    connection.keepaliveTimer = setTimeout(() => {
      const current = this._connections.get(token);
      if (!current) return;
      current.res.write(': keepalive\n\n');
      this._scheduleKeepalive(token);
    }, delay);
    connection.keepaliveTimer.unref();
  }

  _closeExistingConnection(token) {
    const existing = this._connections.get(token);
    if (existing) {
      if (existing.keepaliveTimer) clearTimeout(existing.keepaliveTimer);
      this._connections.delete(token);
      try { existing.res.end(); } catch (_) {}
    }
  }

  _send(res, statusCode, body) {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });
    res.end(payload);
  }
}

module.exports = SseControlHandler;
```

### 8.2 `tunnel/wakeBuffer.js`（新增）

```javascript
class WakeBuffer {
  constructor(options) {
    this._sseControlHandler = options.sseControlHandler;
    this._wakeTimeout = options.wakeTimeout || 10_000;
    this._maxWakeAttempts = options.maxWakeAttempts || 3;
    this._retryIntervalMs = options.retryIntervalMs || 3_000;
    this._buffers = new Map(); // clientToken → { promise, resolve, reject, timer }
  }

  waitForTunnel(clientToken) {
    let buf = this._buffers.get(clientToken);
    if (buf && buf.promise) {
      return buf.promise;
    }

    buf = { promise: null, resolve: null, reject: null, timer: null };
    this._buffers.set(clientToken, buf);

    const promise = this._wakeWithRetry(clientToken, buf).finally(() => {
      this._cleanup(clientToken);
    });
    buf.promise = promise;
    return promise;
  }

  onTunnelReconnected(clientToken) {
    const buf = this._buffers.get(clientToken);
    if (!buf) return;

    if (buf.timer) clearTimeout(buf.timer);
    if (buf.resolve) buf.resolve();
  }

  onClientDisconnected(clientToken) {
    const buf = this._buffers.get(clientToken);
    if (buf && buf.reject) {
      buf.reject(new Error('client-offline'));
    }
    this._cleanup(clientToken);
  }

  _cleanup(clientToken) {
    const buf = this._buffers.get(clientToken);
    if (buf) {
      if (buf.timer) clearTimeout(buf.timer);
      this._buffers.delete(clientToken);
    }
  }

  async _wakeWithRetry(clientToken, buf) {
    for (let attempt = 1; attempt <= this._maxWakeAttempts; attempt++) {
      const result = await this._tryWake(clientToken, buf);
      if (result === 'ready') return;
      if (result === 'client-offline') throw new Error('client-offline');

      if (attempt < this._maxWakeAttempts) {
        await delay(this._retryIntervalMs);
      }
    }
    throw new Error('wake-timeout after 3 attempts');
  }

  _tryWake(clientToken, buf) {
    return new Promise((resolve, reject) => {
      buf.resolve = () => resolve('ready');
      buf.reject = reject;
      buf.timer = setTimeout(() => resolve('timeout'), this._wakeTimeout);
      buf.timer.unref();

      const woke = this._sseControlHandler.sendWakeSignal(clientToken);
      if (!woke) {
        clearTimeout(buf.timer);
        resolve('client-offline');
      }
    });
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = WakeBuffer;
```

### 8.3 `tunnel/server.js` 改动

```javascript
// 构造函数新增
this._sseControlHandler = new SseControlHandler({
  path: options.ssePath || options.tunnel_sse_path || '/api/v1/events',
  onAuthenticated: (token) => {
    if (this._tunnelManager && typeof this._tunnelManager.markClientSleeping === 'function') {
      this._tunnelManager.markClientSleeping(token);
    }
  },
  onDisconnected: (token) => {
    if (this._tunnelManager && typeof this._tunnelManager.markClientSseDisconnected === 'function') {
      this._tunnelManager.markClientSseDisconnected(token);
    }
  },
});
this._sseControlHandler.setCredentials(this.credentials);

// _handleHttpRequest 修改
_handleHttpRequest(req, res) {
  if (this._sseControlHandler.handleRequest(req, res)) return;
  handleDisguiseRequest(req, res);
}

// _handleAuth 修改
_handleAuth(record, frame) {
  // ...existing auth logic...

  const clientCapabilities = new Set(frame.capabilities || []);
  record.silentMode = clientCapabilities.has('silent_mode');

  // ...existing padding negotiation...
}

// 暴露接口
getSseControlHandler() {
  return this._sseControlHandler;
}
```

### 8.4 `tunnel/manager.js` 改动

```javascript
// 构造函数新增
this._sseControlHandler = tunnelServer.getSseControlHandler();
this._wakeBuffer = new WakeBuffer({
  sseControlHandler: this._sseControlHandler,
  wakeTimeout: 10_000
});
this._clientTokens = new Map();
this._silentModeClients = new Set();
this._sleepingClients = new Set();

// forward() 修改：必须继续同步返回 Duplex，不能返回 Promise
forward(host, port, callback) {
  if (!this._connected) {
    const clientToken = this._getSleepingClientToken();
    if (clientToken && this._isSleepingClient(clientToken)) {
      return this._createPendingWakeStream(clientToken, host, port, callback);
    }
    return createErrorStream('tunnel-disconnected');
  }
  // ...existing logic...
}

_createPendingWakeStream(clientToken, host, port, callback) {
  const pending = createPendingDuplex();
  this._waitAndForward(clientToken, host, port, callback, pending).catch((err) => {
    pending.destroy(err);
  });
  return pending;
}

async _waitAndForward(clientToken, host, port, callback, pendingStream) {
  try {
    await this._wakeBuffer.waitForTunnel(clientToken);
    this._bindForwardStreamAfterWake(pendingStream, host, port, callback);
  } catch (err) {
    pendingStream.destroy(err.message === 'client-offline'
      ? new Error('client-offline')
      : new Error('tunnel-wake-timeout'));
  }
}

_bindForwardStreamAfterWake(pendingStream, host, port, callback) {
  // 等价于现有 forward() 在 WS 已连接分支中的 reqid 分配及 CONNECT 帧发送逻辑：
  // 1. 分配新的 server-side reqid
  // 2. 发送 CONNECT 帧到已重建的 WS
  // 3. 将 pendingStream 的读写/error/close 桥接到该 reqid 对应的 tunnel 数据流
  // 4. 注册 activeRequests 清理逻辑
}

// setConnected() 修改
setConnected(socket, connected, clientAddress) {
  if (connected) {
    const record = this._server._records.get(socket);
    if (record) {
      const token = this._computeToken();
      this._clientTokens.set(socket, token);
      if (record.silentMode) {
        this._silentModeClients.add(token);
      }
      this._sleepingClients.delete(token);
      this._wakeBuffer.onTunnelReconnected(token);
    }
    // ...existing logic...
  } else {
    const token = this._clientTokens.get(socket);
    if (token) {
      this._wakeBuffer.onClientDisconnected(token);
      this._clientTokens.delete(socket);
    }
    // ...existing logic...
  }
}

markClientSleeping(token) {
  this._sleepingClients.add(token);
}

markClientSseDisconnected(token) {
  // SSE 断线只表示控制面暂时不可用；保留 silentMode 历史，等待客户端 3-8s 重连。
}
```

### 8.5 协议扩展：AUTH 帧 capability

客户端 AUTH 帧新增 `silent_mode` capability：

```javascript
// 客户端发送
{ type: AUTH, username, password, capabilities: ['padding', 'silent_mode'] }

// 服务端识别
if (clientCapabilities.has('silent_mode')) {
  record.silentMode = true;
}
```

无需服务端回复确认 — 静默模式完全由客户端控制。

---

## 9. Android UI 与配置变更

### 9.1 `ServerConfig.kt` 新增字段

```kotlin
data class ServerConfig(
    // ...existing fields...
    val silentMode: Boolean = false,
    val sseHost: String = "",
    val ssePort: Int = 8003,
    val ssePath: String = "/api/v1/events",
)
```

### 9.2 ConfigScreen UI 变更

在服务器配置区域下方新增**静默模式**分组：

```
┌─────────────────────────────────────┐
│  静默模式 (Silent Mode)              │
│                                      │
│  [Switch ○───────] 开启               │
│                                      │
│  SSE 控制面地址                       │
│  ┌───────────────────────────────┐   │
│  │ events.example.com            │   │
│  └───────────────────────────────┘   │
│  用于静默模式下的唤醒信号接收           │
│  （可选，留空则使用服务器地址）          │
└─────────────────────────────────────┘
```

**交互逻辑**：
- Switch 控制 `silentMode` 开关
- `sseHost` 输入框仅在 Switch 开启时可编辑
- `sseHost` 留空时，默认使用 `serverHost`
- 不校验证书

### 9.3 ConfigRepository / DataStore 变更

新增 4 个 preference key：

```kotlin
object ConfigKeys {
    val SILENT_MODE = booleanPreferencesKey("silent_mode")
    val SSE_HOST = stringPreferencesKey("sse_host")
    val SSE_PORT = intPreferencesKey("sse_port")
    val SSE_PATH = stringPreferencesKey("sse_path")
}
```

默认值：`silentMode = false`，`sseHost = ""`，`ssePort = 8003`，`ssePath = "/api/v1/events"`

### 9.4 `TunnelViewModel` 变更

```kotlin
val silentMode: StateFlow<Boolean>
val sseHost: StateFlow<String>

fun updateSilentMode(enabled: Boolean)
fun updateSseHost(host: String)
```

### 9.5 状态显示

`TunnelStatus` 新增状态：

```kotlin
enum class TunnelStatus(val displayName: String) {
    // ...existing...
    Sleeping("静默中"),  // 新增
}
```

UI 显示为"静默中"，用户知道隧道处于省电模式但仍在监听唤醒信号。

---

## 10. 兼容性矩阵

| 客户端 | 服务端 | 行为 |
|--------|--------|------|
| 新客户端（静默开启） | 新服务端 | 完整静默模式：SSE 控制面 + 按需 WS |
| 新客户端（静默关闭） | 新服务端 | 持续 WS + 新心跳参数（210-270s） |
| 新客户端（静默开启） | 旧服务端 | SSE 收到 404，降级为持续 WS |
| 新客户端（静默关闭） | 旧服务端 | 持续 WS + 旧心跳参数（15-40s） |
| 旧客户端 | 新服务端 | 持续 WS + 新心跳参数（210-270s） |

---

## 11. 参数汇总表

| 参数 | 值 | 来源 |
|------|-----|------|
| WS 心跳间隔 | 210-270 秒随机 | 用户确认 + PDF 评估 |
| WS 心跳超时 | 300 秒 | 设计确认 |
| 静默超时（无流量→断 WS） | 3000 秒（50 分钟） | 用户确认：40/50 分钟均可，取 50 分钟避免频繁重连 |
| SSE keepalive 间隔 | 35-45 秒随机 | 用户确认 + CDN/代理保活 |
| SSE 断线重连间隔 | 3-8 秒随机 | 用户确认 + 去周期化 |
| 服务端唤醒缓冲超时 | 10 秒 | 用户确认 |
| 静默超时检查间隔 | 60 秒 | 设计建议 |

---

## 12. 实现顺序建议

### Phase 1: 服务端基础设施
1. 新增 `tunnel/sseControl.js`
2. 新增 `tunnel/wakeBuffer.js`
3. 修改 `tunnel/server.js`（集成 SSE、心跳参数、silent_mode capability）
4. 修改 `tunnel/manager.js`（集成 WakeBuffer、sleeping token registry、静默超时检测）

### Phase 2: 客户端核心模块
1. 新增 `SseControlClient.kt`
2. 新增 `SilentModeController.kt`
3. 修改 `TunnelClient.kt`（暴露 `globalLastActivityAt`、`disconnect()`）
4. 修改 `BlockProxyVpnService.kt`（集成 SilentModeController）

### Phase 3: 配置与 UI
1. 修改 `ServerConfig.kt`（新增字段）
2. 修改 `ConfigRepository` / DataStore（新增 preference keys）
3. 修改 `TunnelViewModel`（新增状态字段）
4. 修改 ConfigScreen UI（新增静默模式分组）
5. 修改 `TunnelStatus.kt`（新增 Sleeping 状态）

### Phase 4: 测试与验证
1. 服务端单元测试（SSE、WakeBuffer）
2. 客户端单元测试（SilentModeController、SseControlClient）
3. 集成测试（静默→唤醒→传输完整流程）
4. 兼容性测试（新旧客户端/服务端交叉验证）

---

## 13. 风险与缓解

### 13.1 唤醒延迟

**风险**：服务端发出唤醒信号后，客户端重建 WS 需要 1-3 秒，期间到达的请求需要缓冲。

**缓解**：
- WakeBuffer 缓冲最多 10 秒
- 隧道重建后立即转发（零延迟）
- 超时返回 503

### 13.2 SSE 断线或失败

**风险**：客户端在静默模式下，如果 SSE 持续失败（服务端宕机、网络中断、CDN 断流），无法收到唤醒信号。

**缓解**：
- 客户端保持 SLEEPING 状态，3-8 秒随机重连 SSE
- 服务端 SSE close/error 只清理 active SSE connection，不清理 silentMode 历史
- 用户可通过 UI 手动关闭静默模式，回退到持续 WS

### 13.3 服务端重启

**风险**：服务端重启时，客户端的 WS 或 SSE 连接断开。

**缓解**：
- WS 断开 → 客户端按原逻辑重连（指数退避）
- SSE 断开 → 3-8 秒随机延迟后重连
- 服务端恢复后第一次 WS 或 SSE 成功，服务端重新获知客户端状态

### 13.4 多客户端场景

**风险**：当前设计假设单一客户端，多客户端场景下 clientToken 可能冲突。

**缓解**：
- 使用 `SHA256(username:password)` 作为 token，同一凭据的多个连接共享 token
- WakeBuffer 按 token 分组，同一 token 的多个请求共享同一个唤醒 Promise
- 当前实际场景只有一个客户端，暂不处理多客户端复杂逻辑

---

## 14. 总结

本设计在当前 WebSocket 双向隧道架构基础上，引入了**静默模式**，通过：

1. **心跳频率降低**（15-40s → 210-270s）显著减少 DPI 特征
2. **按需驱动**（50 分钟无流量→断 WS→SSE 唤醒）消除持续性 WS 连接特征
3. **协议解耦**（HTTP/1.1 SSE 控制面 + WS 数据面）实现灵活的状态管理
4. **向后兼容**（新旧客户端/服务端交叉兼容）确保平滑升级

最终实现从"24 小时在线隧道"到"幽灵设备"的转变，将隐匿性从 Tier 2 提升至 Tier 1。
