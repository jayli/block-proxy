# CF CDN IP Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in Cloudflare CDN IP rotation to the Android tunnel client so NAT rotation can change both local source port and peer CF edge IP.

**Architecture:** Keep WebSocket URLs domain-based (`wss://serverHost:serverPort/wsPath`) and inject CF edge IPs through OkHttp `Dns`. Use a synchronous in-memory `CfIpSelector` for `Dns.lookup()`, with `CfIpPool` handling asset/internal-file/DataStore persistence outside the lookup path. `TunnelClient` owns sender-aware lifecycle events so active, candidate, and draining connections do not corrupt IP selection state.

**Tech Stack:** Kotlin, OkHttp `Dns`, Jetpack DataStore, WorkManager, Compose, JUnit4, kotlinx-coroutines-test, Turbine.

---

## Global Constraints

- `cfCdnEnabled` defaults to `false`; all current behavior must remain unchanged when disabled.
- `Dns.lookup()` must be synchronous and must not call suspend functions or DataStore directly.
- CF CDN mode requires TLS and a Cloudflare-supported HTTPS port.
- Speed tests must use the configured tunnel port, not a hard-coded `443`.
- Every speed-test socket must call `VpnService.protect()` when a protect callback is available.
- NAT rotation must advance the CF cursor exactly once per candidate connection attempt.
- Draining WebSocket closure during rotation must not be treated as a CF IP failure.
- Runtime CF IP exposed to Compose must be observable through `StateFlow`.
- The periodic refresh worker follows saved config, not VPN service lifecycle.
- For Tasks 4-8, the listed test bullets are required acceptance cases. The implementing worker must write concrete failing test code for each bullet before implementation, even when this plan does not inline every full test body.

Supported HTTPS ports for CF mode:

```kotlin
val CLOUDFLARE_HTTPS_PORTS = setOf(443, 2053, 2083, 2087, 2096, 8443)
```

---

## File Structure

### New Files

| File | Responsibility |
|------|----------------|
| `app/src/main/java/com/blockproxy/android/cdn/CfIpPool.kt` | Load asset/internal IP lists and persist cursor |
| `app/src/main/java/com/blockproxy/android/cdn/CfIpSelector.kt` | Synchronous in-memory IP selection state machine |
| `app/src/main/java/com/blockproxy/android/cdn/CfIpRuntimeRegistry.kt` | Apply refreshed snapshots to the live selector |
| `app/src/main/java/com/blockproxy/android/cdn/CfIpDns.kt` | OkHttp DNS wrapper for `serverHost` |
| `app/src/main/java/com/blockproxy/android/cdn/CfIpSpeedTester.kt` | TCP connect speed test on configured port |
| `app/src/main/java/com/blockproxy/android/cdn/CfIpRefreshWorker.kt` | WorkManager periodic/manual refresh |
| `app/src/main/assets/cf-ips.txt` | Full CF IP candidate list |
| `app/src/main/assets/cf-good-ips.txt` | Seed good-IP list |
| `app/src/test/java/com/blockproxy/android/cdn/CfIpPoolTest.kt` | Pool parsing/persistence tests |
| `app/src/test/java/com/blockproxy/android/cdn/CfIpSelectorTest.kt` | Selection state-machine tests |
| `app/src/test/java/com/blockproxy/android/cdn/CfIpRuntimeRegistryTest.kt` | Runtime snapshot reload tests |
| `app/src/test/java/com/blockproxy/android/cdn/CfIpDnsTest.kt` | DNS interception/fallback tests |
| `app/src/test/java/com/blockproxy/android/cdn/CfIpSpeedTesterTest.kt` | Speed tester behavior tests |

### Modified Files

| File | Change |
|------|--------|
| `app/src/main/java/com/blockproxy/android/config/ServerConfig.kt` | Add `cfCdnEnabled` |
| `app/src/main/java/com/blockproxy/android/config/ConfigRepository.kt` | Persist and validate CF config |
| `app/src/main/java/com/blockproxy/android/status/StatusStore.kt` | Add observable current CF IP |
| `app/src/main/java/com/blockproxy/android/tunnel/TunnelClient.kt` | Inject DNS/selector; sender-aware lifecycle |
| `app/src/main/java/com/blockproxy/android/service/BlockProxyVpnService.kt` | Create CF dependencies and reconcile worker schedule |
| `app/src/main/java/com/blockproxy/android/ui/TunnelViewModel.kt` | Config state, manual refresh state, worker scheduling |
| `app/src/main/java/com/blockproxy/android/ui/ConfigScreen.kt` | CF switch, validation, refresh UI |
| `app/src/main/java/com/blockproxy/android/ui/MainScreen.kt` | Show current CF IP |
| `app/src/main/java/com/blockproxy/android/MainActivity.kt` | Wire new UI parameters |

