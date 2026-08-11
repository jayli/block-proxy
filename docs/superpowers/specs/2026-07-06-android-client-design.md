# Android 客户端设计文档

## 概述

Android 客户端用于平替 iOS 客户端的核心隧道能力。首版目标与 iOS 客户端一致：让外网设备通过 block-proxy 服务端回程访问 Android 设备所在内网的 TCP 资源。

首版不实现本地 SOCKS5/HTTP 代理、geosite/geoip 分流、UDP over TCP，也不实现 Android 端主动 forward CONNECT。客户端只实现服务端发起的 reverse CONNECT 协议子集，并尽量保持与 `tunnel/protocol.js`、`tunnel/server.js`、`tunnel/manager.js` 兼容。

Android 与 iOS 的主要差异在保活模型。iOS 使用 `NEPacketTunnelProvider`，Android 使用 `VpnService` 承载用户授权的 VPN 生命周期，并在服务进程内启动前台通知、网络监听和重连循环。VPN 本身不用于拦截设备流量；它是一个系统可感知、用户授权、适合长驻网络任务的进程入口。首版必须把后台、锁屏、网络切换、服务端重启、厂商省电策略纳入实机验收，不能把前台服务视为确定 SLA。

## 参考依据

- iOS 设计：`docs/superpowers/specs/2026-07-03-ios-client-design.md`
- iOS 计划：`docs/superpowers/plans/2026-07-03-ios-client-plan.md`
- iOS 参考实现：`ios-client/`
- 服务端协议：`tunnel/protocol.js`
- 服务端连接管理：`tunnel/server.js`、`tunnel/manager.js`
- Android 官方约束：`VpnService` 需要用户授权；Android 14 起前台服务必须声明合适的 foreground service type；`connectedDevice` 类型适用于需要网络连接的外部设备交互。

## 设计决策

| 决策项 | 选择 | 理由 |
|---|---|---|
| 功能范围 | 首版仅服务端回程访问 Android 内网 | 与 iOS 首版对齐，先验证 reverse CONNECT 和移动端保活 |
| 保活方案 | `VpnService` + 前台通知 + 应用层重连 | Android 普通后台服务不适合长连接；前台 VPN Service 更符合系统模型 |
| VPN 路由 | 建立最小 TUN 接口，不读取 TUN 数据 | 首版不接管设备流量；只利用 VPN 生命周期承载 tunnel |
| 技术栈 | Kotlin + Jetpack Compose + Coroutines | Android 原生、测试友好、并发模型清晰 |
| 网络库 | Kotlin/JDK Socket + `SSLSocket` | 隧道协议是原始 TCP/TLS 字节流，避免 HTTP 客户端抽象干扰帧顺序 |
| 配置管理 | DataStore + Android Keystore 加密凭据 | 非敏感配置结构化持久化；密码不明文落盘 |
| UI 风格 | 极简 Compose 页面 | 状态显示、启停按钮、配置表单即可 |
| TLS 证书校验 | 默认 `allowInsecure=true` | 与 iOS 个人部署默认一致；TLS 仍加密，默认不要求服务端证书链可信 |
| 构建目录 | 所有 Android 工程代码放在 `android-client/` | 不污染现有 Node、Python、iOS 代码边界 |

## 首版范围

必须支持：

- AUTH / AUTH_OK / AUTH_FAIL / ERROR。
- PING / PONG，每条 tunnel 连接独立响应。
- 服务端发起 CONNECT / DATA / CLOSE / CONNECT_FAILED。
- 与服务端建立 1 到 2 条 TLS tunnel 连接。
- 第一条连接必须成功，第二条连接尽力建立；双连接降级后后台补充连接。
- 服务端通过 `TunnelManager.forward()` 回程访问 Android 所在内网 TCP 资源。
- 连接超时、完整帧 idle timeout、指数退避重连、网络切换后重连。
- 严格帧编解码测试和协议交叉向量测试。

暂不支持：

- Android 本地 SOCKS5/HTTP 代理。
- Android 端主动 forward CONNECT。
- geosite/geoip 分流。
- UDP over TCP。
- HTTPS MITM 证书安装流程。
- Play Store 发布适配；首版以本地安装 APK 为目标。

## 项目结构

