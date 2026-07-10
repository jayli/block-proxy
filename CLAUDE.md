# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

### Development
- `pnpm i` – Install dependencies (pnpm is the preferred package manager)
- `npm run dev` – Start development mode with BLOCK_PROXY_DEV=1 (starts all services)
- `npm run craco` – Start React development server with CRACO (port 3000)
- `npm run start` / `npm run express` – Start backend + proxy server for production
- `npm run proxy` – Start proxy only (no admin interface)
- `npm run socks5` – Start SOCKS5 server only
- `npm run cp` – Print start banner (used internally by other scripts)

### Testing
- `npm run test:proxy-core` – Proxy-core 单元测试（proxy-core-connect-tests.js，无需代理服务）
- `node test/proxy-core-cert-lifecycle-tests.js` – 证书生命周期测试（RSA 生成、缓存、健康检查、预热等 14 项）
- `node test/cert-lifecycle/smoke-test-rsa-signs-ecdsa.js` – RSA rootCA 签名冒烟测试
- `npm run test:proxy` – 一键代理连通性/性能/吞吐量测试（需先启动代理服务）
- `npm test` – Run React tests (currently limited, based on CRA defaults)
- `npm run test:android` – Android 单元测试（cd android-client && gradlew :app:testDebugUnitTest）
- `npm run test:android:emulator` – Android 仪器化测试（需模拟器运行，自动清除代理环境变量）

### Utilities
- `npm run rm_bkconfig` – Remove backup config file
- `npm run gen-icons` – Generate client app icons from `icons/app_icon.png`
- `npm run watch:icons` – Watch icon changes and auto-regenerate

### macOS Client
- `npm run client:build` – 构建 macOS 客户端（自动检测架构，输出到 `client/dist/`）

### Android
- `npm run android:build` – 构建 debug APK（cd android-client && gradlew :app:assembleDebug）
- `npm run android:install` – 通过 adb 安装 APK 到连接的设备/模拟器
- `npm run android:start` – 启动 Android 应用 MainActivity
- `npm run android:logcat` – 过滤 logcat 日志（BlockProxy|Tunnel|AndroidRuntime）
- `npm run android:devices` – 列出已连接的 adb 设备
- `npm run android:native:build` – 构建 tun2socks 原生 .so 库（需要 ANDROID_NDK_HOME 环境变量）

### Build & Deployment
- `npm run build` – Build React frontend
- `npm run docker:build` – Build Docker image (amd64)
- `npm run docker:build:arm` – Build ARM64 Docker image
- `npm run docker:push` – Build and push amd64 + arm64 dual-arch to ACR (needs `docker login` first)
- `npm run docker:push:amd64` / `npm run docker:push:arm64` – Push single architecture
- `npm run eject` – Eject from Create React App (irreversible)

### Global CLI
- `block-proxy` – Start the proxy system (auto-restart on failure, max 10000 times)
- `block-proxy -c rule.js` – Start with external MITM rule configuration

## Architecture Overview

Block-Proxy is a MITM-based proxy filtering tool designed for parental control and ad blocking, built with Node.js, React, and a custom proxy-core engine (forked from AnyProxy). It runs on OpenWRT routers or Docker containers.

### Core Components

1. **Proxy Engine** (`/proxy/`) – 核心入口 `proxy.js`，基于 `proxy-core/` 实现 MITM 请求/响应过滤。`attacker.js` 执行拦截判断，`domain.js` 做 host 匹配，`fs.js` 管理 config.json 读写备份，`scan.js` 每 2 小时 ARP 扫描发现设备。`mitm/` 子目录包含规则定义（`rule.js`）和具体的响应修改器（YouTube 去广告、有道词典 VIP）

2. **Proxy-Core** (`/proxy/proxy-core/`) – 从 `@bachi/anyproxy` 提取的核心模块集合，提供代理服务器、证书管理、HTTPS 服务器管理等底层功能。关键文件：`proxy-server.js`（代理服务器入口）、`cert-lifecycle.js`（证书生命周期管理：预热、验证、并发去重、自愈）、`cert-mgr.js`（证书管理兼容层）、`https-server-mgr.js`（SNI 回调与 LRU 缓存）、`request-handler.js`（HTTP/HTTPS 请求处理）、`util.js`（工具函数）

