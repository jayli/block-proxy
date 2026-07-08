# Android 客户端正向代理与分流功能设计文档

## 概述

在现有 Android 客户端只支持 reverse CONNECT 的基础上，新增 Android 设备正向代理能力。客户端通过 `VpnService` 建立 TUN 接口接管设备流量，但不在 Kotlin 代码中手写 TCP/IP 栈；TUN 数据交给 `tun2socks` 处理，`tun2socks` 再连接本地 SOCKS5 服务。Android 客户端只需要实现本地 SOCKS5、分流决策、直连转发和 Forward CONNECT 隧道转发。

核心数据流：

```text
Android App
  -> VpnService TUN
  -> tun2socks
  -> LocalSocksServer
  -> RoutingEngine
     -> direct Socket
     -> Forward CONNECT over existing TunnelClient
```

这个设计避免在应用层手写 SYN/SYN-ACK/ACK、seq/ack、窗口、重传、乱序、FIN/RST 和 TCP checksum。TCP/IP 状态机由 `tun2socks` 负责。

## 设计决策

| 决策项 | 选择 | 理由 |
|---|---|---|
| 流量捕获 | `VpnService` + 默认路由 + `tun2socks` | Android VPN 标准路径，避免手写 TCP/IP 栈 |
| 应用内入口 | 本地 SOCKS5 服务 | `tun2socks` 可把 TCP 流量转成 SOCKS5 CONNECT |
| 正向代理协议 | Forward CONNECT | 复用现有 tunnel 协议和服务端能力 |
| 分流输入 | SOCKS5 目标 host + 可选域名映射 | SOCKS5 可能给域名，也可能只给 IP，必须同时支持 |
| 域名来源 | 优先 SOCKS5 ATYP_DOMAIN；否则查询域名映射；仍无域名则按兜底策略 | 避免假设 `tun2socks` 总能保留域名 |
| DNS 策略 | 不在 Kotlin 里解析 TUN DNS 包；通过 `tun2socks` 配套 DNS/fakeDNS 或本地 DNS resolver 维护映射 | 域名规则需要可靠域名来源，但不回到手写 packet reader |
| 分流规则 | `domain:` 和 `geosite:`，geosite 支持 full/domain/plain/regex | 与现有桌面端规则语义保持一致 |
| 兜底逻辑 | 分流开启：直连规则 -> 代理规则 -> 兜底直连；分流关闭：全走代理 | 用户明确需求 |
| UDP 范围 | 首版只保证 TCP；DNS UDP 仅作为域名映射辅助；非 DNS UDP 暂不支持或丢弃 | Forward CONNECT 是 TCP 语义，完整 UDP 需另行设计 |
| IPv6 范围 | 首版不支持 IPv6 路由 | 降低首版复杂度 |
| 隧道覆盖配置 | 移除 `tunnelHost/tunnelPort` | 始终使用服务器设置 |

## 非目标

- 不实现 userspace TCP/IP 栈。
- 不直接从 TUN 读取 IP 包并解析 TCP/UDP。
- 不实现通用 UDP 代理、QUIC 代理或 UDP over tunnel。
- 不实现 IPv6 路由。
- 不修改服务端 Forward CONNECT 协议。

## 架构组件

```text
android-client/app/src/main/java/com/blockproxy/android/
├── config/
│   ├── RoutingConfig.kt
│   └── RoutingConfigRepository.kt
├── routing/
│   ├── RoutingEngine.kt
│   ├── GeositeLoader.kt
│   ├── GeositeMatcher.kt
│   └── ProtoParser.kt
├── socks/
│   ├── LocalSocksServer.kt
│   ├── SocksSession.kt
│   ├── SocksProtocol.kt
│   └── DomainMappingStore.kt
├── tunnel/
│   ├── ForwardSessionRegistry.kt
│   └── ForwardSession.kt
├── tun/
│   ├── Tun2SocksController.kt
│   └── VpnNetworkSnapshot.kt
└── ui/
    └── RoutingScreen.kt
```

