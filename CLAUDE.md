# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

### Development
- `pnpm i` – Install dependencies (pnpm preferred)
- `npm run dev` – Start dev mode (`BLOCK_PROXY_DEV=1`, Express + proxy + SOCKS5 + tunnel)
- `npm run craco` – React dev server (port 3000, CRACO proxies `/api` to Express 8004)
- `npm run start` / `npm run express` – Backend + proxy (production)
- `npm run proxy` – Proxy only | `npm run socks5` – SOCKS5 only

### Testing
- `npm run test:proxy-core` – proxy-core 连接测试（无需代理服务）
- `npm run test:registry` – MITM 规则注册测试
- `npm run test:mitm-runtime` – MITM 运行时测试
- `node test/proxy-core-cert-lifecycle-tests.js` – 证书生命周期测试（14 项）
- `node test/cert-lifecycle/smoke-test-rsa-signs-ecdsa.js` – RSA rootCA 签名冒烟测试
- `npm run test:proxy` – 代理连通性/性能/吞吐量测试（需先启动代理）
- `npm run test:android` – Android phone flavor 单元测试 | `npm run test:android:emulator` – 仪器化测试
- `cd android-client && ./gradlew :app:testPhoneDebugUnitTest --tests '*ClassName'` – 运行单个测试类
- 其他单测: `node test/tunnel-integration.test.js`, `node test/server-config-validation-tests.js`, `node test/fd-diagnostics-tests.js`, `node test/socks5-server-limits-tests.js`

### Utilities
- `npm run rm_bkconfig` – Remove backup config
- `npm run gen-icons` / `npm run watch:icons` – Generate/watch client app icons

### macOS Client (`/client/`)
- `npm run client:build` – 构建 macOS 客户端（自动检测架构，输出 `client/dist/`）
- `bash build.sh` – Nuitka 构建 .app（输出 `dist/BlockProxyClient.app` 和 `BlockProxyClient-macos-<arch>.zip`）
- `python main.py` – 直接运行（开发模式）
- `cd client && pytest tests/` – 单元测试
- 删除 `icons/app.icns` 后再 `build.sh` 可强制重新生成应用图标

### Android (`/android-client/`)
- `npm run android:build` – 构建 phone + emulator 两个 debug APK
- `npm run android:build:phone` – 仅构建 phone APK（armeabi-v7a, arm64-v8a）
- `npm run android:build:emulator` – 仅构建 emulator APK（含 x86_64）
- `npm run android:install` – adb 安装 phone APK
- `npm run android:install:emulator` – adb 安装 emulator APK 到 emulator-5554
- `npm run android:start` – 启动 MainActivity
- `npm run android:logcat` – 过滤 logcat (BlockProxy|Tunnel|AndroidRuntime)
- `npm run android:devices` – 列出 adb 设备
- `npm run android:native:build` – 构建 hev-socks5-tunnel + tun2socks .so（需 ANDROID_NDK_HOME）
- `npm run android:release:upload -- <tag>` – 构建 phone debug APK 并上传到 GitHub Release
- **Build 前提**: SDK API 35, minSdk 23, targetSdk 35; 首次需 `git submodule update --init --recursive` 后 `android:native:build`
- **Product Flavors**: `phone`（手机发布, arm only）/ `emulator`（虚拟机调试, 全 ABI）

### Build & Deploy
- `npm run build` – React frontend → `/build/`
- `npm run docker:build` / `docker:build:arm` – 单架构 Docker 镜像
- `npm run docker:push` – amd64 + arm64 dual-arch to ACR
- `block-proxy` / `block-proxy -c rule.js` – Global CLI (auto-restart, 3s delay, max 10000)
- `block-proxy --pubkey <path> --privkey <path>` – 指定隧道 TLS 证书路径

## Architecture

MITM proxy for parental control & ad blocking. Node.js + React + proxy-core (AnyProxy fork). Runs on OpenWRT routers or Docker.

