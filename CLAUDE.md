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

### Build & Deployment
- `npm run build` – Build React frontend
- `npm run docker:build` – Build Docker image for current architecture
- `npm run docker:build_arm` – Build ARM64 Docker image
- `npm test` – Run React tests
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
   - `scan.js` – Network scanning for device discovery (every 2 hours via ARP)
   - `fs.js` – Configuration file management (read/write/backup)
   - `attacker.js` – Request blocking logic
   - `domain.js` – Host pattern matching
   - `operator.js` – Proxy control operations (restart, etc.)
   - `http.js` – HTTP client utilities
   - `wanip.js` – WAN IP detection

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

5. **CLI Interface** (`/bin/`)
   - `start.js` – Global CLI entry point with auto-restart capabilities (max 10000 restarts) and config cleanup on exit

6. **Configuration** (`config.json`)
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
       → SOCKS5 (8002) → TLS → AnyProxy → MITM Rules → Target Server
```

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
- `@bachi/anyproxy` – Modified AnyProxy fork for MITM
- `express` – Backend API server
- `react`, `react-dom` – Frontend framework
- `commander` – CLI argument parsing
- `axios` – HTTP client for API calls
- `qrcode` – Certificate QR code generation for MITM setup
- `ping` – Network ping utility
- `http-proxy-agent`, `https-proxy-agent` – Upstream proxy support

## Important Notes
- SOCKS5 proxy does not support MAC address targeting (only HTTP proxy does)
- Clients must install AnyProxy certificate for HTTPS MITM inspection
- Service needs network scanning permissions (best deployed on OpenWRT gateway, uses `arp -a`)
- Admin interface allows real-time rule management with proxy restart
- Docker builds use Chinese npm registry (registry.npmmirror.com) by default
- iOS Safari has security restriction: proxy with auth cannot be same as gateway IP
- Network device table refreshes every 2 hours; new devices may need manual refresh
- HTTP keep-alive enabled with max 100 sockets for performance

# Project Rules & Skills

- **Import Skill**: 实时遵循 `.claude/skills/*/skill.md` 中的指令。