### 修改现有组件

| 文件 | 变更 |
|---|---|
| `BlockProxyVpnService.kt` | 建立带默认路由的 VPN，启动本地 SOCKS5 和 `tun2socks`，保护应用自身 socket |
| `TunnelClient.kt` | 增加 forward session 分发、连接选择、reqid 分配和断线清理 |
| `ServerConfig.kt` | 移除 `tunnelHost/tunnelPort` 和 `effectiveHost/effectivePort` |
| `ConfigRepository.kt` | 删除 tunnel override 的读写和校验 |
| `TunnelViewModel.kt` | 移除 tunnel override 状态，增加 routing 配置状态 |
| `ConfigScreen.kt` | 移除 tunnel override UI，增加分流设置入口 |
| `MainActivity.kt` | 增加 `RoutingScreen` 导航 |
| `app/build.gradle.kts` | 集成 `tun2socks` 依赖和 geosite assets |

## 数据流

### VPN 与 tun2socks

```text
BlockProxyVpnService
  1. 在建立 VPN 前记录底层网络和 DNS 信息
  2. 启动 LocalSocksServer，监听 127.0.0.1:<localPort>
  3. 建立 VPN：addAddress + addRoute("0.0.0.0", 0)
  4. 启动 tun2socks：TUN fd -> 127.0.0.1:<localPort>
  5. 所有 tunnel/direct socket 都调用 VpnService.protect()
```

`tun2socks` 的具体集成方式在实现阶段确定，可以是 Android 可用的 native binary、JNI library 或可嵌入模块。无论选择哪种方式，必须满足：

- 输入为 `VpnService.establish()` 返回的 TUN fd。
- 输出为本地 SOCKS5 server。
- 能在服务停止时可靠退出。
- 不让本地 SOCKS5、tunnel socket、direct socket 回流进 VPN。
- 域名来源策略有明确能力边界：如果 SOCKS5 只提供 IP，需要 fakeDNS/本地 DNS 映射辅助；若首版不启用 fakeDNS，则域名规则只能匹配 ATYP_DOMAIN 请求，IP-only 请求按兜底处理。

### SOCKS5 请求处理

```text
tun2socks -> LocalSocksServer
  -> 解析 SOCKS5 greeting
  -> 解析 CONNECT request
  -> targetHost 可能是 domain，也可能是 IP
  -> endpoint = DomainMappingStore.resolve(targetHost, targetPort)
  -> RoutingEngine.resolve(endpoint.connectHost, endpoint.domain)
  -> direct: protect(Socket) 后连接 endpoint.connectHost:endpoint.port
  -> proxy: ForwardSessionRegistry.open(endpoint.connectHost, endpoint.port)
  -> 双向 relay
```

首版仅支持 SOCKS5 `CONNECT`。`UDP ASSOCIATE` 返回不支持或关闭连接。

`SocksSession` 表示单个 SOCKS5 客户端连接的生命周期。它持有客户端 socket、`ResolvedEndpoint`、直连 socket 或 `ForwardSession`、双向 relay coroutine，以及 session 级清理逻辑。`LocalSocksServer` 只负责监听和创建 session，`SocksProtocol` 只负责协议解析和响应编码。

### 域名来源

域名规则依赖域名。不能假设 `tun2socks` 总会给 SOCKS5 域名，因为很多 App 会先通过系统 DNS 得到 IP，再建立 TCP 连接。设计按优先级处理：

1. SOCKS5 request 的 `ATYP_DOMAIN`：直接使用该域名，连接目标也是该域名。
2. `DomainMappingStore.resolve(ip)`：由 fakeDNS 或本地 DNS resolver 维护，返回用于分流的域名以及真正用于连接的 host。
3. 无域名：`RoutingEngine` 只按配置兜底处理，首版不做 SNI/HTTP Host sniffing。

