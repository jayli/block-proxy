# CLAUDE.md

This file provides guidance to Claude Code (and other agents via the AGENTS.md symlink) when working with code in this repository.

## Common Commands

### Development
- `pnpm i` – 安装依赖 (pnpm preferred)
- `npm run dev` – 即 `BLOCK_PROXY_DEV=1 npm run express`：全栈（Express + proxy + SOCKS5 + tunnel），且 Express 启动后会自动 spawn `npm run craco`（React dev server :3000, `/api` → 8004），无需另开终端；该变量只在 `server/express.js` 里读取
- `npm run start` / `npm run express` – 后端 + 代理（生产）；`npm run proxy` / `npm run socks5` – 仅代理 / 仅 SOCKS5

### Testing
- `npm run test:proxy-core` – proxy-core 连接测试（无需代理服务）；`npm run test:proxy` – 代理连通性/性能/吞吐量测试（即 `node test/run.js`，默认连 127.0.0.1:8001/8002、认证 admin/admin，需先启动代理；加 `-- --auto-start` 自动拉起、`-- --skip-external` 跳过外网站点）；`npm run test:public-proxy` – 8002 公网代理协议分发测试（SOCKS5 / HTTP CONNECT over TLS）
- `npm run test:registry` / `npm run test:mitm-runtime` – MITM 规则注册 / 运行时测试
- `npm run test:access-logger` – 访问日志单元测试 + 与真实代理钩子的集成测试
- `npm run test:temp-credentials` – 临时代理凭据单元测试（生成/过期/撤销/20 条裁剪）
- `npm run test:auth-bypass` – 认证豁免白名单单元测试（内置只读/临时读写/合并去重/fail-closed/loadConfig 刷新）
- `npm run test:lan-scan` – 局域网设备表扫描单元测试（网段过滤/邻居表解析/MAC 归一化/全量替换语义）
- `npm run test:android` – Android phone flavor 单元测试；`npm run test:android:emulator` – 仪器化测试
- 单类测试: `cd android-client && ./gradlew :app:testPhoneDebugUnitTest --tests '*ClassName'`
- `npm run test` – React 前端测试 (react-scripts test)
- 其余单测按文件名后缀分两种风格，别混用：`*.test.js`（`tunnel/test/*`、`test/tunnel-integration.test.js`、`test/timestamp-console.test.js`）是 `node:test`，用 `node --test <file>` 跑（如 `node --test tunnel/test/protocol.test.js`）；`test/*-tests.js` 是自带断言的普通 Node 脚本，直接 `node test/<file>.js`（没有 npm 脚本的有 `fd-diagnostics-` / `proxy-core-cert-lifecycle-` / `server-config-validation-` / `socks5-server-limits-tests.js`）；`socks5-server-limits-tests.js` 偶发未捕获的 `read ECONNRESET` 导致退出码 1（2026-10-09 实测 10 次里 2 次，疑似服务端销毁连接的竞态下测试客户端 socket 没挂 `error` 监听），重跑即过，别当成自己改动引入的回归

### Utilities
- `npm run rm_bkconfig` – 删除备份配置；`npm run gen-icons` / `npm run watch:icons` – 生成/监听客户端图标

### macOS Client (`/client/`)
- `npm run client:build` – 构建客户端（自动检测架构, 输出 `client/dist/`）；`bash build.sh` – Nuitka 构建 .app（`dist/BlockProxyClient.app` + `BlockProxyClient-macos-<arch>.zip`）；前置: `fileicon`（brew install fileicon）
- `python main.py` – 直接运行（开发模式）；`cd client && pytest tests/` – 单元测试；删除 `icons/app.icns` 后 `build.sh` 可强制重建应用图标

### Android (`/android-client/`)
- `npm run android:build[:phone|:emulator]` – 构建 phone/emulator debug APK（phone 仅 arm / emulator 全 ABI）
- `npm run android:install` / `npm run android:install:emulator` – adb 安装（后者装到 emulator-5554）；`android:start` / `android:logcat` / `android:devices` – 启动 / 日志 / 设备
- APK 输出: `app/build/outputs/apk/phone|emulator/debug/`，命名自动区分 flavor
- `npm run android:native:build` – 构建 hev-socks5-tunnel + tun2socks .so（需 ANDROID_NDK_HOME）
- `npm run android:release:upload -- <tag>` – 构建 phone debug APK 并上传 GitHub Release
- **构建前提**: SDK 35, minSdk 23, targetSdk 35；首次需 `git submodule update --init --recursive` 后 `android:native:build`

