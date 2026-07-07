# Real Device Validation Checklist

BlockProxy Android Client — 真机验证清单

> Use this checklist to validate the tunnel client on a physical Android device
> before release. Each test case has Pass/Fail/Notes columns for recording results.

---

## Device Information / 设备信息

| Field            | Value |
|------------------|-------|
| Device model     |       |
| Android version  |       |
| ROM / vendor     |       |
| API level        |       |
| Test date        |       |
| Tester           |       |
| App version      |       |
| Server version   |       |

**ROM examples:** MIUI, ColorOS, HarmonyOS, OneUI, OxygenOS, stock AOSP, Pixel Experience

---

## Pre-test Setup / 测试前准备

### 1. Build & Install

```bash
# Build debug APK
cd android-client
./gradlew assembleDebug

# Install on connected device
adb install -r app/build/outputs/apk/debug/app-debug.apk

# Verify installation
adb shell pm list packages | grep blockproxy
```

### 2. Configure Server Connection

1. Open BlockProxy app
2. Navigate to Config screen (设置 icon)
3. Enter tunnel server address:
   - **Host**: your block-proxy server IP/domain
   - **Port**: `8003` (default)
   - **TLS**: enabled (recommended)
   - **Allow insecure**: enabled (for self-signed certs) or disabled (for CA-signed certs)
4. Enter credentials:
   - **Username**: your SOCKS5/tunnel username
   - **Password**: your SOCKS5/tunnel password
5. Tap **Save** (保存)

### 3. Server-side Configuration

On the block-proxy server, configure `tunnel_domains` in `config.json`:

```json
{
  "tunnel_domains": [
    {
      "domain": "your-test-domain.example.com",
      "target_host": "192.168.x.x",
      "target_port": 8080
    }
  ]
}
```

### 4. Verify Server is Running

```bash
# Check tunnel server is listening on port 8003
ss -tlnp | grep 8003

# Or from another machine:
nc -zv <server-ip> 8003
```

---

## Test Cases / 测试用例

### TC-01: Battery Optimization Exemption / 电池优化豁免

> The app requests battery optimization exemption on first VPN start to prevent
> the system from killing the tunnel service during Doze mode.

| # | Check Item | Pass/Fail | Notes |
|---|-----------|-----------|-------|
| 1.1 | On first connect, system battery exemption dialog appears (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) | | |
| 1.2 | After granting, UI shows battery exempted state (indicator on MainScreen) | | |
| 1.3 | `adb shell dumpsys deviceidle whitelist \| grep blockproxy` shows `com.blockproxy.android` | | |
| 1.4 | On second connect (already exempted), no duplicate prompt | | |
| 1.5 | If user denies exemption, warning shown on next connect attempt | | |
| 1.6 | Battery settings link opens `ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS` | | |

### TC-02: WakeLock / 唤醒锁

> The service acquires a `PARTIAL_WAKE_LOCK` with tag `"block-proxy:tunnel"` to
> prevent CPU deep sleep while the tunnel is active. Safety cap: 24 hours.

| # | Check Item | Pass/Fail | Notes |
|---|-----------|-----------|-------|
| 2.1 | After starting tunnel: `adb shell dumpsys power \| grep block-proxy` shows WakeLock held | | |
| 2.2 | Lock tag is `"block-proxy:tunnel"`, type is `PARTIAL_WAKE_LOCK` | | |
| 2.3 | After stopping tunnel, WakeLock is released (no longer in `dumpsys power` output) | | |
| 2.4 | After service crash/kill, WakeLock is released on `onDestroy` | | |

### TC-03: Notification Permission (Android 13+) / 通知权限

> Android 13 (API 33) requires `POST_NOTIFICATIONS` runtime permission.
> The foreground service notification uses channel `"tunnel_service"`.

| # | Check Item | Pass/Fail | Notes |
|---|-----------|-----------|-------|
| 3.1 | On Android 13+, notification permission prompt appears on first launch | | |
| 3.2 | After granting, notification is visible when tunnel is running | | |
| 3.3 | Notification title: "BlockProxy", text reflects current status (e.g., "已连接") | | |
| 3.4 | Notification has "停止" (Stop) action button | | |
| 3.5 | Tapping Stop action stops the tunnel service | | |
| 3.6 | Tapping notification body opens MainActivity | | |
| 3.7 | Notification is `IMPORTANCE_LOW` (no sound) | | |
| 3.8 | On Android < 13, no permission prompt, notification shown directly | | |