首版推荐实现 `DomainMappingStore` 接口和内存缓存，并在 `tun2socks` 集成任务中决定是否启用 fakeDNS。若使用 fakeDNS，store 必须能识别 fake IP，并把 fake IP 还原成域名作为 `connectHost`；不能把 fake IP 传给直连 socket 或 Forward CONNECT。若选定的 `tun2socks` 方案无法提供 fakeDNS，文档和 UI 需要明确“部分 IP-only 流量不能命中域名规则”。

建议的数据结构：

```kotlin
data class ResolvedEndpoint(
    val originalHost: String,
    val connectHost: String,
    val port: Int,
    val domain: String?,
    val source: DomainSource,
)

enum class DomainSource {
    SOCKS_DOMAIN,
    FAKE_DNS,
    DNS_CACHE,
    IP_ONLY,
}
```

## Forward CONNECT

Forward CONNECT 复用现有 tunnel frame：

```text
Android client                          block-proxy server
     |-- CONNECT [reqid, addr, port] -->|
     |<-- CONNECT_OK / FAILED ----------|
     |-- DATA [reqid, bytes] ---------->|
     |<-- DATA [reqid, bytes] ----------|
     |-- CLOSE [reqid] ---------------->|
     |<-- CLOSE [reqid] ----------------|
```

reqid 约定：

- Reverse CONNECT：`0x0001..0x7FFF`
- Forward CONNECT：`0x8000..0xFFFE`

Android 端必须新增 `ForwardSessionRegistry`，不能只给 `TunnelClient` 加发送方法。Registry 负责：

- 分配未被占用的 forward reqid，wrap 时跳过活跃 reqid。
- 将 reqid 绑定到具体 `TunnelConnection`。
- round-robin 选择可用 tunnel connection。
- 等待 `CONNECT_OK` / `CONNECT_FAILED`，带超时。
- 把 inbound `DATA` 放入 per-session queue，提供背压。
- 收到 `CLOSE` 时结束 session。
- tunnel connection 断开时，只清理绑定到该 connection 的 forward sessions。
- `stop()` 时关闭所有 forward sessions。

`TunnelClient` 的 frame dispatch 需要区分：

- `Frame.Connect` with reverse reqid -> `ReverseConnectHandler`
- `Frame.Data` / `Frame.Close` for known forward reqid -> `ForwardSessionRegistry`
- `Frame.Data` / `Frame.Close` for reverse reqid -> `ReverseConnectHandler`
- `Frame.ConnectOk` / `Frame.ConnectFailed` -> `ForwardSessionRegistry`

新增 forward dispatch 只能扩展现有 tunnel 分发逻辑，不能改变服务端发起的 reverse CONNECT 行为。所有 server-originated `CONNECT` 仍必须由 `ReverseConnectHandler` 处理，并继续使用原有 per-connection session 清理、`CONNECT_OK`/`CONNECT_FAILED` 顺序和 target socket `protect()` 语义。任何修改 `TunnelClient` 或 VPN 默认路由的任务都必须跑 reverse CONNECT 回归测试。

## RoutingEngine

```kotlin
enum class RouteDecision { DIRECT, PROXY }

class RoutingEngine(
    private val config: RoutingConfig,
    private val geositeMatcher: GeositeMatcher,
) {
    fun resolve(targetHost: String, domain: String?): RouteDecision
}
```

行为：

1. `config.enabled == false`：所有 TCP CONNECT 走 `PROXY`。
2. 分流开启时，先检查 `directRules`。
3. 未命中 direct，再检查 `proxyRules`。
4. 都未命中，返回 `DIRECT`。
5. `domain == null` 时无法匹配 `domain:` / `geosite:`，直接走兜底。

规则格式：

```text
# comment
domain:example.com
geosite:cn
geosite:google
```

`domain:example.com` 匹配 `example.com` 和其子域名。

## 配置

### RoutingConfig

```kotlin
data class RoutingConfig(
    val enabled: Boolean = false,
    val directRules: List<String> = emptyList(),
    val proxyRules: List<String> = emptyList(),
)
```