---

## Task 1: Config Field and Validation

**Files:**
- Modify: `app/src/main/java/com/blockproxy/android/config/ServerConfig.kt`
- Modify: `app/src/main/java/com/blockproxy/android/config/ConfigRepository.kt`
- Test: `app/src/test/java/com/blockproxy/android/config/ConfigRepositoryTest.kt`

**Interfaces:**
- Produces `ServerConfig.cfCdnEnabled: Boolean = false`
- Produces validation for CF mode: TLS required and port must be in the supported HTTPS set

- [ ] **Step 1: Write failing tests**

Add tests to `ConfigRepositoryTest.kt`:

```kotlin
@Test
fun `save and observe preserves cfCdnEnabled`() = scope.runTest {
    repository.observe().test {
        assertNull(awaitItem())

        repository.save(
            ServerConfig(
                serverHost = "example.com",
                serverPort = 443,
                useTls = true,
                cfCdnEnabled = true,
            )
        )

        assertEquals(true, awaitItem()?.cfCdnEnabled)
        cancelAndConsumeRemainingEvents()
    }
}

@Test
fun `cfCdnEnabled defaults to false`() = scope.runTest {
    repository.save(ServerConfig(serverHost = "example.com"))

    repository.observe().test {
        assertEquals(false, awaitItem()?.cfCdnEnabled)
        cancelAndConsumeRemainingEvents()
    }
}

@Test
fun `cf cdn requires tls`() = scope.runTest {
    assertFailsWith<IllegalArgumentException> {
        repository.save(
            ServerConfig(
                serverHost = "example.com",
                serverPort = 443,
                useTls = false,
                cfCdnEnabled = true,
            )
        )
    }
}

@Test
fun `cf cdn rejects unsupported port`() = scope.runTest {
    assertFailsWith<IllegalArgumentException> {
        repository.save(
            ServerConfig(
                serverHost = "example.com",
                serverPort = 8003,
                useTls = true,
                cfCdnEnabled = true,
            )
        )
    }
}
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.config.ConfigRepositoryTest"
```

Expected: FAIL because `cfCdnEnabled` and validation are not implemented.

- [ ] **Step 3: Add config field**

Add to `ServerConfig` after `customHeaders`:

```kotlin
val cfCdnEnabled: Boolean = false,
```

- [ ] **Step 4: Add repository validation and persistence**

In `ConfigRepository.save()`:

```kotlin
private val cloudflareHttpsPorts = setOf(443, 2053, 2083, 2087, 2096, 8443)

suspend fun save(config: ServerConfig) {
    require(config.serverHost.isNotBlank()) { "serverHost must not be blank" }
    require(config.serverPort in 1..65535) { "serverPort must be in 1..65535" }
    if (config.cfCdnEnabled) {
        require(config.useTls) { "Cloudflare CDN mode requires TLS" }
        require(config.serverPort in cloudflareHttpsPorts) {
            "Cloudflare CDN mode requires a Cloudflare HTTPS proxy port"
        }
    }
    source.save(config)
}
```

In `DataStoreConfigDataSource`, add:

```kotlin
val KEY_CF_CDN_ENABLED = booleanPreferencesKey("cf_cdn_enabled")
```

Read/write `cfCdnEnabled` alongside existing fields.

- [ ] **Step 5: Verify**

Run:

```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.config.ConfigRepositoryTest"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/config android-client/app/src/test/java/com/blockproxy/android/config
git commit -m "feat(android): add CF CDN config validation"
```

---

## Task 2: StatusStore Observable CF IP

**Files:**
- Modify: `app/src/main/java/com/blockproxy/android/status/StatusStore.kt`
- Test: `app/src/test/java/com/blockproxy/android/status/StatusStoreTest.kt`

**Interfaces:**
- Produces `currentCfIp: StateFlow<String?>`
- Produces `updateCfIp(ip: String?)`

- [ ] **Step 1: Write failing tests**

Create or update `StatusStoreTest.kt`:

```kotlin
@Test
fun `currentCfIp defaults to null`() {
    val store = StatusStore()
    assertNull(store.currentCfIp.value)
}

@Test
fun `updateCfIp emits value`() = runTest {
    val store = StatusStore()
    store.currentCfIp.test {
        assertNull(awaitItem())
        store.updateCfIp("104.16.4.14")
        assertEquals("104.16.4.14", awaitItem())
        cancelAndConsumeRemainingEvents()
    }
}

@Test
fun `update disconnected clears cf ip`() = runTest {
    val store = StatusStore()
    store.updateCfIp("104.16.4.14")
    store.updateCfIp(null)
    assertNull(store.currentCfIp.value)
}
```

- [ ] **Step 2: Run failing tests**

```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.status.StatusStoreTest"
```

Expected: FAIL because `currentCfIp` is missing.

- [ ] **Step 3: Implement observable CF IP**

Add to `StatusStore`:

```kotlin
private val _currentCfIp = MutableStateFlow<String?>(null)
val currentCfIp: StateFlow<String?> = _currentCfIp.asStateFlow()

fun updateCfIp(ip: String?) {
    _currentCfIp.value = ip
}
```

Keep existing `status: StateFlow<TunnelStatus>` unchanged for minimal blast radius.

- [ ] **Step 4: Verify**

```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.status.StatusStoreTest"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/status android-client/app/src/test/java/com/blockproxy/android/status
git commit -m "feat(android): expose current CF IP as observable status"
```

---

## Task 3: Asset Files

**Files:**
- Create: `app/src/main/assets/cf-ips.txt`
- Create: `app/src/main/assets/cf-good-ips.txt`

- [ ] **Step 1: Copy assets**

```bash
mkdir -p android-client/app/src/main/assets
cp android-client/data/cf-ips.txt android-client/app/src/main/assets/cf-ips.txt
cp android-client/data/cf-good-ips.txt android-client/app/src/main/assets/cf-good-ips.txt
```

- [ ] **Step 2: Verify counts**

```bash
wc -l android-client/app/src/main/assets/cf-ips.txt android-client/app/src/main/assets/cf-good-ips.txt
```

Expected: approximately `680` full IPs and `50` good seed IPs.

- [ ] **Step 3: Commit**

```bash
git add android-client/app/src/main/assets
git commit -m "feat(android): add Cloudflare IP seed assets"
```

---

## Task 4: CfIpPool Persistence

**Files:**
- Create: `app/src/main/java/com/blockproxy/android/cdn/CfIpPool.kt`
- Test: `app/src/test/java/com/blockproxy/android/cdn/CfIpPoolTest.kt`

**Interfaces:**

```kotlin
data class CfIpSnapshot(
    val goodIps: List<String>,
    val cursor: Int,
)

class CfIpPool(private val context: Context) {
    fun loadAllIps(): List<String>
    fun loadGoodIpsBlocking(): List<String>
    fun saveGoodIps(ips: List<String>)
    suspend fun loadCursor(): Int
    suspend fun saveCursor(index: Int)
    suspend fun loadSnapshot(): CfIpSnapshot
}
```

- [ ] **Step 1: Write failing tests**

Cover these cases in `CfIpPoolTest.kt`:

- parses lists by trimming whitespace and dropping blank lines
- reads internal `filesDir/cf-good-ips.txt` before asset seed
- copies seed asset to internal file when internal file is missing
- persists and loads cursor
- `loadSnapshot()` returns good IPs and cursor
- `saveGoodIps(emptyList())` is allowed only when explicitly called by tests; speed tester must avoid overwriting with empty results

- [ ] **Step 2: Run failing tests**

```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.cdn.CfIpPoolTest"
```

Expected: FAIL because `CfIpPool` does not exist.

- [ ] **Step 3: Implement `CfIpPool`**

Implementation requirements:

- Use `preferencesDataStore(name = "cf_ip_prefs")`.
- Store cursor under `cf_ip_cursor`.
- Use constants:
  - `ASSET_ALL_IPS = "cf-ips.txt"`
  - `ASSET_GOOD_IPS = "cf-good-ips.txt"`
  - `GOOD_IPS_FILENAME = "cf-good-ips.txt"`
- `saveGoodIps()` writes atomically:
  - write `cf-good-ips.txt.tmp`
  - rename to `cf-good-ips.txt`
- `loadGoodIpsBlocking()` can use blocking file/asset reads because it is called outside OkHttp DNS lookup during setup/worker paths.

- [ ] **Step 4: Verify**

```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.cdn.CfIpPoolTest"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/cdn/CfIpPool.kt android-client/app/src/test/java/com/blockproxy/android/cdn/CfIpPoolTest.kt
git commit -m "feat(android): add CF IP pool persistence"
```

