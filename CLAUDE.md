# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

### Development
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
- `block-proxy` – Start the proxy system (auto-restart on failure)
- `block-proxy -c rule.js` – Start with external MITM rule configuration

## Architecture Overview

Block-Proxy is a MITM-based proxy filtering tool designed for parental control and ad blocking, built with Node.js, React, and a custom AnyProxy fork. It runs on OpenWRT routers or Docker containers.

### Core Components

1. **Proxy Engine** (`/proxy/`)
   - `proxy.js` – Main AnyProxy integration with MITM logic
   - `mitm/` – MITM rule implementations (YouTube ads, dictionary, etc.)
   - `scan.js` – Network scanning for device discovery (every 2 hours)
   - `fs.js` – Configuration file management

2. **SOCKS5 Proxy** (`/socks5/`)
   - `server.js` – SOCKS5 over TLS implementation (port 8002)
   - `start.js` – SOCKS5 server entry point

3. **Backend Server** (`/server/`)
   - `express.js` – Express.js API server for admin interface (port 8004)
   - `start.js` – Main server entry point (decides whether to start admin UI)

4. **React Frontend** (`/src/`)
   - `App.js` – Admin interface for managing blocking rules
   - Built with Create React App, configured via CRACO

5. **CLI Interface** (`/bin/`)
   - `start.js` – Global CLI entry point with auto-restart capabilities and config cleanup

6. **Configuration** (`config.json`)
   - Runtime configuration: ports, blocked hosts, authentication
   - Auto-saved from admin interface

### Port Configuration
- `8001` – HTTP proxy port (mandatory)
- `8002` – SOCKS5 over TLS port (optional)
- `8003` – AnyProxy monitoring interface (optional)
- `8004` – Admin configuration interface (optional)
- `3000` – React development server (dev only)

### Entry Points
- **Primary**: `bin/start.js` (CLI) → `server/start.js` → decides between proxy-only or full stack
- **Proxy-only**: `proxy/start.js` → `proxy/proxy.js`
- **Development**: `npm run dev` → starts everything with dev flag

## Key Patterns

### MITM Rule System
- Host-based blocking with regex pattern matching
- Time-based restrictions (start/end times, weekdays)
- MAC address targeting for device-specific rules
- YouTube ad blocking with predefined regex patterns
- Custom rule injection via external `rule.js` configuration

### Configuration Management
- Configuration stored in `config.json` at runtime
- Supports external rule files via `-c` flag
- Network device scanning every 2 hours (stored in `config.json`)
- Auto-clears global config file on exit/restart

### Deployment Patterns
- Designed for OpenWRT router deployment with host networking (`--network=host`)
- Docker container with volume mounting for configuration
- Multi-architecture support (ARM/X86)
- Auto-restart on failure with config cleanup
- Production vs. development modes controlled by `BLOCK_PROXY_DEV` env var

### Development Workflow
1. **Development**: `npm run dev` starts proxy + admin UI + SOCKS5 (if enabled)
2. **Testing**: Proxy-only mode with `npm run proxy`
3. **Building**: `npm run build` compiles React frontend to `/build/`
4. **Docker**: Separate commands for x86 and ARM architectures

### Dependencies
- `@bachi/anyproxy` – Modified AnyProxy fork for MITM
- `express` – Backend API server
- `react`, `react-dom` – Frontend framework
- `commander` – CLI argument parsing
- `axios` – HTTP client for API calls
- `qrcode` – Certificate QR code generation for MITM setup

## Important Notes
- SOCKS5 proxy does not support MAC address targeting (only HTTP proxy does)
- Clients must install AnyProxy certificate for HTTPS MITM inspection
- Service needs network scanning permissions (best deployed on OpenWRT gateway)
- Admin interface allows real-time rule management with proxy restart
- Docker builds use Chinese npm registry (registry.npmmirror.com) by default
