# iOS 客户端部署指南

## 前置条件

1. Apple Developer 账号已启用 Network Extensions capability
2. 创建 App ID: `com.blockproxy` 和 `com.blockproxy.tunnel-extension`
3. 创建 App Group: `group.com.blockproxy`
4. 生成包含 Network Extension entitlement 的 Provisioning Profile

## 构建与安装

### Xcode 直连安装
1. 连接 iOS 设备
2. 在 Xcode 中选择目标设备
3. 配置签名（Team + Provisioning Profile）
4. 点击 Run 安装

### TestFlight 分发
1. Archive 项目
2. 上传到 App Store Connect
3. 添加内部/外部测试员
4. 通过 TestFlight App 安装

## 首次使用

1. 打开 BlockProxy App
2. 点击右上角"配置"
3. 填写服务器地址、端口、用户名、密码
4. 默认 TLS 开启，`allowInsecure=true`（加密但不校验证书链）
5. 返回主界面，打开"启用隧道"开关
6. 系统弹出 VPN 配置授权对话框，点击"允许"

## 服务端配置

**重要**: block-proxy 服务端必须配置 `tunnel_domains` 才能将请求路由到 iOS tunnel。

在 block-proxy 管理页面（Express 默认端口 8004）的"隧道域名列表"中，添加需要回程到 iOS 内网的域名或 IP。iOS 客户端连接的是 tunnel 端口，默认 8003。
如果未配置，tunnel 虽然连接成功，但请求不会进入 tunnel 回程通道。

## TLS 说明

- 默认 `allowInsecure=true`: TLS 加密传输但不校验服务端证书链
- 适用于个人侧载场景，避免自签名证书配置
- 如需严格校验，关闭 `allowInsecure` 并确保服务端证书可信

## 已知限制

- iOS 系统强制在状态栏显示 VPN 图标（系统行为，无法关闭）
- Network Extension 内存受系统动态限制，需真机压测；实现应保持低内存占用，避免缓存大量 DATA 或无限增长日志
- WiFi/蜂窝切换时 tunnel 会短暂断开并重连（非无缝迁移）
- Extension 被系统终止后需用户手动重新启动