---

## Task 5: CfIpSelector State Machine

**Files:**
- Create: `app/src/main/java/com/blockproxy/android/cdn/CfIpSelector.kt`
- Create: `app/src/main/java/com/blockproxy/android/cdn/CfIpRuntimeRegistry.kt`
- Test: `app/src/test/java/com/blockproxy/android/cdn/CfIpSelectorTest.kt`
- Test: `app/src/test/java/com/blockproxy/android/cdn/CfIpRuntimeRegistryTest.kt`

**Interfaces:**

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

object CfIpRuntimeRegistry {
    fun attach(pool: CfIpPool, selector: CfIpSelector)
    fun detach(selector: CfIpSelector)
    suspend fun reloadActiveSnapshot(): Boolean
}
```

- [ ] **Step 1: Write failing tests**

Cover:

- first `selectForLookup()` returns cursor IP without advancing
- repeated lookup after `markConnected()` returns same IP
- `forceNextOnNextLookup()` advances exactly once
- `markActiveDisconnectedUnexpectedly()` advances exactly once on the next lookup
- `markCandidateFailed()` advances exactly once on the next lookup without implying active failure
- `markStoppedCleanly()` does not force advancement
- empty pool returns null
- cursor wraps around
- `replaceSnapshot()` normalizes cursor and preserves current IP if still present
- `persistCursor` is called only when cursor changes
- runtime registry attaches a pool/selector pair and calls `replaceSnapshot()` on reload
- runtime registry `reloadActiveSnapshot()` returns `false` when nothing is attached
- runtime registry `detach(selector)` does not detach a newer selector if an old selector calls detach late

- [ ] **Step 2: Run failing tests**

```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.cdn.CfIpSelectorTest"
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.cdn.CfIpRuntimeRegistryTest"
```

Expected: FAIL because `CfIpSelector` and `CfIpRuntimeRegistry` do not exist.

- [ ] **Step 3: Implement `CfIpSelector`**

Implementation guidance:

- Use a private lock or `@Synchronized` on public methods; OkHttp may call DNS on background threads.
- Store:
  - `goodIps: List<String>`
  - `cursor: Int`
  - `advanceOnNextLookup: Boolean`
  - `selectedIp: String?`
- `selectForLookup()`:
  - returns null when `goodIps` empty
  - advances cursor only when `advanceOnNextLookup == true`
  - clears `advanceOnNextLookup` after applying it
  - persists cursor only if it changed
- `markCandidateFailed()` should set the same `advanceOnNextLookup` flag as active failure, but it must remain a separate method for clearer lifecycle semantics.

- [ ] **Step 4: Implement `CfIpRuntimeRegistry`**

Implementation guidance:

- Store the active `CfIpPool` and `CfIpSelector` behind a private lock.
- `attach(pool, selector)` replaces the active pair.
- `detach(selector)` clears the active pair only if the attached selector is the same instance.
- `reloadActiveSnapshot()`:
  - copies the active pair under lock
  - returns `false` if no pair is attached
  - calls `pool.loadSnapshot()`
  - calls `selector.replaceSnapshot(snapshot)`
  - returns `true`

- [ ] **Step 5: Verify**

```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.cdn.CfIpSelectorTest"
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.cdn.CfIpRuntimeRegistryTest"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/cdn/CfIpSelector.kt android-client/app/src/main/java/com/blockproxy/android/cdn/CfIpRuntimeRegistry.kt android-client/app/src/test/java/com/blockproxy/android/cdn/CfIpSelectorTest.kt android-client/app/src/test/java/com/blockproxy/android/cdn/CfIpRuntimeRegistryTest.kt
git commit -m "feat(android): add CF IP selector runtime state"
```

---

## Task 6: CfIpDns

**Files:**
- Create: `app/src/main/java/com/blockproxy/android/cdn/CfIpDns.kt`
- Test: `app/src/test/java/com/blockproxy/android/cdn/CfIpDnsTest.kt`

**Interfaces:**

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

- [ ] **Step 1: Write failing tests**

Cover:

- non-server host delegates to injected delegate
- server host uses selector IP
- empty selector result falls back to delegate
- invalid IP falls back to delegate
- `lookup()` does not use `runBlocking` or suspend APIs

- [ ] **Step 2: Run failing tests**

```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.cdn.CfIpDnsTest"
```

Expected: FAIL because `CfIpDns` does not exist.

- [ ] **Step 3: Implement `CfIpDns`**

Implementation requirements:

- Compare hostnames case-insensitively.
- Convert selected IP with `InetAddress.getByName(ip)`.
- Catch `IllegalArgumentException` / `UnknownHostException` and delegate to system DNS.
- Do not mutate cursor except through `selector.selectForLookup()`.

- [ ] **Step 4: Verify**

```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.cdn.CfIpDnsTest"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/cdn/CfIpDns.kt android-client/app/src/test/java/com/blockproxy/android/cdn/CfIpDnsTest.kt
git commit -m "feat(android): add CF-aware OkHttp DNS"
```

---

## Task 7: CfIpSpeedTester

**Files:**
- Create: `app/src/main/java/com/blockproxy/android/cdn/CfIpSpeedTester.kt`
- Test: `app/src/test/java/com/blockproxy/android/cdn/CfIpSpeedTesterTest.kt`

**Interfaces:**

```kotlin
interface SocketConnector {
    fun connect(ip: String, port: Int, timeoutMs: Int, protect: ((Socket) -> Boolean)?): Long?
}