```text
android-client/
├── README.md
├── settings.gradle.kts
├── build.gradle.kts
├── gradle/
├── gradlew
├── gradlew.bat
└── app/
    ├── build.gradle.kts
    ├── src/main/AndroidManifest.xml
    ├── src/main/java/com/blockproxy/android/
    │   ├── MainActivity.kt
    │   ├── ui/
    │   │   ├── MainScreen.kt
    │   │   ├── ConfigScreen.kt
    │   │   └── TunnelViewModel.kt
    │   ├── config/
    │   │   ├── ServerConfig.kt
    │   │   ├── ConfigRepository.kt
    │   │   └── CredentialStore.kt
    │   ├── service/
    │   │   ├── BlockProxyVpnService.kt
    │   │   ├── TunnelServiceController.kt
    │   │   ├── TunnelNotification.kt
    │   │   └── TunnelWatchdogWorker.kt
    │   ├── tunnel/
    │   │   ├── Frame.kt
    │   │   ├── FrameCodec.kt
    │   │   ├── FrameExtractor.kt
    │   │   ├── TunnelClient.kt
    │   │   ├── TunnelConnection.kt
    │   │   ├── SendQueue.kt
    │   │   └── ReverseConnectHandler.kt
    │   └── status/
    │       ├── TunnelStatus.kt
    │       └── StatusStore.kt
    ├── src/test/java/com/blockproxy/android/
    └── src/androidTest/java/com/blockproxy/android/
```

## 进程与生命周期

```text
MainActivity / Compose UI
        |
        | VpnService.prepare() 用户授权
        v
BlockProxyVpnService (前台通知 + VPN 生命周期)
        |
        | load config + credentials
        v
TunnelClient
        |
        +-- TunnelConnection #1 -- TLS/TCP --> block-proxy:8003
        |
        +-- TunnelConnection #2 -- TLS/TCP --> block-proxy:8003
        |
        +-- ReverseConnectHandler -- TCP --> Android 所在内网目标
```

`MainActivity` 不直接维护长连接。它只负责配置、授权、启停和状态展示。`BlockProxyVpnService` 是长连接宿主，启动后立即调用 `startForeground()` 展示常驻通知，然后建立一个最小 VPN interface，再启动 `TunnelClient`。

`TunnelClient.start()` 必须立即返回，不等待 tunnel 已连接。连接状态通过 `StateFlow`/持久化状态向 UI 暴露。`onDestroy()`、用户停止 VPN、系统撤销 VPN 权限时必须停止重连循环、关闭所有 tunnel socket 和 target socket。

## VPN 配置

首版不处理 TUN 包，不代理本机流量。`BlockProxyVpnService` 仍需要调用 `VpnService.Builder.establish()` 建立系统认可的 VPN 会话。建议配置：

- `setSession("BlockProxy")`
- `addAddress("10.255.0.2", 32)`，仅作为 TUN 本地地址。
- 不添加默认路由。
- 如设备或 Android 版本要求至少一条 route 才能建立，可用只覆盖虚拟地址的窄路由，禁止把 `0.0.0.0/0` 加入首版。
- `protect(socket)` 必须在 tunnel 连接 socket connect 之前调用，避免 tunnel socket 被 VPN 自身捕获。

如果某些设备上“无默认路由 VPN”无法稳定维持，实机验证阶段需要记录设备型号、Android 版本和失败模式，再决定是否改为普通 foreground service。不能为了保活直接接管默认路由。

## Android 权限与服务声明

Manifest 需要声明：

