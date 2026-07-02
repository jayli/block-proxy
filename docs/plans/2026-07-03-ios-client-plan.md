# iOS 客户端实现计划

## 概述

基于 [iOS 客户端设计文档](2026-07-03-ios-client-design.md)，分阶段实现 iOS 隧道客户端。

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
- [ ] 首次启动时调用 `setupVPN()` 创建 VPN 配置（系统弹出授权对话框）
- [ ] 验证 VPN 可以启动/停止（此时 Extension 为空壳，立即 return）

### 1.3 ConfigStore

- [ ] 实现 `ConfigStore.swift`：UserDefaults (App Group) 存非敏感配置
- [ ] 实现 `KeychainHelper.swift`：Keychain 存密码
- [ ] 实现 `ServerConfig.swift` 模型（Codable）
- [ ] 验证主 App 写入后 Extension 可读取

**验收标准**：VPN 可启停，配置可跨进程共享。

## 阶段二：隧道协议实现

### 2.1 FrameCodec

- [ ] 实现 `FrameCodec.swift`：帧编解码
- [ ] 实现所有帧类型的 encode/decode（AUTH, CONNECT, DATA, CLOSE, PING/PONG, ERROR 等）
- [ ] 编写单元测试：验证编解码结果与 Python `tunnel_client.py` 输出一致
- [ ] 边界测试：最大帧、空数据、IPv4/Domain 地址类型

### 2.2 TunnelClient 核心

- [ ] 实现 `TunnelClient.swift`：NWConnection 建立 TCP/TLS 连接
- [ ] 实现认证流程（发送 AUTH 帧，处理 AUTH_OK / AUTH_FAIL / ERROR）
- [ ] 实现帧处理主循环（PING/PONG, CONNECT, DATA, CLOSE）
- [ ] 实现重连逻辑（指数退避 1s → 2s → 4s → ... → 60s）
- [ ] 实现状态回调（connecting, connected, reconnecting, occupied, authFailed, disconnected）

### 2.3 反向连接处理

- [ ] 实现 `_handleReverseConnect()`：接收服务端 CONNECT 请求
- [ ] 连接内网目标地址，发送 CONNECT_OK
- [ ] 实现双向数据转发（目标 ↔ 隧道，使用 TaskGroup）
- [ ] 处理连接失败、超时、断开等异常情况
- [ ] 实现 CLOSE 帧的优雅关闭

### 2.4 集成到 PacketTunnelProvider

- [ ] 在 `startTunnel()` 中初始化 TunnelClient
- [ ] 在 `stopTunnel()` 中停止 TunnelClient
- [ ] 实现 `handleAppMessage()` 返回状态

**验收标准**：Extension 可以连接 block-proxy 服务端，接收反向 CONNECT 请求，连接到内网目标并双向转发数据。

## 阶段三：UI 与状态通信

### 3.1 跨进程通信

- [ ] Extension 端：状态变化时写入 App Group UserDefaults + 发送 Darwin Notification
- [ ] App 端：监听 Darwin Notification，实时刷新状态
- [ ] App 端：`handleAppMessage` 主动查询 Extension 状态
- [ ] 处理 Extension 未运行 / 状态过期的情况

### 3.2 主界面

- [ ] 实现 `ContentView.swift`：状态卡片 + 启用开关
- [ ] 实现 `TunnelViewModel.swift`：状态管理、VPN 启停调用
- [ ] 状态指示器：圆点颜色 + 文本 + 延迟显示

### 3.3 配置页面

- [ ] 实现 `ConfigView.swift`：配置表单（服务器地址/端口/TLS/认证/隧道参数）
- [ ] 保存/加载配置
- [ ] 输入验证（地址非空、端口范围等）

### 3.4 首次启动流程

- [ ] 检测 VPN 配置是否存在，不存在则引导创建
- [ ] 处理系统授权对话框
- [ ] 配置未填写时禁用启用开关

**验收标准**：UI 完整可用，状态实时更新，配置持久化正确。

## 阶段四：健壮性与优化

### 4.1 连接保活

- [ ] 实现 PING/PONG 心跳检测（60s 超时断开）
- [ ] 隧道断开后自动重连（已在阶段二实现，此处验证）
- [ ] Extension 进程崩溃后 iOS 自动重启（系统行为，验证即可）
- [ ] 网络切换（WiFi ↔ 蜂窝）时的重连处理

### 4.2 错误处理

- [ ] 认证失败：显示明确错误，不自动重试
- [ ] 端口被占用：显示错误信息
- [ ] TLS 证书错误：根据 allowInsecure 配置处理
- [ ] 内网目标不可达：发送 CONNECT_FAILED 帧

### 4.3 日志

- [ ] Extension 端日志写入 App Group 共享目录
- [ ] 主 App 提供日志查看功能（可选，后续迭代）

### 4.4 双连接支持（可选）

- [ ] 参考 macOS client 的双隧道连接实现
- [ ] Round-robin 负载均衡
- [ ] 连接补充逻辑（断开一条后自动补充）

**验收标准**：长时间运行稳定，网络切换后自动恢复，错误信息清晰。

## 阶段五：测试与部署

### 5.1 测试

- [ ] FrameCodec 单元测试：与 Python 输出交叉验证
- [ ] TunnelClient 集成测试：连接 mock server
- [ ] 端到端测试：iOS client → block-proxy → 内网资源
- [ ] 保活测试：杀死主 App，验证隧道仍存活
- [ ] 重连测试：模拟网络断开，验证自动重连

### 5.2 部署

- [ ] 配置 Ad Hoc / Development 签名
- [ ] 通过 Xcode 直接安装到设备
- [ ] 或通过 TestFlight 分发
- [ ] 编写安装说明（含 VPN 授权步骤）

## 风险与注意事项

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Network Extension entitlement 申请 | 阻塞开发 | 提前在 Developer Portal 配置 |
| iOS VPN 状态栏图标强制显示 | 用户体验 | 可接受，这是系统行为 |
| Extension 内存限制（约 15MB） | 性能 | 隧道协议本身轻量，不太可能触发 |
| App Store 审核（如未来上架） | 发布 | 当前仅侧载，不影响 |
| NWConnection 与 asyncio 行为差异 | 兼容性 | 严格遵循帧协议，通过单元测试验证 |
