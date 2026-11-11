# CLAUDE.md

This file provides guidance to Claude Code (and other agents via the AGENTS.md symlink) when working with code in this repository.

## Common Commands

### Development
- `pnpm i` – 安装依赖 (pnpm preferred)
- `npm run dev` – 即 `BLOCK_PROXY_DEV=1 npm run express`（跑的是 `server/start.js`，所以开关仍看 `config.json`）：Express 启动后会自动 spawn `npm run craco`（React dev server :3000，`/api` 经 `craco.config.js` 以 HTTPS + 忽略证书校验转发到 8004），无需另开终端；`BLOCK_PROXY_DEV` 只在 `server/express.js` 里读取。后台面板固定 HTTPS，首次访问是自签证书警告
- `npm run start` / `npm run express` – 后端 + 代理（生产）；`npm run proxy` / `npm run socks5` – 仅代理 / 仅 SOCKS5
- `server/start.js` 的分流很容易踩：`enable_express` 为 "1" 时开面板（`express.js` 内部再 `LocalProxy.init()`）；**否则只起 proxy**，SOCKS5 是独立开关（`enable_socks5`）

### Testing
单跑一个用例的写法（这仓库没有统一测试入口，按下面的风格选）：
```bash
node --test --test-name-pattern="wildcard" 'test/cert-lifecycle/*.js'   # node:test，按用例名过滤
cd client && python3 -m pytest tests/test_proxy_core_unified_port.py::test_default_local_port_is_single_1080 -q
cd android-client && ./gradlew :app:testPhoneDebugUnitTest --tests '*CfIpPoolTest'
```

- `npm run test:proxy-core` – proxy-core 连接测试（无需代理服务）；`npm run test:proxy` – 代理连通性/性能/吞吐量测试（即 `node test/run.js`，默认连 127.0.0.1:8001/8002、认证 admin/admin，需先启动代理；加 `-- --auto-start` 自动拉起、`-- --skip-external` 跳过外网站点；参数还有 `--http-port`/`--socks5-port`/`--http-user`/`--http-pass`）；`npm run test:public-proxy` – 8002 公网代理测试（`public-proxy-protocol-tests.js` 首字节分发 / SOCKS5 / HTTP CONNECT，`public-proxy-h2-tests.js` ALPN h2 多路复用与回退）；**这两个测试直接 `readFileSync('cert/socks5_tls.{crt,key}')`**，而这对证书是 gitignore 的运行时产物，全新克隆里必须先启动一次代理（或手动生成）否则 ENOENT
- `npm run test:registry` / `npm run test:mitm-runtime` – MITM 规则注册 / 运行时测试
- `npm run test:access-logger` – 访问日志单元测试 + 与真实代理钩子的集成测试
- `npm run test:visit-logger` – 访问足迹日志（按 MAC 记录访问过的全部域名）单元测试 + 集成测试
- `npm run test:temp-credentials` – 临时代理凭据单元测试（生成/过期/撤销/用户名单词不重复/20 条裁剪）
- `npm run test:auth-bypass` – 认证豁免白名单单元测试（内置只读/临时读写/合并去重/fail-closed/loadConfig 刷新）
- `npm run test:lan-scan` – 局域网设备表扫描单元测试（网段过滤/邻居表解析/MAC 归一化/全量替换语义）
- `npm run test:android` – Android phone flavor 单元测试；`npm run test:android:emulator` – 仪器化测试
- **`npm test`（react-scripts test）当前跑不起来，别拿它当验证**：`src/setupTests.js` 依赖的 `@testing-library/jest-dom`、`App.test.js` 依赖的 `@testing-library/react` 都不在 `package.json` 里，且 `App.test.js` 断言的 “learn react” 文案早已不在 `App.js`。前端改动只能靠 `npm run build` + 手动看页面（且记得把重建后的 `build/` 一起改）
- 其余单测按文件名后缀分两种风格，别混用：
  - `node:test` 风格（`tunnel/test/*.js`、`test/tunnel-integration.test.js`、`test/timestamp-console.test.js`、`test/host-match-tests.js`、`test/cert-lifecycle/*.js`）用 `node --test <file>`；**不要传目录**（`node --test tunnel/test/` 在 Node 26 会把目录当模块 require → MODULE_NOT_FOUND），要引号包住 glob 让 node 自己展开：`node --test 'tunnel/test/*.js'`（86 项）、`node --test 'test/cert-lifecycle/*.js'`；裸 `node --test` 在仓库根会顺带跑 `src/App.test.js` 和 `test/run.js` 并失败，别用
  - 自带断言的普通 Node 脚本（其余 `test/*-tests.js`）直接 `node test/<file>.js`；没有 npm 别名的有 `fd-diagnostics-` / `express-tls-` / `http-auth-switch-` / `proxy-core-cert-lifecycle-` / `server-config-validation-` / `socks5-ipv6-` / `socks5-server-limits-` / `tunnel-forward-idle-config-tests.js`
  - `socks5-server-limits-tests.js` 偶发未捕获的 `read ECONNRESET` 导致退出码 1（2026-10-09 实测 10 次里 2 次，疑似服务端销毁连接的竞态下测试客户端 socket 没挂 `error` 监听），重跑即过，别当成自己改动引入的回归

### Utilities
- `npm run rm_bkconfig` – 删除备份配置；`npm run gen-icons` / `npm run watch:icons` – 生成/监听客户端图标

### macOS Client (`/client/`)
- `npm run client:build` – 构建客户端（自动检测架构, 输出 `client/dist/`）；`bash build.sh` – Nuitka 构建 .app（`dist/BlockProxyClient.app` + `BlockProxyClient-macos-<arch>.zip`）；前置: `fileicon`（brew install fileicon）
- `python main.py` – 直接运行（开发模式）；`cd client && python3 -m pytest tests/` – 单元测试（550 项，约 16s）；`cd client && python3 tests/smoke_settings_window.py` – PyObjC 真窗口冒烟（不进 pytest，需要真实 GUI 会话）；删除 `icons/app.icns` 后 `build.sh` 可强制重建应用图标