class CfIpSpeedTester(
    private val ipPool: CfIpPool,
    private val testPort: Int,
    private val protect: ((Socket) -> Boolean)? = null,
    private val socketConnector: SocketConnector = RealSocketConnector(),
) {
    suspend fun runTest(onProgress: (tested: Int, total: Int) -> Unit = { _, _ -> }): List<String>
}
```

- [ ] **Step 1: Write failing tests**

Cover:

- uses `testPort` passed by caller
- calls connector once per IP per round
- calls protect through connector for real sockets
- selects top 50 by median latency
- excludes unreachable IPs
- reports progress for all tested IPs
- does not overwrite existing good-IP file when no IP is reachable

- [ ] **Step 2: Run failing tests**

```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.cdn.CfIpSpeedTesterTest"
```

Expected: FAIL because `CfIpSpeedTester` does not exist.

- [ ] **Step 3: Implement `CfIpSpeedTester`**

Implementation requirements:

- `TOP_N = 50`
- `CONNECT_TIMEOUT_MS = 3000`
- `CONCURRENCY = 20`
- `TEST_ROUNDS = 2`
- Use `Semaphore(CONCURRENCY)`.
- Use `Dispatchers.IO` for socket work.
- Return selected IPs sorted by latency.
- Only call `ipPool.saveGoodIps(topIps)` when `topIps.isNotEmpty()`.

- [ ] **Step 4: Verify**

```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.cdn.CfIpSpeedTesterTest"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/cdn/CfIpSpeedTester.kt android-client/app/src/test/java/com/blockproxy/android/cdn/CfIpSpeedTesterTest.kt
git commit -m "feat(android): add CF IP speed tester"
```

---

## Task 8: CfIpRefreshWorker

**Files:**
- Create: `app/src/main/java/com/blockproxy/android/cdn/CfIpRefreshWorker.kt`
- Test: `app/src/test/java/com/blockproxy/android/cdn/CfIpRefreshWorkerTest.kt`

**Interfaces:**
- `schedule(context, serverPort)`
- `cancelSchedule(context)`
- `refreshNow(context, serverPort): UUID`
- `workInfoFlow(context, id): Flow<WorkInfo?>` or ViewModel-level WorkManager observation
- input key `server_port`
- output key `selected_count`

- [ ] **Step 1: Write tests for request construction helpers**

Cover:

- periodic request includes `NetworkType.CONNECTED`
- one-time request includes `server_port`
- `calculateDelayToNext4Am()` returns a positive delay no greater than 24 hours

- [ ] **Step 2: Run failing tests**

```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.cdn.CfIpRefreshWorkerTest"
```

Expected: FAIL because worker/helpers do not exist.

- [ ] **Step 3: Implement worker**

Implementation requirements:

- `doWork()` reads `server_port`; if missing, return `Result.failure()`.
- Create `CfIpSpeedTester(ipPool, testPort = serverPort, protect = null)`.
- Call `setProgress(workDataOf("tested" to tested, "total" to total))`.
- On success with at least one selected IP:
  - call `val applied = CfIpRuntimeRegistry.reloadActiveSnapshot()`
  - return `Result.success(workDataOf("selected_count" to topIps.size, "applied_to_running_tunnel" to applied))`
- On zero selected IPs, return `Result.retry()` and keep previous good-IP file.
- Configure exponential backoff.
- Tests must assert that the success output includes both `selected_count` and `applied_to_running_tunnel`.

- [ ] **Step 4: Verify**

```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.cdn.CfIpRefreshWorkerTest"
./gradlew :app:compileDebugKotlin
```

Expected: PASS and build success.

- [ ] **Step 5: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/cdn/CfIpRefreshWorker.kt android-client/app/src/test/java/com/blockproxy/android/cdn/CfIpRefreshWorkerTest.kt
git commit -m "feat(android): add CF IP refresh worker"
```

