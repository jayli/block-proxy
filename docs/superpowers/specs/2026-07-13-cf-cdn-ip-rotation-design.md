# CF CDN IP Rotation for Android Client Tunnel

**Date**: 2026-07-13
**Status**: Ready for implementation after plan review
**Scope**: Android client only (`android-client/`)

## Problem Statement

The Android client currently creates each tunnel WebSocket connection to `serverHost:serverPort`. NAT rotation replaces the TCP connection, so the local source port changes, but the peer address remains the same DNS-selected server IP. When the configured tunnel endpoint is behind Cloudflare CDN, this makes rotation less useful because repeated tunnel connections can still converge on the same Cloudflare edge IP.

## Goal

Add an opt-in CF CDN mode. When enabled, every newly established tunnel TCP connection can resolve `serverHost` to a client-managed Cloudflare edge IP selected from a curated good-IP pool. NAT rotation then rotates both:

- local source port, by creating a new TCP connection as today
- peer IP, by selecting the next Cloudflare edge IP through OkHttp DNS override

When CF CDN mode is disabled, behavior must remain identical to the current client.

## Non-Goals

- Do not change the tunnel server protocol.
- Do not connect to `wss://ip:port/...`; keep URL host as the configured domain.
- Do not bypass TLS SNI or Host header handling manually.
- Do not implement dynamic public scraping of IP lists in this change.
- Do not make CF refresh required for connecting; shipped seed IPs must be enough for first use.

## Architecture

Use a custom `okhttp3.Dns` implementation to override resolution only for `serverHost`. The WebSocket URL remains `wss://serverHost:serverPort/wsPath`, so OkHttp still uses the configured domain for SNI, certificate verification, and Host header. The custom DNS returns a selected Cloudflare edge IP as the resolved address.

The key implementation constraint is that `Dns.lookup()` is synchronous. It must not call suspend functions, block on DataStore, or do network work other than returning `InetAddress` objects. Therefore, the CF IP module keeps an in-memory snapshot of the good-IP pool and cursor for synchronous lookup, while persistence is loaded during initialization and written back asynchronously after selection changes.

## Compatibility Constraints

Cloudflare proxy mode only supports specific HTTP(S) ports. CF CDN mode must be treated as a TLS/HTTPS feature:

- `TunnelClient` already uses `wss://` and `https://` in the current implementation.
- CF CDN mode should require `useTls = true`.
- CF CDN mode should reject or warn on ports Cloudflare does not proxy for HTTPS.
- The speed tester must test the same peer port that tunnel connections will use, not a hard-coded `443`, unless the UI forces the tunnel port to `443`.

Recommended implementation rule:

```kotlin
val CLOUDFLARE_HTTPS_PORTS = setOf(443, 2053, 2083, 2087, 2096, 8443)
```

If `cfCdnEnabled == true` and `serverPort !in CLOUDFLARE_HTTPS_PORTS`, config save should fail or the UI should show an explicit validation error. The default `8003` port is not suitable for Cloudflare proxy mode.

## Components

### 1. `CfIpPool`

**Package**: `com.blockproxy.android.cdn`
**File**: `CfIpPool.kt`

Responsibilities:

- Load full CF IP list from `assets/cf-ips.txt`.
- Load good CF IP seed from `assets/cf-good-ips.txt` on first use.
- Save refreshed good IPs to `filesDir/cf-good-ips.txt`.
- Load and save cursor position using DataStore.
- Provide a synchronous immutable snapshot for DNS lookup.

Important: `CfIpPool` owns persistence, but `Dns.lookup()` must use a preloaded snapshot rather than calling DataStore directly.

