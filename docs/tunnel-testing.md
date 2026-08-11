# Reverse Tunnel Manual Testing

## Setup

1. Server: set `enable_tunnel: "1"`, `tunnel_port: 8004`,
   `tunnel_domains: ["internal.example.com"]` in config.json. Restart.

2. Client: set `tunnel.enabled: true` in config.json.
   Restart.

## Test Cases

### 1. Connection
- Client menu shows "隧道配置 (已连接)"
- Server logs: "[Tunnel] Client authenticated"

### 2. Tunnel domain forwarding
- Browser → Server proxy → `https://internal.example.com`
- Request appears in Client logs
- Response returned to browser

### 3. Non-tunnel domain (no interference)
- Browser → `https://google.com`
- Normal proxy behavior, no tunnel involvement

### 4. Client disconnect → tunnel domain blocked
- Stop Client
- Visit tunnel domain → connection reset (not DNS leak!)
- Restart Client → auto-reconnect

### 5. Port occupied
- Start second Client
- Shows "隧道端口已被占用", stops retrying

### 6. Server restart
- Restart Server while Client connected
- Client detects disconnect, reconnects within backoff cycle

### 7. Heartbeat
- Block Client's network temporarily (>60s)
- Server should detect and clean up
- Restore network → Client reconnects