### Build & Deploy
- `npm run build` – React frontend → `/build/`（会先删 `config_backup.json`）。**`build/` 被 git 跟踪**：Express 直接托管它，npm 包只发 `build/` 不发 `src/`，所以改了 `src/` 要重新 build 并把 `build/` 一并提交（近期后台界面相关提交都带着 `build/`）
- `npm run docker:build` / `docker:build:arm` – 单架构镜像；`docker:push` – amd64+arm64 双架构推送 ACR（另有 `docker:push:amd64` / `docker:push:arm64`）
- `block-proxy` / `block-proxy -c rule.js` – 全局 CLI（失败自动重启, 3s delay, max 10000）；`block-proxy --pubkey <path> --privkey <path>` – 指定隧道 TLS 证书

## Architecture

MITM proxy for parental control & ad blocking. Node.js + React + proxy-core (AnyProxy fork). 可运行于 OpenWRT 路由器或 Docker.

### Ports
| 端口 | 用途 |
| --- | --- |
| 8001 | 内网 HTTP proxy (mandatory, proxy-core) |
| 8002 | 公网代理 SOCKS5 / HTTP CONNECT over TLS (optional, 同端口按首字节分发) |
| 8003 | Tunnel server (reverse tunnel, HTTP/2 + allowHTTP1) |
| 8004 | Express admin API |
| 3000 | React dev server (dev only) |

### Entry Points
- **Primary**: `bin/start.js` (CLI) → `server/start.js` → proxy-only or full stack
- **Proxy-only**: `proxy/start.js` → `proxy/proxy.js`
- **Dev**: `npm run dev` → full stack with dev flag

### Request Flow
Client → HTTP Proxy (8001) → proxy-core → MITM → Target；SOCKS5 / HTTP CONNECT (8002, TLS) → 认证 → CONNECT → 8001；Tunnel xhttp (8003) → 8001

### Core Components
- **Proxy** (`/proxy/`) – `proxy.js` 入口, `attacker.js` 拦截判断, `domain.js` host 匹配, `fs.js` config 读写备份, `scan.js` 每 2h 扫描局域网设备表(状态与并发去重), 实际扫描在 `lan-scan.js`(原生 UDP 探测 + 内核邻居表解析, 不依赖 arp/ping 命令; 只扫 10/8 与 192.168/16 且排除 172.*, 全量替换而非追加), `mitm/rule.js` 规则 + 响应修改器(YouTube 去广告/有道 VIP), `http.js` HTTP 助手, `monitor.js` 系统指标, `operator.js` 管理路由, `wanip.js` 公网 IP, `access-logger.js` 访问日志(按 MAC 记录被监控设备访问其拦截域名), `temp-credentials.js` 临时代理凭据(7 天有效, 仅 8001/8002), `auth-bypass-hosts.js` 认证豁免白名单(内置 auth_bypass_hosts.json 只读 + 临时 temp_auth_bypass_hosts.json 可增删, 仅 8001), `fd-diagnostics.js` fd/TCP 诊断; `mitm/` 另含 `registry.js`(规则注册), `persistentStore.js`, `uaFilter.js`, `ydcd/`, `youtube/`
- **Proxy-Core** (`/proxy/proxy-core/`) – AnyProxy fork 本地模块（非 npm 依赖）: `proxy-server.js`(入口), `index.js`, `request-handler.js`(HTTP/S/WS 转发核心, 1126 行), `https-server-mgr.js`(SNI+IP HTTPS, LRU 1000), `cert-lifecycle.js`(预热/并发去重/健康检查), `cert-mgr.js`, `util.js`, `log.js`, `rule-default.js`, `request-error-handler.js`(内联错误页), `ws-server-mgr.js`(WS 服务器工厂)
  - 证书存储: `~/.anyproxy` → 项目本地 `certificates/`；`X-Tunnel-Relay: 1` 头注入 tunnel CONNECT 响应
  - ECONNRESET/EPIPE 自动重试一次 (GET/HEAD/OPTIONS)；keep-alive `maxRequestsPerSocket: 50` 防 gRPC RST_STREAM；流式响应阈值 20MB (无 responseRules 时 64KB)
  - 剥离 MITM 响应中的 `Alt-Svc` 头，防止客户端学到 h3/QUIC 入口绕过 TCP 代理