```kotlin
data class CfIpSnapshot(
    val goodIps: List<String>,
    val cursor: Int,
) {
    fun normalizedCursor(): Int =
        if (goodIps.isEmpty()) 0 else ((cursor % goodIps.size) + goodIps.size) % goodIps.size
}

class CfIpPool(private val context: Context) {
    fun loadAllIps(): List<String>
    fun loadGoodIpsBlocking(): List<String>
    fun saveGoodIps(ips: List<String>)

    suspend fun loadCursor(): Int
    suspend fun saveCursor(index: Int)
    suspend fun loadSnapshot(): CfIpSnapshot
}
```

Implementation details:

- `loadGoodIpsBlocking()` first reads `filesDir/cf-good-ips.txt`.
- If the internal file is missing or empty, it reads `assets/cf-good-ips.txt` and copies that seed to internal storage.
- IP parsing trims whitespace and drops blank lines.
- If the refreshed pool size changes, cursor is normalized with modulo before use.
- Save refreshed good IPs atomically by writing a temp file and renaming it.

### 2. `CfIpSelector`

**Package**: `com.blockproxy.android.cdn`
**File**: `CfIpSelector.kt`

This is the synchronous state machine used by `CfIpDns`. It separates IP selection from OkHttp DNS so it can be unit-tested without Android or OkHttp.

Responsibilities:

- Hold current good-IP snapshot in memory.
- Select the current IP synchronously.
- Advance exactly once for each rotation or failed active reconnect.
- Persist cursor asynchronously through an injected callback.
- Track whether the next lookup should reuse the current IP or advance.
- Replace the in-memory snapshot when a refresh worker produces a new good-IP file.

```kotlin
class CfIpSelector(
    initialSnapshot: CfIpSnapshot,
    private val persistCursor: (Int) -> Unit,
) {
    fun currentIp(): String?
    fun selectForLookup(): String?
    fun forceNextOnNextLookup()
    fun markConnected()
    fun markActiveDisconnectedUnexpectedly()
    fun markCandidateFailed()
    fun markStoppedCleanly()
    fun replaceSnapshot(snapshot: CfIpSnapshot)
    fun getSelectedIp(): String?
}
```

State rules:

- First lookup uses the normalized current cursor, not cursor + 1.
- Successful auth calls `markConnected()` and future clean reconnects reuse the same IP.
- NAT rotation calls `forceNextOnNextLookup()` before creating the candidate connection. The following lookup advances exactly once.
- Unexpected disconnect of the active connection calls `markActiveDisconnectedUnexpectedly()`. The following lookup advances exactly once.
- Candidate connection failure calls `markCandidateFailed()`. This does not mark the active tunnel as failed; it only makes the next candidate lookup advance once.
- User stop calls `markStoppedCleanly()` and must not force an IP change.
- Replacing the good-IP snapshot normalizes cursor and preserves the selected IP if still present; otherwise it selects the normalized cursor.

### 3. `CfIpRuntimeRegistry`

**Package**: `com.blockproxy.android.cdn`
**File**: `CfIpRuntimeRegistry.kt`

This object bridges worker refresh completion to the currently running tunnel selector. It avoids hot-replacing `TunnelClient`: the service attaches the active `CfIpPool` and `CfIpSelector`, and refresh completion reloads the latest persisted snapshot into that selector.

```kotlin
object CfIpRuntimeRegistry {
    fun attach(pool: CfIpPool, selector: CfIpSelector)
    fun detach(selector: CfIpSelector)
    suspend fun reloadActiveSnapshot(): Boolean
}
```

Behavior:

- `BlockProxyVpnService.setupTunnel()` calls `attach(pool, selector)` when CF mode is enabled.
- Service stop/destroy calls `detach(selector)` so stale selectors are not updated after teardown.
- `CfIpRefreshWorker` calls `reloadActiveSnapshot()` after successfully saving a non-empty good-IP list.
- If the VPN service is not running, `reloadActiveSnapshot()` returns `false` and the new good-IP file is picked up on the next service start.
- `reloadActiveSnapshot()` must not interrupt the active WebSocket. It only affects future DNS lookups for reconnects or NAT rotation candidates.

### 4. `CfIpDns`