### Android (`/android-client/`)
- `npm run android:build[:phone|:emulator]` – 构建 phone/emulator debug APK（phone 仅 arm / emulator 全 ABI）
- `npm run android:install` / `npm run android:install:emulator` – adb 安装（后者装到 emulator-5554）；`android:start` / `android:logcat` / `android:devices` – 启动 / 日志 / 设备
- APK 输出: `app/build/outputs/apk/{phone,emulator}/debug/`（文件名见下方「重要约束」）
- `npm run android:native:build` – 构建 hev-socks5-tunnel + tun2socks .so（需 ANDROID_NDK_HOME）
- `npm run android:release:upload -- <tag>` – 构建 phone debug APK 并上传 GitHub Release
- **构建前提**: SDK 35, minSdk 23, targetSdk 35（`local.properties` 里的 `sdk.dir` 是本机路径，gitignore）
- 预编译 `.so` 已随仓库提交（`app/src/main/jniLibs/{arm64-v8a,x86_64}/lib{hev-socks5-tunnel,tun2socks}.so`），只改 Kotlin 时**不需要**跑 native 构建；`.gitmodules` 虽声明了 `native/hev-socks5-tunnel`，但索引里没有对应 gitlink、目录也不在树里，所以 `git submodule update --init` 是空操作——要改 C 才得先补上 submodule（`build-native.sh` 找不到 `native/hev-socks5-tunnel/Android.mk` 会直接报错退出）
- `utlsws` AAR（`app/libs/utlsws.aar`，由 `native/utlsws/build-aar.sh` 用 gomobile 生成）被 gitignore、不在仓库里；`GomobileUtlsPostClient.createOrNull()` 通过 `Class.forName("utlsws.Utlsws")` 反射加载，缺 AAR 时返回 null，`TunnelClient` 就直接用 `OkHttpXhttpUploadClient`（uTLS 运行期失败也会回退到它）

### Build & Deploy
- **生成物，别手改**: `build/`、`client/geodata/geodata_tags.json`（这两个被跟踪，但是 `npm run build` / `client/scripts/gen_geodata_tags.py` 的产物）、`client/dist/`、`cert/*.{crt,key}`、`certificates/`（MITM 域名证书缓存）、`logs/{access,visits}/`、`config.json`/`config_backup.json`/`temp_credentials.json`/`temp_auth_bypass_hosts.json`/`proxy/mitm/persistentStore.json`、`android-client/app/build/`；例外：`android-client/app/src/main/jniLibs/*.so` 是 `build-native.sh` 的产物但**已提交**，改了 native 要一并提交
- `npm run build` – React frontend → `/build/`（会先删 `config_backup.json`）。**`build/` 被 git 跟踪**且 Express 直接托管它（`express.static('../build/')`）、npm 包只发 `build/` 不发 `src/`，所以改了 `src/` 要重新 build 并把 `build/` 一并提交（hash 文件名会变，commit 里看着像改名）
- `npm run docker:build` / `docker:build:arm` – 单架构镜像；`docker:push` – amd64+arm64 双架构推送 ACR（另有 `docker:push:amd64` / `docker:push:arm64`）
- `block-proxy` / `block-proxy -c rule.js` – 全局 CLI（失败自动重启, 3s delay, max 10000）；`block-proxy --pubkey <path> --privkey <path>` – 指定隧道 TLS 证书

## Architecture

MITM proxy for parental control & ad blocking. Node.js + React + proxy-core (AnyProxy fork). 可运行于 OpenWRT 路由器或 Docker.

### Ports
| 端口 | 用途 |
| --- | --- |
| 8001 | 内网 HTTP proxy (mandatory, proxy-core) |
| 8002 | 公网代理 SOCKS5 / HTTP CONNECT over TLS (optional；ALPN 协商出 h2 时同连接多路复用 CONNECT 流，否则按首字节分发) |
| 8003 | Tunnel server (reverse tunnel, HTTP/2 + allowHTTP1) |
| 8004 | Express admin API（HTTPS，自签证书） |
| 3000 | React dev server (dev only) |

### Entry Points
- **Primary**: `bin/start.js` (CLI) → `server/start.js` → proxy-only or full stack
- **Proxy-only**: `proxy/start.js` → `proxy/proxy.js`
- **Dev**: `npm run dev` → full stack with dev flag

### Request Flow
Client → HTTP Proxy (8001) → proxy-core → MITM → Target；SOCKS5 / HTTP CONNECT / HTTP/2 CONNECT (8002, TLS + ALPN) → 认证 → CONNECT → 8001；Tunnel xhttp (8003) → 8001