### Ports
- `8001` – HTTP proxy (mandatory, proxy-core)
- `8002` – SOCKS5 over TLS (optional)
- `8003` – Tunnel server (reverse tunnel, NAT 穿透, HTTP/2 + allowHTTP1)
- `8004` – Express admin API
- `3000` – React dev server (dev only)

### Entry Points
- **Primary**: `bin/start.js` (CLI) → `server/start.js` → proxy-only or full stack
- **Proxy-only**: `proxy/start.js` → `proxy/proxy.js`
- **Dev**: `npm run dev` → full stack with dev flag

### Request Flow
```
Client → HTTP Proxy (8001) → proxy-core → MITM Rules → Target
       → SOCKS5 (8002) → TLS handshake + auth → CONNECT tunnel → HTTP Proxy (8001) → Target
       → Tunnel xhttp (8003, HTTP/2) → TunnelManager → HTTP Proxy (8001) → MITM → Target
```

### Core Components

- **Proxy** (`/proxy/`) – `proxy.js` 入口, `attacker.js` 拦截判断, `domain.js` host 匹配, `fs.js` config 读写备份, `scan.js` 每 2h ARP 扫描, `mitm/rule.js` 规则 + 响应修改器(YouTube 去广告, 有道 VIP), `http.js` HTTP 请求助手(绕过头校验), `monitor.js` 管理页/系统指标, `operator.js` 管理路由动作, `wanip.js` 公网 IP 获取, `fd-diagnostics.js` fd/TCP 连接诊断
- **Proxy-Core** (`/proxy/proxy-core/`) – 从 AnyProxy fork 提取的本地模块 (非 npm 依赖): `proxy-server.js`(入口, EventEmitter), `request-handler.js`(HTTP/S/WS 转发核心, ~980 行), `https-server-mgr.js`(SNI+IP HTTPS 服务 + LRU 1000 缓存), `cert-lifecycle.js`(预热/验证/并发去重/健康检查), `cert-mgr.js`(兼容层), `util.js`(helpers), `request-error-handler.js`(内联 HTML 错误页), `ws-server-mgr.js`(WS 服务器工厂)
  - 证书存储从 `~/.anyproxy` 迁移到项目本地 `certificates/` 目录
  - `X-Tunnel-Relay: 1` 头注入: tunnel 域名的 CONNECT 响应自动添加
  - ECONNRESET/EPIPE 自动重试一次 (GET/HEAD/OPTIONS)
  - 自定义 keep-alive agent: `maxRequestsPerSocket: 50` 防止 gRPC RST_STREAM
  - 流式响应阈值: 20MB (无 responseRules 时 64KB)
- **SOCKS5** (`/socks5/`) – SOCKS5 over TLS + UDP over TCP(自定义帧协议): `server.js`, `start.js`
- **Tunnel** (`/tunnel/`) – xhttp 传输协议（HTTP POST 上行 + SSE 下行）: `server.js`(HTTP/2 服务入口, allowHTTP1), `xhttpHandler.js`(xhttp 核心处理器), `uploadQueue.js`(上行帧重排序), `protocol.js`(帧编解码), `manager.js`(连接生命周期), `sseControl.js`(旧 SSE 路径适配), `disguiseResponse.js`(HTTPS 伪装)
- **Server** (`/server/`) – Express API (8004), 托管 React build, token cookie 认证; `start.js` 按 config 决定启动模式; `express.js` 管理接口 + 静态托管; `timestampConsole.js`, `util.js`
- **Frontend** (`/src/`) – CRA + CRACO 管理界面, `App.js` 主组件
- **CLI** (`/bin/start.js`) – 全局入口, 失败自动重启(3s delay, max 10000), 退出清理全局配置
- **Certs** (`/cert/`) – `rootCA.key` + `rootCA.crt`, 运行时同步到 `certificates/` 目录
- **Config** (`config.json`) – 运行时配置（详见下方字段）
- **Test Suite** (`/test/`) – `run.js` 一键测试(自动启动 Mock Server), `proxy-tests.js` 连通性/延迟/并发/吞吐量, `proxy-core-connect-tests.js` 连接测试, 以及隧道/配置校验/MITM/fd/socks5 单测