3. **SOCKS5 Proxy** (`/socks5/`) – SOCKS5 over TLS 实现（端口 8002），TLS 握手认证后通过 CONNECT 隧道转发至 HTTP Proxy。支持 UDP over TCP（自定义帧协议承载 UDP 数据通过 TLS TCP 连接）

4. **Backend Server** (`/server/`) – Express API 服务器（默认端口 8004）。`start.js` 根据 config 决定启动完整栈还是仅代理模式

5. **React Frontend** (`/src/`) – CRA + CRACO 构建的管理界面，`App.js` 为主组件

6. **Test Suite** (`/test/`) – `run.js` 一键测试入口（自动启动 Mock Server），`proxy-tests.js` 覆盖 HTTP/SOCKS5 连通性、延迟、并发、吞吐量。`proxy-core-connect-tests.js` 测试 proxy-core 模块连接。`proxy-core-cert-lifecycle-tests.js` 测试证书生命周期

7. **CLI** (`/bin/start.js`) – 全局命令入口，失败自动重启（max 10000 次），退出时清理全局配置

8. **TLS Certificates** (`/cert/`) – `rootCA.key` + `rootCA.crt`，运行时同步到项目的 `certificates/` 目录，客户端需安装此证书才能 HTTPS MITM

9. **Configuration** (`config.json`) – 运行时配置（非源码），由 `proxy/fs.js` 管理。关键字段：`block_hosts[]`, `proxy_port`, `socks5_port`, `enable_express`, `enable_socks5`, `enable_mitm`（"0"/"1"，关闭后纯隧道转发不拦截 HTTPS），`mitm_debug_log`（"0"/"1"，输出 MITM 调试日志），`devices[]`, `auth_username`, `auth_password`

### Port Configuration
- `8001` – HTTP proxy port (mandatory, proxy-core)
- `8002` – SOCKS5 over TLS port (optional)
- `8003` – Tunnel server port (reverse tunnel client connections)
- `8004` – Admin configuration interface (Express，原 AnyProxy 监控端口已永久关闭)
- `3000` – React development server (dev only)

### Entry Points
- **Primary**: `bin/start.js` (CLI) → `server/start.js` → decides between proxy-only or full stack
- **Proxy-only**: `proxy/start.js` → `proxy/proxy.js`
- **Development**: `npm run dev` → starts everything with dev flag

### Request Flow
```
Client → HTTP Proxy (8001) → proxy-core → MITM Rules → Target Server
       → SOCKS5 (8002) → TLS → SOCKS5 Server → HTTP Proxy (8001) → Target Server
```
SOCKS5 先做 TLS 握手和认证，然后通过 CONNECT 命令建立隧道，将 TCP 流量转发至下游 HTTP 代理。

### Bidirectional Tunnel System (Port 8003)

反向隧道系统用于 NAT 穿透，允许内网客户端通过 TLS 连接回服务端。

**架构流程：**
```
内网客户端 → 隧道 TLS (8003) → TunnelManager → HTTP Proxy (8001) → MITM → 目标服务器
```

**关键特性：**
- TLS 加密传输 + 用户名密码认证
- 双 TCP 连接并行消除队头阻塞
- 心跳检测（30s PING / 60s 超时）
- 自动重连与连接池补充
- 可配置隧道域名白名单（哪些域名走隧道转发）
- 支持反向 CONNECT（服务端通过隧道访问客户端侧目标）

**核心文件：**
- `socks5/tunnel-server.js` — 隧道服务端，监听 8003 端口
- `socks5/tunnel-client.js` — 隧道客户端（服务端侧，管理连接池）
- `socks5/reverse-connect-handler.js` — 处理反向 CONNECT 请求
- `client/tunnel_client.py` — macOS 客户端的隧道实现