---

## Task 9: TunnelClient CF Integration

**Files:**
- Modify: `app/src/main/java/com/blockproxy/android/tunnel/TunnelClient.kt`
- Test: existing tunnel tests plus focused new tests if feasible

**Interfaces:**
- Optional constructor parameters: `cfIpDns`, `cfIpSelector`, `onCfIpChanged`
- WebSocket and HTTP disguise both use CF-aware OkHttp client when enabled

- [ ] **Step 1: Add regression tests or test hooks**

Cover through unit tests where the current test harness permits:

- CF disabled uses original `okHttpClient`
- CF enabled builds client with custom DNS
- `forceNextOnNextLookup()` is called once before rotation candidate
- candidate failure does not close or mark old active failed
- candidate failure calls `markCandidateFailed()`, not `markActiveDisconnectedUnexpectedly()`
- active unexpected disconnect marks selector for next lookup
- draining close does not mark selector failed

If direct unit testing is too invasive, add narrow package-private hooks and document why.

- [ ] **Step 2: Add constructor parameters**

```kotlin
private val cfIpDns: CfIpDns? = null,
private val cfIpSelector: CfIpSelector? = null,
private val onCfIpChanged: (String?) -> Unit = {},
```

- [ ] **Step 3: Use CF-aware client consistently**

Create a helper:

```kotlin
private fun connectionClient(): OkHttpClient =
    if (cfIpDns != null) okHttpClient.newBuilder().dns(cfIpDns).build() else okHttpClient
```

Use it for:

- `performHttpDisguise()`
- `TunnelWebSocket.connect()`

- [ ] **Step 4: Mark auth success**

In `onAuthSuccess`:

```kotlin
frameChannels[sender] = frameChannel
cfIpSelector?.markConnected()
onCfIpChanged(cfIpDns?.getCurrentIp())
```

- [ ] **Step 5: Make disconnect handling sender-aware**

In `onDisconnect`, close the frame channel as today, then classify:

- if `stopped == true`: do not mark failure
- if `sender === activeWs` and `error != null`: `cfIpSelector?.markActiveDisconnectedUnexpectedly()`
- if `sender === candidateWs`: candidate failed; call `cfIpSelector?.markCandidateFailed()` so the next candidate lookup tries another IP, but do not clear active status
- if `sender === drainingWs`: do nothing to CF selector

Avoid calling a global `markDisconnected(false)` from every WebSocket callback.

- [ ] **Step 6: Update rotation**

Before candidate `establishConnection()`:

```kotlin
cfIpSelector?.forceNextOnNextLookup()
```

Do not also advance in any other rotation path.

- [ ] **Step 7: Update stop**

At the start of `stop()`:

```kotlin
cfIpSelector?.markStoppedCleanly()
onCfIpChanged(null)
```

- [ ] **Step 8: Verify**

```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.tunnel.*"
./gradlew :app:compileDebugKotlin
```

Expected: PASS and build success.