- **SOCKS5** (`/socks5/`) – 8002 公网代理端口，SOCKS5 over TLS + UDP over TCP(自定义帧) + HTTP CONNECT over TLS: `server.js`(含 `createPublicProxyHandler` 首字节协议分发、`createHttpConnectHandler` HTTP CONNECT 隧道), `start.js`, `test_tls_reuse.js`; 客户端 `client/proxy_core.py` (asyncio 实现)
- **Tunnel** (`/tunnel/`) – xhttp 传输协议（HTTP POST 上行 + SSE 下行）: `server.js`(HTTP/2 入口), `xhttpHandler.js`(核心处理器), `uploadQueue.js`(上行帧重排序), `protocol.js`(帧编解码), `manager.js`(连接生命周期), `sseControl.js`(旧 SSE 适配), `disguiseResponse.js`(HTTPS 伪装)
- **Server** (`/server/`) – Express API (8004), 托管 React build, token cookie 认证: `start.js`, `express.js`, `timestampConsole.js`, `util.js`
- **Frontend** (`/src/`) – CRA + CRACO 管理界面, `App.js` 主组件
- **CLI** (`/bin/start.js`) – 全局入口, 失败自动重启, 退出清理全局配置
- **Certs** (`/cert/`) – MITM 根证书 `rootCA.key`/`rootCA.crt` **不进 git、不进 npm 包**，由本机生成：`startProxyServer()` 先调 `cert/generator.js#ensureRootCA()`（缺失或残缺就重新生成一对，30 年 RSA-2048，私钥 0600），再由 `proxy.js#ensureRootCA()` 按 SHA-256 指纹同步到 `certificates/`（根证书变了会清空已签发的域名证书缓存）；也可手动 `node cert/generator.js`，全新克隆里的测试靠 `test/helpers/ensure-root-ca.js` 补齐。Docker 镜像不内置根证书，要跨容器重建保留同一把 CA 须挂载 `/app/cert`。隧道 TLS 默认复用 `cert/socks5_tls.{crt,key}`（缺失时 `ensureTempCert` 自签 ECC P-256）
- **Config** (`config.json`) – 运行时配置（见下）；**Test Suite** (`/test/`) – `run.js` 一键测试(自动启动 Mock Server), `proxy-tests.js`, `proxy-core-connect-tests.js` 及隧道/MITM/fd/socks5 单测
- **Docs** (`/docs/`) – `tunnel-testing.md`, `android-client-deployment.md`, `ios-client-deployment.md`, `plans/` 与 `superpowers/{specs,plans}/`(设计与实施记录, 命名 `YYYY-MM-DD-<主题>-design/implementation.md`)；根目录 `Useage.md` 为完整用户手册（服务端部署/证书安装/客户端使用）

### Config (`config.json`)