### Core Components
- **Proxy** (`/proxy/`) – `proxy.js` 入口, `attacker.js` 拦截判断, `host-match.js` 域名匹配语义(`filter_host` 命中自身及子域, 按 `.` 边界判定, 不做任意子串; 拦截/访问日志/足迹日志共用), `domain.js` DNS 解析/本机 IP, `fs.js` config 读写备份, `scan.js` 每 2h 扫描局域网设备表(状态与并发去重), 实际扫描在 `lan-scan.js`(原生 UDP 探测 + 内核邻居表解析, 不依赖 arp/ping 命令; 只扫 10/8 与 192.168/16 且排除 172.*, 全量替换而非追加), `mitm/rule.js` 规则 + 响应修改器(YouTube 去广告/有道 VIP), `http.js` HTTP 助手, `monitor.js` 系统指标, `operator.js` 管理路由, `wanip.js` 公网 IP, `access-logger.js` 访问日志(按 MAC 记录被监控设备访问其拦截域名), `visit-logger.js` 访问足迹日志(按 MAC 记录访问过的全部域名, 不记 path), `temp-credentials.js` 临时代理凭据(7 天有效, 仅 8001/8002), `auth-bypass-hosts.js` 认证豁免白名单(内置 auth_bypass_hosts.json 只读 + 临时 temp_auth_bypass_hosts.json 可增删, 仅 8001), `fd-diagnostics.js` fd/TCP 诊断; `mitm/` 另含 `registry.js`(规则注册), `persistentStore.js`, `uaFilter.js`(UA 豁免只跳过内置 YouTube MITM 重写, 不绕过父控拦截规则), `ydcd/`, `youtube/`
- **Proxy-Core** (`/proxy/proxy-core/`) – AnyProxy fork 本地模块（非 npm 依赖）: `proxy-server.js`(入口), `index.js`, `request-handler.js`(HTTP/S/WS 转发核心, ~1190 行), `https-server-mgr.js`(SNI+IP HTTPS, LRU 1000), `cert-lifecycle.js`(预热/并发去重/健康检查), `cert-mgr.js`, `util.js`, `log.js`, `rule-default.js`, `request-error-handler.js`(内联错误页), `ws-server-mgr.js`(WS 服务器工厂)
  - 证书存储: 项目本地 `certificates/`（`util.getAnyProxyHome()` 直接返回这个目录，不再用 `~/.anyproxy`；Dockerfile 里那句 `rm -rf /root/.anyproxy/certificates` 是遗留清理）；`X-Tunnel-Relay: 1` 头注入 tunnel CONNECT 响应
  - 内置通配符证书: `cert-lifecycle.js#BUILTIN_WILDCARDS` 对 CDN 父域一次签出裸域 + `*.parent` 两个 SAN，主机名轮换时先查通配符缓存，避免 rrN---sn-xxx 每个新主机重复签发（通配符只匹配一层标签）
  - ECONNRESET/EPIPE 自动重试一次 (GET/HEAD/OPTIONS)；keep-alive `maxRequestsPerSocket: 50` 防 gRPC RST_STREAM；流式响应阈值 20MB (无 responseRules 时 64KB)
  - 剥离 MITM 响应中的 `Alt-Svc` 头，防止客户端学到 h3/QUIC 入口绕过 TCP 代理
- **SOCKS5** (`/socks5/`) – 8002 公网代理端口，SOCKS5 over TLS + UDP over TCP(自定义帧) + HTTP CONNECT over TLS + HTTP/2 CONNECT(ALPN h2 多路复用): `server.js`(`createPublicProxyDispatcher` 按 ALPN/首字节分发、`createHttpConnectHandler` HTTP/1.1 隧道、`createHttp2ConnectHandler` 解密的 TLSSocket 交给内置 `http2.createServer()` 处理 CONNECT 流), `start.js`, `test_tls_reuse.js`; 客户端 `client/proxy_core.py` + `client/h2_upstream.py` (asyncio 实现)
- **Tunnel** (`/tunnel/`) – xhttp 传输协议（HTTP POST 上行 + SSE 下行）: `server.js`(HTTP/2 入口), `xhttpHandler.js`(核心处理器), `uploadQueue.js`(上行帧重排序), `protocol.js`(帧编解码), `manager.js`(连接生命周期), `sseControl.js`(旧 SSE 适配), `disguiseResponse.js`(HTTPS 伪装)
- **Server** (`/server/`) – Express API (8004, **固定 HTTPS**，自签证书 `cert/express_tls.{crt,key}` 由 `cert/generator.js#ensurePanelCert()` 在启动时校验后按需生成、SAN 含本机内网 IP；不再监听明文，旧 `http://` 链接需改为 `https://`)，托管 React build, token cookie 认证: `start.js`, `express.js`, `timestampConsole.js`, `util.js`
- **Frontend** (`/src/`) – CRA + CRACO 管理界面, `App.js` 主组件（单文件承载全部 5 个 tab：HTTP/Socks5 端口设置 / 拦截主机列表 / 路由表 / 隧道配置 / 认证豁免白名单）；**`craco.config.js` 只影响 `npm run dev`**（dev server 把 `/api` 以 HTTPS 转发到 8004）；`npm run build` 用的是裸 `react-scripts build`，不走 CRACO 的 webpack 覆盖
- **CLI** (`/bin/start.js`) – 全局入口, 失败自动重启, 退出清理全局配置
- **Certs** (`/cert/`) – MITM 根证书 `rootCA.key`/`rootCA.crt` **不进 git、不进 npm 包**，由本机生成：`startProxyServer()` 先调 `cert/generator.js#ensureRootCA()`（缺失或残缺就重新生成一对，30 年 RSA-2048，私钥 0600），再由 `proxy.js#ensureRootCA()` 按 SHA-256 指纹同步到 `certificates/`（根证书变了会清空已签发的域名证书缓存）；也可手动 `node cert/generator.js`，全新克隆里的测试靠 `test/helpers/ensure-root-ca.js` 补齐。Docker 镜像不内置根证书，要跨容器重建保留同一把 CA 须挂载 `/app/cert`。隧道 TLS 默认复用 `cert/socks5_tls.{crt,key}`（缺失时 `ensureTempCert` 自签 ECC P-256）
- **Config** (`config.json`) – 运行时配置（见下）；**Test Suite** (`/test/`) – `run.js` 一键测试(自动启动 Mock Server), `proxy-tests.js`, `proxy-core-connect-tests.js` 及隧道/MITM/fd/socks5 单测
- **Docs** (`/docs/`) – `tunnel-testing.md`, `android-client-deployment.md`, `ios-client-deployment.md`, `plans/` 与 `superpowers/{specs,plans}/`(设计与实施记录, 命名 `YYYY-MM-DD-<主题>-design/implementation.md`)；根目录 `Useage.md` 为完整用户手册（服务端部署/证书安装/客户端使用）

### Config (`config.json`)