## Key Patterns

### MITM Rule System
- Host-based blocking with regex pattern matching
- Time-based restrictions (start/end times, weekdays)
- MAC address targeting for device-specific rules (HTTP proxy only)
- YouTube ad blocking with predefined regex patterns
- Custom rule injection via external `rule.js` configuration
- Two rule types: `beforeSendRequest` and `beforeSendResponse`
- Built-in rules: YouTube ad removal, Youdao Dictionary VIP unlock

**Adding Custom MITM Rules:**
1. Edit `proxy/mitm/rule.js` for built-in rules, or
2. Create external rule file and start with `block-proxy -c rule.js`
3. Rule structure: `{ type, host, regexp, callback }` where callback receives `(url, request, response)`
4. See `example/rule.js` for reference

### Configuration Management
- Configuration stored in `config.json` at runtime
- Supports external rule files via `-c` flag (global config via `_fs.setGlobalConfigFile()`)
- Network device scanning every 2 hours (stored in `config.json` as `devices[]`)
- Auto-clears global config file on exit/restart
- Backup config: `config_backup.json` (removed on build)

### Block Host Rule Structure
```javascript
{
  "filter_host": "example.com",           // Host pattern
  "filter_match_rule": "^https?://...",   // URL regex (optional)
  "filter_start_time": "00:00",           // Start time
  "filter_end_time": "23:59",             // End time
  "filter_weekday": [1,2,3,4,5,6,7],     // 1=Monday, 7=Sunday
  "filter_mac": "AA:BB:CC:DD:EE:FF"      // Target device (optional)
}
```

### Deployment Patterns
- Designed for OpenWRT router deployment with host networking (`--network=host`)
- Docker container with volume mounting for configuration
- Multi-architecture support (ARM/X86)
- Auto-restart on failure with config cleanup (3 second delay, max 10000 restarts)
- Production vs. development modes controlled by `BLOCK_PROXY_DEV` env var

### Development Workflow
1. **Development**: `npm run dev` starts proxy + admin UI + SOCKS5 (if enabled)
2. **Frontend Development**: `npm run craco` starts React dev server (port 3000)，CRACO 将 `/api` 请求代理到 Express 后端端口 8004（或 `config.json` 中的 `express_port`）
3. **Testing**: Proxy-only mode with `npm run proxy`
4. **Building**: `npm run build` compiles React frontend to `/build/`
5. **Docker**: Dockerfile 基于 Node 18 Alpine（多阶段构建），本地开发可用更高版本 Node

### Dependencies
运行时依赖（express, react, axios 等）放在 `dependencies` 中，仅 `@craco/craco` 在 `devDependencies`。

**Proxy-Core** (`/proxy/proxy-core/`)：从 `@bachi/anyproxy` fork 提取并本地化的核心模块，是代理系统的底层引擎。分析连接处理、TLS 拦截、请求转发等底层逻辑时，应直接阅读此目录下的源码。关键文件：
- `proxy-server.js` — 代理服务器入口
- `request-handler.js` — HTTP/HTTPS 请求处理与转发核心
- `https-server-mgr.js` — HTTPS MITM 服务管理、动态证书生成
- `cert-lifecycle.js` — 证书生命周期管理（预热、验证、并发去重、SNI 自愈）
- `cert-mgr.js` — AnyProxy 兼容的证书管理 facade

## macOS Client (`/client/`)

macOS 状态栏代理客户端，纯 Python 实现，连接远端 SOCKS5 over TLS 服务。当前版本 v0.1.3。

### Commands
- `python main.py` – 直接运行客户端（开发模式）
- `bash build.sh` – Nuitka 一键构建 macOS .app（输出到 `dist/BlockProxyClient.app`）
- `cd client && pytest tests/` – 运行客户端单元测试
- `npm run gen-icons` – 生成应用图标（从 `icons/app_icon.png` 生成 `.icns`）
- `npm run watch:icons` – 监听图标变化并自动重新生成
- 删除 `icons/app.icns` 后再 `bash build.sh` 可强制重新生成应用图标