- `android.permission.INTERNET`
- `android.permission.ACCESS_NETWORK_STATE`
- `android.permission.FOREGROUND_SERVICE`
- `android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE`（target Android 14+ 时）
- `android.permission.POST_NOTIFICATIONS`（Android 13+ 通知权限）
- `android.permission.WAKE_LOCK`
- `android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
- `BlockProxyVpnService` 继承 `VpnService`，带 `android.permission.BIND_VPN_SERVICE`。
- `android:foregroundServiceType="connectedDevice"`。

前台服务通知必须常驻、可点击返回主界面，并提供停止 tunnel 的 action。Android 13+ 如果通知权限未授予，启动流程必须提示用户授权或清楚显示系统可能限制通知展示。

## 隧道协议

帧格式与服务端完全一致：

```text
+--------+------------------+
| Length |     Payload      |
| 2 byte |   variable       |
+--------+------------------+
```

Payload 第一字节为类型：

```kotlin
enum class FrameType(val code: Int) {
    CONNECT(0x01),
    DATA(0x02),
    CLOSE(0x03),
    CONNECT_OK(0x04),
    PING(0x10),
    PONG(0x11),
    AUTH(0x20),
    AUTH_OK(0x21),
    AUTH_FAIL(0x22),
    ERROR(0x23),
    CONNECT_FAILED(0x81),
}
```

地址类型：

```kotlin
enum class AddressType(val code: Int) {
    IPV4(0x01),
    DOMAIN(0x03),
    IPV6(0x04),
}
```

字段格式：

- AUTH: `[type][uname_len][username][passwd_len][password]`
- CONNECT: `[type][reqid:2][atyp][addr...][port:2]`
- DATA: `[type][reqid:2][data...]`
- CLOSE / CONNECT_OK / CONNECT_FAILED: `[type][reqid:2]`
- ERROR: `[type][msg_len][message]`
- PING / PONG / AUTH_OK / AUTH_FAIL: `[type]`

边界：

- Payload 最大 65535 字节。
- DATA 头部 3 字节，单帧 data 最大 65532 字节。
- username、password、domain、error message 单字段最大 255 UTF-8 字节。
- 服务端 reverse reqid 为 `1..0x7FFF`。
- forward reqid `0x8000..0xFFFE` 保留但首版不用。
- IPv4 和 domain 必须完整支持；IPv6 常量保留，首版不作为验收目标。

已知帧必须严格解码：固定长度帧拒绝尾随垃圾，长度字段和 UTF-8 字段长度不一致时拒绝，decode 端也拒绝超过协议上限的 payload。未知帧类型按 Python 客户端兼容策略处理：`FrameCodec` 返回 `Unknown(type, payload)` 或等价结构，认证阶段收到未知帧视为协议错误，认证成功后记录日志并忽略，不关闭 tunnel 连接。这样服务端未来增加新帧类型时，旧 Android 客户端不会因为未知但可跳过的控制帧主动断线。

## 字节流组帧

TCP 是字节流，单次 `InputStream.read()` 可能返回半个长度前缀、半个 payload 或多个连续帧。每条 tunnel 连接维护独立 `FrameExtractor`：

1. append 新字节到 per-connection buffer。
2. 少于 2 字节时等待更多数据。
3. 读取 big-endian payload length。
4. 少于 `2 + length` 时继续等待。
5. 满足完整帧后 decode payload，消费这段字节。
6. buffer 剩余内容继续循环提取下一帧。
7. 已知帧 decode 失败、payload 超上限或 length 异常时关闭该 tunnel 连接，并清理该连接承载的 reqid sessions。
8. 未知帧类型不算 decode 失败；认证后记录日志并忽略。

idle timeout 语义必须与 Python/iOS 计划对齐：从开始等待下一完整帧时计时，只有完整帧成功组装并解码后重置 60 秒 timer。半个 length prefix 或半个 payload 不能重置 timeout。

## 双连接模型

服务端最多接受 2 条客户端连接，并对 reverse 请求做 round-robin。Android 客户端遵循同一模型：

1. 第一条连接成功认证后 tunnel 可用。
2. 第二条连接失败不影响单连接运行。
3. 第二条连接一旦认证成功，立即启动独立 receive loop 和 PING/PONG。
4. 任意连接断开时，只清理绑定到该连接的 reqid sessions。
5. 双连接降级为单连接后后台尝试补充连接：先延迟 1 秒，再最多尝试 3 次；第 1 次失败后等待 2 秒，第 2 次失败后等待 4 秒，第 3 次失败后放弃本轮补充，继续单连接运行。后续如果剩余连接也断开，则进入全量重连流程。
6. 所有连接断开后进入 `reconnecting`，按 1s、2s、4s、...、60s 指数退避。
7. AUTH_FAIL 为不可重试状态；AUTH 阶段 ERROR 映射为 occupied，不自动重试。
8. AUTH 后 ERROR 记录日志并忽略，保持与服务端/Python 行为兼容。

## 并发模型

Kotlin Coroutines 是首版并发基础：

- `BlockProxyVpnService` 持有一个 `SupervisorJob`，销毁服务时 cancel。
- 每条 `TunnelConnection` 持有独立 receive coroutine、send queue coroutine、socket 和 frame extractor。
- 所有发往同一 tunnel connection 的 outbound frame 都必须通过该 connection 的同一个 `SendQueue` 串行写入，包括 `PONG`、`CONNECT_OK`、`CONNECT_FAILED`、`DATA` 和 `CLOSE`。`CONNECT_OK` 完成入队后才能启动 target -> tunnel relay，避免 DATA 排在 CONNECT_OK 前，也避免 PING/PONG 与 DATA 在多个 coroutine 中并发写入导致帧交错。
- `ReverseConnectHandler` 维护 `reqid -> RequestSession`，session 绑定收到 CONNECT 的那条 `TunnelConnection`。
- target -> tunnel 和 tunnel -> target 分开 coroutine，但同一方向写入必须顺序化。
- 大数据切片发送时每个 DATA chunk 不超过 65532 字节，并在循环中 `yield()`，避免单个 reqid 长时间占用调度。
- CLOSE 必须幂等；closing 后迟到 DATA 可以丢弃，不能写入已关闭 target socket。

## 连接断开清理

任意一条 tunnel connection 断开时，只清理绑定到该连接的资源，不能影响另一条仍可用的 tunnel connection：

1. 标记该 `TunnelConnection` closed，停止 receive loop。
2. 关闭该 connection 的 `SendQueue`，丢弃后续入队请求。
3. 从 connection registry 移除该 connection。
4. 找出所有 `RequestSession.tunnelConnection === disconnectedConnection` 的 session。
5. 对这些 session 取消 target -> tunnel relay task 和 target write task。
6. 关闭对应 target socket，释放 target write queue。
7. 从 `reqid -> RequestSession` 表移除这些 reqid。
8. 对已经 closing 的 session，不重复关闭 target socket，不重复触发业务回调。
9. 如果 registry 仍有连接，保持 `connected` 或降级状态并触发补充连接；如果 registry 为空，进入 `reconnecting`。

## 网络与 TLS

`TunnelConnection` 使用普通 `Socket` 或 `SSLSocket`：

- connect timeout：10 秒。
- target connect timeout：30 秒。
- socket read idle timeout：以“等待下一完整帧”为单位计时。Android/JDK 阻塞 `InputStream.read()` 不能只靠 coroutine timeout 取消；timeout 到期时必须关闭 socket 以中断阻塞 read，或由 socket adapter 使用可中断读机制实现同等语义。
- `tcpNoDelay = true`。
- `keepAlive = true`，但不能只依赖 TCP keepalive。
- TLS 最低版本 TLS 1.2。
- `allowInsecure=true` 时使用显式 trust-all `X509TrustManager` 和 hostname verifier；只允许用于 tunnel server，不要全局改 JVM TLS 行为。
- `VpnService.protect(socket)` 在 tunnel socket connect 前调用；target 内网 socket 不需要 protect，因为它不是发往 tunnel server 的外部连接。
- 网络变化检测是 Android 相对 Python 客户端的增强，也可视为 macOS sleep/wake 处理的 Android 近似方案。首版最低可依赖 socket error 和 60 秒完整帧 idle timeout 发现断线；推荐再接入 `ConnectivityManager.NetworkCallback`，在网络 lost/available/switch 时主动关闭旧 tunnel socket 并触发重连。

## 常驻策略

Android 客户端必须在屏幕熄灭后持续运行，不被系统回收。以下四项为首版必须实现的常驻机制：

### 1. 电池优化白名单

首次启动 VPN 时，检查 `PowerManager.isIgnoringBatteryOptimizations(packageName)`。如果未豁免，立即通过 `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 弹出系统对话框请求豁免。豁免后系统不再将该 App 纳入 Doze / App Standby 限制。如果用户拒绝，UI 应明确提示"未豁免电池优化可能导致黑屏后隧道断开"，并在配置页面提供手动跳转入口。

