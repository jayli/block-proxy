# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

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
- `npm run test:proxy` – 一键代理连通性/性能/吞吐量测试（需先启动代理服务）
- `npm test` – Run React tests (currently limited, based on CRA defaults)

### Utilities
- `npm run rm_bkconfig` – Remove backup config file

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

Block-Proxy is a MITM-based proxy filtering tool designed for parental control and ad blocking, built with Node.js, React, and a custom AnyProxy fork. It runs on OpenWRT routers or Docker containers.

### Core Components

1. **Proxy Engine** (`/proxy/`) – 核心入口 `proxy.js`，集成 AnyProxy 实现 MITM 请求/响应过滤。`attacker.js` 执行拦截判断，`domain.js` 做 host 匹配，`fs.js` 管理 config.json 读写备份，`scan.js` 每 2 小时 ARP 扫描发现设备。`mitm/` 子目录包含规则定义（`rule.js`）和具体的响应修改器（YouTube 去广告、有道词典 VIP）

2. **SOCKS5 Proxy** (`/socks5/`) – SOCKS5 over TLS 实现（端口 8002），TLS 握手认证后通过 CONNECT 隧道转发至 AnyProxy

3. **Backend Server** (`/server/`) – Express API 服务器（端口 8004）。`start.js` 根据 config 决定启动完整栈还是仅代理模式

4. **React Frontend** (`/src/`) – CRA + CRACO 构建的管理界面，`App.js` 为主组件

5. **Test Suite** (`/test/`) – `run.js` 一键测试入口（自动启动 Mock Server），`proxy-tests.js` 覆盖 HTTP/SOCKS5 连通性、延迟、并发、吞吐量

6. **CLI** (`/bin/start.js`) – 全局命令入口，失败自动重启（max 10000 次），退出时清理全局配置

7. **AnyProxy Fork** (`node_modules/@bachi/anyproxy/`) – 核心 MITM 代理引擎，fork 自 AnyProxy 的私有 npm 包（v0.1.5）。关键源码：`proxy.js`（入口）、`lib/requestHandler.js`（HTTP/HTTPS 请求处理与转发）、`lib/httpsServerMgr.js`（HTTPS MITM 服务管理、动态证书生成）、`lib/certMgr.js`（根证书与域名证书管理）。所有底层连接处理、TLS 拦截、请求转发的实现分析都应从此包查找

8. **TLS Certificates** (`/cert/`) – `rootCA.key` + `rootCA.crt`，Docker 构建时复制到容器的 `~/.anyproxy/certificates/`，客户端需安装此证书才能 HTTPS MITM

9. **Configuration** (`config.json`) – 运行时配置（非源码），由 `proxy/fs.js` 管理。关键字段：`block_hosts[]`, `proxy_port`, `socks5_port`, `enable_express`, `enable_socks5`, `devices[]`, `auth_username`, `auth_password`

### Port Configuration
- `8001` – HTTP proxy port (mandatory, AnyProxy)
- `8002` – SOCKS5 over TLS port (optional)
- `8003` – AnyProxy monitoring interface (optional)
- `8004` – Admin configuration interface (optional, Express)
- `3000` – React development server (dev only)

### Entry Points
- **Primary**: `bin/start.js` (CLI) → `server/start.js` → decides between proxy-only or full stack
- **Proxy-only**: `proxy/start.js` → `proxy/proxy.js`
- **Development**: `npm run dev` → starts everything with dev flag

### Request Flow
```
Client → HTTP Proxy (8001) → AnyProxy → MITM Rules → Target Server
       → SOCKS5 (8002) → TLS → SOCKS5 Server → HTTP Proxy (8001) → Target Server
```
SOCKS5 先做 TLS 握手和认证，然后通过 CONNECT 命令建立隧道，将 TCP 流量转发至下游 HTTP 代理。

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
2. **Frontend Development**: `npm run craco` starts React dev server (port 3000)，CRACO 将 `/api` 请求代理到 AnyProxy 监控端口 8003（非 Express 8004）
3. **Testing**: Proxy-only mode with `npm run proxy`
4. **Building**: `npm run build` compiles React frontend to `/build/`
5. **Docker**: Dockerfile 基于 Node 18 Alpine（多阶段构建），本地开发可用更高版本 Node

