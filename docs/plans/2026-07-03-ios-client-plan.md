# iOS 客户端实现计划

## 概述

基于 [iOS 客户端设计文档](2026-07-03-ios-client-design.md)，分阶段实现 iOS 隧道客户端。首版优先实现 block-proxy 服务端回程访问 iOS 所在内网资源的能力：iOS 端建立并保活 1 到 2 条 TLS tunnel，接收服务端发起的 reverse CONNECT，并完成 TCP 双向转发。

## 前置条件

- [ ] Apple Developer 账号已启用 Network Extensions capability
- [ ] 创建 App ID `com.blockproxy` 和 `com.blockproxy.tunnel-extension`
- [ ] 创建 App Group `group.com.blockproxy`
- [ ] 生成包含 Network Extension entitlement 的 Provisioning Profile
- [ ] Xcode 16+ 已安装

## 阶段一：项目骨架与 VPN 基础设施

### 1.1 创建 Xcode 项目

- [ ] 创建 iOS App 项目 `BlockProxy`，SwiftUI + Swift
- [ ] 添加 Network Extension target `TunnelExtension`，选择 Packet Tunnel Provider
- [ ] 配置 App Group `group.com.blockproxy`（两个 target 都启用）
- [ ] 配置 Entitlements（App Groups, Network Extension, Keychain）
- [ ] 验证编译通过（主 App + Extension 均可 build）

### 1.2 VPNManager 基础

- [ ] 实现 `VPNManager.swift`：`setupVPN()`, `startVPN()`, `stopVPN()`
- [ ] `VPNManager` 按 `providerBundleIdentifier` / `localizedDescription` 查找 BlockProxy manager，不使用 `loadAllFromPreferences().first`
- [ ] `setupVPN()` 后保存并复用 BlockProxy 对应的 `NETunnelProviderManager`
- [ ] 首次启动时调用 `setupVPN()` 创建 VPN 配置（系统弹出授权对话框）
- [ ] 验证 VPN 可以启动/停止（此时 Extension 为空壳，立即 return）
- [ ] 真机验证空路由表 VPN 配置可以启动，不拦截设备正常网络流量
- [ ] 真机验证至少覆盖 iOS 17.0-17.2、一个较新的 iOS 17.x、iOS 18.x；如果设备不足，记录未覆盖版本风险

### 1.3 ConfigStore

- [ ] 实现 `ConfigStore.swift`：UserDefaults (App Group) 存非敏感配置
- [ ] 实现 `KeychainHelper.swift`：Keychain 存密码
- [ ] 实现 `ServerConfig.swift` 模型（Codable）
- [ ] 验证主 App 写入后 Extension 可读取

**验收标准**：VPN 可启停，配置可跨进程共享；空路由表方案在真机上可启动，且不影响 Safari 等普通网络访问。

## 阶段二：隧道协议实现

### 2.1 FrameCodec

- [ ] 实现 `FrameCodec.swift`：单帧 encode/decode + TCP 字节流组帧
- [ ] 实现所有帧类型的 encode/decode（AUTH, CONNECT, DATA, CLOSE, PING/PONG, ERROR 等）
- [ ] 实现 per-connection receive buffer，从 `NWConnection.receive()` 交付的任意长度 bytes 中拼接并提取完整帧
- [ ] 覆盖 TCP 分片/粘包：半个长度前缀、半个 payload、一个 receive 含多帧、帧尾加下一帧前缀
- [ ] 帧 length 超限或 payload 解码失败时关闭该 tunnel connection 并清理其 reqid sessions
- [ ] 编写单元测试：验证编解码结果与 Python `tunnel_client.py` 输出一致
- [ ] 边界测试：最大 payload 65535、最大 DATA 65532、空 DATA、255 字节用户名/密码/domain/message、IPv4/Domain 地址类型
- [ ] 明确 IPv6 常量保留但首版不作为验收目标

### 2.2 TunnelClient 核心

