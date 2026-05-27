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
- `npm run docker:build` – Build Docker image for current architecture
- `npm run docker:build:arm` – Build ARM64 Docker image
- `npm run eject` – Eject from Create React App (irreversible)

### Global CLI
- `block-proxy` – Start the proxy system (auto-restart on failure, max 10000 times)
- `block-proxy -c rule.js` – Start with external MITM rule configuration

## Architecture Overview

Block-Proxy is a MITM-based proxy filtering tool designed for parental control and ad blocking, built with Node.js, React, and a custom AnyProxy fork. It runs on OpenWRT routers or Docker containers.

### Core Components

1. **Proxy Engine** (`/proxy/`)
   - `proxy.js` – Main AnyProxy integration with MITM logic, request/response filtering
   - `mitm/rule.js` – MITM rule definitions (YouTube ads, Youdao Dictionary, etc.)
   - `mitm/youtube/` – YouTube ad-blocking response modifiers
   - `mitm/ydcd/` – Youdao Dictionary VIP modifier
   - `mitm/persistentStore.js` – Presistent store for MITM state (you can read along)
   - `mitm/uaFilter.js` – User-Agent based filtering
   - `scan.js` – Network scanning for device discovery (every 2 hours via ARP)
   - `fs.js` – Configuration file management (read/write/backup)
   - `attacker.js` – Request blocking logic
   - `domain.js` – Host pattern matching
   - `operator.js` – Proxy control operations (restart, etc.)
   - `http.js` – HTTP client utilities
   - `wanip.js` – WAN IP detection
   - `monitor.js` – Proxy monitoring interface

2. **SOCKS5 Proxy** (`/socks5/`)
   - `server.js` – SOCKS5 over TLS implementation (port 8002), forwards to AnyProxy
   - `start.js` – SOCKS5 server entry point

3. **Backend Server** (`/server/`)
   - `express.js` – Express.js API server for admin interface (port 8004)
   - `start.js` – Main server entry point (decides whether to start admin UI based on config)
   - `util.js` – Shared utilities

4. **React Frontend** (`/src/`)
   - `App.js` – Admin interface for managing blocking rules
   - Built with Create React App, configured via CRACO

5. **Test Suite** (`/test/`)
   - `run.js` – 一键测试入口，自动检测代理状态、启动 Mock Server、运行测试、输出报告
   - `proxy-tests.js` – 测试逻辑：HTTP 代理和 SOCKS5 连通性/延迟/并发/稳定性/吞吐量，以及外部站点验证
   - `lib/mock-server.js` – 本地 Mock HTTP 服务器，提供可控的响应体大小和延迟

6. **CLI Interface** (`/bin/`)
   - `start.js` – Global CLI entry point with auto-restart capabilities (max 10000 restarts) and config cleanup on exit

7. **AnyProxy Fork** (`/hack-of-anyproxy/`)
   - Modified AnyProxy request handler with custom TLS handling, IPv6 normalization, and UA-based filtering
   - Patched into `@bachi/anyproxy` package at runtime

8. **Configuration** (`config.json`)
   - Runtime configuration: ports, blocked hosts, authentication, device list
   - Auto-saved from admin interface
   - Key fields: `block_hosts[]`, `proxy_port`, `socks5_port`, `enable_express`, `enable_socks5`, `devices[]`, `auth_username`, `auth_password`

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
2. **Frontend Development**: `npm run craco` starts React dev server (port 3000) with API proxy to backend (port 8003)
3. **Testing**: Proxy-only mode with `npm run proxy`
4. **Building**: `npm run build` compiles React frontend to `/build/`
5. **Docker**: Separate commands for x86 and ARM architectures

### Dependencies
**Note:** Due to the `@bachi/anyproxy` fork being incompatible with newer Node.js versions, it is bundled as a `devDependency`. Most runtime dependencies are in `devDependencies`:
- `@bachi/anyproxy` – Modified AnyProxy fork for MITM
- `express` – Backend API server
- `react`, `react-dom` – Frontend framework
- `commander` – CLI argument parsing
- `axios` – HTTP client for API calls
- `qrcode` – Certificate QR code generation for MITM setup
- `ping` – Network ping utility
- `http-proxy-agent`, `https-proxy-agent` – Upstream proxy support
- `@craco/craco` – CRA configuration override

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
- **Testing**: 通过代理请求 `127.0.0.1` 会被 AnyProxy 拦截返回管理页面。Mock Server 需绑定 `0.0.0.0` 并通过 LAN IP 访问
- SOCKS5 proxy does not support MAC address targeting (only HTTP proxy does)
- Clients must install AnyProxy certificate for HTTPS MITM inspection
- Service needs network scanning permissions (best deployed on OpenWRT gateway, uses `arp -a`)
- Admin interface allows real-time rule management with proxy restart
- Docker builds use Chinese npm registry (registry.npmmirror.com) by default
- iOS Safari has security restriction: proxy with auth cannot be same as gateway IP
- Network device table refreshes every 2 hours; new devices may need manual refresh
- HTTP keep-alive enabled with max 100 sockets for performance

# Project Rules & Skills

- **Local Skills**: 实时遵循 `.claude/skills/*/skill.md` 中的指令。可用技能: `commit`, `pcap-analyse`
- **CLI入口**: 全局命令 `block-proxy` 注册在 `bin/start.js`，通过 `npm i -g` 安装后可直接调用
- **config.json** 是运行时配置文件（非源码），由 `proxy/fs.js` 管理读写和备份，不在 git 中追踪变更