运行时配置，由 `proxy/fs.js` 读写并备份到 `config_backup.json`；本地没有 `config.json`（已 gitignore）时由 `proxy/proxy.js#loadConfig()` 按默认值写出。新增配置项：默认值与读取逻辑改 `loadConfig()`（默认对象 + 已有配置分支 + 无配置文件分支），**必填**项还要登记到 `server/express.js` 的 `REQUIRED_FIELDS`（配置导入校验，老配置缺字段在 `validateImportedConfig()` 里补默认值；`access_log`/`tunnel_padding`/`mitm_debug_log` 等可选项不在其中）。`block-proxy -c rule.js` 的规则路径经 `config.json` 的 `config_file` 字段（`fs.setGlobalConfigFile`）传给子进程，`proxy.js#loadGlobalConfigFile()` 读取后立即清除（一次性消费，只留在内存的 `cliRulePath`），CLI 退出时也会兜底清除:
- 端口/开关: `proxy_port`, `socks5_port`, `express_port`, `enable_express`, `enable_socks5`, `enable_tunnel`, `enable_mitm`/`mitm_debug_log`/`socks5_tls`("0"/"1")
- 认证: `auth_username`/`auth_password`（代理/SOCKS5/隧道共用）, `login_username`/`login_password`（管理面板登录，两者独立）
- 8001 认证开关: `auth_http_enabled`（"0" 默认 = 内网免密，"1" 才校验），只作用于 8001，且在 `checkProxyAuth` 里排在「恶意扫描 IP 拦截」之后、「认证豁免白名单」之前——关掉密码校验不会顺带关掉 badguy 防护；`auth_username`/`auth_password` 仍保留给 8002/8003 强制校验。另注：来源 IP 为 `127.0.0.1` 的请求（SOCKS5/隧道转发进 8001 那一路）一律放行
- 临时凭据: 不在 `config.json` 里，存于根目录 `temp_credentials.json`（已 gitignore）—— 8004 后台按钮生成，固定 7 天有效，最多保留最新 20 组，作为 `auth_username`/`auth_password` 的平替；**仅 8001 内网 HTTP 与 8002 公网 SOCKS5/HTTP CONNECT 生效，隧道 8003 不接入**（客户端 App 用不了）；由 `proxy/temp-credentials.js` 管理，认证时按 mtime 缓存读盘
- 认证豁免白名单: 分两份——内置 `auth_bypass_hosts.json`（**随 git 提交**，后台只展示不可改）+ 临时 `temp_auth_bypass_hosts.json`（已 gitignore，8004 后台「认证豁免白名单」tab 可自由增删）；结构均为 `{"hosts": [...]}`，两者合并去重后生效（内置优先）；命中名单的 host 免代理认证（不回 407），用于收到 407 后不带凭据重试就直接失败的 app（E听说/小红书/知乎等）；由 `proxy/auth-bypass-hosts.js` 管理（fail-closed：文件缺失/损坏按空名单；临时文件不存在不告警），`proxy/proxy.js` 在 `loadConfig()` 时读入 `authPassHosts`，**重启代理才生效**；**仅 8001 内网 HTTP 代理生效**（8002 公网代理有独立认证逻辑，不读本名单）
- 拦截/设备: `block_hosts[]`, `devices[]`, `rule_modules{}`
- 访问日志: `access_log: { enabled("0"/"1"), dir(默认 logs/access), max_total_bytes(默认 50MB), flush_interval_ms(默认 1000) }` —— 记录 `block_hosts` 中按 `filter_mac` 配置的设备访问其对应拦截域名的请求(时间/IP/MAC/协议/方法/域名/path)，按天分片滚动，总量超限删最旧分片；请求路径仅内存入队，磁盘 IO 全在异步 flush
- 访问足迹日志: `visit_log: { enabled("0"/"1"), dir(默认 logs/visits), max_total_bytes(默认 15MB), flush_interval_ms(默认 1000) }` —— 记录 `block_hosts` 中按 `filter_mac` 配置的设备访问过的**全部**域名(不管该域名是否被拦截)，行格式 `[时间] MAC IP 域名`，不带 path；用于事后查某台机器访问过哪些网站。与 `access_log` 相互独立、可分别开关，两者共用 `devices[]` 的 IP→MAC 表(因此依赖局域网扫描结果)，按天分片滚动，总量超限删最旧分片；请求路径仅内存入队，磁盘 IO 全在异步 flush
- 隧道: `tunnel_port`, `tunnel_domains[]`, `tunnel_xhttp_base_path`("/xhttp"), `tunnel_sse_path`("/api/v1/events"，只用于旧路径的 410 提示), `tunnel_sse_keepalive_min_ms`/`max_ms`(20000/25000), `tunnel_silent_idle_timeout`(3000，**目前没人消费**：`proxy.js` 会传进 `TunnelServer` options，但构造函数不读它，真实空闲判定靠 xhttp 的 90s liveness)、`tunnel_rotation_drain_timeout`(10), `tunnel_rotation_drain_idle_timeout`(20), `tunnel_forward_idle_timeout_ms`(300000, **0 或负数 = 关闭该超时**, 读取时用 `Number.isFinite` 而非 `||` 以保留 0), `tunnel_padding: { enabled, probability, min_bytes, max_bytes }`(默认 false)
- 链式代理: `chain_proxy_enabled`, `chain_proxy_type`(http/socks5), `chain_proxy_address`([user:pass@]host:port)
- 其他: `your_domain`, `vpn_proxy`, `network_scanning_status`, `progress_time_stamp`

### MITM 规则系统

两套互相独立的机制，别混用字段：
- **拦截规则**：`config.json` 的 `block_hosts[]`（后台 UI 维护，`src/App.js`），条目 `{ filter_host, filter_match_rule, filter_start_time, filter_end_time, filter_weekday, filter_mac }`，由 `proxy.js#shouldBlockHost()` 判定（域名及子域匹配（`proxy/host-match.js`，按 `.` 边界，不做任意子串）+ URL 正则 + 时间段 + 周几 + MAC，MAC 仅 HTTP 代理）。
- **MITM 改写规则**（回调式）：规则组 `{ 组名: [ { type: 'beforeSendRequest'|'beforeSendResponse', host, regexp, callback(url, request, response) } ] }`（也可写成 `{ name, description, rules }`），范例见 `example/rule.js`；`callback` 返回含 `response` 的对象，不处理就原样返回原 response。`proxy/mitm/registry.js` 合并三个来源，**同名组后者覆盖前者**：内置 `proxy/mitm/rule.js` < CLI `block-proxy -c rule.js` < Docker 挂载的 `config/rule.js`；单个组可由 `config.rule_modules["<source>:<组名>"] = false` 关闭（如 `builtin:Youtube`）；每次启动/重启代理前 `rebuildRuleRegistry()` 重建。HTTPS 要客户端装了根证书且 `enable_mitm`="1" 才会被解密并进入回调，明文 HTTP 不受影响。

