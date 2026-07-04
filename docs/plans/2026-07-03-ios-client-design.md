# iOS 客户端设计文档

## 概述

iOS 客户端用于平替 macOS 客户端的核心隧道能力。首版目标是通过建立与 block-proxy 服务端的反向隧道连接，使外网设备能够通过服务端访问 iOS 所在内网的资源。

核心挑战是 iOS 会不定期挂起或终止普通 App 进程，因此使用 iOS 系统级 VPN（Network Extension）承载隧道长连接。`NEPacketTunnelProvider` 能显著提高后台存活概率，但不能把系统重启、Extension 崩溃、内存压力恢复视为确定 SLA；设计必须包含重连、状态恢复和实机保活验证。

## 设计决策

| 决策项 | 选择 | 理由 |
|-------|------|------|
| 功能范围 | 首版仅实现服务端回程访问 iOS 内网 | 优先实现 reverse CONNECT；不含本地代理/分流/客户端主动 forward CONNECT |
| 保活方案 | NEPacketTunnelProvider + 应用层重连 | 系统级 VPN 进程更适合长连接，但仍需处理断线、网络切换和 Extension 被终止 |
| VPN 路由 | 空路由表（需实机验证） | VPN 仅用于保活，不拦截设备流量；是否能稳定启动和后台存活必须前置验证 |
| 技术栈 | 纯 Swift + SwiftUI | 与 iOS 系统 API 集成最顺畅 |
| 网络框架 | Network.framework (NWConnection) | 比 URLSession 更适合长连接场景；需显式补齐 TCP 选项、读超时和网络切换处理 |
| 配置管理 | 手动配置表单 | 简单可靠，支持保存多个配置 |
| UI 风格 | 极简风格 | 状态显示 + 启停按钮 + 配置页 |
| 部署方式 | 侧载（TestFlight / Xcode） | 个人使用，不受 App Store 审核限制 |
| TLS 证书校验 | 默认 `allowInsecure=true` | TLS 主要用于加密隧道流量；个人侧载场景默认不要求服务端证书链可信，用户可手动关闭 |

## 首版范围

首版实现协议子集，而不是完整复制 macOS client 的所有能力：

- 必须支持：AUTH / AUTH_OK / AUTH_FAIL / ERROR、PING / PONG、服务端发起的 CONNECT / DATA / CLOSE / CONNECT_FAILED。
- 必须支持：与服务端建立 1 到 2 条 TLS tunnel 连接；第二条连接失败时允许单连接运行；双连接降级后尝试补充连接。
- 必须支持：block-proxy 服务端通过 tunnel 回程访问 iOS 所在内网的 TCP 资源。
- 暂不支持：iOS 端本地 SOCKS5/HTTP 代理、geosite/geoip 分流、UDP over TCP。
- 暂不支持：iOS 客户端主动通过 tunnel 发起 forward CONNECT 到服务端侧 AnyProxy。保留 `0x8000-0xFFFE` forward reqid 约定，但首版不分配和使用该区间。

## 架构

### 项目结构

```
ios-client/
├── BlockProxy/                    # 主 App Target
│   ├── App/
│   │   ├── BlockProxyApp.swift    # SwiftUI App 入口
│   │   └── ContentView.swift      # 主界面
│   ├── Models/
│   │   ├── ServerConfig.swift     # 服务器配置模型
│   │   └── TunnelStatus.swift     # 连接状态枚举
│   ├── ViewModels/
│   │   └── TunnelViewModel.swift  # 连接状态管理
│   ├── Views/
│   │   ├── StatusView.swift       # 连接状态显示
│   │   └── ConfigView.swift       # 配置表单
│   ├── Services/
│   │   └── VPNManager.swift       # VPN 配置与启停管理
│   └── Utils/
│       └── ConfigStore.swift      # 配置持久化（UserDefaults/Keychain）
│
├── TunnelExtension/               # Network Extension Target
│   ├── Info.plist
│   ├── PacketTunnelProvider.swift # VPN 进程入口（系统调用）
│   ├── TunnelClient.swift         # 隧道客户端核心（Swift 实现）
│   ├── FrameCodec.swift           # 帧编解码 + TCP 字节流组帧
│   └── TunnelConfig.swift         # 配置传递（App Group 共享）
│
├── BlockProxy.xcodeproj           # Xcode 项目文件
└── BlockProxy.entitlements        # 权限声明
```

