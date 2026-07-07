# Android 客户端部署指南

## 前置条件

1. Android 设备（API 26+，Android 8.0 或更高版本）
2. 已安装 `adb`（Android Debug Bridge）并可通过 USB 或 WiFi 连接设备
3. block-proxy 服务端已运行，tunnel 端口（默认 8003）可访问
4. 设备与服务端在同一网络中，或可通过公网访问 tunnel 端口

## 构建

### Debug APK

```bash
cd android-client
./gradlew :app:assembleDebug
```

输出路径：`app/build/outputs/apk/debug/app-debug.apk`

### Release APK（需配置签名）

```bash
./gradlew :app:assembleRelease
```

需在 `app/build.gradle.kts` 中配置 `signingConfigs`。

## 安装

### adb 安装

```bash
adb install app/build/outputs/apk/debug/app-debug.apk
```

如果已安装旧版本：

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### 卸载

```bash
adb uninstall com.blockproxy.android
```

## 首次使用

1. 打开 BlockProxy 应用
2. 授予通知权限（Android 13+ 需要，用于前台服务通知）
3. 在配置界面填写：
   - **服务器地址**：block-proxy 服务端的 IP 或域名
   - **端口**：默认 8003（tunnel 端口）
   - **用户名/密码**：与服务端 `config.json` 中的 `auth_username`/`auth_password` 一致
4. 默认 TLS 开启，`allowInsecure=true`（加密但不校验证书链）
5. 返回主界面，点击启动隧道

## 服务端配置

**重要**: block-proxy 服务端必须配置 `tunnel_domains` 才能将请求路由到 Android tunnel。

在 block-proxy 管理页面（Express 默认端口 8004）的"隧道域名列表"中，添加需要回程到 Android 设备所在内网的域名或 IP。Android 客户端连接的是 tunnel 端口，默认 8003。

如果未配置 `tunnel_domains`，tunnel 虽然连接成功，但请求不会进入 tunnel 回程通道。

### 配置示例

通过管理界面添加 `tunnel_domains`：

```
*.internal.example.com
192.168.1.0/24
nas.local
```

## 冒烟测试

安装并启动后，按以下步骤验证：

1. **检查连接状态**：应用主界面显示"已连接"（Connected）
2. **检查服务端日志**：block-proxy 日志中应出现 tunnel 客户端的连接记录
3. **配置 tunnel_domains**：添加一个测试域名（如 `httpbin.org`）
4. **从外部访问测试域名**：通过代理访问 `httpbin.org`，确认请求经过 tunnel 回程
5. **双连接验证**：等待约 5 秒后，服务端应有 2 个 tunnel 连接（dual connection）

## TLS 说明

- 默认 `allowInsecure=true`: TLS 加密传输但不校验服务端证书链
- 适用于个人侧载场景，避免自签名证书配置
- 如需严格校验，关闭 `allowInsecure` 并确保服务端证书可信
- 开发/测试时可关闭 `useTls` 使用纯 TCP 连接（不推荐生产环境）

## 常见问题排查

### 连接失败（Reconnecting）

- 检查设备与服务端的网络连通性：`adb shell ping <server_ip>`
- 确认 tunnel 端口（8003）未被防火墙拦截
- 检查服务端是否正在运行：`curl http://<server_ip>:8004/api/status`

### 认证失败（AuthFailed）

- 确认用户名/密码与服务端 `config.json` 一致
- 检查服务端 `auth_username` 和 `auth_password` 配置

### 端口被占用（Occupied）

- 服务端返回 ERROR，表示已有其他客户端占用了 tunnel 槽位
- 断开其他客户端后重试

### 通知权限被拒绝

- Android 13+ 需要 `POST_NOTIFICATIONS` 权限
- 前往 设置 → 应用 → BlockProxy → 权限 → 通知，手动开启

### Tunnel 频繁断开重连

- 检查网络稳定性（WiFi 信号强度、路由器 NAT 超时设置）
- 客户端内置 60 秒 idle timeout 和自动重连机制
- 如 NAT 超时过短，考虑在服务端配置 keepalive

### 请求不经过 Tunnel

- 确认服务端 `tunnel_domains` 已配置目标域名
- 检查客户端状态为"已连接"而非"重连中"
- 确认请求的域名或 IP 匹配 `tunnel_domains` 规则

## 日志查看

```bash
# 查看应用日志
adb logcat -s BlockProxy

# 查看完整日志
adb logcat | grep -i blockproxy
```

## 已知限制

- Android VpnService 在状态栏显示 VPN 图标（系统行为，无法关闭）
- 双连接模式下，如果一条 tunnel 断开，会自动尝试补充（最多 3 次，间隔 1s → 2s → 4s）
- 网络切换（WiFi ↔ 移动数据）时 tunnel 会短暂断开并重连
- 应用被系统终止后需用户手动重新启动