### Config (`config.json`)

运行时配置，由 `proxy/fs.js` 读写并备份到 `config_backup.json`。主要字段:

- 端口/开关: `proxy_port`, `socks5_port`, `express_port`, `enable_express`, `enable_socks5`, `enable_tunnel`, `enable_mitm`("0"/"1"), `mitm_debug_log`("0"/"1"), `socks5_tls`("0"/"1")
- 认证: `auth_username`/`auth_password`（代理/SOCKS5/隧道共用）, `login_username`/`login_password`（Express 管理面板登录，与代理认证相互独立）
- 拦截/设备: `block_hosts[]`, `devices[]`, `rule_modules{}`
- 隧道: `tunnel_port`, `tunnel_domains[]`, `tunnel_xhttp_base_path`(默认 "/xhttp"), `tunnel_sse_path`(默认 "/api/v1/events"), `tunnel_sse_keepalive_min_ms`/`max_ms`(默认 20000/25000), `tunnel_silent_idle_timeout`(默认 3000), `tunnel_rotation_drain_timeout`(默认 10), `tunnel_rotation_drain_idle_timeout`(默认 20), `tunnel_padding: { enabled, probability, min_bytes, max_bytes }`(默认 enabled:false)
- 链式代理: `chain_proxy_enabled`, `chain_proxy_type`(http/socks5), `chain_proxy_address`([user:pass@]host:port)
- 其他: `your_domain`, `vpn_proxy`, `network_scanning_status`, `progress_time_stamp`

### MITM Rule System

Host-based blocking with regex, time restrictions, MAC targeting (HTTP proxy only). Two rule types: `beforeSendRequest` / `beforeSendResponse`. Custom rules: edit `proxy/mitm/rule.js` or `block-proxy -c rule.js`. Rule callback: `(url, request, response)`.

```javascript
// Block host rule structure
{ "filter_host": "example.com", "filter_match_rule": "^https?://...",
  "filter_start_time": "00:00", "filter_end_time": "23:59",
  "filter_weekday": [1,2,3,4,5,6,7], "filter_mac": "AA:BB:CC:DD:EE:FF" }
```

### SOCKS5 Proxy (`/socks5/`)

SOCKS5 over TLS (port 8002, `socks5_tls` 可关):
- TLS 握手认证 → 转发至 HTTP Proxy
- UDP over TCP 通过自定义帧协议承载 UDP 数据
- 客户端: `client/proxy_core.py` (asyncio 实现)

### Bidirectional Tunnel (`/tunnel/`, Port 8003)

NAT 穿透 + xhttp 传输协议（HTTP POST 上行 + SSE 下行，无 WebSocket）。

**核心文件**:
- `tunnel/server.js` — HTTP/2 服务入口（`http2.createSecureServer`, `allowHTTP1: true`, TLS min 1.2），路由分发
- `tunnel/xhttpHandler.js` — xhttp 核心处理器（会话管理、SSE 推送、帧解码、上传缓冲）
- `tunnel/uploadQueue.js` — 上行帧重排序队列（min-heap，处理 POST 乱序到达）
- `tunnel/protocol.js` — 帧编解码 (FRAME_TYPES, encodeFrame/decodeFrame)
- `tunnel/manager.js` — tunnel 连接生命周期管理 (forward/reverse, sessionId-based)
- `tunnel/sseControl.js` — 旧 SSE 路径适配器（仅返回 410 迁移提示）
- `tunnel/disguiseResponse.js` — HTTPS GET 伪装响应