### 进程模型

```
┌─────────────────────────────────────────────────┐
│                 主 App 进程                       │
│  ┌───────────┐  ┌────────────┐  ┌────────────┐ │
│  │  SwiftUI  │  │ VPNManager │  │ ConfigStore│ │
│  │    UI     │  │ (启停 VPN) │  │ (持久化)   │ │
│  └───────────┘  └────────────┘  └────────────┘ │
│         ▲              │                          │
│         │              │ startVPNTunnel()         │
│         │              ▼                          │
│         │   ┌──────────────────────┐             │
│         │   │  App Group 共享存储   │             │
│         │   │ (UserDefaults suite) │             │
│         │   └──────────────────────┘             │
└─────────┼─────────────────────────────────────────┘
          │
          │  通过 App Group 读取配置
          ▼
┌─────────────────────────────────────────────────┐
│          PacketTunnelProvider 进程                │
│          (Network Extension, 系统级保活)          │
│  ┌──────────────────────────────────────────────┐│
│  │              TunnelClient                     ││
│  │  ┌──────────┐  ┌──────────┐  ┌───────────┐  ││
│  │  │FrameCodec│  │ TLS 连接  │  │ 重连逻辑  │  ││
│  │  │(帧编解码)│  │(NWConnection)│ │(指数退避) │  ││
│  │  └──────────┘  └──────────┘  └───────────┘  ││
│  └──────────────────────────────────────────────┘│
│                     │                             │
│                     ▼                             │
│          ┌─────────────────────┐                  │
│          │  block-proxy 服务端  │                  │
│          │  (隧道端口 8003)     │                  │
│          └─────────────────────┘                  │
└─────────────────────────────────────────────────┘
```

### 保活机制

| 场景 | iOS 行为 | 应对 |
|------|---------|------|
| App 进入后台 | Network Extension 通常继续运行 | TunnelClient 保持 TLS 长连接并响应 PING |
| 主 App 被系统杀死 | Extension 是独立进程，通常不受影响 | Extension 内部独立维护配置、状态和重连 |
| 隧道连接断开 | Extension 进程仍存活 | TunnelClient 内部自动重连 |
| 网络切换 | 旧 NWConnection 可能失效 | 监听 connection state/path update，关闭旧连接并按指数退避重连 |
| Extension 进程崩溃 | 不能假设一定立即自动恢复 | 主 App 下次启动时检查 VPN 状态并提示/尝试恢复 |
| 设备重启 | VPN 配置保留，但 tunnel 不一定自动启动 | 主 App 启动时检查并允许一键重新启动 |
| 系统内存压力 | Extension 可能被终止 | 降低内存占用，状态写入 App Group，依赖用户或系统重新拉起后恢复 |

保活验收必须用真机覆盖：锁屏、后台、杀主 App、WiFi/蜂窝切换、30 分钟空闲、服务端重启、设备弱网恢复。

## 隧道协议

首版使用与 macOS client 的 `tunnel_client.py` 和服务端 `tunnel/protocol.js` 相同的帧格式和常量，但只实现服务端回程访问 iOS 内网所需的协议子集。

### 帧类型

```swift
enum FrameType: UInt8 {
    case connect        = 0x01
    case data           = 0x02
    case close          = 0x03
    case connectOK      = 0x04
    case ping           = 0x10
    case pong           = 0x11
    case auth           = 0x20
    case authOK         = 0x21
    case authFail       = 0x22
    case error          = 0x23
    case connectFailed  = 0x81
}

enum AddressType: UInt8 {
    case ipv4   = 0x01
    case domain = 0x03
    case ipv6   = 0x04
}
```

### 帧格式

所有帧以 2 字节大端长度前缀开始，后跟 payload：

```
+--------+------------------+
| Length |     Payload      |
| 2 byte |   variable       |
+--------+------------------+
```

Payload 第一字节为帧类型，后续字段依类型而定：