- [ ] 实现 `TunnelClient.swift`：NWConnection 建立 TCP/TLS 连接
- [ ] 默认 `allowInsecure=true`；TLS 默认用于加密传输，不强制校验证书链
- [ ] 实现初始 tunnel connect 10 秒超时
- [ ] 实现认证流程（发送 AUTH 帧，处理 AUTH_OK / AUTH_FAIL / ERROR）
- [ ] 实现帧处理主循环（PING/PONG, CONNECT, DATA, CLOSE）
- [ ] 实现 60 秒完整帧 idle timeout：开始等待下一完整帧时计时，完整帧 decode 成功后重置；半帧 receive 不重置
- [ ] 实现重连逻辑（指数退避 1s → 2s → 4s → ... → 60s）
- [ ] 实现状态回调（connecting, connected, reconnecting, occupied, authFailed, disconnected）
- [ ] 实现 1 到 2 条 tunnel 连接：第一条必须成功，第二条尽力建立
- [ ] 实现双连接降级后的连接补充逻辑
- [ ] 确保某条 tunnel 断开时只清理该连接承载的 reqid session
- [ ] 配置 TCP 参数：尽力启用 noDelay/keepalive，并记录 iOS 无法保证 Python keepalive 间隔完全等价
- [ ] 配置/评估 `multipathServiceType = .handover`，但验收按断线重连而不是无缝迁移
- [ ] 明确帧语义：AUTH 阶段 ERROR = occupied；AUTH 后 ERROR 仅记录日志并忽略
- [ ] 每条 tunnel 连接独立响应 PING/PONG，并维护独立 idle timeout
- [ ] 实现 `NWConnection` state 策略：`.waiting` 等待系统恢复并设置 5-10 秒超时，`.failed` 立即重建，`.cancelled` 清理本连接
- [ ] 实现 `TunnelClient.start()` 生命周期契约：启动后台重连循环并立即返回，不阻塞 `startTunnel()`
- [ ] 实现 `TunnelClient.stop()` 生命周期契约：停止重连、关闭连接、等待清理完成或 timeout 后强制 cancel

### 2.3 反向连接处理

- [ ] 实现 `_handleReverseConnect()`：接收服务端 CONNECT 请求
- [ ] 连接内网目标地址，30 秒超时；成功发送 CONNECT_OK，失败发送 CONNECT_FAILED
- [ ] 实现 per-reqid session 管理：active target connection、承载 tunnel connection、关闭状态、relay Task 引用
- [ ] 实现 per-connection send queue / send actor：所有 tunnel 帧等待上一帧 `NWConnection.send` completion 后再发送
- [ ] 实现 target → tunnel 转发：按 65532 字节切片 DATA 帧并保持写入顺序
- [ ] 实现 tunnel → target 转发：同一 reqid 的 DATA 必须按帧顺序写入目标连接，连续多个 DATA 可能属于同一次逻辑写入
- [ ] 在大数据 relay 循环中显式 `Task.yield()`，避免单个 reqid 长时间占用调度
- [ ] 处理连接失败、超时、断开等异常情况
- [ ] 实现 CLOSE 帧的优雅关闭与幂等处理，避免重复 close 或 CLOSE 早于已排队 DATA；closing 后允许丢弃迟到 DATA

### 2.4 集成到 PacketTunnelProvider

- [ ] 在 `startTunnel()` 中初始化 TunnelClient
- [ ] `startTunnel()` 启动 TunnelClient 后即可 completion；连接成功与否通过状态回调更新
- [ ] `stopTunnel()` 等待 TunnelClient 停止清理完成或达到 timeout 后再 completion
- [ ] 实现 `handleAppMessage()` 返回状态
- [ ] 处理 `NWConnection` state/path update：`.waiting` 给系统恢复窗口，`.failed` 立即重建，网络切换按断线重连
- [ ] 在 Extension 内部独立维护状态；主 App 不运行时 tunnel 仍可重连

**验收标准**：Extension 可以连接 block-proxy 服务端，建立 1 到 2 条 tunnel，每条连接可从任意 TCP 分片/粘包中提取完整帧，独立响应 PING/PONG 和 idle timeout，接收反向 CONNECT 请求，连接到内网目标并双向转发数据；所有 tunnel send 串行保序；断开一条连接时只影响该连接上的请求，断开全部连接后进入自动重连。