- [ ] **Step 9: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelClient.kt
git commit -m "feat(android): integrate CF DNS into tunnel lifecycle"
```

---

## Task 10: BlockProxyVpnService Integration

**Files:**
- Modify: `app/src/main/java/com/blockproxy/android/service/BlockProxyVpnService.kt`

**Interfaces:**
- Creates `CfIpPool`, `CfIpSelector`, `CfIpDns`
- Passes `onCfIpChanged = statusStore::updateCfIp`
- Reconciles worker schedule based on saved config
- Stores the active selector in a service field so teardown can detach it from `CfIpRuntimeRegistry`

- [ ] **Step 1: Add imports**

```kotlin
import com.blockproxy.android.cdn.CfIpDns
import com.blockproxy.android.cdn.CfIpPool
import com.blockproxy.android.cdn.CfIpRefreshWorker
import com.blockproxy.android.cdn.CfIpRuntimeRegistry
import com.blockproxy.android.cdn.CfIpSelector
```

- [ ] **Step 2: Add service fields**

Add nullable fields to `BlockProxyVpnService`:

```kotlin
private var cfIpPool: CfIpPool? = null
private var cfIpSelector: CfIpSelector? = null
```

- [ ] **Step 3: Build CF dependencies after config load**

In `setupTunnel()`, after config validation and protect callback creation:

```kotlin
cfIpPool = if (config.cfCdnEnabled) CfIpPool(applicationContext) else null
cfIpSelector = cfIpPool?.let { pool ->
    val snapshot = pool.loadSnapshot()
    CfIpSelector(snapshot) { cursor ->
        serviceScope?.launch { pool.saveCursor(cursor) }
    }
}
val cfIpDns = cfIpSelector?.let { selector ->
    CfIpDns(config.serverHost, selector)
}
if (cfIpPool != null && cfIpSelector != null) {
    CfIpRuntimeRegistry.attach(cfIpPool, cfIpSelector)
}
```

- [ ] **Step 4: Reconcile worker schedule**

In `setupTunnel()`:

```kotlin
if (config.cfCdnEnabled) {
    CfIpRefreshWorker.schedule(applicationContext, config.serverPort)
} else {
    CfIpRefreshWorker.cancelSchedule(applicationContext)
    cfIpSelector?.let { CfIpRuntimeRegistry.detach(it) }
    cfIpPool = null
    cfIpSelector = null
    statusStore.updateCfIp(null)
}
```

Do not cancel the CF refresh worker from the normal stop action unless config is disabled.

- [ ] **Step 5: Pass dependencies to `TunnelClient`**

```kotlin
val client = TunnelClient(
    config = config,
    credentials = credentials,
    targetSocketFactory = targetSocketFactory,
    clientScope = scope,
    protect = protectCallback,
    cfIpDns = cfIpDns,
    cfIpSelector = cfIpSelector,
    onCfIpChanged = statusStore::updateCfIp,
)
```

- [ ] **Step 6: Clear CF IP on service teardown**

In ACTION_STOP and `onDestroy()`:

```kotlin
cfIpSelector?.let { CfIpRuntimeRegistry.detach(it) }
cfIpPool = null
cfIpSelector = null
statusStore.updateCfIp(null)
```

- [ ] **Step 7: Verify**

```bash
cd android-client
./gradlew :app:compileDebugKotlin
```

Expected: build success.

- [ ] **Step 8: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/service/BlockProxyVpnService.kt
git commit -m "feat(android): wire CF IP rotation into VPN service"
```

---

## Task 11: TunnelViewModel State and Worker Control

**Files:**
- Modify: `app/src/main/java/com/blockproxy/android/ui/TunnelViewModel.kt`

**Interfaces:**
- `ConfigUiState.cfCdnEnabled`
- `updateCfCdnEnabled(Boolean)`
- `cfIpRefreshState: StateFlow<CfIpRefreshState>`
- `currentCfIp: StateFlow<String?>`
- `refreshCfIpPool()`

- [ ] **Step 1: Add UI state**

```kotlin
sealed class CfIpRefreshState {
    data object Idle : CfIpRefreshState()
    data class Refreshing(val tested: Int = 0, val total: Int = 0) : CfIpRefreshState()
    data class Done(val count: Int, val appliedToRunningTunnel: Boolean) : CfIpRefreshState()
    data class Error(val message: String) : CfIpRefreshState()
}
```

Add to `ConfigUiState`:

```kotlin
val cfCdnEnabled: Boolean = false,
```

- [ ] **Step 2: Expose observable current CF IP**

```kotlin
val currentCfIp: StateFlow<String?> = BlockProxyVpnService.statusStore.currentCfIp
```

- [ ] **Step 3: Load/save CF config**

Update config loading and `saveConfig()` to include `cfCdnEnabled`.

In `saveConfig()`, schedule/cancel worker:

```kotlin
if (state.cfCdnEnabled) {
    CfIpRefreshWorker.schedule(context, config.serverPort)
} else {
    CfIpRefreshWorker.cancelSchedule(context)
}
```

- [ ] **Step 4: Add manual refresh**

`refreshCfIpPool()` should:

- validate current port for CF mode
- call `CfIpRefreshWorker.refreshNow(context, port)`
- observe that specific work id
- map `WorkInfo.progress` to `Refreshing(tested, total)`
- map output `selected_count` and `applied_to_running_tunnel` to `Done(count, appliedToRunningTunnel)`
- remove observers or collect flow in `viewModelScope` to avoid leaks

Do not use `observeForever` without guaranteed removal.