### Tunnel 协议要点

服务端**只有 xhttp**（HTTP POST 上行 + SSE 下行），无 WebSocket upgrade：`tunnel/server.js` 用 `http2.createSecureServer({allowHTTP1:true})` 监听，`xhttpHandler.handleRequest()` 命中 `/xhttp/*`，旧的 `/api/v1/events` 由 `sseControl.js` 返回 410（迁移提示），其余路径落到 `disguiseResponse.js` 的伪装页。

- 会话: `POST /xhttp/create`（body 为 AUTH 帧, 含 username/password/capabilities/clientId）→ `{ sessionId, capabilities }`；创建后 15s 未建立 SSE 自动清理；同 token 下**其他 clientId** 占用返回 409（`DEFAULT_TAKEOVER_GRACE_MS` = 60s 宽限），同 clientId 未建 SSE 的僵尸会话直接接管、已建 SSE 的保留共存用于优雅轮换
- 上行: `POST /xhttp/upload/:sessionId/:seq`（seq 递增）；下行: `GET /xhttp/stream?token=...`（SSE 长连接，帧 base64 编码于 `event: frame`，开头先写一行 `retry: 5000`）；另有 `POST /xhttp/close/:sessionId`。所谓 keepalive **不是注释行**：20~25s 内无写入时会下发一个 PING 帧（也走 `event: frame`），已有未回 PONG 时只重新排程
- token = SHA-256(username:password)；能力协商: `padding`(CAP_PADDING) / `upload-batch-v1`(CAP_UPLOAD_BATCH) / `upload-h2-v1`(CAP_UPLOAD_H2)
- 存活: SSE 会话 `lastActivityAt` 超过 90s（`DEFAULT_LIVENESS_TIMEOUT_MS`）被 `DEFAULT_LIVENESS_SWEEP_MS`(10s) 的巡检关闭；同一会话缺失 PONG 时 10s 后补发 PING（`PONG_PROBE_MAX_ATTEMPTS` = 10）
- 帧/reqid: `tunnel/protocol.js` 的类型常量与 `client/tunnel_client.py`、Android `FrameCodec.kt` 三处必须一致；reqid 反向 (server→client) 0x0001–0x7FFF / 正向 (client→server) 0x8000–0xFFFE
- UploadQueue: min-heap 按 seq 重排序, 乱序缓冲 64 帧, 单 POST body 上限 70000 字节（`MAX_POST_BODY_SIZE`）
- Padding: 协商后 DATA 帧有概率追加 PADDING 帧（64~512 字节）+ 响应头随机 `X-Padding`; 服务端默认关闭（`tunnel_padding.enabled`），开启后概率取 `tunnel_padding.probability`（默认 0.3）
- 并发限制（`tunnel/manager.js`）: forward/reverse 各 200, reverse CONNECT 30s, 已建立连接空闲 5min；`tunnel_forward_idle_timeout_ms` 由 `forwardIdleTimeoutMs` 传给 manager，`<=0` 即关闭该定时器
- 连接轮换在**客户端**侧: macOS `client/tunnel_client.py` 每 `random.uniform(rotation_min=600, rotation_max=1800)` 秒建新会话（秒），Android `TunnelRotationPolicy` 是 1~2 **小时**（毫秒）；服务端只负责新旧会话共存。服务端虽读入了 `tunnel_rotation_drain_timeout`/`tunnel_rotation_drain_idle_timeout`（存在 `TunnelServer` 实例字段上），但实例内没有其他消费方，真正执行 drain 的是客户端（macOS 侧 drain 10s + 轮询 idle 20s）
- 隧道域名白名单 `tunnel_domains[]`（自身及子域，按 `.` 边界），命中即从 8001 转发进隧道；目标又命中同一白名单时拒绝（防递归）
- **macOS 客户端仍未迁到 xhttp**：`client/tunnel_client.py` 仍是 `wss://host:8003/websocket` + WS 二进制帧（`client/config.py` 的 `tunnel.ws_path` 默认 `/websocket`，测试也断言这个 URL），而服务端该路径返回 404——改动隧道协议时两边要一起动，别只改服务端

### 部署与环境

OpenWRT `--network=host` | Docker Node 18 Alpine 多阶段构建（npmmirror 源）；运行时依赖在 `dependencies`, 仅 `@craco/craco` 在 `devDependencies`

## macOS Client (`/client/`)

Pure Python（PyObjC UI + asyncio proxy core），Nuitka 编译原生二进制。v0.1.6。运行时依赖见 `client/requirements.txt`（含 `h2`，用于 8002 的 HTTP/2 CONNECT 复用）。

```
main.py (入口, 单实例, 崩溃重启) → app.py (PyObjC 状态栏)
  ├── proxy_core.py (asyncio SOCKS5/HTTP + UDP over TCP) / h2_upstream.py (8002 HTTP/2 CONNECT 复用池) / tunnel_client.py (WebSocket 隧道 + 自动重连，**尚未迁到 xhttp**) / health_policy.py (健康检查重启窗口守卫)
  ├── node_connect.py (节点连接: DoH 解析 → 多 IP 尝试 → TLS SNI 被安全软件拦截时降级不发 SNI, cert pin TOFU)
  ├── routing.py / geodata_loader.py / proto_parser.py (geosite/geoip 分流) / doh_resolver.py (DoH 解析节点)
  ├── super_dns_control.py / super_dns_panel.py (Super DNS 域名管理)
  ├── rewrite_proxy.py (重定向/透明反向代理: 本地明文 HTTP 端口 → 外部目标, 独立线程+事件循环, 与 ProxyCore 解耦)
  ├── config.py (~/Library/Application Support/BlockProxyClient/) + settings_window.py (合并设置窗口: config_panel.py / routing_panel.py / super_dns_panel.py / rewrite_panel.py 四面板合一, 顶部大 Tab 切换) / log_window.py (PyObjC 独立进程)
  ├── autostart.py (LaunchAgent) / logger.py (访问/崩溃日志) / system_proxy.py (networksetup)
  └── traffic_stats.py / traffic_view.py / requirements.txt / watch-icons.js / scripts/ / geodata/ / tests/
```

