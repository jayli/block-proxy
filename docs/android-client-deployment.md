# Android 客户端部署指南

## 前置条件

1. Android 设备（API 23+，Android 6.0 或更高版本）
2. 已安装 `adb`（Android Debug Bridge）并可通过 USB 或 WiFi 连接设备
3. block-proxy 服务端已运行，tunnel 端口（默认 8003）可访问
4. 设备与服务端在同一网络中，或可通过公网访问 tunnel 端口

## 构建

### 手机 APK（GitHub Release 使用）

```bash
cd android-client
./gradlew :app:assemblePhoneDebug
```

输出路径：`app/build/outputs/apk/phone/debug/BlockProxyClient-android.apk`

该 APK 使用 debug 签名，下载后可直接安装到手机。GitHub Release 只上传这个文件。

### 虚拟机 APK（本地调试使用）

```bash
./gradlew :app:assembleEmulatorDebug
```

输出路径：`app/build/outputs/apk/emulator/debug/BlockProxyClient-android-emulator.apk`

该 APK 保留 x86/x86_64 native 库，专门用于 Android 虚拟机。

## 安装

### adb 安装

```bash
cd android-client
bash install-debug.sh
```

也可以从仓库根目录执行：

```bash
npm run android:install
```

该脚本会优先读取目标设备 ABI：`x86/x86_64` 自动安装虚拟机 APK，`arm/arm64` 自动安装手机 APK。

如果需要手动安装手机包：

```bash
adb install -r app/build/outputs/apk/phone/debug/BlockProxyClient-android.apk
```

如果需要手动安装虚拟机调试包：

```bash
adb -s emulator-5554 install -r app/build/outputs/apk/emulator/debug/BlockProxyClient-android-emulator.apk
```

## 发布到 GitHub Release

```bash
npm run android:release:upload -- v0.1.4
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

## 开机自启与国产 ROM 配置（重要）

客户端内置了两层开机/进程死亡自愈机制：

1. **`BootRestartReceiver`**：监听 `BOOT_COMPLETED`，开机后自动拉起隧道服务
2. **`TunnelWatchdogWorker`**：WorkManager 周期任务（15 分钟），进程被杀后兜底重启

两者启动服务前都会先调用 `VpnService.prepare()` 重新获取 VPN 授权（Android 重启后会重置 VPN owner，不重新 prepare 会导致 `establish()` 静默失败）。首次使用时授予过一次 VPN 授权后，该授权会被系统持久化，重启后可静默复用。

但**国产 ROM（vivo/OPPO/小米/华为等）会在系统层拦截 `BOOT_COMPLETED` 广播和后台进程**，导致上述两层机制全部失效——表现为手机重启后隧道长时间（数小时）不恢复，诊断日志在重启时间段完全空白。必须手动完成以下配置：

### vivo（Funtouch OS，已在 Y67A / Android 6 实测）

1. **允许自启动**：i 管家 → 应用管理 → 自启动管理 → 打开 BlockProxy
   （这是关键项：不开启时 `BOOT_COMPLETED` 不会送达，`BootRestartReceiver` 不会执行）
2. **允许后台高耗电**：i 管家 → 电池 → 后台高耗电管理（或 设置 → 电池）→ 允许 BlockProxy
   （防止运行中进程被省电策略杀掉）
3. **最近任务加锁**（可选加固）：最近任务列表中下拉 BlockProxy 卡片加锁

其他国产 ROM 同理：在各自的「自启动管理」和「电池优化白名单」中放行 BlockProxy。

### 全盘加密（FDE）设备的注意事项

Android 6 设备多为块级全盘加密（`ro.crypto.type=block`）：**重启后、用户解锁屏幕之前 `/data` 分区不解密，任何 app 都无法运行**，`BOOT_COMPLETED` 也不会送达。因此：

- 作为长期在线隧道设备的手机，建议**不设置锁屏密码**（开机自动完成解密，无需人工干预）
- 若设置了锁屏密码，重启后必须人工解锁一次，隧道才能自愈

### 自愈验证方法

配置完成后重启手机实测一次，拉取诊断日志确认链路：

```bash
adb reboot
# 等待开机完成（FDE 设备需解锁屏幕）后：
adb shell run-as com.blockproxy.android cat files/tunnel-diagnostics.log | tail -30
```

预期日志链路（开机后约 30 秒内完成）：

```
boot.restart_service                              ← BOOT_COMPLETED 送达并触发
service.on_start_command ... bootRestore=true
vpn.established appExclusionSucceeded=true        ← VPN 重新 prepare + establish 成功
tunnel.connected session=... cdnIp=...            ← 隧道恢复
```

若出现 `boot.skip_restart ... vpnPrepared=false`，说明该机型重启后未保留 VPN 授权，需打开 App 重新授权一次；若连 `boot.*` 日志都没有，说明自启动权限未生效。

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