运行时配置，由 `proxy/fs.js` 读写并备份到 `config_backup.json`；本地没有 `config.json`（已 gitignore）时由 `proxy/proxy.js#loadConfig()` 按默认值写出。新增配置项：默认值与读取逻辑改 `loadConfig()`（默认对象 + 已有配置分支 + 无配置文件分支），**必填**项还要登记到 `server/express.js` 的 `REQUIRED_FIELDS`（配置导入校验，老配置缺字段在 `validateImportedConfig()` 里补默认值；`access_log`/`tunnel_padding`/`mitm_debug_log` 等可选项不在其中）。`block-proxy -c rule.js` 的规则路径经 `config.json` 的 `config_file` 字段（`fs.setGlobalConfigFile`）传给子进程，`proxy.js#loadGlobalConfigFile()` 读取后立即清除（一次性消费，只留在内存的 `cliRulePath`），CLI 退出时也会兜底清除:
- 端口/开关: `proxy_port`, `socks5_port`, `express_port`, `enable_express`, `enable_socks5`, `enable_tunnel`, `enable_mitm`/`mitm_debug_log`/`socks5_tls`("0"/"1")
- 认证: `auth_username`/`auth_password`（代理/SOCKS5/隧道共用）, `login_username`/`login_password`（管理面板登录，两者独立）
- 临时凭据: 不在 `config.json` 里，存于根目录 `temp_credentials.json`（已 gitignore）—— 8004 后台按钮生成，固定 7 天有效，最多保留最新 20 组，作为 `auth_username`/`auth_password` 的平替；**仅 8001 内网 HTTP 与 8002 公网 SOCKS5/HTTP CONNECT 生效，隧道 8003 不接入**（客户端 App 用不了）；由 `proxy/temp-credentials.js` 管理，认证时按 mtime 缓存读盘
- 认证豁免白名单: 分两份——内置 `auth_bypass_hosts.json`（**随 git 提交**，后台只展示不可改）+ 临时 `temp_auth_bypass_hosts.json`（已 gitignore，8004 后台「认证豁免白名单」tab 可自由增删）；结构均为 `{"hosts": [...]}`，两者合并去重后生效（内置优先）；命中名单的 host 免代理认证（不回 407），用于收到 407 后不带凭据重试就直接失败的 app（E听说/小红书/知乎等）；由 `proxy/auth-bypass-hosts.js` 管理（fail-closed：文件缺失/损坏按空名单；临时文件不存在不告警），`proxy/proxy.js` 在 `loadConfig()` 时读入 `authPassHosts`，**重启代理才生效**；**仅 8001 内网 HTTP 代理生效**（8002 公网代理有独立认证逻辑，不读本名单）
- 拦截/设备: `block_hosts[]`, `devices[]`, `rule_modules{}`
- 访问日志: `access_log: { enabled("0"/"1"), dir(默认 logs/access), max_total_bytes(默认 50MB), flush_interval_ms(默认 1000) }` —— 记录 `block_hosts` 中按 `filter_mac` 配置的设备访问其对应拦截域名的请求(时间/IP/MAC/协议/方法/域名/path)，按天分片滚动，总量超限删最旧分片；请求路径仅内存入队，磁盘 IO 全在异步 flush
- 隧道: `tunnel_port`, `tunnel_domains[]`, `tunnel_xhttp_base_path`("/xhttp"), `tunnel_sse_path`("/api/v1/events"), `tunnel_sse_keepalive_min_ms`/`max_ms`(20000/25000), `tunnel_silent_idle_timeout`(3000), `tunnel_rotation_drain_timeout`(10), `tunnel_rotation_drain_idle_timeout`(20), `tunnel_padding: { enabled, probability, min_bytes, max_bytes }`(默认 false)
- 链式代理: `chain_proxy_enabled`, `chain_proxy_type`(http/socks5), `chain_proxy_address`([user:pass@]host:port)
- 其他: `your_domain`, `vpn_proxy`, `network_scanning_status`, `progress_time_stamp`

### MITM 规则系统

两套互相独立的机制，别混用字段：
- **拦截规则**：`config.json` 的 `block_hosts[]`（后台 UI 维护，`src/App.js`），条目 `{ filter_host, filter_match_rule, filter_start_time, filter_end_time, filter_weekday, filter_mac }`，由 `proxy.js#shouldBlockHost()` 判定（host 子串 + URL 正则 + 时间段 + 周几 + MAC，MAC 仅 HTTP 代理）。
- **MITM 改写规则**（回调式）：规则组 `{ 组名: [ { type: 'beforeSendRequest'|'beforeSendResponse', host, regexp, callback(url, request, response) } ] }`（也可写成 `{ name, description, rules }`），范例见 `example/rule.js`；`callback` 返回含 `response` 的对象，不处理就原样返回原 response。`proxy/mitm/registry.js` 合并三个来源，**同名组后者覆盖前者**：内置 `proxy/mitm/rule.js` < CLI `block-proxy -c rule.js` < Docker 挂载的 `config/rule.js`；单个组可由 `config.rule_modules["<source>:<组名>"] = false` 关闭（如 `builtin:Youtube`）；每次启动/重启代理前 `rebuildRuleRegistry()` 重建。HTTPS 要客户端装了根证书且 `enable_mitm`="1" 才会被解密并进入回调，明文 HTTP 不受影响。