**xhttp 传输协议**:
- 会话创建: `POST /xhttp/create`（body 为 AUTH 帧，含 username/password/capabilities/clientId）→ 返回 `{ sessionId, capabilities }`
- 上行: `POST /xhttp/upload/:sessionId/:seq`（每帧一个独立 POST，seq 递增）
- 下行: `GET /xhttp/stream?token=<token>&sessionId=<sid>&clientId=<id>`（SSE 长连接，帧以 base64 编码在 `event: frame` 中推送）
- token = SHA-256(username:password)，用于 SSE/close 鉴权
- SSE keepalive: 20~25 秒随机间隔发送注释行
- session 创建后 15s 内未建立 SSE 会被清理；同 token 被新会话占用时返回 409（stale 会话走 60s takeover 宽限）
- 无 WebSocket upgrade 握手，流量特征与常规 HTTP API 无异

**能力协商 (capabilities)**:
- `padding` (`CAP_PADDING`) — DATA 帧后有概率追加 PADDING 帧 + HTTP 响应头随机注入 `X-Padding`
- `upload-batch-v1` (`CAP_UPLOAD_BATCH`) — 上行帧批处理/有界调度
- `upload-h2-v1` (`CAP_UPLOAD_H2`) — 上行优先走 HTTP/2

**上行帧重排序 (UploadQueue)**:
- min-heap 按 seq 排序，处理 HTTP POST 乱序到达
- 最大乱序缓冲 64 帧，溢出则关闭队列
- 已消费的旧 seq 静默丢弃（重复到达）
- 单 POST body 上限约 70KB（略大于 MAX_FRAME_PAYLOAD + header）

**双向 reqid 分配**:
- 反向 (server→client): `0x0001–0x7FFF` (server 分配)
- 正向 (client→server): `0x8000–0xFFFE` (client 分配)

**Padding 协商**:
- 客户端在 AUTH 帧中声明 `CAP_PADDING` 能力
- 服务端在 SSE 连接后通过 CAPABILITIES 帧确认
- 双方启用后，DATA 帧发送后有概率追加 PADDING 帧（随机 64~512 字节）
- 服务端默认关闭，`tunnel_padding.enabled` 开启；默认 probability 0.3

**连接管理与限制**:
- forward/reverse 各默认 200 并发上限，reverse CONNECT 超时 30s，空闲超时 5min
- 连接轮换 drain 超时 10s + 空闲超时 20s

### Deployment & Dependencies

- OpenWRT: `--network=host` | Docker: Node 18 Alpine 多阶段构建
- Dockerfile uses npmmirror.com 镜像源
- 运行时依赖在 `dependencies`, 仅 `@craco/craco` 在 `devDependencies`
- 生产 vs 开发模式由 `BLOCK_PROXY_DEV` 环境变量控制

### Development Workflow
1. `npm run dev` – proxy + admin UI + SOCKS5 + tunnel
2. `npm run craco` – React dev server (CRACO 代理 `/api` 到 8004)
3. `npm run proxy` – proxy-only testing
4. `npm run build` – frontend → `/build/`

## macOS Client (`/client/`)

Pure Python (PyObjC UI + asyncio proxy core), Nuitka 编译为原生二进制。v0.1.6。

```
main.py (入口, 文件锁单实例, 崩溃重启) → app.py (PyObjC 状态栏)
  ├── proxy_core.py (asyncio SOCKS5/HTTP + UDP over TCP)
  ├── tunnel_client.py (xhttp over TLS 隧道 + 自动重连)
  ├── routing.py / geodata_loader.py / proto_parser.py (geosite/geoip 分流, 零依赖 protobuf)
  ├── doh_resolver.py (DoH DNS 解析节点地址)
  ├── super_dns_control.py / super_dns_window.py (Super DNS 域名管理)
  ├── config.py (~/Library/Application Support/BlockProxyClient/)
  ├── config_window.py / routing_window.py / log_window.py (PyObjC, 独立进程)
  ├── autostart.py (LaunchAgent 开机自启)
  ├── logger.py (访问/崩溃日志)
  ├── system_proxy.py (networksetup)
  └── traffic_stats.py / traffic_view.py (流量统计与可视化)
```