### 2. PARTIAL_WAKE_LOCK

`BlockProxyVpnService` 启动 tunnel 前获取 `PARTIAL_WAKE_LOCK`，阻止 CPU 进入深度睡眠。tunnel 停止或服务销毁时释放 WakeLock。WakeLock tag 使用 `"block-proxy:tunnel"` 以便在 `adb shell dumpsys power` 中识别。这是保持网络 IO 持续可用的必要条件。

### 3. START_STICKY

`BlockProxyVpnService.onStartCommand()` 返回 `START_STICKY`，确保系统在服务被杀后尝试重新创建服务。配合 foreground service 和 VPN 生命周期，进一步降低被系统回收的概率。

### 4. WorkManager 看门狗

注册一个每 15 分钟执行一次的 `PeriodicWorkRequest`，检查 `BlockProxyVpnService` 是否在运行。如果服务不在运行但用户配置了 tunnel 且之前处于 connected/reconnecting 状态，看门狗通过 `ContextCompat.startForegroundService()` 重新启动服务。这是最后一层兜底，覆盖前三种机制均被厂商 ROM 绕过的极端情况。

### 厂商 ROM 说明

部分国产 ROM（MIUI、ColorOS、HarmonyOS 等）有独立于 Android 电池优化的"自启动管理"机制，即使上述四项全部到位，仍可能被杀。首版不通过 API 处理厂商自启动管理（无法统一），但在配置页面提供引导提示，告知用户需要手动在系统设置中将 BlockProxy 加入自启动白名单。

## 配置与凭据

`ServerConfig` 存储非敏感字段：