功能/约束要点:
- 纯 Python 替代 xray-core、纯 PyObjC 替代 rumps/tkinter（公司安全软件按二进制特征码拦截）
- 本地代理与隧道生命周期解耦: 隧道断开本地代理继续运行, 后台重连；仅 tunnel 配置变化时只重启隧道
- **重定向（透明反向代理）与主代理完全解耦**：`rewrite_proxy.py` 的 `RewriteProxy` 有自己的线程与事件循环，由 `app.py#_sync_rewrite()` 按 `config.rewrite` 独立启停——**代理没连接时也能单独生效**（`_connect`/`_disconnect`/`_reconnect` 一律不触碰它）。配置 `{ enabled, listen_port(默认 996), target }`：访问 `http://127.0.0.1:<listen_port>/path` 被暗中转发到 `target` 的同一路径（类似 nginx `proxy_pass`，调用方察觉不到目标存在）。目标**一律直连**（不经节点、不走分流规则），https 目标带 SNI 但 `CERT_NONE` **不校验证书**（IP 字面量目标自动抑制 SNI）；改写 `Host`（默认端口省略、IPv6 加方括号）、补 `X-Real-IP`/`X-Forwarded-For`/`X-Forwarded-Proto`，不透传客户端的 `Host`/`Connection`/`Proxy-Connection`，向上游始终带 `Connection: close`；不承接 `CONNECT` 与 `Upgrade`（都回 502）。启动失败（端口被占/配置无效）只记日志不抛异常，也不拖垮 app；`_sync_rewrite` 按 `(enabled, listen_port, target)` 指纹幂等，三者未变不重启 listener。面板说明里写明用途是 Claude Code 桌面版接三方 API（把本地地址填为 baseURL）
  - **连接模型（2026-11-11 重写）**：客户端侧是**真 keep-alive**（一条连接顺序处理多请求，空闲上限 `KEEPALIVE_IDLE_TIMEOUT`=120s 只管「等下一个请求头」）；上游侧**每个请求新建一条连接**、读完响应主动关闭、绝不复用。原因：常见目标（如 litellm adapter `claude-adapter.js:436` / `retry.js:318`）在 SSE 响应里硬编码 `connection: keep-alive`，收到 `Connection: close` 也不真关连接却把它标记为待关闭，客户端若复用那条连接发第二个请求，Node 直接回 `HTTP/1.1 400 Bad Request` 空 body（`HPE_CLOSED_CONNECTION`）——旧实现在 Claude Code 桌面版上表现为反复 `API Error: 400 status code (no body)`。每请求新建上游连接让这个状态机问题从结构上不可能出现（代价仅一次握手，内网实测 16~21ms）
  - **响应 framing 按 RFC 9112 收尾**：`Transfer-Encoding: chunked` 原样转发 chunk 帧读到 0 块（含可选 trailer）；`Content-Length: N` 读满 N 字节；两者都无（close-delimited）则**重构成 chunked** 再发给客户端（靠上游 EOF 判定结束，否则客户端等不到结尾、连接也无法复用）。逐跳头（`Connection` 及其点名 token、`Keep-Alive`、`TE`、`Trailer`、`Upgrade`、`Proxy-Connection`）一律剥掉，framing 与 `Connection` 由本模块自己定。请求体同样按 framing 精确读走（chunked / Content-Length / 无体），读完正好停在下一个请求起点；上游提前回应导致写失败时仍把客户端字节**读干净**（sink），否则残留字节会错位成下一个请求
  - **每请求一条 access 日志**（落 `access.log`，格式 `REWRITE | METHOD path | 状态 | scheme://host:port | 耗时ms | keepalive|close|失败类别`），失败类别（建连失败 / framing 错误）另外进 `crash.log`。旧实现只记建连失败，正常转发的请求一条不记，排查 400 时完全不可见