### Tunnel 协议要点

- 会话: `POST /xhttp/create`（body 为 AUTH 帧, 含 username/password/capabilities/clientId）→ `{ sessionId, capabilities }`；创建后 15s 未建立 SSE 自动清理；同 token 新会话占用返回 409（60s takeover 宽限）
- 上行: `POST /xhttp/upload/:sessionId/:seq`（seq 递增）；下行: `GET /xhttp/stream?token=...`（SSE 长连接, 帧 base64 编码于 `event: frame`）；SSE keepalive 20~25s 随机注释行
- token = SHA-256(username:password)；能力协商: `padding`(CAP_PADDING) / `upload-batch-v1`(CAP_UPLOAD_BATCH) / `upload-h2-v1`(CAP_UPLOAD_H2)
- PONG 探测: 缺失 PONG 时 10s 后补发 PING（最多 10 次），超限复用 liveness-timeout (90s) 关闭会话
- reqid: 反向 (server→client) 0x0001–0x7FFF / 正向 (client→server) 0x8000–0xFFFE
- UploadQueue: min-heap 按 seq 重排序, 乱序缓冲 64 帧, 单 POST body 上限约 70KB
- Padding: 协商后 DATA 帧有概率追加 PADDING 帧（64~512 字节）+ 响应头随机 `X-Padding`; 服务端默认关闭（`tunnel_padding.enabled`, probability 0.3）
- 并发限制: forward/reverse 各默认 200, reverse CONNECT 30s, 空闲 5min；连接轮换 drain 10s + idle 20s
- 无 WebSocket upgrade 握手, 流量特征与常规 HTTP API 无异；旧 SSE 路径 (`sseControl.js`) 仅返回 410 迁移提示

### 部署与环境

OpenWRT `--network=host` | Docker Node 18 Alpine 多阶段构建（npmmirror 源）；运行时依赖在 `dependencies`, 仅 `@craco/craco` 在 `devDependencies`

## macOS Client (`/client/`)

Pure Python（PyObjC UI + asyncio proxy core），Nuitka 编译原生二进制。v0.1.6。

```
main.py (入口, 单实例, 崩溃重启) → app.py (PyObjC 状态栏)
  ├── proxy_core.py (asyncio SOCKS5/HTTP + UDP over TCP) / tunnel_client.py (xhttp 隧道 + 自动重连) / health_policy.py (健康检查重启窗口守卫)
  ├── node_connect.py (节点连接: DoH 解析 → 多 IP 尝试 → TLS SNI 被安全软件拦截时降级不发 SNI, cert pin TOFU)
  ├── routing.py / geodata_loader.py / proto_parser.py (geosite/geoip 分流) / doh_resolver.py (DoH 解析节点)
  ├── super_dns_control.py / super_dns_window.py (Super DNS 域名管理)
  ├── config.py (~/Library/Application Support/BlockProxyClient/) + config_window.py / routing_window.py / log_window.py (PyObjC 独立进程)
  ├── autostart.py (LaunchAgent) / logger.py (访问/崩溃日志) / system_proxy.py (networksetup)
  └── traffic_stats.py / traffic_view.py / requirements.txt / watch-icons.js / scripts/ / geodata/ / tests/
```