存储使用 DataStore Preferences，规则按换行序列化。不要写 JSON 描述，也不要引入 JSON parser。

Repository 模式与现有 `ConfigRepository` 对齐：

```kotlin
interface RoutingConfigDataSource {
    fun observe(): Flow<RoutingConfig>
    suspend fun save(config: RoutingConfig)
    suspend fun clear()
}

class RoutingConfigRepository(private val source: RoutingConfigDataSource)
```

### ServerConfig

```kotlin
data class ServerConfig(
    val serverHost: String,
    val serverPort: Int = 8003,
    val useTls: Boolean = true,
    val allowInsecure: Boolean = true,
)
```

移除 `tunnelHost/tunnelPort` 后，现有 `TunnelClient` 必须改用 `config.serverHost` 和 `config.serverPort`。

## UI

`RoutingScreen` 保持简单：

- Switch：启用/禁用分流。
- Tab：直连规则 / 代理规则。
- 多行输入框：每行一条规则。
- 保存按钮：保存到 DataStore。

`ConfigScreen` 在电池优化前增加分流入口，并展示当前状态：

- 启用：`已启用`
- 未启用：`未启用（全走代理）`

保存后首版可以要求重启 VPN 服务生效；热更新可作为后续增强。

## 测试策略

### 单元测试

| 测试 | 覆盖 |
|---|---|
| `RoutingConfigRepositoryTest` | 默认值、保存、读取、换行规则序列化、fake data source |
| `RoutingEngineTest` | disabled 全代理、direct 优先、proxy 命中、兜底直连、null domain |
| `GeositeMatcherTest` | full/domain/plain/regex |
| `ProtoParserTest` | geosite protobuf 基础解析 |
| `SocksProtocolTest` | SOCKS5 greeting、CONNECT 解析、unsupported command |
| `LocalSocksServerTest` | CONNECT 后按 routing 调 direct/proxy handler |
| `ForwardSessionRegistryTest` | reqid 分配、wrap 避开活跃、CONNECT_OK/FAILED、DATA queue、connection 断开清理 |
| `Tun2SocksControllerTest` | 启停命令构造、进程退出、失败状态 |

### 集成测试

- Fake tunnel server 验证 Forward CONNECT 完整流程。
- Fake SOCKS client 验证 `LocalSocksServer` 能完成 CONNECT 和双向 relay。
- `BlockProxyVpnService` 仪器测试验证启动顺序和资源清理。

### 端到端 Smoke Test

1. 启动 block-proxy 服务端。
2. Android 客户端启动 VPN。
3. 分流关闭：浏览器访问网站，连接经 Forward CONNECT。
4. 分流开启：`domain:example.com` 放 direct，访问 example.com 直连；代理规则命中时走 tunnel。
5. 验证 IP-only 流量的兜底行为符合文档。

## 风险与限制

| 风险 | 影响 | 缓解 |
|---|---|---|
| `tun2socks` 选型不支持 fakeDNS | 部分请求只得到 IP，域名规则无法命中 | 设计保留 `DomainMappingStore`；文档明确 IP-only 兜底 |
| 非 DNS UDP/QUIC 不支持 | HTTP/3、部分游戏或实时应用不可用 | 首版可要求系统/浏览器回退 TCP；后续设计 UDP |
| Android 厂商后台限制 | VPN/tun2socks 进程可能被杀 | 复用现有前台服务、WakeLock、watchdog |
| socket 未 protect | 直连/tunnel 流量回流 VPN，形成环路 | 所有 outbound socket 必须经 `VpnService.protect()`，加测试和日志 |
| geosite.dat 过期 | 新域名无法命中 | assets 内置，后续可做手动更新 |
| reqid wrap 碰撞 | 错发 DATA/CLOSE 到错误 session | Registry 分配时跳过活跃 reqid |

## 服务端影响

服务端无需修改。Forward CONNECT 已由现有 tunnel server/manager 处理。Android 端新增的是客户端发起方能力和 session 管理。