- **AUTH**: `[type][uname_len][username][passwd_len][password]`
- **CONNECT**: `[type][reqid:2][atyp][addr...][port:2]`
- **DATA**: `[type][reqid:2][data...]`
- **CLOSE / CONNECT_OK / CONNECT_FAILED**: `[type][reqid:2]`
- **ERROR**: `[type][msg_len][message]`
- **PING / PONG / AUTH_OK / AUTH_FAIL**: `[type]`

边界约束：

- 帧 payload 最大为 65535 字节。
- DATA 帧头部为 3 字节，因此单帧 data 最大为 65532 字节。
- `uname_len`、`passwd_len`、domain 长度、`msg_len` 都是 1 字节，最大 255 字节。
- 服务端发起的 reverse reqid 使用 `1...0x7FFF`；Python forward reqid 约定为 `0x8000...0xFFFE`，iOS 首版不使用该区间。
- IPv4 和 domain 必须完整支持。IPv6 常量保留，但首版不作为验收目标，避免与 Python encode 侧行为不一致。

### 字节流组帧

TCP 是字节流，`NWConnection.receive()` 每次交付的数据长度不保证等于一个完整 tunnel frame。一次 receive 可能只包含长度前缀的 1 字节，也可能包含半个 payload，或同时包含上一帧尾部和下一帧前缀。

因此 `FrameCodec` 不只负责单帧 encode/decode，还需要提供 per-connection frame extractor：

1. 每条 tunnel 连接维护独立 receive buffer。
2. 每次 `receive()` 得到 bytes 后 append 到该连接 buffer。
3. buffer 少于 2 字节时等待更多数据。
4. buffer 满足 2 字节后读取 big-endian payload length。
5. buffer 少于 `2 + length` 时继续等待。
6. buffer 满足完整帧后 decode payload，消费 `2 + length` 字节。
7. 如果 buffer 中还有后续数据，继续循环提取下一帧。
8. 如果 length 超过协议上限或 payload 解码失败，关闭该 tunnel 连接并清理其 reqid sessions。

idle timeout 语义与 Python `wait_for(read_frame(...), timeout=60)` 对齐：从开始等待下一完整帧时计时，只有完整帧成功组装并解码后才重置 60 秒 timer。收到半个 length prefix 或半个 payload 不算一次完整活动，不能重置 timer。

### 与 Python 版本的对应关系

| Python (tunnel_client.py) | Swift (TunnelClient.swift) |
|---|---|
| `encode_frame()` / `decode_frame_from_buffer()` | `FrameCodec.encode()` / `FrameCodec.decode()` |
| `readexactly(2)` + `readexactly(length)` | per-connection receive buffer + frame extractor |
| `asyncio.open_connection()` | `NWConnection` |
| `ssl.create_default_context()` | `NWParameters.tls` |
| `_set_tcp_options()` | `NWParameters` TCP options（尽力启用 noDelay/keepalive，实际间隔受 iOS 和网络类型影响） |
| `wait_for(read_frame, timeout=60)` | `receive()` 外层包装 Task 超时竞态 |
| `asyncio.Event()` | per-reqid 状态对象 + continuation/actor |
| `asyncio.Queue` | per-reqid 有序缓冲 |
| `asyncio.TaskGroup` | 连接级 task 管理，单个 reqid 的写入必须保持顺序 |
| `_run_loop()` 指数退避 | `runLoop()` 指数退避 |

### 关键差异（vs macOS client）