### TC-04: VPN Permission / VPN 权限

> The app uses `VpnService` to signal VPN status to the system. The TUN interface
> is established with address `10.255.0.2/32` and session name `"BlockProxy"`.
> **No traffic is actually routed through the TUN interface.**

| # | Check Item | Pass/Fail | Notes |
|---|-----------|-----------|-------|
| 4.1 | System VPN consent dialog appears on first start | | |
| 4.2 | VPN icon (key icon) shown in status bar after connection | | |
| 4.3 | VPN session name is `"BlockProxy"` in system VPN settings | | |
| 4.4 | `adb shell dumpsys connectivity \| grep -A5 VPN` shows the VPN session | | |
| 4.5 | After stopping tunnel, VPN icon disappears from status bar | | |
| 4.6 | Denying VPN permission shows Error status, service stops gracefully | | |

### TC-05: Lock Screen 30 Minutes / 锁屏 30 分钟

> Validates that the tunnel survives 30 minutes of screen-off with WakeLock
> and battery exemption active.

| # | Check Item | Pass/Fail | Notes |
|---|-----------|-----------|-------|
| 5.1 | Start tunnel, confirm status = Connected ("已连接") | | |
| 5.2 | Lock screen (power button), wait 30 minutes | | |
| 5.3 | Unlock screen, app shows Connected status | | |
| 5.4 | `adb shell dumpsys power \| grep block-proxy` — WakeLock still held | | |
| 5.5 | Notification still shows Connected | | |
| 5.6 | VPN icon still in status bar | | |

### TC-06: Lock Screen 1 Hour / 锁屏 1 小时

> Extended screen-off test. Validates long-term tunnel stability.

| # | Check Item | Pass/Fail | Notes |
|---|-----------|-----------|-------|
| 6.1 | Start tunnel, confirm status = Connected | | |
| 6.2 | Lock screen, wait 1 hour | | |
| 6.3 | Unlock screen, app shows Connected status | | |
| 6.4 | WakeLock still held | | |
| 6.5 | Notification still shows Connected | | |
| 6.6 | Reverse CONNECT still works (trigger a test request from server side) | | |

### TC-07: App Background / 应用后台

> The tunnel service must continue running when the app is backgrounded.

| # | Check Item | Pass/Fail | Notes |
|---|-----------|-----------|-------|
| 7.1 | Start tunnel, press Home button | | |
| 7.2 | Tunnel stays connected (check notification) | | |
| 7.3 | Wait 5 minutes in background | | |
| 7.4 | Switch back to app, status shows Connected | | |
| 7.5 | Open recent apps, app thumbnail shows correct status | | |

### TC-08: Activity Swiped Away / 清除最近任务

> Swiping the app from the recents list should NOT kill the foreground service.
> The service runs independently via `startForeground`.

| # | Check Item | Pass/Fail | Notes |
|---|-----------|-----------|-------|
| 8.1 | Start tunnel, confirm Connected | | |
| 8.2 | Open recents, swipe BlockProxy away | | |
| 8.3 | Notification still shows "BlockProxy" with Connected status | | |
| 8.4 | VPN icon still in status bar | | |
| 8.5 | `adb shell dumpsys activity services com.blockproxy.android` shows `BlockProxyVpnService` running | | |
| 8.6 | Re-open app, status shows Connected | | |

### TC-09: WiFi → Cellular Switch / WiFi 切换蜂窝

> Network change should trigger reconnection. The tunnel sockets are
> protected from VPN routing via `VpnService.protect()`.

| # | Check Item | Pass/Fail | Notes |
|---|-----------|-----------|-------|
| 9.1 | Start tunnel on WiFi, confirm Connected | | |
| 9.2 | Disable WiFi (cellular takes over) | | |
| 9.3 | Status briefly shows Reconnecting ("重连中") | | |
| 9.4 | Status returns to Connected within reasonable time | | |
| 9.5 | Notification updates to reflect reconnection | | |
| 9.6 | Reverse CONNECT still works after reconnection | | |