功能/约束要点:
- 纯 Python 替代 xray-core、纯 PyObjC 替代 rumps/tkinter（公司安全软件按二进制特征码拦截）
- 本地代理与隧道生命周期解耦: 隧道断开本地代理继续运行, 后台重连；仅 tunnel 配置变化时只重启隧道
- 私有地址直连 (127/8, 10/8, 172.16/12, 192.168/16), 可配置关闭；三种上游模式: SOCKS5 over TLS / HTTP CONNECT / UDP ASSOCIATE
- DoH 解析节点: 默认 `dns.alidns.com` + bootstrap `223.5.5.5,223.6.6.6`
- 窗口为独立进程（Nuitka 编译后 `sys.executable` 非 Python 解释器, 用 `subprocess.Popen` + 系统 Python）
- 系统唤醒恢复: socket 探测端口存活 + 隧道线程状态恢复, 等 3s 网络稳定后重试
- Nuitka 构建后处理: `build.sh` 自动重命名可执行文件、修正 Info.plist (CFBundleExecutable, LSUIElement)；状态栏图标始终 `setTemplate_(True)`（单色黑+alpha, 系统按浅/深色模式自动反白, 兼容 Tahoe Liquid Glass）
- **build.sh 模块清单**: `--include-data-files` 逐个列出顶层 .py（编译后窗口子进程用系统 Python 读同级源码），新增顶层模块必须同步加入，否则编译产物运行时才报 ModuleNotFoundError；`tests/test_build_script.py` 强制遍历校验
- **版本号三处同步**: `client/VERSION`、`client/build.sh`（`VERSION=`）、`client/app.py`（`版本：vX.Y.Z`）

## Android Client (`/android-client/`)

Kotlin + Jetpack Compose + VpnService + tun2socks (JNI) + xhttp 传输。v0.1.6 (versionCode 3)。

流程: VpnService TUN fd → tun2socks → LocalSocksServer → RoutingEngine → DIRECT(protected Socket) / PROXY(ForwardSession → TunnelClient → XhttpSession → XhttpTransport)

### 模块 (`app/src/main/java/com/blockproxy/android/`)
- `cdn/` – CDN IP 池: `CfCdnConfig`(NONE/Cloudflare/Aliyun), `CfIpDns`, `CfIpPool`, `CfIpSelector`, `CfIpRefreshWorker`, `CfIpRuntimeRegistry`, `CfIpSpeedTester`
- `doh/` – `DohConfig` + `DohDns`（OkHttp Dns override, `dns.alidns.com`）；`tun/` – `Tun2Socks.kt`, `Tun2SocksMapDnsConfig.kt`
- `socks/` – `LocalSocksServer`, `SocksSession`, `SocksConnectors`, `SocksProtocol`, `TlsClientHelloParser`, `TrafficSniffer`, `DomainMappingStore`, `HostnameValidator`, `HttpHostParser`
- `tunnel/` – 传输层: `TunnelClient`(生命周期/自动重连/轮换), `TunnelTransportFactory`, `XhttpSession`(POST /xhttp/create), `XhttpTransport`(SSE 下行 + POST 上行, idle watchdog 90s + 15s 重连窗口), `XhttpUploadClient`(OkHttp/NativeUtls, uTLS 失败回退), `XhttpUploadScheduler`, `GomobileUtlsPostClient`(utlsws AAR 反射), `Frame`/`FrameCodec`/`FrameSender`, `PaddingInjector`
- `tunnel/` – 连接管理: `ForwardSession`/`ForwardSessionRegistry`(正向 CONNECT), `ReverseConnectHandler`(反向 CONNECT 双向中继), `ForwardAdmissionController`(12 全局 + 每目标 4), `TunnelRotationPolicy`(1~2h), `TargetSocket`/`RealTargetSocket`(支持 VpnService.protect)
- `routing/` – `RoutingEngine`, `GeositeLoader`, `GeositeMatcher`, `ProtoParser`, `RouteDecision`, `DomainRule`
- `service/` – `BlockProxyVpnService`, `TunnelServiceController`, `TunnelNotification`, `TunnelWatchdogWorker`, `BootRestartReceiver`, `BootRestoreRetryPolicy`
- `ui/` – Compose 界面 + `TunnelViewModel`, `RoutingViewModel`, `NetworkInfoCard`, `SlideButton`, `SliderStateMachine`
- `status/` – `StatusStore`(全局 StateFlow), `TunnelStatus`；`diagnostics/` – `TunnelDiagnosticsLog`；`util/` – `NetworkInfoManager`, `TlsTester`；`config/` – `ConfigRepository`, `CredentialStore`, `ClientIdentityStore`, `RoutingConfig(Repository)`, `ServerConfig`
- 根目录: `BlockProxyApplication.kt`, `MainActivity.kt`, `CrashReportActivity.kt`