1. **首版协议子集**：macOS `TunnelClient` 同时支持 reverse CONNECT 和客户端主动 forward CONNECT；iOS 首版只支持服务端回程访问 iOS 内网
2. **NWConnection vs asyncio**：Swift Network framework API 不同，但用 async/await 包装后逻辑一致
3. **无本地代理服务器**：macOS 在本地启动 SOCKS5/HTTP 代理（1080/1087），iOS 首版不暴露本地代理端口
4. **无 UDP over TCP**：iOS 回程访问场景首版只处理 TCP
5. **无分流引擎**：iOS 不含 geosite/geoip 分流
6. **TCP keepalive 不完全等价**：Python 会设置 `TCP_NODELAY`、`SO_KEEPALIVE`、`TCP_KEEPIDLE=60`、`TCP_KEEPINTVL=10`、`TCP_KEEPCNT=3`。iOS 端应尽量通过 `NWParameters` 配置等效能力，但蜂窝网络和系统策略可能覆盖 keepalive 间隔，所以不能只依赖 TCP keepalive，仍需应用层 PING/PONG 和读超时。
7. **读超时需自行实现**：`NWConnection.receive()` 没有 Python `asyncio.wait_for()` 的内置超时语义。每条 tunnel 连接必须用 receive task 和 sleep task 竞态实现 60 秒完整帧 idle timeout，避免对端静默断开时永久等待。
8. **连接超时需自行实现**：Python 初始 tunnel connect timeout 为 10 秒，reverse CONNECT 到内网目标 timeout 为 30 秒。`NWConnection` 没有直接等价参数，Swift 端都需要用 Task 超时包装。
9. **网络切换不是无缝迁移**：WiFi/蜂窝切换按断线重连处理。可以评估 `multipathServiceType = .handover`，但 block-proxy 服务端未按 MPTCP 设计，首版不承诺连接迁移或无缝切换。
10. **DNS 行为不同**：`NWConnection` 可能使用 Happy Eyeballs 并优先/并发尝试 IPv6 和 IPv4，和 Python `asyncio.open_connection()` 选择结果可能不同。首版验证需同时覆盖内网 IP 和域名目标，纯 IPv4 内网环境优先使用 IPv4 地址排查问题。

### 帧处理语义

- AUTH 阶段收到 `AUTH_OK` 后连接可用。
- AUTH 阶段收到 `AUTH_FAIL` 时进入 `authFailed`，不自动重试。
- AUTH 阶段收到 `ERROR` 时按 Python 行为映射为 `occupied`，停止重试。
- AUTH 之后收到 `ERROR` 时与 Python 主循环保持兼容：记录日志并忽略，不改变连接状态。
- 每条 tunnel 连接独立处理 `PING`，并在同一条连接上回复 `PONG`。
- 任意完整帧到达都会重置该连接的 60 秒 idle timeout；服务端 30 秒 PING 是空闲兜底，不是唯一重置源。

### 双连接模型

Python 客户端会优先建立 2 条 tunnel 连接，服务端最多接收 2 条连接并对请求做 round-robin。iOS 首版也应遵循这一模型：

1. 第一条连接必须成功认证，否则 tunnel 不可用。
2. 第二条连接尽力建立，失败不影响单连接运行。
3. 任意一条连接断开时，只清理该连接承载的 reqid。
4. 双连接降级为单连接后，后台尝试补充第二条连接。
5. 所有连接都断开时进入 `reconnecting`，按 1s、2s、4s、...、60s 指数退避重连。
6. 服务端 PING 会广播到所有已认证连接；iOS 每条连接必须独立回复 PONG，并分别维护 idle timeout。

### 并发模型

- 每条 tunnel 连接有独立 receive loop，负责帧解码、PING/PONG、连接级 idle timeout 和该连接承载的 reqid 分发。
- 每个 reqid session 持有自己的 relay Task 引用，直到双向转发和清理结束，避免未持有 Task 导致生命周期不可控。
- target -> tunnel 和 tunnel -> target 使用独立 Task，但同一方向内的写入必须串行化。
- 每条 tunnel 连接必须有独立 send queue 或 send actor。所有 `CONNECT_OK`、`CONNECT_FAILED`、`DATA`、`CLOSE`、`PONG` 帧都通过该队列发送，下一帧必须等待上一帧 `NWConnection.send` completion 后再发送，确保 wire order 与 enqueue order 一致。
- per-reqid 的 DATA 顺序只解决同一请求的数据顺序；per-connection send queue 还要解决多个 reqid、PING/PONG 和 CLOSE 混合发送时的连接级顺序。
- 不把所有 reqid 的数据转发放进单一 actor 的长时间同步执行块；需要在大数据转发循环中显式 `Task.yield()`，保持多 reqid 公平调度。
- 共享状态（连接列表、reqid session 表、状态回调）可由 actor 或串行队列保护，但数据面读写不应长时间占用该 actor。

### TunnelClient 生命周期契约