- **本地单端口**（`local.port`，默认 1080，仅绑 127.0.0.1）同时提供 SOCKS5 与 HTTP，按连接首字节分发（0x05 → SOCKS5，其余 → HTTP），与服务端 8002 同构；旧配置里的 `local.socks_port`/`local.http_port` 由 `config.py` 在加载时迁移为 `local.port`（以旧 `socks_port` 为准）并删除旧键；`system_proxy` 把 SOCKS 防火墙/Web/Secure Web 三项都指向这个端口
- 8002 上游（protocol=socks5/http + tls）: `protocol=http` 时用独立 ALPN 上下文（`_h2_ssl_ctx`）协商 h2，一条连接多路复用 CONNECT 流；协商不到 h2 就一次性降级回 HTTP/1.1（`_ssl_ctx` 不宣告 ALPN，健康检查/延迟探测不受影响）；`socks5` 路径不进 h2
- 私有地址直连 (127/8, 10/8, 172.16/12, 192.168/16), 可配置关闭；三种上游模式: SOCKS5 over TLS / HTTP CONNECT / UDP ASSOCIATE
- DoH 解析节点: `BLOCK_PROXY_DOH_BASE`（默认 `https://dns.alidns.com/resolve`）+ `BLOCK_PROXY_DOH_BOOTSTRAP_IPS`（默认 `223.5.5.5,223.6.6.6`），两个环境变量可覆盖
- `server.ipv6Only`（面板「启用 IPv6」）：勾选后只解析 AAAA、只用 IPv6 地址连节点，解析不出 AAAA 直接报错而不退回 IPv4；DoH 缓存与地址状态按「域名 + 地址族」分键，切换开关不复用另一地址族的钉住 IP；仅对 `socks5|http` 生效，隧道模式置灰
- `server.allowInsecure` 被钉死为 True（`ALLOW_INSECURE_FORCED`），面板不可改、旧配置的 False 会在加载时被纠正——服务端证书 SAN 只有 localhost/127.0.0.1，主机名校验必然失败，真实身份靠 `certBindEnabled` 的证书指纹 TOFU 承担
- 窗口为独立进程（Nuitka 编译后 `sys.executable` 非 Python 解释器, 用 `subprocess.Popen` + 系统 Python）
- 合并设置窗口（`settings_window.py`）: 节点配置/分流规则/Super DNS/重定向 四面板合一（`config_panel.py` / `routing_panel.py` / `super_dns_panel.py` / `rewrite_panel.py`），顶部大 Tab（`assets/` 图标 + 文字，`setTemplate_(True)` 跟随浅/深色）。约束与坑：
  - 面板只建控件、不建窗口不写盘；「保存」由宿主统一编排——节点配置 + 分流规则 + 重定向当一个事务一起落盘再关窗（主进程只重连一次），Super DNS 的「保存」只写域名文件、不关窗。节点配置与重定向面板底部「取消 / 保存」并排居中（取消在左），取消转给宿主 `cancelAll_`（什么都不写、直接关窗，关窗时 `windowWillClose_` 停轮询并结束模态循环）
  - 三处菜单开的是同一窗口。已打开时把 `{tab, seq}` 写进 `ui_state.json` 的 `panel_request`，窗口 0.3s 轮询（`PANEL_REQUEST_POLL_SEC`，同一轮询顺带推 `proxy_state`）到 seq 变化就切 Tab 并前置；开窗时把文件里已有 seq 记为「已见过」，否则陈旧请求会抢 Tab
  - 切 Tab 时窗口顶边不动、底边变速到新面板高度（0.25s）。`setFrame_display_animate_` 的 animate 参数实测不插值，必须走 `NSAnimationContext` + `animator()`；但 `animator()` 只在 `NSApp.isActive()` 为真时驱动动画，inactive 时整个动画被丢弃（completionHandler 也不触发、窗口停在旧高度），所以必须按 isActive 分支、inactive 退化为 `setFrame_display_` 瞬时改高度（IPC 跳转时本进程常不是 active）。面板与 Tab 栏按钮都挂 `NSViewMinYMargin` 贴顶锚定，动画前把新面板顶边粘到 Tab 栏正下方，全程间距恒定
  - 几何：四面板统一 520 宽（`WINDOW_WIDTH`=560）——节点配置 518 高、分流 480、Super DNS 430、重定向 330；Tab 栏按钮宽度按 `len(TAB_SPECS)` 等分（4 个 Tab 时 128px，最长文案「Super DNS」实测 69.9px 放得下）；节点配置用两列网格（`GRID_MARGIN_X`=16 / `GRID_COL_W`=234 / `GRID_GAP_X`=20 / `GRID_LABEL_W`=78 / `GRID_LABEL_GAP`=6，故控件 x=100 与 x=354、宽 150），地址与用户名同列等宽、端口与密码同列等宽；协议独占一行（右侧是代理连接开关 + 状态文案），本地代理端口合并后单独占一行（标签「本地SOCKS/HTTP代理端口:」实测 166px，用 `LOCAL_PORT_LABEL_W` 让文字起点与「用户名:」对齐）
  - **标签要比输入框低 `LABEL_ALIGN_DY`(2px)** 才能墨迹对齐（label frame 22px、输入框 24px，且 label 文字在自己 frame 内偏上 3px）；改 label 高度没用——文字贴顶锚定，加高只会把字顶上去。协议行的 `NSPopUpButton` 文字居中方式不同，那一行偏移是 0 而不是 2px
  - 证书指纹是 64 位 SHA-256 hex：完整显示需降到 `CERT_PIN_FONT_SIZE`(11) 等宽字体 + 撑满 `GRID_FULL_W`(488px)，13pt 要 552px 放不下；其余文案仍 13pt。指纹/提示行相对「绑定服务器证书」复选框额外下推 `CERT_BIND_LABEL_DROP_Y`(4px)，下面的控件跟着同样多的下推
  - 「重置」按钮右缘对齐栅格右缘（`GRID_MARGIN_X + GRID_FULL_W - RESET_BTN_W`）使左右留白对称；分流面板加宽到 520 后中间文本框从 385px 变成 445px（差的 28px 是 `NSTabView` 自身边框加滚动条）
- 系统唤醒恢复: socket 探测端口存活 + 隧道线程状态恢复, 等 3s 网络稳定后重试
- 事件循环看门狗: `proxy_core.py` 每秒心跳，主循环卡死超过 5s 就把线程栈 dump 进 crash.log；旧 loop 线程超过 `ORPHAN_THREAD_GIVEUP_SECONDS`(30s) 判定僵死，本进程内不再自动重启，提示用户退出重开
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
- `tunnel/` – 传输层: `TunnelClient`(生命周期/自动重连/轮换), `TunnelTransportFactory`, `XhttpSession`(POST /xhttp/create), `XhttpTransport`(SSE 下行 + POST 上行, idle watchdog 90s + 15s 重连窗口), `XhttpUploadClient`(OkHttp/NativeUtls, uTLS 失败回退), `XhttpUploadListener`(连续上传失败回调, 触发隧道自愈), `XhttpUploadScheduler`, `GomobileUtlsPostClient`(utlsws AAR 反射), `Frame`/`FrameCodec`/`FrameSender`, `PaddingInjector`, `SseIdleWatchdog`(SSE 下行空闲看门狗)
- `tunnel/` – 连接管理: `ForwardSession`/`ForwardSessionRegistry`(正向 CONNECT), `ReverseConnectHandler`(反向 CONNECT 双向中继), `ForwardAdmissionController`(12 全局 + 每目标 4), `TunnelRotationPolicy`(1~2h), `TargetSocket`/`RealTargetSocket`(支持 VpnService.protect)
- `routing/` – `RoutingEngine`, `GeositeLoader`, `GeositeMatcher`, `ProtoParser`, `RouteDecision`, `DomainRule`
- `service/` – `BlockProxyVpnService`, `TunnelServiceController`, `TunnelNotification`, `TunnelWatchdogWorker`, `BootRestartReceiver`, `BootRestoreRetryPolicy`, `VpnAutoRestartPolicy`(开机/看门狗自动重启前先重新 prepare VPN 授权)
- `ui/` – Compose 界面 + `TunnelViewModel`, `RoutingViewModel`, `NetworkInfoCard`, `SlideButton`, `SliderStateMachine`
- `status/` – `StatusStore`(全局 StateFlow), `TunnelStatus`；`diagnostics/` – `TunnelDiagnosticsLog`；`util/` – `NetworkInfoManager`, `TlsTester`；`config/` – `ConfigRepository`, `CredentialStore`, `ClientIdentityStore`, `RoutingConfig(Repository)`, `ServerConfig`
- 根目录: `BlockProxyApplication.kt`, `MainActivity.kt`, `CrashReportActivity.kt`