**关键设计**:
- 纯 Python 替代 xray-core（公司安全软件按二进制特征码拦截 xray-core/py2app/PyInstaller）
- 纯 PyObjC 替代 rumps/tkinter（Nuitka 兼容性）
- 本地代理与隧道生命周期解耦：隧道断开时本地代理继续运行，隧道后台重连
- 窗口作为独立进程（Nuitka 编译后 `sys.executable` 非 Python 解释器，用 `subprocess.Popen` + 系统 Python）
- 私有地址直连 (127/8, 10/8, 172.16/12, 192.168/16)，可配置关闭
- 系统唤醒: socket 探测端口存活 + 隧道线程状态恢复，等待 3s 网络稳定后重试
- 仅 tunnel 配置变化时只重启隧道（`_reconnect_tunnel_only()`），其他变化完整重启
- DoH 解析节点地址 (`doh_resolver.py`, 默认 `dns.alidns.com` + bootstrap `223.5.5.5,223.6.6.6`)
- Nuitka 构建后处理: `build.sh` 自动重命名可执行文件、修正 Info.plist (CFBundleExecutable, LSUIElement)
- 删除 `icons/app.icns` 后再 `build.sh` 可强制重新生成应用图标
- **三种上游连接模式**: SOCKS5 over TLS / HTTP CONNECT / UDP ASSOCIATE, 由 routing engine 选择
- **macOS Tahoe (26+)**: `_is_tahoe_or_newer()` 检测系统版本以适配 Liquid Glass 图标处理

## Android Client (`/android-client/`)

Kotlin + Jetpack Compose + VpnService + tun2socks (JNI) + xhttp 传输。v0.1.6 (versionCode 3)。

```
VpnService TUN fd → tun2socks (native C, JNI) → 127.0.0.1:socksPort
  → LocalSocksServer → RoutingEngine (geosite/geoip)
    → DIRECT: protected Socket (VpnService.protect 绕过 VPN)
    → PROXY: ForwardSession → TunnelClient
                               → XhttpSession (POST /xhttp/create 建立会话)
                               → XhttpTransport (SSE 下行 + POST 上行)
```

**关键设计**:
- `addDisallowedApplication(packageName)` 内核级 VPN 循环防护 + `VpnService.protect()` 逐 socket defense-in-depth
- `ParcelFileDescriptor.detachFd()` 转移 fd 所有权给 native, onDestroy 仅在未 detach 时 close
- hev-socks5-tunnel 作为 git submodule (`native/hev-socks5-tunnel/`, v2.15.0): lwip 用户态 TCP/IP + hev-task-system, 仅一个 pthread
- `tun2socks_jni.c`: spawns detached pthread, JNI_OnLoad 缓存 JavaVM + protect method ID
- DataStore 持久化配置/凭据/分流, WorkManager TunnelWatchdogWorker (15min)
- UI: ConfigScreen, RoutingScreen, AboutScreen, MainScreen, StatusCard; StatusStore 全局 StateFlow (Preparing/Connecting/Connected/Disconnected/Error)
- **minSdk 23 + Core Library Desugaring**: 通过 `desugar_jdk_libs:2.1.5` 支持 Android 6.0+, Java 17 编译
- **Product Flavors**: `phone`（arm only, 发布用）/ `emulator`（全 ABI, 调试用），APK 固定命名区分

### 模块 (`app/src/main/java/com/blockproxy/android/`)