- [ ] **Step 5: Verify**

```bash
cd android-client
./gradlew :app:compileDebugKotlin
```

Expected: build success.

- [ ] **Step 6: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/ui/TunnelViewModel.kt
git commit -m "feat(android): add CF CDN UI state and refresh control"
```

---

## Task 12: ConfigScreen UI

**Files:**
- Modify: `app/src/main/java/com/blockproxy/android/ui/ConfigScreen.kt`
- Modify: `app/src/main/java/com/blockproxy/android/MainActivity.kt`

- [ ] **Step 1: Add `ConfigScreen` parameters**

Add:

```kotlin
onUpdateCfCdnEnabled: (Boolean) -> Unit,
onRefreshCfIpPool: () -> Unit,
cfIpRefreshState: CfIpRefreshState,
```

- [ ] **Step 2: Add CF UI after port field**

UI requirements:

- Switch label: `使用 Cloudflare CDN`
- When enabled, show manual refresh button.
- When enabled and port unsupported, show an error text and disable save.
- Refresh button disabled while `Refreshing`.
- Show progress `tested/total` when available.
- Show final count from `Done(count)`.
- If `Done.appliedToRunningTunnel == true`, show that the refreshed pool is active for future rotations/reconnects.
- If `Done.appliedToRunningTunnel == false`, show that it will take effect the next time the tunnel starts.

- [ ] **Step 3: Wire `MainActivity`**

Collect:

```kotlin
val cfIpRefreshState by viewModel.cfIpRefreshState.collectAsState()
val currentCfIp by viewModel.currentCfIp.collectAsState()
```

Pass new callbacks/state to `ConfigScreen` and pass `currentCfIp` to `MainScreen`.

- [ ] **Step 4: Verify**

```bash
cd android-client
./gradlew :app:compileDebugKotlin
```

Expected: may fail until Task 13 updates `MainScreen`; fix both together if needed.

- [ ] **Step 5: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/ui/ConfigScreen.kt android-client/app/src/main/java/com/blockproxy/android/MainActivity.kt
git commit -m "feat(android): add CF CDN controls to config UI"
```

---

## Task 13: MainScreen CF IP Display

**Files:**
- Modify: `app/src/main/java/com/blockproxy/android/ui/MainScreen.kt`

- [ ] **Step 1: Add parameters**

```kotlin
cfCdnEnabled: Boolean = false,
currentCfIp: String? = null,
```

- [ ] **Step 2: Update `StatusCard` display**

When connected:

```kotlin
val display = if (status == TunnelStatus.Connected) {
    if (cfCdnEnabled && currentCfIp != null) {
        "已连接 · $currentCfIp:$port (CF)"
    } else {
        "已连接 · $host:$port"
    }
} else {
    status.displayText
}
```

- [ ] **Step 3: Verify**

```bash
cd android-client
./gradlew :app:compileDebugKotlin
```

Expected: build success.

- [ ] **Step 4: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/ui/MainScreen.kt
git commit -m "feat(android): show CF peer IP in tunnel status"
```

---

## Task 14: Final Verification

- [ ] **Step 1: Run unit tests**

```bash
cd android-client
./gradlew :app:testDebugUnitTest
```

Expected: PASS.

- [ ] **Step 2: Build APK**

```bash
cd android-client
npm run android:build
```

Expected: build success and APK produced.

- [ ] **Step 3: Manual validation**

1. CF switch defaults off for existing saved config.
2. With CF off, tunnel connects and status shows `host:port`.
3. Turning CF on with port `8003` shows validation error or save fails.
4. Turning CF on with port `443` saves successfully.
5. Manual refresh shows progress and final selected count.
6. Connect with CF on: status shows `currentCfIp:port (CF)`.
7. NAT rotation changes peer IP and UI updates.
8. Candidate rotation failure keeps old active connection and old CF IP.
9. Clean stop/restart does not force cursor advancement.
10. Toggle CF off, save, reconnect: no CF DNS override and status returns to `host:port`.

- [ ] **Step 4: Review docs and implementation together**

Confirm implementation matches:

- [spec](../specs/2026-07-13-cf-cdn-ip-rotation-design.md)
- this plan

- [ ] **Step 5: Commit final fixes**

```bash
git add android-client docs/superpowers/specs/2026-07-13-cf-cdn-ip-rotation-design.md docs/superpowers/plans/2026-07-13-cf-cdn-ip-rotation.md
git commit -m "fix(android): finalize CF CDN IP rotation integration"
```