### Architecture
```
main.py (入口, 文件锁单实例, 崩溃自动重启) → app.py (纯 PyObjC 状态栏 App)
                                              ├── proxy_core.py (asyncio SOCKS5/HTTP 代理核心 + UDP over TCP)
                                              ├── tunnel_client.py (隧道连接管理 + 自动重连)
                                              ├── routing.py (geosite/geoip 分流引擎)
                                              ├── geodata_loader.py (解析 geoip.dat/geosite.dat)
                                              ├── proto_parser.py (零依赖 protobuf 解析器)
                                              ├── config.py (配置读写, ~/Library/Application Support/BlockProxyClient/)
                                              ├── logger.py (日志管理, RotatingFileHandler)
                                              ├── config_window.py (PyObjC 配置窗口, 独立进程)
                                              ├── routing_window.py (PyObjC 分流规则窗口, 独立进程)
                                              ├── log_window.py (PyObjC 日志窗口, NSTableView, 独立进程)
                                              └── system_proxy.py (macOS 系统代理 networksetup)
```

### Key Design Decisions
- **纯 Python 替代 xray-core**：公司安全软件（云壳）按二进制特征码拦截 xray-core、py2app、PyInstaller，因此用 asyncio + ssl 模块纯 Python 实现 SOCKS5 over TLS 协议，用 Nuitka 编译为原生二进制
- **纯 PyObjC 替代 rumps/tkinter**：所有 UI 窗口（状态栏、配置、分流、日志）均用纯 PyObjC 实现，不依赖 rumps 或 tkinter，避免 Nuitka 打包兼容性问题
- **代理协议流程**：本地应用 → 本地 SOCKS5(1080)/HTTP(1087) → TLS 连接远端 → SOCKS5 握手(用户名密码认证) → CONNECT → 双向 relay
- **UDP over TCP**：通过自定义帧协议在 TLS TCP 隧道中承载 UDP 数据，支持 UDP 代理
- **私有地址直连**：127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 等私有地址段不走代理，直接连接（可通过配置项关闭）
- **分流引擎**：内置 geosite/geoip 数据库（Xray/V2Ray 兼容格式），支持域名分流（geosite:tag）和 IP CIDR 分流（geoip:code），零外部依赖（自定义 protobuf 解析器）
- **UI 线程安全**：代理启动/停止在后台线程执行，UI 更新通过 PyObjC 的 `performSelectorOnMainThread` 调度回主线程
- **窗口作为独立进程**：配置/分流/日志窗口通过 `subprocess.Popen` 用系统 Python 启动（Nuitka 编译后 `sys.executable` 不是 Python 解释器），关闭后自动检测配置变化并重启代理
- **菜单状态独立刷新**：分流规则菜单的勾选状态（`routing_item.setState_`）仅反映 `config.data["routing"]["enabled"]`，与代理是否运行无关。配置窗口和分流窗口关闭时均调用 `_update_routing_check()` 刷新状态
- **Nuitka 构建后处理**：`build.sh` 自动重命名可执行文件、修正 Info.plist（CFBundleExecutable、LSUIElement 等）

### Reliability Architecture (v0.1.3+)
- **本地代理与隧道生命周期解耦**：本地 SOCKS5/HTTP 代理服务器独立运行，不受远端隧道状态影响。隧道断开时本地代理继续接受连接，隧道自动后台重连（指数退避，最长 60 秒）
- **隧道管理方法**：`_start_tunnel()`、`_stop_tunnel()`、`_tunnel_enabled()` 封装隧道生命周期，本地代理通过 `_tunnel_enabled()` 判断是否需要隧道
- **Health Check 健壮性**：通过 snapshot 避免 NPE（`tc = self.tunnel_client`），检测 non-retryable 状态（`occupied`/`auth_failed`）避免无意义重启循环
- **线程安全**：`proxy_core.py` 的 `stop()` 方法使用 `_stop_lock` 防止并发访问，内部状态先 snapshot 到局部变量再使用
- **系统唤醒处理**：`_ensure_local_proxy_after_wake()` 检测本地代理端口存活（socket 探测），`_ensure_tunnel_after_wake()` 检测隧道线程状态并恢复连接。即使本地代理需要重启，也会通过 `set_tunnel_client()` 重新关联隧道引用
- **配置变更智能重启**：仅 tunnel 配置变化时只重启隧道（`_reconnect_tunnel_only()`），其他配置变化才完整重启本地代理