## 阶段三：UI 与状态通信

### 3.1 跨进程通信

- [ ] Extension 端：状态变化时写入 App Group UserDefaults + 发送 Darwin Notification
- [ ] App 端：监听 Darwin Notification，实时刷新状态
- [ ] App 端：`handleAppMessage` 主动查询 Extension 状态
- [ ] App 端：配置保存后通过 `sendProviderMessage()` 通知 Extension 配置变更
- [ ] Extension 端：收到配置变更后对比版本，必要时停止旧 tunnel 并按新配置重连
- [ ] 处理 Extension 未运行 / 状态过期的情况

### 3.2 主界面

- [ ] 实现 `ContentView.swift`：状态卡片 + 启用开关
- [ ] 实现 `TunnelViewModel.swift`：状态管理、VPN 启停调用
- [ ] 状态指示器：圆点颜色 + 文本 + 延迟显示

### 3.3 配置页面

- [ ] 实现 `ConfigView.swift`：配置表单（服务器地址/端口/TLS/认证/隧道参数）
- [ ] 配置默认值：TLS 开启，`allowInsecure=true`
- [ ] 保存/加载配置
- [ ] 输入验证（地址非空、端口范围等）

### 3.4 首次启动流程

- [ ] 检测 VPN 配置是否存在，不存在则引导创建
- [ ] 处理系统授权对话框
- [ ] 配置未填写时禁用启用开关

**验收标准**：UI 完整可用，状态实时更新，配置持久化正确。

## 阶段四：健壮性与优化

### 4.1 连接保活

- [ ] 验证 PING/PONG 心跳检测：服务端 30s 发 PING，60s 未收到 PONG 后断开
- [ ] 验证隧道断开后自动重连（阶段二已实现）
- [ ] 验证锁屏、后台、杀主 App 后 Extension 是否继续运行
- [ ] 验证 WiFi ↔ 蜂窝切换后的重连处理
- [ ] 验证 WiFi ↔ 蜂窝切换不会被描述为无缝迁移；用户状态显示为短暂重连
- [ ] 验证 30 分钟空闲后 tunnel TLS 仍在线，或能自动恢复
- [ ] 验证服务端重启后 iOS Extension 自动重连
- [ ] 验证 Extension 崩溃/被系统终止后的用户可恢复路径，不假设系统一定自动重启

### 4.2 错误处理

- [ ] 认证失败：显示明确错误，不自动重试
- [ ] 端口被占用：显示错误信息
- [ ] TLS 证书错误：默认 `allowInsecure=true` 不阻断连接；用户关闭 allowInsecure 后按证书错误处理
- [ ] 内网目标不可达：发送 CONNECT_FAILED 帧

### 4.3 日志

- [ ] Extension 端日志写入 App Group 共享目录
- [ ] 主 App 提供日志查看功能（可选，后续迭代）

### 4.4 首版不实现项确认

- [ ] 不实现 iOS 本地 SOCKS5/HTTP 代理
- [ ] 不实现 geosite/geoip 分流
- [ ] 不实现 UDP over TCP
- [ ] 不实现 iOS 客户端主动 forward CONNECT；保留 `0x8000...0xFFFE` reqid 约定但不使用

**验收标准**：长时间运行稳定，网络切换后自动恢复，错误信息清晰。

## 阶段五：测试与部署

### 5.1 测试