### TC-10: Server Restart / 服务端重启

> The client should automatically reconnect when the block-proxy server
> restarts. Uses exponential backoff: 1s → 2s → 4s → ... → 60s (cap).

| # | Check Item | Pass/Fail | Notes |
|---|-----------|-----------|-------|
| 10.1 | Start tunnel, confirm Connected | | |
| 10.2 | Kill block-proxy server (`kill <pid>` or `docker stop`) | | |
| 10.3 | Client enters Reconnecting status | | |
| 10.4 | Restart block-proxy server | | |
| 10.5 | Client reconnects automatically (status → Connected) | | |
| 10.6 | Notification reflects the reconnection | | |
| 10.7 | Reverse CONNECT works after reconnection | | |

### TC-11: Weak Network Recovery / 弱网恢复

> Tests recovery from complete network loss (airplane mode).

| # | Check Item | Pass/Fail | Notes |
|---|-----------|-----------|-------|
| 11.1 | Start tunnel, confirm Connected | | |
| 11.2 | Enable airplane mode | | |
| 11.3 | Client enters Reconnecting status | | |
| 11.4 | Wait 30 seconds with airplane mode on | | |
| 11.5 | Disable airplane mode | | |
| 11.6 | Client reconnects, status → Connected | | |
| 11.7 | Reconnection completes within 2 minutes | | |

### TC-12: Single Connection Fallback / 单连接回退

> The client attempts up to `MAX_CONNECTIONS = 2` connections. If the server
> only accepts 1, the client should work with a single connection and attempt
> replenishment in the background.

| # | Check Item | Pass/Fail | Notes |
|---|-----------|-----------|-------|
| 12.1 | Configure server to accept max 1 tunnel connection | | |
| 12.2 | Start client, confirm Connected with first connection | | |
| 12.3 | Client attempts second connection (check logcat for replenishment attempts) | | |
| 12.4 | After 3 failed replenishment attempts (2s, 4s intervals), client stops trying | | |
| 12.5 | Single connection works normally for reverse CONNECT | | |
| 12.6 | If remaining connection drops, full reconnect cycle starts | | |

```bash
# Monitor replenishment attempts:
adb logcat | grep -i "replenish\|tunnel-\|establish"
```

### TC-13: Dual Connection Round-Robin / 双连接轮询

> With 2 connections established, reverse CONNECT requests should be
> distributed across both connections.

| # | Check Item | Pass/Fail | Notes |
|---|-----------|-----------|-------|
| 13.1 | Configure server to accept 2 tunnel connections | | |
| 13.2 | Start client, confirm Connected | | |
| 13.3 | Both connections established (check logcat for 2 AUTH_OK) | | |
| 13.4 | Trigger multiple reverse CONNECT requests from server | | |
| 13.5 | Requests are distributed across both connections | | |
| 13.6 | If one connection drops, remaining connection handles all requests | | |
| 13.7 | Dropped connection triggers replenishment attempt | | |

```bash
# Verify dual connections:
adb logcat | grep "AUTH_OK\|tunnel-"
```

### TC-14: Service Kill & Recovery / 服务杀死恢复

> Tests service recovery after the system or user kills the process.
> The service returns `START_STICKY` from `onStartCommand`.

| # | Check Item | Pass/Fail | Notes |
|---|-----------|-----------|-------|
| 14.1 | Start tunnel, confirm Connected | | |
| 14.2 | Kill app: `adb shell am kill com.blockproxy.android` | | |
| 14.3 | Service restarts (START_STICKY or WorkManager watchdog) | | |
| 14.4 | Tunnel reconnects, status → Connected | | |
| 14.5 | Notification reappears with correct status | | |
| 14.6 | VPN icon returns to status bar | | |
| 14.7 | WakeLock re-acquired after restart | | |
| 14.8 | Reconnection completes within 30 seconds | | |

```bash
# Verify service restart:
adb shell dumpsys activity services com.blockproxy.android
```

