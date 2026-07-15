# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

### Development
- `pnpm i` – Install dependencies (pnpm preferred)
- `npm run dev` – Start dev mode (BLOCK_PROXY_DEV=1, all services)
- `npm run craco` – React dev server (port 3000, CRACO proxies `/api` to Express 8004)
- `npm run start` / `npm run express` – Backend + proxy (production)
- `npm run proxy` – Proxy only | `npm run socks5` – SOCKS5 only

### Testing
- `npm run test:proxy-core` – proxy-core 单元测试（无需代理服务）
- `node test/proxy-core-cert-lifecycle-tests.js` – 证书生命周期测试（14 项）
- `node test/cert-lifecycle/smoke-test-rsa-signs-ecdsa.js` – RSA rootCA 签名冒烟测试
- `npm run test:proxy` – 代理连通性/性能/吞吐量测试（需先启动代理）
- `npm run test:android` – Android 单元测试 | `npm run test:android:emulator` – 仪器化测试

### Utilities
- `npm run rm_bkconfig` – Remove backup config
- `npm run gen-icons` / `npm run watch:icons` – Generate/watch client app icons

### macOS Client (`/client/`)
- `npm run client:build` – 构建 macOS 客户端（自动检测架构，输出 `client/dist/`）
- `bash build.sh` – Nuitka 构建 .app（输出 `dist/BlockProxyClient.app` 和 `.zip`）
- `python main.py` – 直接运行（开发模式）
- `cd client && pytest tests/` – 单元测试
- 删除 `icons/app.icns` 后再 `build.sh` 可强制重新生成应用图标

### Android (`/android-client/`)
- `npm run android:build` – 构建 debug APK
- `npm run android:install` – adb 安装 APK
- `npm run android:start` – 启动 MainActivity
- `npm run android:logcat` – 过滤 logcat (BlockProxy|Tunnel|AndroidRuntime)
- `npm run android:devices` – 列出 adb 设备
- `npm run android:native:build` – 构建 tun2socks .so（需 ANDROID_NDK_HOME）
- **Build 前提**: SDK API 35, minSdk 26; 首次需先 `android:native:build`; ABI: arm64-v8a, armeabi-v7a, x86_64

### Build & Deploy
- `npm run build` – React frontend → `/build/`
- `npm run docker:build` / `docker:build:arm` – 单架构 Docker 镜像
- `npm run docker:push` – amd64 + arm64 dual-arch to ACR
- `block-proxy` / `block-proxy -c rule.js` – Global CLI (auto-restart, max 10000)

## Architecture

MITM proxy for parental control & ad blocking. Node.js + React + proxy-core (AnyProxy fork). Runs on OpenWRT routers or Docker.

### Ports
- `8001` – HTTP proxy (mandatory, proxy-core)
- `8002` – SOCKS5 over TLS (optional)
- `8003` – Tunnel server (reverse tunnel, NAT 穿透)
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
       → Tunnel TLS (8003) → TunnelManager → HTTP Proxy (8001) → MITM → Target