- [ ] FrameCodec 单元测试：与 Python 输出交叉验证
- [ ] FrameCodec stream extractor 测试：半个 length prefix、半个 payload、多帧粘包、坏 length、坏 payload
- [ ] TunnelClient 集成测试：连接 mock server
- [ ] 端到端测试：iOS client → block-proxy → 内网资源
- [ ] VPNManager 多配置测试：系统存在多个 VPN 配置时只启停 BlockProxy manager
- [ ] 双连接测试：服务端显示 2 条连接，reverse CONNECT 可分配到任一连接
- [ ] 单连接降级测试：断开其中一条 tunnel 后，剩余连接继续服务并尝试补充第二条
- [ ] PING 广播测试：两条连接都收到服务端 PING，并分别回复 PONG
- [ ] idle timeout 测试：完整帧到达重置 60 秒 timer；半帧 receive 不重置；对端静默时断开并重连
- [ ] send 保序测试：连续 DATA/CLOSE/PONG 通过 per-connection send queue 后 wire order 与 enqueue order 一致
- [ ] NWConnection state 测试：`.waiting` 短暂等待恢复，超时后重连；`.failed` 立即重建
- [ ] 连接超时测试：初始 tunnel connect 10 秒超时；reverse target connect 30 秒超时
- [ ] 大数据分片测试：服务端连续发送多个 DATA 帧，iOS 按顺序写入 target
- [ ] CLOSE 竞态测试：CLOSE 后迟到 DATA 被安全丢弃，不写入已关闭 target
- [ ] DNS 目标测试：分别测试内网 IPv4 地址和内网域名，记录 IPv6/Happy Eyeballs 造成的差异
- [ ] 配置热更新测试：修改服务器地址/端口/认证后，运行中的 Extension 按新配置重连
- [ ] 保活测试：杀死主 App，验证隧道仍存活
- [ ] 重连测试：模拟网络断开，验证自动重连
- [ ] 空闲测试：30 分钟无业务流量后，服务端 PING/PONG 仍正常或 tunnel 可恢复

### 5.2 部署

- [ ] 配置 Ad Hoc / Development 签名
- [ ] 通过 Xcode 直接安装到设备
- [ ] 或通过 TestFlight 分发
- [ ] 编写安装说明（含 VPN 授权步骤）
- [ ] 部署说明加入 block-proxy 服务端 `tunnel_domains` 配置：在管理页面“隧道域名列表”添加需要回程到 iOS 内网的域名或可匹配目标
- [ ] 部署说明解释 TLS 默认 `allowInsecure=true`：默认加密但不校验证书链，用户可手动关闭

## 风险与注意事项

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Network Extension entitlement 申请 | 阻塞开发 | 提前在 Developer Portal 配置 |
| iOS VPN 状态栏图标强制显示 | 用户体验 | 可接受，这是系统行为 |
| Extension 内存限制（约 15MB） | 性能 | 隧道协议本身轻量，不太可能触发 |
| App Store 审核（如未来上架） | 发布 | 当前仅侧载，不影响 |
| NWConnection 与 asyncio 行为差异 | 兼容性 | 严格遵循帧协议，通过单元测试验证 |
| 空路由表 VPN 在不同 iOS 版本行为差异 | 可能阻塞保活方案 | 阶段一即真机验证，不等到隧道完成后再发现 |
| Extension 生命周期不可完全控制 | 后台隧道可能中断 | 应用层重连、状态持久化、主 App 启动时恢复/提示 |
| DATA 写入乱序或背压处理不当 | 连接异常、数据损坏、内存积压 | per-reqid 顺序写入，限制单帧大小，连接关闭时清理队列 |
| TCP keepalive 在蜂窝网络下被系统或运营商覆盖 | 空闲连接被 NAT 回收 | TCP keepalive 只作为辅助，核心依赖 PING/PONG、idle timeout 和自动重连 |
| `NWConnection.receive()` 无内置读超时 | 静默断线无法发现 | receive task 与 sleep task 竞态实现 60 秒 idle timeout |
| WiFi/蜂窝切换无法无缝迁移 | 业务连接短暂中断 | 视为断线重连，UI 显示 reconnecting，不承诺 MPTCP 无缝切换 |
| DNS/Happy Eyeballs 与 Python 选择不同 IP 版本 | 内网域名连接变慢或失败 | 首版验证 IP 和域名两类目标，纯 IPv4 内网优先用 IPv4 地址定位 |
| TCP 分片/粘包未正确组帧 | 帧解码失败或协议错乱 | per-connection receive buffer 按 length-prefix 提取完整帧 |
| `NWConnection.send` 并发导致帧乱序 | DATA/CLOSE 顺序错误、连接异常 | per-connection send queue/actor 串行发送并等待 completion |
| 服务端未配置 `tunnel_domains` | tunnel 已连接但请求不走回程 | 部署文档明确服务端隧道域名配置和端到端验证步骤 |