- `start()` 只负责启动后台重连循环并立即返回，不能阻塞 `PacketTunnelProvider.startTunnel()` 的 completion。
- `start()` 返回并不代表 tunnel 已连接；连接状态通过状态回调和 App Group 状态同步。
- `stop()` 负责停止重连循环，关闭所有 tunnel connections 和 target connections，并等待清理完成。
- `stopTunnel()` 调用 `stop()` 时应等待清理完成或达到固定 timeout，再调用 completionHandler。
- 如果 `stop()` 超时，必须强制 cancel relay tasks 并关闭 `NWConnection`，然后返回，避免 Network Extension 停止流程卡死。

### NWConnection 状态处理

- `.ready`：连接可用，开始认证或继续收发帧。
- `.waiting`：网络暂时不可用，等待系统恢复；设置一个短 timeout（例如 5 到 10 秒），超时仍未恢复再主动关闭并进入重连。
- `.failed`：不可恢复错误，立即关闭该连接并进入重连或补充连接流程。
- `.cancelled`：按本地关闭处理，清理该连接承载的 reqid sessions。
- path update 只作为辅助信号，最终以连接 state 和 idle timeout 共同判断是否重连。

### Reverse CONNECT 数据流

每个服务端发起的 CONNECT 对应一个独立 reqid session：

1. 收到 CONNECT 后，iOS 连接目标内网地址。
2. 连接成功后发送 CONNECT_OK；失败或超时发送 CONNECT_FAILED。
3. target -> tunnel：从目标读取数据，按最大 65532 字节切片成 DATA 帧，按读取顺序写入承载该 reqid 的 tunnel 连接。
4. tunnel -> target：收到 DATA 后按帧顺序写入目标连接，不能并发乱序写同一个 target；单个逻辑写入可能被服务端拆成多个连续 DATA 帧，必须连续接收并顺序交付。
5. 任一方向 EOF 或收到 CLOSE 时关闭对应 session，并向对端发送一次 CLOSE；CLOSE 必须幂等。
6. 收到 CLOSE 后仍可能有 DATA 在途，或本地准备发送 CLOSE 时服务端同时发送 DATA。session 进入 closing 后允许优雅丢弃迟到 DATA，不再写入已关闭 target。
7. 连接级断开时，只清理该连接上的 active sessions，并向状态层报告降级或重连。

## VPN 配置

### PacketTunnelProvider

```swift
class PacketTunnelProvider: NEPacketTunnelProvider {
    private var tunnelClient: TunnelClient?

    override func startTunnel(options: [String: NSObject]?,
                              completionHandler: @escaping (Error?) -> Void) {
        // 空路由表：不拦截任何流量
        let settings = NEPacketTunnelNetworkSettings(
            tunnelRemoteAddress: "127.0.0.1"
        )
        settings.ipv4Settings = NEIPv4Settings(
            addresses: ["10.0.0.2"],
            subnetMasks: ["255.255.255.0"]
        )
        settings.ipv4Settings?.includedRoutes = []
        settings.ipv4Settings?.excludedRoutes = [NEIPv4Route.default()]

        setTunnelNetworkSettings(settings) { error in
            guard error == nil else { return completionHandler(error) }
            let config = ConfigStore.shared.load()
            self.tunnelClient = TunnelClient(config: config)
            self.tunnelClient?.start()
            completionHandler(nil)
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason,
                             completionHandler: @escaping () -> Void) {
        tunnelClient?.stop()
        completionHandler()
    }
}
```

### VPNManager（主 App 端）

```swift
class VPNManager: ObservableObject {
    func setupVPN() async throws {
        let config = NETunnelProviderProtocol()
        config.providerBundleIdentifier = "com.blockproxy.tunnel-extension"
        config.serverAddress = "BlockProxy Tunnel"
        let manager = NETunnelProviderManager()
        manager.protocolConfiguration = config
        manager.localizedDescription = "BlockProxy"
        manager.isEnabled = true
        try await manager.saveToPreferences()
    }

    func startVPN(config: ServerConfig) async throws {
        try ConfigStore.shared.save(config)
        let manager = try await loadBlockProxyManager()
        try manager.connection.startVPNTunnel()
    }

    func stopVPN() async throws {
        let manager = try await loadBlockProxyManager()
        manager.connection.stopVPNTunnel()
    }
}
```

