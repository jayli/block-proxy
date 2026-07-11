# Android 客户端隧道隐匿改造设计文档

**日期**: 2026-07-11
**状态**: 设计已确认，待实施
**前置**: [隧道伪装传输设计](./2026-07-11-tunnel-stealth-design.md)（服务端 + Python 客户端已完成并测试通过）
**范围**: Android 客户端隧道层，与已改造的服务端完全对接

## 目标

将 Android 客户端隧道实现从原始 TLS Socket + 双连接补充模型，改造为与 Python 客户端完全一致的 WebSocket + 单活跃连接轮换模型。

## 当前状态 vs 目标状态

| 维度 | Android 当前 | Python 已实现（目标） |
|------|-------------|---------------------|
| 传输层 | TLS 原始 Socket | WebSocket over TLS (wss://) |
| 帧拼装 | `FrameExtractor` 流式拼帧 | OkHttp WebSocket 自动分帧 |
| 帧发送 | `SendQueue` 串行队列 | OkHttp `send()` 内部线程安全 |
| 连接模型 | 2 连接补充（Replenishment） | 1 活跃 WS + 定期轮换 + Drain |
| HTTP 伪装 | 无 | WebSocket 前发 GET / + /favicon.ico |
| 心跳 | 被动响应 PING→PONG | 主动随机间隔 PING，带随机 payload，回显校验 |
| PING/PONG | `object`（无 payload） | `data class`（可变长度 payload） |
| 重连策略 | 指数退避（相同） | 指数退避（相同） |

## 架构总览

```
TunnelClient
├── OkHttpClient (共享单例，配置 trust-all SSL + TLS 1.2+)
├── _activeWs: WebSocket?          ← 所有帧收发走这条连接
├── _candidateWs: WebSocket?       ← 轮换候选，认证后待切换
├── _drainingWs: WebSocket?        ← 旧连接等待排空
│
├── 连接管理
│   ├── _establishConnection()     ← HTTP伪装 → wss:// → AUTH
│   ├── _rotationLoop()            ← 随机间隔触发轮换
│   └── _runLoop()                 ← 指数退避重连 (1s→2s→...→60s)
│
├── 心跳 (_heartbeatLoop)          ← 随机 15-40s 发 PING
├── 帧处理 (_handleFrame)          ← CONNECT/DATA/CLOSE/CONNECT_OK/CONNECT_FAILED/PONG
│
├── ReverseConnectHandler          ← 服务端→客户端 CONNECT 请求
│   └── RequestSession × N         ← 每个反向连接一个 session
│
└── ForwardSessionRegistry         ← 客户端→服务端 CONNECT 请求
    └── ForwardSession × N         ← 每个正向连接一个 session
```

## 详细设计

### 1. 传输层：OkHttp WebSocket

废弃 `TunnelSocket` / `TunnelConnection` / `RealTunnelSocket` / `RealTargetSocket` 等原始 Socket 抽象，改为 OkHttp WebSocket。

**连接建立**（与 Python `_establish_connection` 一致）：
1. `http_disguise` 开启时：用 OkHttp 同步发 `GET /` 和 `GET /favicon.ico`（间隔 0.5-2s 随机延迟）
2. 构建 `wss://host:port/ws` 的 `Request`，携带自定义 headers
3. `OkHttpClient.newWebSocket(request, listener)` 建立连接
4. WebSocket 打开后立即发送 `AUTH` 帧
5. 等待 `AUTH_OK` / `AUTH_FAIL` / `ERROR`

**WebSocket 配置**：
- `pingInterval`: null — 使用协议帧心跳，不用 OkHttp 内置 ping
- 只处理二进制帧（`onMessage` 中 `bytes` 非空）

**帧接收**：OkHttp WebSocket 回调天然分帧（每个 `onMessage(ByteString)` 是完整消息），不再需要 `FrameExtractor` 流式拼帧。

**帧发送**：直接用 `webSocket.send(ByteString.of(encoded))`，OkHttp 内部保证线程安全，不再需要 `SendQueue`。

**trust-all SSL**：与现有 `RealTunnelSocket` 一致，允许自签证书。

### 2. 连接轮换模型

与 Python `_rotation_loop` + `_rotation_cycle` 完全一致。

**核心状态**：
```kotlin
_activeWs      — 当前活跃连接，承载所有send和读写
_candidateWs   — 轮换中的候选（认证通过、尚未切换为active）
_drainingWs    — 旧active连接，等待活跃请求排空后关闭
```

**轮换周期**：`rotation_min` (默认600s) ~ `rotation_max` (默认1800s) 随机间隔，默认开启。

**轮换流程**：
```
1. 创建新 WebSocket → 认证 → 成为 _candidateWs
2. _activeWs 切换为 _drainingWs，_candidateWs 切换为 _activeWs
3. 最小等待 drain_timeout (默认 10s)
4. 轮询 _drainingWs 上的活跃请求数 + 最后活动时间
   - 有活跃请求 且 距最后活动时间 < drain_idle_timeout (默认 20s) → 继续等
   - 无活跃请求 或 空闲超时 → 关闭 _drainingWs
```

**状态追踪**：`ReverseConnectHandler` 和 `ForwardSessionRegistry` 暴露按 WebSocket 查询活跃请求数和最后活动时间的方法，与 Python `_get_ws_drain_state()` 对应。

**请求路由**：
- 新请求（正向+反向）始终发往 `_activeWs`
- `_drainingWs` 上的已有 DATA/CLOSE 继续正常处理
- `_drainingWs` 收到新 CONNECT 时直接拒绝（防御）

### 3. 心跳

与 Python `_heartbeat_loop` 一致。

- 间隔：`heartbeat_min`(15s) ~ `heartbeat_max`(40s) 随机
- 发送随机 8-40 字节 payload 的 `PING` 帧
- 服务端回复 `PONG`，payload 必须与发出的 PING payload 一致
- `heartbeat_timeout`(60s) 内未收到有效 PONG → 关闭连接并重连
- 心跳发往 `_activeWs` 和 `_drainingWs`

### 4. 帧协议变更

`FrameCodec` 需要修改：

- `Frame.Ping` / `Frame.Pong` 从 `object` 改为 `data class Ping(val payload: ByteArray)` / `data class Pong(val payload: ByteArray)`
- 编解码支持可变长度 payload（协议格式：`type(1) + payload`）
- `MAX_PAYLOAD_SIZE` 修正为与协议常量一致

### 5. HTTP 伪装

与 Python `_perform_http_disguise` 一致，在 WebSocket 连接前执行：

1. OkHttp 同步 `GET https://host:port/` → 读取响应 → 关闭
2. `delay(random(500ms, 2000ms))`
3. OkHttp 同步 `GET https://host:port/favicon.ico` → 读取响应 → 关闭
4. `delay(random(500ms, 2000ms))`
5. 然后才建立 WebSocket

两个 OkHttp `Call.execute()`（阻塞式），用 `withContext(Dispatchers.IO)` 包裹。

### 6. 配置变更

`ServerConfig` 新增字段：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| wsPath | String | `"/ws"` | WebSocket 路径 |
| httpDisguise | Boolean | `true` | HTTP 伪装开关 |
| headers | Map\<String, String\> | `emptyMap()` | 自定义请求头 |

`DataStoreConfigDataSource` 同步更新持久化。

### 7. TunnelClient 公共 API

```kotlin
class TunnelClient(...) {
    val status: StateFlow<TunnelStatus>
    fun start()
    suspend fun stop(timeoutMs: Long = 5_000L)
    suspend fun openForwardSession(host: String, port: Int): ForwardSession
    fun measureLatency(): Long?   // 新增，与 Python measure_latency 对应
}
```

## 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 重写 | `tunnel/TunnelClient.kt` | 核心重写：OkHttp WebSocket + 轮换 + disguise + 心跳 |
| 新增 | `tunnel/TunnelWebSocket.kt` | OkHttp WebSocket 监听器封装（认证、帧分发、断连回调） |
| 修改 | `tunnel/Frame.kt` | Ping/Pong 改为带 payload |
| 修改 | `tunnel/FrameCodec.kt` | Ping/Pong 编解码支持 payload |
| 删除 | `tunnel/TunnelConnection.kt` | 原有逻辑合并到 TunnelWebSocket |
| 删除 | `tunnel/FrameExtractor.kt` | OkHttp 分帧，不再需要流式拼帧 |
| 删除 | `tunnel/SendQueue.kt` | OkHttp 内部线程安全 |
| 修改 | `tunnel/ReverseConnectHandler.kt` | 适配 WebSocket，增加 drain 状态查询 |
| 修改 | `tunnel/ForwardSession.kt` | 适配 WebSocket |
| 修改 | `tunnel/ForwardSessionRegistry.kt` | 适配 WebSocket |
| 修改 | `config/ServerConfig.kt` | 新增 wsPath、httpDisguise、headers 字段 |
| 修改 | `config/ConfigRepository.kt` | 持久化新字段 |
| 修改 | `service/BlockProxyVpnService.kt` | 适配新 TunnelClient 构造参数 |
| 修改 | `app/build.gradle.kts` | 添加 OkHttp 依赖 |

共约 14 个文件变更，其中 3 个删除、2 个新增、其余修改。
