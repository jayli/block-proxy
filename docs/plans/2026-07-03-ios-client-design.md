# iOS 客户端设计文档

## 概述

iOS 客户端用于平替 macOS 客户端的隧道功能。通过建立与 block-proxy 服务端的反向隧道连接，使外网设备能够通过服务端访问 iOS 所在内网的资源。

核心挑战是 iOS 会不定期杀死 App 进程，因此必须使用 iOS 系统级 VPN（Network Extension）来保活隧道进程。

## 设计决策

| 决策项 | 选择 | 理由 |
|-------|------|------|
| 功能范围 | 仅隧道功能 | 平替 macOS client，不含本地代理/分流 |
| 保活方案 | NEPacketTunnelProvider | 系统级保活，Extension 进程不会被轻易杀死 |
| VPN 路由 | 空路由表 | VPN 仅用于保活，不拦截任何网络流量 |
| 技术栈 | 纯 Swift + SwiftUI | 与 iOS 系统 API 集成最顺畅 |
| 网络框架 | Network.framework (NWConnection) | 比 URLSession 更适合长连接场景 |
| 配置管理 | 手动配置表单 | 简单可靠，支持保存多个配置 |
| UI 风格 | 极简风格 | 状态显示 + 启停按钮 + 配置页 |
| 部署方式 | 侧载（TestFlight / Xcode） | 个人使用，不受 App Store 审核限制 |

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
│   ├── FrameCodec.swift           # 帧编解码（与 Python 版本协议兼容）
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
| App 进入后台 | Network Extension 继续运行 | 无需特殊处理 |
| 主 App 被系统杀死 | Network Extension 继续运行 | Extension 是独立进程 |
| 隧道连接断开 | Extension 进程仍存活 | TunnelClient 内部自动重连 |
| Extension 进程崩溃 | iOS 自动重启 Extension | `startTunnel()` 被再次调用 |
| 设备重启 | VPN 配置保持，需用户手动启动 | 可在主 App 启动时自动尝试启动 |
| 系统内存压力 | Extension 可能被终止 | iOS 会在资源恢复后重启 |

## 隧道协议

与 macOS client 的 `tunnel_client.py` 完全兼容，使用相同的帧格式和常量。

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

### 与 Python 版本的对应关系

| Python (tunnel_client.py) | Swift (TunnelClient.swift) |
|---|---|
| `encode_frame()` / `decode_frame_from_buffer()` | `FrameCodec.encode()` / `FrameCodec.decode()` |
| `asyncio.open_connection()` | `NWConnection` |
| `ssl.create_default_context()` | `NWParameters.tls` |
| `asyncio.Event()` | `CheckedContinuation` |
| `asyncio.Queue` | `AsyncStream<Data>` |
| `asyncio.TaskGroup` | `TaskGroup` |
| `_run_loop()` 指数退避 | `runLoop()` 指数退避 |

### 关键差异（vs macOS client）

1. **无本地代理服务器**：macOS 在本地启动 SOCKS5/HTTP 代理（1080/1087），iOS 只做反向隧道
2. **NWConnection vs asyncio**：Swift Network framework API 不同，但用 async/await 包装后逻辑一致
3. **无 UDP over TCP**：iOS 反向隧道场景主要是 TCP，暂不需要 UDP 支持
4. **无分流引擎**：iOS 不含 geosite/geoip 分流

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
        let managers = try await NETunnelProviderManager.loadAllFromPreferences()
        try managers.first?.connection.startVPNTunnel()
    }

    func stopVPN() async throws {
        let managers = try await NETunnelProviderManager.loadAllFromPreferences()
        managers.first?.connection.stopVPNTunnel()
    }
}
```

## 跨进程通信

主 App 和 Network Extension 运行在不同进程，通过 App Group + Darwin Notification 通信：

### Extension → App（状态推送）

1. Extension 将状态写入 App Group UserDefaults
2. 发送 Darwin Notification 通知主 App
3. 主 App 监听通知，读取最新状态刷新 UI

### App → Extension（状态查询）

1. 通过 `NETunnelProviderSession.sendProviderMessage()` 发送查询
2. Extension 在 `handleAppMessage()` 中返回当前状态

推荐组合使用：App 启动时用 `handleAppMessage` 拉取精确状态，之后依赖 Darwin Notification 实时更新。

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
- TLS 开关、允许不安全证书开关
- 用户名、密码
- 隧道服务器地址/端口（可选覆盖）

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