约束要点:
- VPN 循环防护: `addDisallowedApplication` 内核级排除 + `VpnService.protect()` 逐 socket defense-in-depth；fd 所有权转移 `detachFd()`（onDestroy 仅在未 detach 时 close）
- hev-socks5-tunnel 在 `.gitmodules` 里声明为 submodule (`native/hev-socks5-tunnel/`, v2.15.0)，但**实际不在索引里**（见上面 Android 构建前提）；其产物 `.so` 已提交在 `jniLibs/`：lwip 用户态 TCP/IP, 仅一个 pthread；`tun2socks_jni.c` spawns detached pthread, JNI_OnLoad 缓存 JavaVM + protect method ID
- minSdk 23 + Core Library Desugaring (`desugar_jdk_libs:2.1.5`), Java 17；DataStore 持久化配置/凭据/分流 + WorkManager Watchdog (15min)
- CF/CDN IP 轮换: SSE 与 upload 各自独立 `CfIpDns`+`CfIpSelector`, `forceNextOnNextLookup()` 切换 IP; `CfIpRefreshWorker` 定期刷新 IP 池; `CfIpRuntimeRegistry` 支持 protect 回调绕过 VPN; 支持 Cloudflare 与 Aliyun CDN 边缘 IP
- 连接轮换: 每 1~2h 随机建立新 xhttp session 刷新 NAT 映射, 旧连接 draining（drain 时长由**客户端**实现决定，服务端不消费 `tunnel_rotation_drain_*`）
- 状态机: `StatusStore` StateFlow (Preparing/Connecting/Connected/Disconnected/Error)；logcat 崩溃堆栈在 AndroidRuntime

## 重要约束 (Important Notes)

- **Testing 陷阱**: 经代理请求 `127.0.0.1` 会被 AnyProxy 拦截返回管理页, Mock Server 需绑 `0.0.0.0` 并经 LAN IP 访问
- SOCKS5 与 8002 的 HTTP CONNECT 均不支持 MAC 定向拦截（来源 IP 为服务端本机）；未装证书时设 `enable_mitm`="0" 切纯隧道模式；iOS Safari 带认证代理不能与网关 IP 相同
- 路由表每 2h 刷新（`proxy/proxy.js` 的 `setInterval` 2h 调 `updateDevices()` + `updateWanIp()`；另有每 2 分钟清理不活跃攻击 IP 的定时器）；`config_backup.json` 由 `proxy/fs.js` 在首次读配置时自动生成，`npm run rm_bkconfig` 删除；`config.json` 语法错误时会回退到备份恢复
- Android 仪器化测试: `npm run test:android:emulator` 会自动 unset 代理环境变量, 避免测试流量走代理
- **Android 构建顺序**: 改 native C 后先 `android:native:build` 再 `android:build`；`utlsws` AAR 用 `native/utlsws/build-aar.sh`（gomobile）单独构建
- **Android 发布**: `npm run android:release:upload -- <tag>` 自动构建 phone debug APK 上传；勿上传未签名 release APK
- **APK 文件名不随 flavor 变**：`applicationVariants.all` 把 emulator 输出固定为 `BlockProxyClient-android-emulator.apk`、其余（phone）为 `BlockProxyClient-android.apk`（`archivesBaseName` 是 `BlockProxyClient-android`），`install-debug.sh` / `upload-android-release.sh` / `package.json` 三处硬编码了这些名字，改名要同步四处
- **版本号多处同步**：Android `build.gradle.kts` 的 `versionName` + `AboutScreen.kt` 的 `vX.Y.Z`；macOS 三处（`client/VERSION`、`client/build.sh` 的 `VERSION=`、`client/app.py` 的 `版本：vX.Y.Z`）
- ACR 推送前先 `docker login --username=hi50078584@aliyun.com crpi-x1zji86f6jpcd7t1.cn-hangzhou.personal.cr.aliyuncs.com`
- CLI 自定义证书: `block-proxy --pubkey/--privkey <path>`（`bin/start.js` 只把它们写成 `TUNNEL_PUBKEY`/`TUNNEL_PRIVKEY` 环境变量供 `getTunnelCertPaths()` 读）；链式代理经 `chain_proxy_*` 配置全部流量转上游
- **装依赖用 `pnpm i`，但 `node_modules` 里还有 `package-lock.json` 时代留下的东西**：`node-easy-cert` 在 `node_modules` 里但不在 `package.json`（证书已改用 `selfsigned`/WebCrypto），别把它当依赖引用
- **非本项目 / 不在本仓库的内容**: iOS 客户端源码不在本仓库（`docs/ios-client-deployment.md`、`docs/superpowers/*/2026-07-03-ios-client-*`、`.npmignore` 里的 `ios-client/` 都是遗留，本仓库 git 历史里没有该目录）；`litellm_custom_provider/` 是与代理无关的独立 Python LiteLLM provider，改代理时忽略；`tools/tcpdump/output.pcap` 是约 9.5MB 的样例抓包（勿整个读入，分析走 `pcap-analyse` skill），`tools/speed_test.sh` 经本地 SOCKS5 `127.0.0.1:1081` 测速

## Project Skills (`.claude/skills/`)

调用方式 `$skill-name` 或按描述自动触发: `build-client`(构建 macOS 客户端), `release-client`(发布 GitHub Release), `icon-generate`(状态栏图标 44x44 @ 144 DPI), `pcap-analyse`(分析 pcap/pcapng)。

## Project Rules

- `config.json` 是运行时配置（非源码），由 `proxy/fs.js` 管理，不追踪 git 变更
- 提交信息用 Conventional Commits + 中文描述（如 `feat(client): ...` / `fix(proxy-core): ...`），跟随 git log 现有风格
- 代码修改后等用户验证确认再提交，不自动 git add/commit/push