### TC-15: Smoke Test — Reverse CONNECT / 反向连接冒烟测试

> End-to-end test: an external client accesses a service on the Android
> device's LAN through the block-proxy tunnel.

**Setup:**

1. Start a simple HTTP server on a machine in the Android device's LAN:
   ```bash
   python3 -m http.server 8080
   ```
2. Note the LAN IP of that machine (e.g., `192.168.1.100`)
3. Configure `tunnel_domains` on the block-proxy server:
   ```json
   {
     "tunnel_domains": [
       {
         "domain": "android-lan.example.com",
         "target_host": "192.168.1.100",
         "target_port": 8080
       }
     ]
   }
   ```
4. Restart block-proxy server

| # | Check Item | Pass/Fail | Notes |
|---|-----------|-----------|-------|
| 15.1 | Android client shows Connected | | |
| 15.2 | From an external machine, request `http://android-lan.example.com` through block-proxy | | |
| 15.3 | block-proxy sends CONNECT frame to Android client | | |
| 15.4 | Android client connects to `192.168.1.100:8080` (the LAN target) | | |
| 15.5 | Android client sends CONNECT_OK back to server | | |
| 15.6 | HTTP response is relayed back to the external client | | |
| 15.7 | Response content matches the python HTTP server output | | |
| 15.8 | Subsequent requests also succeed | | |

```bash
# From external machine:
curl -x http://<block-proxy-ip>:8001 http://android-lan.example.com/

# Monitor reverse CONNECT on Android:
adb logcat | grep -i "CONNECT\|session\|relay"
```

---

## Vendor-Specific Notes / 厂商适配备注

Record any vendor-specific behavior observed during testing:

| Vendor / ROM | Issue Description | Severity | Workaround |
|-------------|-------------------|----------|------------|
| | | | |
| | | | |
| | | | |

**Common vendor issues to watch for:**

- **MIUI / HyperOS**: Aggressive background app killing; may require additional "auto-start" permission
- **ColorOS / RealmeUI**: May kill foreground services during screen-off; check "Allow background running" in app settings
- **HarmonyOS**: Different battery optimization behavior; may need manual whitelist
- **Samsung OneUI**: "Put apps to sleep" feature may interfere; check Settings → Battery → Background usage limits
- **Stock Android / Pixel**: Generally most compliant; use as baseline

---

## Power Consumption / 功耗观察

| Test Scenario | Duration | Battery Drain | Notes |
|--------------|----------|---------------|-------|
| Tunnel connected, screen off | 1 hour | | |
| Tunnel connected, screen off | 8 hours (overnight) | | |
| Active reverse CONNECT traffic | 30 min | | |
| Idle (tunnel connected, no traffic) | 4 hours | | |

---

## Unexpected Behavior Log / 异常行为记录

Record any behavior not covered by the test cases above:

| # | Description | Steps to Reproduce | Expected | Actual | Severity |
|---|------------|-------------------|----------|--------|----------|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |

---

## Key ADB Commands Reference / 常用 ADB 命令

```bash
# ── Service status ──
adb shell dumpsys activity services com.blockproxy.android

# ── WakeLock ──
adb shell dumpsys power | grep block-proxy

# ── Battery whitelist ──
adb shell dumpsys deviceidle whitelist | grep blockproxy

# ── VPN status ──
adb shell dumpsys connectivity | grep -A10 VPN

# ── App logs ──
adb logcat --pid=$(adb shell pidof com.blockproxy.android)

# ── Kill app (for TC-14) ──
adb shell am kill com.blockproxy.android

# ── Force stop ──
adb shell am force-stop com.blockproxy.android

# ── Check if app is running ──
adb shell pidof com.blockproxy.android

# ── Notification channels ──
adb shell dumpsys notification | grep -A5 tunnel_service

# ── Network info ──
adb shell dumpsys connectivity | grep -E "NetworkAgentInfo|Validated"
```

---

## Sign-off / 签收

| Role | Name | Date | Result |
|------|------|------|--------|
| Developer | | | ☐ All pass / ☐ Known issues |
| QA | | | ☐ All pass / ☐ Known issues |
| Reviewer | | | ☐ Approved / ☐ Needs fixes |