- `cdn/` — CDN IP 池与轮换: `CfCdnConfig`(支持 NONE/Cloudflare/Aliyun), `CfIpPool`, `CfIpSelector`, `CfIpRefreshWorker`, `CfIpRuntimeRegistry`, `CfIpSpeedTester`
- `doh/` — DoH DNS: `DohConfig` + `DohDns`（OkHttp Dns override，`dns.alidns.com` + bootstrap IP）
- `tun/` — `Tun2Socks.kt`, `Tun2SocksMapDnsConfig.kt`
- `socks/` — 本地 SOCKS 服务: `LocalSocksServer`, `SocksSession`, `SocksConnectors`, `SocksProtocol`, `TlsClientHelloParser`, `TrafficSniffer`, `DomainMappingStore`, `HostnameValidator`, `HttpHostParser`
- `tunnel/` — xhttp 传输（见下方）
- `routing/` — `RoutingEngine`, `GeositeLoader`, `GeositeMatcher`, `ProtoParser`, `RouteDecision`, `DomainRule`
- `service/` — `BlockProxyVpnService`, `TunnelServiceController`, `TunnelNotification`, `TunnelWatchdogWorker`, `BootRestartReceiver`, `BootRestoreRetryPolicy`
- `ui/` — Compose 界面 + `TunnelViewModel`, `RoutingViewModel`
- `status/` — `StatusStore`, `TunnelStatus`
- `diagnostics/` — `TunnelDiagnosticsLog`
- `util/` — `NetworkInfoManager`, `TlsTester`

### Tunnel 模块 (`tunnel/`)

**xhttp 传输层**（替代原 WebSocket 控制通道，SSE 下行 + 按需 POST 上行）:
- `FrameSender` — 帧发送接口（`sendFrame`, `close`, `isOpen`）
- `Frame` / `FrameCodec` — 帧定义与编解码（CONNECT/DATA/CLOSE/PING/PONG/AUTH/AUTH_OK/AUTH_FAIL/ERROR/CAPABILITIES/PADDING/CONNECT_FAILED）
- `XhttpSession` — 会话建立：POST `/xhttp/create`（发送 AUTH 帧）→ 获取 sessionId/capabilities → 创建 XhttpTransport
- `XhttpTransport` — 传输层实现：SSE 下行（OkHttp 长连接）+ 按需 POST 上行；SSE idle watchdog (90s) + 15s 重连窗口
- `XhttpUploadClient` — 上行发送抽象：`OkHttpXhttpUploadClient` / `NativeUtlsXhttpUploadClient`（uTLS 失败回退 OkHttp）
- `XhttpUploadScheduler` — 有界、优先级感知的上行调度器，把 TCP back-pressure 传导给上层
- `GomobileUtlsPostClient` — gomobile 编译的 `utlsws` AAR 反射封装（uTLS HTTP/1.1 POST）
- `TunnelTransportFactory` — 工厂：封装 XhttpSession → XhttpTransport 流程
- `TunnelClient` — 顶层管理器：生命周期（start/stop）、自动重连、连接轮换（1~2 小时随机间隔）、drain 排空
- `TunnelRotationPolicy` — 轮换间隔（默认 1~2h）
- `ForwardAdmissionController` — 正向 CONNECT 准入控制（默认 12 全局 + 每目标 4）
- `ReverseConnectHandler` — 反向 CONNECT：收到服务端 CONNECT 帧后创建 plain TCP 目标连接，双向中继数据
- `ForwardSession` / `ForwardSessionRegistry` — 正向 CONNECT：客户端主动发起，通过 tunnel 代理到服务端
- `PaddingInjector` — 流量填充：协商后按概率在 DATA 帧后追加 PADDING 帧
- `TargetSocket` / `RealTargetSocket` — 目标 TCP socket 抽象（支持 VpnService.protect）

**连接轮换 (rotation)**:
- 每 1~2 小时（随机）建立新 xhttp session 替换旧的，通过新 TCP 连接刷新 NAT 映射
- 旧连接进入 draining 状态，等待活跃请求完成后关闭
- drain 超时 10 秒 + 空闲超时 20 秒