- `serverHost`
- `serverPort`，默认 `8003`
- `useTls`
- `allowInsecure`
- `tunnelHost` 可选
- `tunnelPort` 可选

用户名和密码不放入 DataStore 明文配置。首版使用 AndroidX Security Crypto 或 Android Keystore 派生的加密存储保存 `TunnelCredentials`。如果实现选择 `EncryptedSharedPreferences`，计划中必须固定依赖版本并写凭据迁移/清理测试。

## 状态模型

```text
disconnected
preparing
connecting
connected
reconnecting
occupied
authFailed
error
```

状态来源以 service 内 `TunnelClient` 为准。UI 启动时读取持久化最后状态，然后绑定 service 或观察 repository flow 获取实时状态。前台通知也显示同一状态。

## UI 设计

主界面：

- 状态圆点 + 文本。
- 启用/禁用开关。
- 当前连接数、最近错误、可选延迟。
- 电池优化豁免状态指示（未豁免时显示警告）。
- 配置入口。

配置页面：

- 服务器地址、端口。
- TLS 开关。
- 允许不安全证书开关，默认开启。
- 用户名、密码。
- 隧道服务器地址/端口可选覆盖。
- 电池优化豁免开关，跳转系统设置。
- 厂商自启动管理引导提示。

启动流程：

1. 用户保存配置。
2. App 检查电池优化豁免状态；如未豁免，弹出系统请求对话框。
3. App 调用 `VpnService.prepare(context)`。
4. 如返回 intent，启动系统 VPN 授权页面。
5. 授权成功后 `ContextCompat.startForegroundService()` 启动 `BlockProxyVpnService`。
6. Service 获取 WakeLock，建立 VPN interface，启动 tunnel。

## 服务端配置依赖

block-proxy 服务端只有匹配 `tunnel_domains` 的请求才会走 tunnel 回程。部署说明必须要求用户在管理页面的“隧道域名列表”中添加需要回程到 Android 内网的域名。如果用 IP 访问，也必须确认服务端规则能匹配目标，否则客户端显示 connected 但请求不会进入 `TunnelManager.forward()`。

## 测试策略

单元测试：

- `FrameCodecTest`：所有帧类型 encode/decode、边界长度、非法长度、尾随垃圾、Python/Node 交叉向量。
- `FrameExtractorTest`：半包、粘包、多帧、超大帧、decode 失败。
- `SendQueueTest`：串行写入、异常关闭、取消。
- `TunnelClientTest`：认证成功、AUTH_FAIL、ERROR occupied、第二连接失败降级、断线重连。
- `ReverseConnectHandlerTest`：CONNECT_OK 顺序、CONNECT_FAILED、DATA 切片、CLOSE 幂等、per-connection 清理。
- `ConfigRepositoryTest` 和 `CredentialStoreTest`。
- `TunnelWatchdogWorkerTest`：服务未运行时重启、已运行时跳过、无配置时跳过。

仪器测试/实机测试：

- `VpnService.prepare()` 授权流程。
- 前台通知创建和停止 action。
- 真机锁屏 30 分钟。
- 真机锁屏 1 小时。
- App 退后台、划掉主 Activity。
- WakeLock 持有验证（`adb shell dumpsys power | grep block-proxy`）。
- 电池优化豁免状态确认。
- `adb shell am kill` 后服务恢复验证。
- WiFi/蜂窝切换。
- 服务端重启。
- 连接到 Android 同 LAN 的测试 TCP 服务。
- 厂商省电策略下的存活记录。

端到端 smoke test：

1. 启动 block-proxy，启用 tunnel server。
2. 配置 `tunnel_domains`。
3. 安装 Android APK，配置 tunnel。
4. 启动 VPN，确认服务端出现 1 到 2 条 tunnel 连接。
5. 外部客户端通过 block-proxy 访问匹配域名。
6. 确认请求到达 Android 所在内网目标服务。

## 风险与待确认

- `VpnService` 无默认路由时的跨设备行为需要实机验证。
- Android 厂商省电策略可能杀死前台服务，首版通过电池优化豁免 + WakeLock + START_STICKY + WorkManager 四层防御缓解，但部分厂商 ROM 仍可能绕过，需用户手动加入自启动白名单。
- `PARTIAL_WAKE_LOCK` 会增加耗电，实机验证需记录功耗数据。
- Android 13+ 通知权限会影响前台服务用户感知，需要明确 UI 提示。
- Android 14+ foreground service type 和权限必须与 targetSdk 匹配。
- `allowInsecure=true` 适合个人部署，但需要在 UI 中清楚标识风险。
- Bundle/package name 暂定 `com.blockproxy.android`，实现前可按签名和发布需求调整。