## Android Client (`/android-client/`)

Android VPN 代理客户端，Kotlin + Jetpack Compose UI，通过 VpnService + tun2socks 原生库捕获全局流量，经本地 SOCKS5 服务器分流后走隧道或直接连接。当前版本 v0.1.3。

### Commands
- `npm run android:build` – 构建 debug APK 并复制为 `BlockProxyClient-android.apk`
- `npm run android:install` – adb 安装 `BlockProxyClient-android.apk`
- `npm run android:start` – 启动应用
- `npm run android:logcat` – 查看日志
- `npm run android:devices` – 列出 adb 设备
- `npm run test:android` – 运行单元测试
- `npm run test:android:emulator` – 运行仪器化测试（需模拟器）
- `npm run android:native:build` – 构建原生 .so 库（NDK）

### Build Prerequisites
- Android Studio + SDK (API 35, minSdk 26)
- NDK（通过 `ANDROID_NDK_HOME` 环境变量配置），`build-native.sh` 编译 tun2socks 原生库
- 首次构建需先 `npm run android:native:build` 生成 `jniLibs/` 下的 .so 文件
- ABI: `arm64-v8a`, `armeabi-v7a`, `x86_64`

### Architecture
```
VpnService TUN fd → tun2socks (native C, JNI) → 127.0.0.1:socksPort
                                                        ↓
                                                  LocalSocksServer
                                                        ↓
                                                  RoutingEngine
                                                   ↓ DIRECT    ↓ PROXY
                                             protected Socket  ForwardSession
                                                   ↓              ↓
                                               target host   tunnel server
```

**核心组件：**
- **BlockProxyVpnService** (`service/`) — VpnService 生命周期管理，START_STICKY + WakeLock + Foreground 通知。`setupTunnel()` 串联：加载配置/凭据 → 创建 RoutingEngine → establishVpnInterface → 启动 LocalSocksServer → Tun2Socks.start → 启动 TunnelClient
- **Tun2Socks** (`tun/`) — JNI 桥接层，Kotlin `object` 包装 native 调用。`start()` 通过 `ParcelFileDescriptor.detachFd()` 转移 fd 所有权给原生库。`setProtectCallback()` 注册 VpnService.protect() 回调（defense-in-depth）
- **tun2socks_jni.c** (`native/jni/`) — C JNI 桥接，spawns detached pthread 运行 `hev_socks5_tunnel_main_from_str()`。构建 YAML 配置字符串（tunnel MTU + socks5 address/port），JNI_OnLoad 缓存 JavaVM + VpnService.protect method ID
- **LocalSocksServer** (`socks/`) — 本地 SOCKS5 服务器，接受 tun2socks 转发的连接。每个 CONNECT 请求经 RoutingEngine 判断：DIRECT 走 ProtectedDirectConnector（VpnService.protect 绕过 VPN），PROXY 走 TunnelForwardConnector（通过 ForwardSessionRegistry 创建 ForwardSession）
- **RoutingEngine** (`routing/`) — 基于 geosite 数据库的域名分流。GeositeLoader 解析 geosite.dat（Xray/V2Ray 兼容格式），GeositeMatcher 支持 full/domain/plain/regex 四种匹配模式。RoutingConfig 从 DataStore 读取
- **TunnelClient** (`tunnel/`) — 管理 TLS 隧道连接池。ForwardSessionRegistry 管理 reqid（0x8000-0xFFFE），ReverseConnectHandler 处理远端反向连接请求
- **UI** (`ui/`) — Jetpack Compose 界面，ConfigScreen（服务器配置）、RoutingScreen（分流规则）、StatusCard（连接状态）。Navigation 通过 AppNavigation
- **StatusStore** (`status/`) — 全局 StateFlow 状态管理，TunnelStatus 枚举（Preparing/Connecting/Connected/Disconnected/Error）