```

### Core Components

- **Proxy** (`/proxy/`) – `proxy.js` 入口, `attacker.js` 拦截判断, `domain.js` host 匹配, `fs.js` config 读写备份, `scan.js` 每 2h ARP 扫描, `mitm/rule.js` 规则 + 响应修改器(YouTube 去广告, 有道 VIP)
- **Proxy-Core** (`/proxy/proxy-core/`) – 底层引擎: `proxy-server.js`(入口), `request-handler.js`(HTTP/S 转发核心), `https-server-mgr.js`(SNI+LRU 缓存), `cert-lifecycle.js`(预热/验证/并发去重/自愈), `cert-mgr.js`(兼容层)
- **SOCKS5** (`/socks5/`) – SOCKS5 over TLS + UDP over TCP(自定义帧协议) + 反向隧道: `tunnel-server.js`, `tunnel-client.js`, `reverse-connect-handler.js`
- **Server** (`/server/`) – Express API (8004), `start.js` 按 config 决定启动模式
- **Frontend** (`/src/`) – CRA + CRACO 管理界面, `App.js` 主组件
- **CLI** (`/bin/start.js`) – 全局入口, 失败自动重启(3s delay, max 10000), 退出清理全局配置
- **Certs** (`/cert/`) – `rootCA.key` + `rootCA.crt`, 运行时同步到 `certificates/` 目录
- **Config** (`config.json`) – 运行时配置: `block_hosts[]`, `proxy_port`, `socks5_port`, `enable_express`, `enable_socks5`, `enable_mitm`("0"/"1"), `mitm_debug_log`("0"/"1"), `devices[]`, `auth_username`, `auth_password`
- **Test Suite** (`/test/`) – `run.js` 一键测试(自动启动 Mock Server), `proxy-tests.js` 连通性/延迟/并发/吞吐量, `proxy-core-connect-tests.js` 连接测试

### MITM Rule System

Host-based blocking with regex, time restrictions, MAC targeting (HTTP proxy only). Two rule types: `beforeSendRequest` / `beforeSendResponse`. Custom rules: edit `proxy/mitm/rule.js` or `block-proxy -c rule.js`. Rule callback: `(url, request, response)`.

```javascript
// Block host rule structure
{ "filter_host": "example.com", "filter_match_rule": "^https?://...",
  "filter_start_time": "00:00", "filter_end_time": "23:59",
  "filter_weekday": [1,2,3,4,5,6,7], "filter_mac": "AA:BB:CC:DD:EE:FF" }
```

### SOCKS5 Proxy (`/socks5/`)

SOCKS5 over TLS (port 8002):
- TLS 握手认证 → CONNECT 隧道 → 转发至 HTTP Proxy
- UDP over TCP 通过自定义帧协议承载 UDP 数据
- 客户端: `client/proxy_core.py` (asyncio 实现)

### Bidirectional Tunnel (Port 8003)

NAT 穿透: 内网客户端 TLS 回连服务端。核心文件: `tunnel-server.js`, `tunnel-client.js`, `reverse-connect-handler.js`

### Deployment & Dependencies

- OpenWRT: `--network=host` | Docker: Node 18 Alpine 多阶段构建
- Dockerfile uses npmmirror.com 镜像源
- 运行时依赖在 `dependencies`, 仅 `@craco/craco` 在 `devDependencies`
- 生产 vs 开发模式由 `BLOCK_PROXY_DEV` 环境变量控制

### Development Workflow
1. `npm run dev` – proxy + admin UI + SOCKS5
2. `npm run craco` – React dev server (CRACO 代理 `/api` 到 8004)
3. `npm run proxy` – proxy-only testing
4. `npm run build` – frontend → `/build/`

## macOS Client (`/client/`)

Pure Python (PyObjC UI + asyncio proxy core), Nuitka 编译为原生二进制。v0.1.3。

```
main.py (入口, 文件锁单实例, 崩溃重启) → app.py (PyObjC 状态栏)
  ├── proxy_core.py (asyncio SOCKS5/HTTP + UDP over TCP)
  ├── tunnel_client.py (隧道 + 自动重连, 指数退避 max 60s)
  ├── routing.py / geodata_loader.py / proto_parser.py (geosite/geoip 分流, 零依赖 protobuf)
  ├── config.py (~/Library/Application Support/BlockProxyClient/)
  ├── config_window.py / routing_window.py / log_window.py (PyObjC, 独立进程)
  └── system_proxy.py (networksetup)