约束要点:
- VPN 循环防护: `addDisallowedApplication` 内核级排除 + `VpnService.protect()` 逐 socket defense-in-depth；fd 所有权转移 `detachFd()`（onDestroy 仅在未 detach 时 close）
- hev-socks5-tunnel 为 git submodule (`native/hev-socks5-tunnel/`, v2.15.0): lwip 用户态 TCP/IP, 仅一个 pthread；`tun2socks_jni.c` spawns detached pthread, JNI_OnLoad 缓存 JavaVM + protect method ID
- minSdk 23 + Core Library Desugaring (`desugar_jdk_libs:2.1.5`), Java 17；DataStore 持久化配置/凭据/分流 + WorkManager Watchdog (15min)
- CF/CDN IP 轮换: SSE 与 upload 各自独立 `CfIpDns`+`CfIpSelector`, `forceNextOnNextLookup()` 切换 IP; `CfIpRefreshWorker` 定期刷新 IP 池; `CfIpRuntimeRegistry` 支持 protect 回调绕过 VPN; 支持 Cloudflare 与 Aliyun CDN 边缘 IP
- 连接轮换: 每 1~2h 随机建立新 xhttp session 刷新 NAT 映射, 旧连接 draining (drain 10s + idle 20s)
- 状态机: `StatusStore` StateFlow (Preparing/Connecting/Connected/Disconnected/Error)；logcat 崩溃堆栈在 AndroidRuntime

## 重要约束 (Important Notes)

- **Testing 陷阱**: 经代理请求 `127.0.0.1` 会被 AnyProxy 拦截返回管理页, Mock Server 需绑 `0.0.0.0` 并经 LAN IP 访问
- SOCKS5 与 8002 的 HTTP CONNECT 均不支持 MAC 定向拦截（来源 IP 为服务端本机）；未装证书时设 `enable_mitm`="0" 切纯隧道模式；iOS Safari 带认证代理不能与网关 IP 相同
- 路由表每 2h 刷新；`config_backup.json` 备份配置（`npm run rm_bkconfig` 删除）
- Android 仪器化测试: `npm run test:android:emulator` 会自动 unset 代理环境变量, 避免测试流量走代理
- **Android 构建顺序**: 改 native C 后先 `android:native:build` 再 `android:build`；`utlsws` AAR 用 `native/utlsws/build-aar.sh`（gomobile）单独构建
- **Android 发布**: `npm run android:release:upload -- <tag>` 自动构建 phone debug APK 上传；勿上传未签名 release APK
- ACR 推送前先 `docker login --username=hi50078584@aliyun.com crpi-x1zji86f6jpcd7t1.cn-hangzhou.personal.cr.aliyuncs.com`
- CLI 自定义证书: `block-proxy --pubkey/--privkey <path>`（`TUNNEL_PUBKEY`/`TUNNEL_PRIVKEY` 环境变量）；链式代理经 `chain_proxy_*` 配置全部流量转上游
- **非本项目 / 不在本仓库的内容**: iOS 客户端源码不在本仓库（`docs/ios-client-deployment.md`、`docs/superpowers/*/2026-07-03-ios-client-*`、`.npmignore` 里的 `ios-client/` 都是遗留，本仓库 git 历史里没有该目录）；`litellm_custom_provider/` 是与代理无关的独立 Python LiteLLM provider，改代理时忽略；`tools/tcpdump/output.pcap` 是约 9.5MB 的样例抓包（勿整个读入，分析走 `pcap-analyse` skill），`tools/speed_test.sh` 经本地 SOCKS5 `127.0.0.1:1081` 测速

## Project Skills (`.claude/skills/`)

调用方式 `$skill-name` 或按描述自动触发: `build-client`(构建 macOS 客户端), `release-client`(发布 GitHub Release), `icon-generate`(状态栏图标 44x44 @ 144 DPI), `pcap-analyse`(分析 pcap/pcapng)。

## Project Rules

- `config.json` 是运行时配置（非源码），由 `proxy/fs.js` 管理，不追踪 git 变更
- 提交信息用 Conventional Commits + 中文描述（如 `feat(client): ...` / `fix(proxy-core): ...`），跟随 git log 现有风格
- 代码修改后等用户验证确认再提交，不自动 git add/commit/push