### Key Design Decisions
- **VPN 路由循环防护**：主机制是 `addDisallowedApplication(packageName)`（内核级排除本应用所有 socket），defense-in-depth 是 `VpnService.protect()` 逐 socket 绕过
- **TUN fd 所有权转移**：`ParcelFileDescriptor.detachFd()` 将 fd 交给 native 库管理，onDestroy 中只在 fd 未 detach 时才 close
- **hev-socks5-tunnel 作为 git submodule**（`native/hev-socks5-tunnel/`，v2.15.0）：内含 lwip 用户态 TCP/IP 栈 + hev-task-system 协作式多任务，整个原生层仅一个 pthread
- **DataStore 持久化**：配置/凭据/分流规则均通过 Jetpack DataStore 存储，ConfigRepository/CredentialStore/RoutingConfigRepository 封装读写
- **WorkManager 看门狗**：TunnelWatchdogWorker 每 15 分钟检查隧道健康状态
- **SOCKS5 协议**：CONNECT 命令支持 ATYP_DOMAIN/IPv4/IPv6，用户名密码认证

## Important Notes
- **Testing 陷阱**: 通过代理请求 `127.0.0.1` 会被 AnyProxy 拦截返回管理页面。Mock Server 需绑定 `0.0.0.0` 并通过 LAN IP 访问
- SOCKS5 不支持 MAC 地址定向拦截（仅 HTTP 代理支持）
- 客户端必须安装 `cert/` 目录下的 AnyProxy 证书才能启用 HTTPS MITM（URL 路径过滤、广告重写）。未安装证书时，将 `enable_mitm` 设为 `"0"` 可切换为纯隧道转发模式，关闭所有 MITM 解密和拦截，零证书错误
- Docker 构建默认使用 npmmirror.com 镜像源
- iOS Safari 安全限制：带认证的代理不能和网关 IP 相同
- 路由表每 2 小时刷新；新设备可能需要手动刷新
- ACR 推送前需先 `docker login --username=hi50078584@aliyun.com crpi-x1zji86f6jpcd7t1.cn-hangzhou.personal.cr.aliyuncs.com`
- **Android 构建顺序**：修改 native C 代码后需先 `npm run android:native:build` 重新编译 .so，再 `npm run android:build` 打包 APK
- **Android logcat 调试**：`npm run android:logcat` 过滤 BlockProxy/Tunnel/AndroidRuntime 标签，崩溃堆栈在 AndroidRuntime 中

# Project Rules & Skills

### Local Skills (`.claude/skills/`)

通过 `/skill-name` 或 `Skill` 工具调用：

- **`/commit`** — 智能 Git 提交。分析变更、自动暂存、生成 Conventional Commit 消息（英文类型 + 中文正文），执行提交
- **`/build-client`** — 构建 macOS 客户端（仅本地，不升级版本号）。自动检测架构，输出 `client/dist/BlockProxyClient.app` 和 `.zip`
- **`/release-client`** — 构建并发布 macOS 客户端到 GitHub Release。自动 patch +1 版本号，支持多架构
- **`/icon_generate`** — 生成状态栏 bar 图标。将源图标白色区域镂空为透明，缩放至 44x44 @ 144 DPI
- **`/pcap-analyse`** — 分析 pcap/pcapng 网络抓包文件。专注代理场景的连接诊断、性能评估和异常检测，使用 scapy 或 tshark

### Project Rules

- **CLI 入口**: 全局命令 `block-proxy` 注册在 `bin/start.js`，通过 `npm i -g` 安装后可直接调用
- **config.json** 是运行时配置文件（非源码），由 `proxy/fs.js` 管理读写和备份，不在 git 中追踪变更