```

**关键设计**:
- 纯 Python 替代 xray-core（公司安全软件按二进制特征码拦截 xray-core/py2app/PyInstaller）
- 纯 PyObjC 替代 rumps/tkinter（Nuitka 兼容性）
- 本地代理与隧道生命周期解耦：隧道断开时本地代理继续运行，隧道后台重连
- 窗口作为独立进程（Nuitka 编译后 `sys.executable` 非 Python 解释器，用 `subprocess.Popen` + 系统 Python）
- 私有地址直连 (127/8, 10/8, 172.16/12, 192.168/16)，可配置关闭
- 系统唤醒: socket 探测端口存活 + 隧道线程状态恢复
- 仅 tunnel 配置变化时只重启隧道（`_reconnect_tunnel_only()`），其他变化完整重启
- Nuitka 构建后处理: `build.sh` 自动重命名可执行文件、修正 Info.plist (CFBundleExecutable, LSUIElement)
- 删除 `icons/app.icns` 后再 `build.sh` 可强制重新生成应用图标

## Android Client (`/android-client/`)

Kotlin + Jetpack Compose + VpnService + tun2socks (JNI). v0.1.3。

```
VpnService TUN fd → tun2socks (native C, JNI) → 127.0.0.1:socksPort
  → LocalSocksServer → RoutingEngine (geosite/geoip)
    → DIRECT: protected Socket (VpnService.protect 绕过 VPN)
    → PROXY: ForwardSession → tunnel server
```

**关键设计**:
- `addDisallowedApplication(packageName)` 内核级 VPN 循环防护 + `VpnService.protect()` 逐 socket defense-in-depth
- `ParcelFileDescriptor.detachFd()` 转移 fd 所有权给 native, onDestroy 仅在未 detach 时 close
- hev-socks5-tunnel 作为 git submodule (`native/hev-socks5-tunnel/`, v2.15.0): lwip 用户态 TCP/IP + hev-task-system, 仅一个 pthread
- `tun2socks_jni.c`: spawns detached pthread, JNI_OnLoad 缓存 JavaVM + protect method ID
- DataStore 持久化配置/凭据/分流, WorkManager TunnelWatchdogWorker (15min)
- UI: ConfigScreen, RoutingScreen, StatusCard; StatusStore 全局 StateFlow (Preparing/Connecting/Connected/Disconnected/Error)

## Important Notes

- **Testing 陷阱**: 通过代理请求 `127.0.0.1` 会被 AnyProxy 拦截返回管理页面。Mock Server 需绑定 `0.0.0.0` 并通过 LAN IP 访问
- SOCKS5 不支持 MAC 地址定向拦截（仅 HTTP 代理）
- 未安装证书时设 `enable_mitm` 为 `"0"` 可切换纯隧道模式，关闭所有 MITM 解密，零证书错误
- iOS Safari: 带认证的代理不能和网关 IP 相同
- 路由表每 2 小时刷新；新设备可能需手动刷新
- ACR 推送前需先 `docker login --username=hi50078584@aliyun.com crpi-x1zji86f6jpcd7t1.cn-hangzhou.personal.cr.aliyuncs.com`
- **Android 构建顺序**: 修改 native C 代码后需先 `android:native:build` 重新编译 .so，再 `android:build` 打包 APK
- **Android APK 命名**: 手机/GitHub Release 包固定为 `app/build/outputs/apk/phone/debug/BlockProxyClient-android.apk`；虚拟机调试包为 `app/build/outputs/apk/emulator/debug/BlockProxyClient-android-emulator.apk`
- **Android 发布**: 发布到 GitHub Release 时使用 debug 签名的 phone 包，运行 `npm run android:release:upload -- <tag>`；不要上传未签名的 release APK
- **Android logcat 调试**: `npm run android:logcat` 过滤 BlockProxy/Tunnel/AndroidRuntime 标签，崩溃堆栈在 AndroidRuntime 中
- **Backup config**: `config_backup.json`（`npm run rm_bkconfig` 可删除）

## Project Skills (`.claude/skills/`)

- `/commit` – 智能提交 (Conventional Commit, 英文类型+中文正文)
- `/build-client` – 构建 macOS 客户端（不升级版本号）
- `/release-client` – 构建并发布到 GitHub Release
- `/icon_generate` – 生成状态栏 bar 图标 (44x44 @ 144 DPI)
- `/pcap-analyse` – 分析 pcap/pcapng 抓包文件

## Project Rules

- `config.json` 是运行时配置（非源码），由 `proxy/fs.js` 管理，不追踪 git 变更
- 代码修改后等用户验证确认再提交，不自动 git add/commit/push