**CF/CDN IP 轮换**:
- SSE 和 upload 各自独立的 `CfIpDns` + `CfIpSelector`（`sseCfIpDns/sseCfIpSelector`, `uploadCfIpDns/uploadCfIpSelector`）
- 轮换时 `forceNextOnNextLookup()` 切换 IP
- `CfIpRefreshWorker` 通过 WorkManager 定期刷新 IP 池
- `CfIpRuntimeRegistry` 全局注册, 支持 protect callback 绕过 VPN
- 同时支持 Cloudflare 与 Aliyun CDN 边缘 IP（`CfCdnConfig`/`AliyunCdnConfig`）

## Important Notes

- **Testing 陷阱**: 通过代理请求 `127.0.0.1` 会被 AnyProxy 拦截返回管理页面。Mock Server 需绑定 `0.0.0.0` 并通过 LAN IP 访问
- SOCKS5 不支持 MAC 地址定向拦截（仅 HTTP 代理）
- 未安装证书时设 `enable_mitm` 为 `"0"` 可切换纯隧道模式，关闭所有 MITM 解密，零证书错误
- `auth_username`/`auth_password` 是代理/隧道认证；Express 管理面板登录用 `login_username`/`login_password`，两者独立
- iOS Safari: 带认证的代理不能和网关 IP 相同
- 路由表每 2 小时刷新；新设备可能需手动刷新
- ACR 推送前需先 `docker login --username=hi50078584@aliyun.com crpi-x1zji86f6jpcd7t1.cn-hangzhou.personal.cr.aliyuncs.com`
- **Android 构建顺序**: 修改 native C 代码后需先 `android:native:build` 重新编译 .so; 最后 `android:build` 打包 APK。`utlsws` AAR 需用 `native/utlsws/build-aar.sh`（gomobile）单独构建
- **Android Product Flavors**: `phone`（arm only, 发布包）/ `emulator`（全 ABI, 调试包）, 构建命令不同, APK 命名自动区分
- **Android 发布**: 发布到 GitHub Release 时运行 `npm run android:release:upload -- <tag>`，脚本自动构建 phone debug APK 并上传；不要上传未签名的 release APK
- **Android logcat 调试**: `npm run android:logcat` 过滤 BlockProxy/Tunnel/AndroidRuntime 标签，崩溃堆栈在 AndroidRuntime 中
- **Backup config**: `config_backup.json`（`npm run rm_bkconfig` 可删除）
- **Chain proxy**: `config.json` 支持 `chain_proxy_enabled`/`chain_proxy_type`(http/socks5)/`chain_proxy_address`([user:pass@]host:port) 将所有代理流量经上游代理转发
- **CLI 自定义证书**: `block-proxy --pubkey <path> --privkey <path>` 指定隧道 TLS 证书路径 (设置 `TUNNEL_PUBKEY`/`TUNNEL_PRIVKEY` 环境变量)
- **新增测试**: `npm run test:registry`（规则注册）、`npm run test:mitm-runtime`（MITM 运行时）、`node test/tunnel-integration.test.js`（隧道端到端）、`node test/server-config-validation-tests.js`（config import 验证）、`node test/fd-diagnostics-tests.js`、`node test/socks5-server-limits-tests.js`

## Project Skills (`.claude/skills/`)

- `/commit` – 智能提交 (Conventional Commit, 英文类型+中文正文)
- `/build-client` – 构建 macOS 客户端（不升级版本号）
- `/release-client` – 构建并发布到 GitHub Release
- `/icon_generate` – 生成状态栏 bar 图标 (44x44 @ 144 DPI)
- `/pcap-analyse` – 分析 pcap/pcapng 抓包文件

## Project Rules

- `config.json` 是运行时配置（非源码），由 `proxy/fs.js` 管理，不追踪 git 变更
- 代码修改后等用户验证确认再提交，不自动 git add/commit/push