**Package**: `com.blockproxy.android.cdn`
**File**: `CfIpDns.kt`

Responsibilities:

- Implement `okhttp3.Dns`.
- Intercept only `serverHost`.
- Return `InetAddress` for the selected CF IP.
- Delegate non-server hostnames to `Dns.SYSTEM`.
- Fall back to `Dns.SYSTEM.lookup(serverHost)` if the CF pool is empty or the selected IP is invalid.

```kotlin
class CfIpDns(
    private val serverHost: String,
    private val selector: CfIpSelector,
    private val delegate: Dns = Dns.SYSTEM,
) : Dns {
    override fun lookup(hostname: String): List<InetAddress>
    fun getCurrentIp(): String?
}
```

`CfIpDns` should not own connection lifecycle decisions. `TunnelClient` calls lifecycle methods on `CfIpSelector`, because only `TunnelClient` knows whether a disconnect belongs to active, candidate, or draining WebSocket state.

### 5. `CfIpSpeedTester`

**Package**: `com.blockproxy.android.cdn`
**File**: `CfIpSpeedTester.kt`

Responsibilities:

- TCP-connect test all candidate CF IPs on the configured tunnel port.
- Call `VpnService.protect()` on every test socket when the VPN service provides a callback.
- Select top N by median connect latency.
- Save the selected IPs to `CfIpPool`.

```kotlin
class CfIpSpeedTester(
    private val ipPool: CfIpPool,
    private val testPort: Int,
    private val protect: ((Socket) -> Boolean)? = null,
    private val socketConnector: SocketConnector = RealSocketConnector(),
) {
    suspend fun runTest(onProgress: (tested: Int, total: Int) -> Unit = { _, _ -> }): List<String>
}
```

Parameters:

- `TOP_N = 50`
- `CONNECT_TIMEOUT_MS = 3000`
- `CONCURRENCY = 20`
- `TEST_ROUNDS = 2`
- `testPort = config.serverPort`

Behavior:

- Unreachable IPs are excluded.
- If fewer than 50 IPs are reachable, save all reachable IPs.
- If no IPs are reachable, do not overwrite the previous good-IP file with an empty list.
- Progress is reported as WorkManager progress for manual refresh UI.

### 6. `CfIpRefreshWorker`

**Package**: `com.blockproxy.android.cdn`
**File**: `CfIpRefreshWorker.kt`

Responsibilities:

- Run `CfIpSpeedTester`.
- Support periodic daily refresh.
- Support one-time manual refresh.
- Publish progress and final selected count through WorkManager output data.
- Reload the active selector snapshot after a successful refresh when the VPN service is currently running.

Scheduling policy:

- Schedule/cancel when config is saved in `TunnelViewModel`.
- Reconcile again in `BlockProxyVpnService.setupTunnel()` so service start is idempotent after process death.
- Do not schedule unconditionally in `BlockProxyVpnService.onCreate()`, because config is not loaded there.
- Do not cancel periodic refresh merely because the VPN service stops; the schedule should follow config, not service lifecycle.

Worker input data:

- `server_port`: the configured tunnel port to test.

Worker output data:

- `selected_count`: number of selected good IPs.
- `applied_to_running_tunnel`: boolean indicating whether `CfIpRuntimeRegistry.reloadActiveSnapshot()` updated a live selector.

### 7. `TunnelClient` Integration

`TunnelClient` receives optional CF dependencies:

```kotlin
class TunnelClient(
    private val config: ServerConfig,
    private val credentials: TunnelCredentials,
    private val targetSocketFactory: TargetSocketFactory,
    private val clientScope: CoroutineScope,
    private val protect: ((Socket) -> Boolean)? = null,
    private val cfIpDns: CfIpDns? = null,
    private val cfIpSelector: CfIpSelector? = null,
    private val onCfIpChanged: (String?) -> Unit = {},
)
```

Connection setup:

- Build a per-connection OkHttp client with `.dns(cfIpDns)` when CF mode is enabled.
- Use the same CF-aware client for HTTP disguise requests, or explicitly disable disguise in CF mode. The preferred behavior is to use the same CF DNS for both disguise and WebSocket so both connect to the selected peer IP.
- After WebSocket AUTH_OK, call `cfIpSelector.markConnected()` and `onCfIpChanged(cfIpDns.getCurrentIp())`.

Sender-aware lifecycle:

- Active unexpected disconnect advances on the next reconnect.
- Candidate connection failure calls `markCandidateFailed()` and affects only the next candidate lookup; it must not mark the current active connection as failed.
- Draining connection close during rotation must not mark CF selection as failed.
- User stop is clean and must not force an IP change.

`TunnelClient` already tracks `activeWs`, `candidateWs`, and `drainingWs`; CF lifecycle updates must be based on those sender identities.

### 8. Config Changes

`ServerConfig.kt`:

```kotlin
data class ServerConfig(
    val serverHost: String,
    val serverPort: Int = DEFAULT_PORT,
    val useTls: Boolean = true,
    val allowInsecure: Boolean = true,
    val wsPath: String = "/websocket",
    val httpDisguise: Boolean = true,
    val customHeaders: Map<String, String> = emptyMap(),
    val cfCdnEnabled: Boolean = false,
)
```

`ConfigRepository`:

- Persist `cf_cdn_enabled`.
- Validate that CF mode requires TLS and a Cloudflare-supported HTTPS port.

### 9. UI and Runtime Status

`StatusStore` should expose CF IP as observable state, not as a plain volatile field.

```kotlin
data class RuntimeStatus(
    val tunnelStatus: TunnelStatus = TunnelStatus.Disconnected,
    val currentCfIp: String? = null,
)
```

Acceptable alternatives:

- Replace `StatusStore.status` with `StateFlow<RuntimeStatus>`.
- Or keep existing `status: StateFlow<TunnelStatus>` and add `currentCfIp: StateFlow<String?>`.

The UI must collect the CF IP flow so Compose recomposes when rotation changes the peer IP.

Config screen:

- Add switch: `使用 Cloudflare CDN`.
- When enabled, require TLS and validate the port.
- Add manual refresh button.
- Show refresh progress and final selected count.
- After refresh succeeds, show whether the refreshed pool was applied to the running tunnel selector or will take effect on the next start.

Main screen:

- When connected with CF mode enabled and `currentCfIp != null`, display:
  - `已连接 · 104.16.4.14:443 (CF)`
- Otherwise display current `host:port`.

## Connection Flow Summary

First connection:

```text
setupTunnel()
  -> CfIpPool.loadSnapshot()
  -> CfIpSelector(snapshot)
  -> Dns.lookup(serverHost) returns snapshot.goodIps[cursor]
  -> WebSocket connects to selectedIp:serverPort with SNI=serverHost
  -> AUTH_OK
  -> selector.markConnected()
  -> StatusStore.currentCfIp emits selectedIp
```

NAT rotation:

```text
rotationCycle()
  -> selector.forceNextOnNextLookup()
  -> candidate establishConnection()
  -> Dns.lookup(serverHost) advances cursor exactly once and returns next IP
  -> candidate AUTH_OK
  -> selector.markConnected()
  -> active = candidate, old active = draining
  -> old draining close does not affect selector
```

Active unexpected disconnect:

```text
active onFailure/onClosed unexpectedly
  -> selector.markActiveDisconnectedUnexpectedly()
  -> mainLoop reconnect
  -> next Dns.lookup advances cursor exactly once
```

Clean stop:

```text
stop()
  -> selector.markStoppedCleanly()
  -> close all senders
  -> current CF IP cleared from StatusStore
  -> next user start reuses current cursor unless rotation/failure changed it
```

Empty CF pool:

```text
Dns.lookup(serverHost)
  -> selector.selectForLookup() returns null
  -> delegate to Dns.SYSTEM.lookup(serverHost)
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| `cf-good-ips.txt` missing | Copy initial seed from assets on first use |
| Good IP pool empty | Fall back to `Dns.SYSTEM` |
| All refresh probes fail | Keep previous good-IP file; worker returns failure/retry |
| Worker killed during test | WorkManager retries based on backoff |
| Manual refresh no network | Work waits for `NetworkType.CONNECTED` |
| Cursor out of bounds after pool update | Normalize cursor with modulo |
| CF enabled with unsupported port | Config save rejected or UI validation blocks save |
| CF disabled after enabled | Cancel periodic worker, clear runtime CF IP, pass `cfIpDns = null` |
| Candidate rotation fails | Keep old active connection; next candidate may try next IP |
| Draining connection closes | Do not mark current CF IP failed |
| Refresh completes while tunnel is running | Reload the active selector snapshot; future candidates/reconnects use the refreshed pool |
| Refresh completes while tunnel is stopped | Persist refreshed file; next tunnel start loads it |

## Testing

Unit tests:

- `CfIpPool`: parsing, seed fallback, internal file preference, cursor persistence.
- `CfIpSelector`: first lookup, clean reuse, rotation advances exactly once, active failure advances exactly once, draining close ignored, snapshot replacement.
- `CfIpRuntimeRegistry`: attach/detach active selector, reload active snapshot, no-op when stopped.
- `CfIpDns`: intercept server host only, delegate non-server host, fallback on empty/invalid pool.
- `CfIpSpeedTester`: uses configured port, protects sockets, excludes failures, preserves old file on zero reachable IPs.
- `ConfigRepository`: persists `cfCdnEnabled`, rejects unsupported CF config.
- `StatusStore`: CF IP emits through `StateFlow`.

Integration tests:

- CF disabled: no DNS override and existing tunnel tests still pass.
- CF enabled: WebSocket and HTTP disguise use CF-aware DNS.
- NAT rotation: candidate uses a different peer IP, old active drains normally.
- Candidate failure: old active remains connected and UI keeps old CF IP.
- Active failure: reconnect attempts the next CF IP.
- Clean stop/restart: no forced cursor advance.

## Files Changed

### New Files

| File | Purpose |
|------|---------|
| `app/src/main/java/com/blockproxy/android/cdn/CfIpPool.kt` | IP list loading, seed fallback, cursor persistence |
| `app/src/main/java/com/blockproxy/android/cdn/CfIpSelector.kt` | Synchronous in-memory IP selection state machine |
| `app/src/main/java/com/blockproxy/android/cdn/CfIpRuntimeRegistry.kt` | Apply refreshed snapshots to a live selector |
| `app/src/main/java/com/blockproxy/android/cdn/CfIpDns.kt` | OkHttp DNS implementation |
| `app/src/main/java/com/blockproxy/android/cdn/CfIpSpeedTester.kt` | TCP connect latency measurement |
| `app/src/main/java/com/blockproxy/android/cdn/CfIpRefreshWorker.kt` | WorkManager scheduled/manual refresh |
| `app/src/main/assets/cf-ips.txt` | Full CF IP list |
| `app/src/main/assets/cf-good-ips.txt` | Initial good-IP seed |

### Modified Files

| File | Change |
|------|--------|
| `config/ServerConfig.kt` | Add `cfCdnEnabled` |
| `config/ConfigRepository.kt` | Persist and validate CF config |
| `status/StatusStore.kt` | Add observable CF IP state |
| `tunnel/TunnelClient.kt` | Inject CF DNS/selector and sender-aware lifecycle callbacks |
| `service/BlockProxyVpnService.kt` | Create CF dependencies, reconcile worker schedule, update runtime CF IP |
| `ui/TunnelViewModel.kt` | CF config state, manual refresh state, worker scheduling |
| `ui/ConfigScreen.kt` | CF switch, port validation, refresh controls |
| `ui/MainScreen.kt` | Show current CF IP when connected |