### Dependencies
**Note:** `@bachi/anyproxy` 与较新 Node.js 版本不完全兼容，因此连同大多数运行时依赖一起放在 `devDependencies` 中（查看 package.json 了解完整列表）

**核心依赖 `@bachi/anyproxy`（v0.1.5）：** fork 自开源 AnyProxy 的私有 npm 包，是整个代理系统的底层引擎。分析连接处理、TLS 拦截、请求转发等底层逻辑时，应直接阅读 `node_modules/@bachi/anyproxy/` 的源码（而非项目根目录下的其他备份）。关键文件：
- `proxy.js` — 包入口，创建代理服务器实例
- `lib/requestHandler.js` — HTTP/HTTPS 请求处理与转发核心
- `lib/httpsServerMgr.js` — HTTPS MITM 服务管理、动态伪造证书
- `lib/certMgr.js` — 根证书与域名证书的生成和管理

## macOS Client (`/client/`)

macOS 状态栏代理客户端，纯 Python 实现，连接远端 SOCKS5 over TLS 服务。

### Commands
- `python main.py` – 直接运行客户端（开发模式）
- `bash build.sh` – Nuitka 一键构建 macOS .app（输出到 `dist/SocksClient.app`）
- `cd client && pytest tests/` – 运行客户端单元测试
- 删除 `icons/app.icns` 后再 `bash build.sh` 可强制重新生成应用图标

### Architecture
```
main.py (入口, 文件锁单实例) → app.py (rumps 状态栏 App)
                                  ├── proxy_core.py (asyncio SOCKS5/HTTP 代理核心)
                                  ├── config.py (配置读写, ~/Library/Application Support/SocksClient/)
                                  ├── config_window.py (tkinter 配置窗口, 独立进程启动)
                                  └── system_proxy.py (macOS 系统代理 networksetup)
```

### Key Design Decisions
- **纯 Python 替代 xray-core**：公司安全软件（云壳）按二进制特征码拦截 xray-core、py2app、PyInstaller，因此用 asyncio + ssl 模块纯 Python 实现 SOCKS5 over TLS 协议，用 Nuitka 编译为原生二进制
- **代理协议流程**：本地应用 → 本地 SOCKS5(1080)/HTTP(1087) → TLS 连接远端 → SOCKS5 握手(用户名密码认证) → CONNECT → 双向 relay
- **私有地址直连**：127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 等私有地址段不走代理，直接连接（可通过配置项关闭）
- **UI 线程安全**：代理启动/停止在后台线程执行，UI 更新通过 `AppHelper.callAfter()` 调度回主线程
- **config_window.py 作为独立进程**：tkinter 窗口通过 `subprocess.Popen` 用系统 Python 启动（Nuitka 编译后 `sys.executable` 不是 Python 解释器），关闭后自动检测配置变化并重启代理
- **Nuitka 构建后处理**：`build.sh` 自动重命名可执行文件、修正 Info.plist（CFBundleExecutable、LSUIElement 等）

## Important Notes
- **Testing 陷阱**: 通过代理请求 `127.0.0.1` 会被 AnyProxy 拦截返回管理页面。Mock Server 需绑定 `0.0.0.0` 并通过 LAN IP 访问
- SOCKS5 不支持 MAC 地址定向拦截（仅 HTTP 代理支持）
- 客户端必须安装 `cert/` 目录下的 AnyProxy 证书才能启用 HTTPS MITM（URL 路径过滤、广告重写）。未安装证书时，将 `enable_mitm` 设为 `"0"` 可切换为纯隧道转发模式，关闭所有 MITM 解密和拦截，零证书错误
- Docker 构建默认使用 npmmirror.com 镜像源
- iOS Safari 安全限制：带认证的代理不能和网关 IP 相同
- 路由表每 2 小时刷新；新设备可能需要手动刷新
- ACR 推送前需先 `docker login --username=hi50078584@aliyun.com crpi-x1zji86f6jpcd7t1.cn-hangzhou.personal.cr.aliyuncs.com`

# Project Rules & Skills

- **Local Skills**: 实时遵循 `.claude/skills/*/skill.md` 中的指令。可用技能: `commit`, `pcap-analyse`
- **CLI入口**: 全局命令 `block-proxy` 注册在 `bin/start.js`，通过 `npm i -g` 安装后可直接调用
- **config.json** 是运行时配置文件（非源码），由 `proxy/fs.js` 管理读写和备份，不在 git 中追踪变更