`VPNManager` 不能在 `loadAllFromPreferences()` 后直接取 `.first`。必须按 `providerBundleIdentifier` 或 `localizedDescription` 找到 BlockProxy 对应的 `NETunnelProviderManager`，并在 `setupVPN()` 后持有/复用该 manager。

## 跨进程通信

主 App 和 Network Extension 运行在不同进程，通过 App Group + Darwin Notification 通信：

### Extension → App（状态推送）

1. Extension 将状态写入 App Group UserDefaults
2. 发送 Darwin Notification 通知主 App
3. 主 App 监听通知，读取最新状态刷新 UI

### App → Extension（状态查询）

1. 通过 `NETunnelProviderSession.sendProviderMessage()` 发送查询
2. Extension 在 `handleAppMessage()` 中返回当前状态

### App → Extension（配置变更）

1. 主 App 将新配置写入 App Group 和 Keychain。
2. 若 tunnel 正在运行，通过 `sendProviderMessage()` 通知 Extension 配置已变更。
3. Extension 对比配置版本：仅 UI 状态类配置可热更新；服务器地址、端口、TLS、认证信息变化时，停止当前 tunnel 连接并按新配置重连。
4. 如果 Extension 未运行，配置留待下次 `startTunnel()` 读取。

推荐组合使用：App 启动时用 `handleAppMessage` 拉取精确状态，之后依赖 Darwin Notification 实时更新；配置变更使用 `sendProviderMessage()` 主动通知。

## UI 设计

### 主界面

极简风格，包含：
- 状态指示器（圆点颜色 + 文本）
- 启用/禁用开关
- 延迟显示（连接时）
- 配置入口

### 状态显示

| 隧道状态 | 圆点颜色 | 显示文本 |
|---------|---------|---------|
| `.disconnected` | 灰色 | 已断开 |
| `.connecting` | 黄色 | 正在连接... |
| `.connected` | 绿色 | 已连接 |
| `.reconnecting` | 橙色 | 重连中 (5s) |
| `.occupied` | 红色 | 端口被占用 |
| `.authFailed` | 红色 | 认证失败 |

### 配置页面

表单包含：
- 服务器地址、端口
- TLS 开关、允许不安全证书开关（默认开启 `allowInsecure`）
- 用户名、密码
- 隧道服务器地址/端口（可选覆盖）

### 服务端配置依赖

block-proxy 服务端只有匹配 `tunnel_domains` 的请求才会走 tunnel 回程访问 iOS 内网。部署说明必须要求用户在管理页面的“隧道域名列表”中添加需要回程到 iOS 内网的域名；如果使用 IP 访问，也需要确认服务端规则能匹配该目标，否则 tunnel 已连接但请求不会进入 `TunnelManager.forward()`。

## 配置存储

| 数据类型 | 存储方式 | 理由 |
|---------|---------|------|
| 服务器地址、端口、TLS 等 | UserDefaults (App Group) | 非敏感，需跨进程共享 |
| 用户名、密码 | Keychain (App Group) | 敏感信息，需安全存储 |

## 项目配置

### Entitlements

- `com.apple.security.application-groups`: `group.com.blockproxy`
- `com.apple.developer.networking.networkextension`: `packet-tunnel-provider`
- `keychain-access-groups`: `$(AppIdentifierPrefix)com.blockproxy`

### Apple Developer 配置

1. App ID `com.blockproxy`：启用 Network Extensions + App Groups
2. App ID `com.blockproxy.tunnel-extension`：Network Extension target
3. Provisioning Profile：包含 Network Extension entitlement
4. App Group：`group.com.blockproxy`

### Target 配置

| 配置项 | 主 App | TunnelExtension |
|-------|--------|----------------|
| Bundle ID | `com.blockproxy` | `com.blockproxy.tunnel-extension` |
| Deployment Target | iOS 17.0 | iOS 17.0 |
| App Group | `group.com.blockproxy` | `group.com.blockproxy` |
| Network Extension | — | Packet Tunnel Provider |
| Embed | — | Embed Without Signing |

## 待确认

- Bundle ID 是否需要调整（当前 `com.blockproxy`）
- 是否需要支持多个隧道配置的切换
- 是否需要在状态栏显示 VPN 图标（iOS 系统强制显示）
