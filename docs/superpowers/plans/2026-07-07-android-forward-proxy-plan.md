# Android Forward Proxy And Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Android forward proxy and routing without implementing a userspace TCP/IP stack in Kotlin.

**Architecture:** `VpnService` captures traffic with a default route and hands the TUN fd to `tun2socks`. `tun2socks` connects to an in-app local SOCKS5 server. The SOCKS5 server routes each TCP CONNECT either to a protected direct socket or to the existing tunnel protocol via client-initiated Forward CONNECT sessions.

**Tech Stack:** Kotlin, Coroutines, DataStore, Jetpack Compose, Android VpnService, tun2socks, SOCKS5, existing tunnel frame protocol, geosite.dat assets.

---

## Global Constraints

- Do not parse raw TUN IP/TCP packets in Kotlin.
- Do not implement TCP state tracking, TCP checksums, TCP retransmission, or packet reassembly.
- Use `tun2socks` for TCP/IP handling.
- Support SOCKS5 `CONNECT` only in the first version.
- Treat `UDP ASSOCIATE` as unsupported. Non-DNS UDP and QUIC are out of scope.
- Domain routing must not assume SOCKS5 always provides domains. Use `ATYP_DOMAIN` when available; otherwise use `DomainMappingStore`; otherwise apply fallback.
- If `DomainMappingStore` resolves a fake IP to a domain, direct/proxy connection must use the real domain as `connectHost`, not the fake IP.
- Forward CONNECT reqid range is `0x8000..0xFFFE`; reverse reqid range is `0x0001..0x7FFF`.
- Forward reqid allocation must skip active reqids when wrapping.
- All direct sockets, tunnel sockets, and helper DNS sockets must call `VpnService.protect()` before connect.
- Existing server-originated reverse CONNECT behavior must not regress. Keep `ReverseConnectHandler` semantics and run reverse tunnel regression tests after any `TunnelClient` or VPN routing change.
- Routing enabled: direct rules -> proxy rules -> fallback direct.
- Routing disabled: all SOCKS5 CONNECT traffic goes proxy.
- Remove `ServerConfig.tunnelHost/tunnelPort` and `effectiveHost/effectivePort`.
- All new components need focused unit tests.

---

## File Structure

### New Files

**Config**
- `android-client/app/src/main/java/com/blockproxy/android/config/RoutingConfig.kt`
- `android-client/app/src/main/java/com/blockproxy/android/config/RoutingConfigRepository.kt`
- `android-client/app/src/test/java/com/blockproxy/android/config/RoutingConfigRepositoryTest.kt`

**Routing**
- `android-client/app/src/main/java/com/blockproxy/android/routing/ProtoParser.kt`
- `android-client/app/src/main/java/com/blockproxy/android/routing/GeositeLoader.kt`
- `android-client/app/src/main/java/com/blockproxy/android/routing/GeositeMatcher.kt`
- `android-client/app/src/main/java/com/blockproxy/android/routing/RoutingEngine.kt`
- `android-client/app/src/test/java/com/blockproxy/android/routing/ProtoParserTest.kt`
- `android-client/app/src/test/java/com/blockproxy/android/routing/GeositeMatcherTest.kt`
- `android-client/app/src/test/java/com/blockproxy/android/routing/RoutingEngineTest.kt`

**SOCKS**
- `android-client/app/src/main/java/com/blockproxy/android/socks/SocksProtocol.kt`
- `android-client/app/src/main/java/com/blockproxy/android/socks/SocksSession.kt`
- `android-client/app/src/main/java/com/blockproxy/android/socks/LocalSocksServer.kt`
- `android-client/app/src/main/java/com/blockproxy/android/socks/DomainMappingStore.kt`
- `android-client/app/src/test/java/com/blockproxy/android/socks/SocksProtocolTest.kt`
- `android-client/app/src/test/java/com/blockproxy/android/socks/LocalSocksServerTest.kt`
- `android-client/app/src/test/java/com/blockproxy/android/socks/DomainMappingStoreTest.kt`

**Tunnel Forward**
- `android-client/app/src/main/java/com/blockproxy/android/tunnel/ForwardSession.kt`
- `android-client/app/src/main/java/com/blockproxy/android/tunnel/ForwardSessionRegistry.kt`
- `android-client/app/src/test/java/com/blockproxy/android/tunnel/ForwardSessionRegistryTest.kt`

**TUN/tun2socks**
- `android-client/app/src/main/java/com/blockproxy/android/tun/Tun2SocksController.kt`
- `android-client/app/src/main/java/com/blockproxy/android/tun/VpnNetworkSnapshot.kt`
- `android-client/app/src/test/java/com/blockproxy/android/tun/Tun2SocksControllerTest.kt`

**UI**
- `android-client/app/src/main/java/com/blockproxy/android/ui/RoutingScreen.kt`
- `android-client/app/src/androidTest/java/com/blockproxy/android/ui/RoutingScreenTest.kt`

**Assets**
- `android-client/app/src/main/assets/geodata/geosite.dat`
- tun2socks binary/library assets as required by the selected integration path.

### Modified Files

- `android-client/app/src/main/java/com/blockproxy/android/config/ServerConfig.kt`
- `android-client/app/src/main/java/com/blockproxy/android/config/ConfigRepository.kt`
- `android-client/app/src/test/java/com/blockproxy/android/config/ConfigRepositoryTest.kt`
- `android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelClient.kt`
- `android-client/app/src/test/java/com/blockproxy/android/tunnel/TunnelClientTest.kt`
- `android-client/app/src/main/java/com/blockproxy/android/service/BlockProxyVpnService.kt`
- `android-client/app/src/main/java/com/blockproxy/android/ui/TunnelViewModel.kt`
- `android-client/app/src/main/java/com/blockproxy/android/ui/ConfigScreen.kt`
- `android-client/app/src/main/java/com/blockproxy/android/MainActivity.kt`
- `android-client/app/build.gradle.kts`

---

## Task 1: Routing Config Repository

**Files:**
- Create: `android-client/app/src/main/java/com/blockproxy/android/config/RoutingConfig.kt`
- Create: `android-client/app/src/main/java/com/blockproxy/android/config/RoutingConfigRepository.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/config/RoutingConfigRepositoryTest.kt`

- [ ] **Step 1: Write failing tests**

Cover:
- default config is disabled with empty rules
- repository saves and observes config through a fake data source
- direct/proxy rules are serialized as newline-separated text
- blank lines are ignored
- `clear()` restores default config

- [ ] **Step 2: Run the focused tests**

Run: `cd android-client && ./gradlew :app:testDebugUnitTest --tests '*RoutingConfigRepositoryTest'`

Expected: fail because the classes do not exist.

- [ ] **Step 3: Implement model and repository**

Create:

```kotlin
data class RoutingConfig(
    val enabled: Boolean = false,
    val directRules: List<String> = emptyList(),
    val proxyRules: List<String> = emptyList(),
)
```

Use this repository shape:

```kotlin
interface RoutingConfigDataSource {
    fun observe(): Flow<RoutingConfig>
    suspend fun save(config: RoutingConfig)
    suspend fun clear()
}

class RoutingConfigRepository(private val source: RoutingConfigDataSource) {
    fun observe(): Flow<RoutingConfig> = source.observe()
    suspend fun save(config: RoutingConfig) = source.save(config)
    suspend fun clear() = source.clear()
}
```

Production DataStore implementation stores rules with `joinToString("\n")`; no JSON import.

- [ ] **Step 4: Verify**

Run: `cd android-client && ./gradlew :app:testDebugUnitTest --tests '*RoutingConfigRepositoryTest'`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/config/RoutingConfig.kt \
        android-client/app/src/main/java/com/blockproxy/android/config/RoutingConfigRepository.kt \
        android-client/app/src/test/java/com/blockproxy/android/config/RoutingConfigRepositoryTest.kt
git commit -m "feat(android): add routing config repository"
```

---

## Task 2: Remove Tunnel Override Config

**Files:**
- Modify: `android-client/app/src/main/java/com/blockproxy/android/config/ServerConfig.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/config/ConfigRepository.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelClient.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/ui/TunnelViewModel.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/ui/ConfigScreen.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/config/ConfigRepositoryTest.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/tunnel/TunnelClientTest.kt`

- [ ] **Step 1: Update tests**

Remove expectations for `tunnelHost`, `tunnelPort`, `effectiveHost`, and `effectivePort`.

Add or update tests to assert `TunnelClient` connects to `config.serverHost` and `config.serverPort`.

- [ ] **Step 2: Run focused tests**

Run: `cd android-client && ./gradlew :app:testDebugUnitTest --tests '*ConfigRepositoryTest' --tests '*TunnelClientTest'`

Expected: fail until implementation is updated.

- [ ] **Step 3: Update config code**

Remove:
- `ServerConfig.tunnelHost`
- `ServerConfig.tunnelPort`
- `ServerConfig.effectiveHost`
- `ServerConfig.effectivePort`
- DataStore keys for tunnel override
- validation for `tunnelPort`

- [ ] **Step 4: Update TunnelClient and UI**

Change `TunnelClient` connection setup from:

```kotlin
conn.connect(config.effectiveHost, config.effectivePort)
```

to:

```kotlin
conn.connect(config.serverHost, config.serverPort)
```

Remove tunnel override state and UI fields from `TunnelViewModel` and `ConfigScreen`.

- [ ] **Step 5: Verify**

Run: `cd android-client && ./gradlew :app:testDebugUnitTest`

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/config/ServerConfig.kt \
        android-client/app/src/main/java/com/blockproxy/android/config/ConfigRepository.kt \
        android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelClient.kt \
        android-client/app/src/main/java/com/blockproxy/android/ui/TunnelViewModel.kt \
        android-client/app/src/main/java/com/blockproxy/android/ui/ConfigScreen.kt \
        android-client/app/src/test/java/com/blockproxy/android/config/ConfigRepositoryTest.kt \
        android-client/app/src/test/java/com/blockproxy/android/tunnel/TunnelClientTest.kt
git commit -m "refactor(android): remove tunnel override config"
```

---

## Task 3: Geosite And Routing Engine

**Files:**
- Create: `android-client/app/src/main/java/com/blockproxy/android/routing/ProtoParser.kt`
- Create: `android-client/app/src/main/java/com/blockproxy/android/routing/GeositeLoader.kt`
- Create: `android-client/app/src/main/java/com/blockproxy/android/routing/GeositeMatcher.kt`
- Create: `android-client/app/src/main/java/com/blockproxy/android/routing/RoutingEngine.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/routing/ProtoParserTest.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/routing/GeositeMatcherTest.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/routing/RoutingEngineTest.kt`
- Resource: `android-client/app/src/main/assets/geodata/geosite.dat`

- [ ] **Step 1: Copy geosite asset**

```bash
mkdir -p android-client/app/src/main/assets/geodata
cp client/geodata/geosite.dat android-client/app/src/main/assets/geodata/geosite.dat
```

- [ ] **Step 2: Write failing parser and matcher tests**

Cover protobuf varint, length-delimited fields, malformed input, geosite full/domain/plain/regex semantics.

- [ ] **Step 3: Write failing RoutingEngine tests**

Cover:
- disabled -> proxy
- enabled empty rules -> direct
- direct rule wins before proxy rule
- domain exact and subdomain matching
- geosite delegation
- `domain == null` -> fallback direct when enabled

- [ ] **Step 4: Implement**

Create `RouteDecision` enum:

```kotlin
enum class RouteDecision { DIRECT, PROXY }
```

Implement:

```kotlin
class RoutingEngine(
    private val config: RoutingConfig,
    private val geositeMatcher: GeositeMatcher,
) {
    fun resolve(targetHost: String, domain: String?): RouteDecision
}
```

- [ ] **Step 5: Verify**

Run: `cd android-client && ./gradlew :app:testDebugUnitTest --tests '*ProtoParserTest' --tests '*GeositeMatcherTest' --tests '*RoutingEngineTest'`

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/routing \
        android-client/app/src/test/java/com/blockproxy/android/routing \
        android-client/app/src/main/assets/geodata/geosite.dat
git commit -m "feat(android): add routing engine and geosite matcher"
```

---

## Task 4: SOCKS5 Protocol And Domain Mapping

**Files:**
- Create: `android-client/app/src/main/java/com/blockproxy/android/socks/SocksProtocol.kt`
- Create: `android-client/app/src/main/java/com/blockproxy/android/socks/DomainMappingStore.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/socks/SocksProtocolTest.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/socks/DomainMappingStoreTest.kt`

- [ ] **Step 1: Write failing SOCKS protocol tests**

Cover:
- no-auth greeting accepted
- username/password auth is rejected or not advertised
- CONNECT with IPv4 target
- CONNECT with domain target
- CONNECT with IPv6 target returns unsupported for first version
- UDP ASSOCIATE returns unsupported
- malformed request closes session

- [ ] **Step 2: Write failing DomainMappingStore tests**

Cover:
- lookup unknown IP returns null
- mapping stores domain for IP
- fake IP mapping resolves `connectHost` to domain
- new mapping for same domain replaces old IPs
- clear removes all entries

- [ ] **Step 3: Implement**

`SocksProtocol` should parse and build protocol messages only. It should not open sockets.

`DomainMappingStore` is an in-memory cache used when SOCKS5 receives an IP target. It may be fed by fakeDNS or a local resolver in later tasks.

Use a resolved endpoint shape equivalent to:

```kotlin
data class ResolvedEndpoint(
    val originalHost: String,
    val connectHost: String,
    val port: Int,
    val domain: String?,
    val source: DomainSource,
)
```

When resolving fake DNS mappings, `connectHost` must be the mapped domain. Do not forward fake IPs to direct sockets or Forward CONNECT.

- [ ] **Step 4: Verify**

Run: `cd android-client && ./gradlew :app:testDebugUnitTest --tests '*SocksProtocolTest' --tests '*DomainMappingStoreTest'`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/socks/SocksProtocol.kt \
        android-client/app/src/main/java/com/blockproxy/android/socks/DomainMappingStore.kt \
        android-client/app/src/test/java/com/blockproxy/android/socks/SocksProtocolTest.kt \
        android-client/app/src/test/java/com/blockproxy/android/socks/DomainMappingStoreTest.kt
git commit -m "feat(android): add SOCKS5 protocol parser"
```

---

## Task 5: Forward Session Registry

**Files:**
- Create: `android-client/app/src/main/java/com/blockproxy/android/tunnel/ForwardSession.kt`
- Create: `android-client/app/src/main/java/com/blockproxy/android/tunnel/ForwardSessionRegistry.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelClient.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/tunnel/ForwardSessionRegistryTest.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/tunnel/TunnelClientTest.kt`

- [ ] **Step 1: Write failing registry tests**

Cover:
- first reqid is `0x8000`
- reqid wraps after `0xFFFE`
- wrap skips active reqids
- open sends CONNECT on selected connection
- `CONNECT_OK` completes open
- `CONNECT_FAILED` fails open
- inbound DATA is queued for the right session
- inbound CLOSE ends the right session
- disconnect of one `TunnelConnection` cleans only sessions bound to that connection
- `stop()` closes all sessions

- [ ] **Step 2: Run focused tests**

Run: `cd android-client && ./gradlew :app:testDebugUnitTest --tests '*ForwardSessionRegistryTest' --tests '*TunnelClientTest'`

Expected: fail until implementation exists.

- [ ] **Step 3: Implement registry**

`ForwardSessionRegistry` owns:
- active `reqid -> ForwardSession`
- connection-bound session cleanup
- round-robin connection selection
- connect timeout
- per-session inbound queue with bounded capacity

- [ ] **Step 4: Integrate TunnelClient dispatch**

Update post-auth frame dispatch:
- `Connect` -> reverse handler
- `ConnectOk` / `ConnectFailed` -> forward registry
- `Data` / `Close` -> forward registry if reqid is known forward session; otherwise reverse handler

Expose a minimal API for `LocalSocksServer`:

```kotlin
suspend fun openForwardSession(host: String, port: Int): ForwardSession
```

- [ ] **Step 5: Verify**

Run: `cd android-client && ./gradlew :app:testDebugUnitTest --tests '*ForwardSessionRegistryTest' --tests '*ReverseConnectHandlerTest' --tests '*TunnelClientTest' --tests '*TunnelProtocolIntegrationTest'`

Expected: pass, including existing reverse CONNECT coverage.

- [ ] **Step 6: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/tunnel \
        android-client/app/src/test/java/com/blockproxy/android/tunnel
git commit -m "feat(android): add forward tunnel sessions"
```

---

## Task 6: Local SOCKS Server

**Files:**
- Create: `android-client/app/src/main/java/com/blockproxy/android/socks/SocksSession.kt`
- Create: `android-client/app/src/main/java/com/blockproxy/android/socks/LocalSocksServer.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/socks/LocalSocksServerTest.kt`

- [ ] **Step 1: Write failing tests**

Use fake direct connector, fake forward connector, fake routing engine, and in-memory streams.

Cover:
- server binds to loopback and exposes selected port
- CONNECT domain uses domain directly for routing
- CONNECT IP consults `DomainMappingStore`
- CONNECT fake IP uses mapped domain as `connectHost`
- routing `DIRECT` uses protected direct connector
- routing `PROXY` opens forward session
- relay copies bytes in both directions
- unsupported command returns SOCKS5 failure
- session cleanup closes sockets and forward session

- [ ] **Step 2: Run focused tests**

Run: `cd android-client && ./gradlew :app:testDebugUnitTest --tests '*LocalSocksServerTest'`

Expected: fail until implementation exists.

- [ ] **Step 3: Implement LocalSocksServer**

Responsibilities:
- accept loopback TCP connections
- handle SOCKS5 no-auth handshake
- handle CONNECT only
- resolve route decision
- connect direct or forward
- relay data with bounded chunks and cancellation-safe cleanup

Do not put SOCKS parsing logic in this class; keep it in `SocksProtocol`.

- [ ] **Step 4: Verify**

Run: `cd android-client && ./gradlew :app:testDebugUnitTest --tests '*SocksProtocolTest' --tests '*LocalSocksServerTest'`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/socks \
        android-client/app/src/test/java/com/blockproxy/android/socks
git commit -m "feat(android): add local SOCKS5 server"
```

---

## Task 7a: tun2socks Selection Spike

**Files:**
- Create: `docs/superpowers/specs/2026-07-07-android-tun2socks-selection.md`

- [ ] **Step 1: Define selection criteria**

Evaluate each candidate against:
- Android compatibility and minimum SDK requirements
- supported ABIs: `arm64-v8a`, `armeabi-v7a`, `x86_64`
- TUN fd input support
- SOCKS5 upstream support
- fakeDNS or DNS mapping support
- startup/stop API shape
- packaging model: native binary, JNI `.so`, Gradle dependency, or source module
- APK size impact
- license compatibility
- maintenance status
- testability in unit/instrumentation tests

- [ ] **Step 2: Research candidates**

At minimum evaluate:
- a maintained `tun2socks` implementation that can build for Android
- `badvpn-tun2socks`
- any existing Android tun2socks library already suitable for SOCKS5 upstream

Record exact repository/artifact names, versions or commits, supported ABIs, and fakeDNS support.

- [ ] **Step 3: Pick one integration path**

Write the decision to `docs/superpowers/specs/2026-07-07-android-tun2socks-selection.md`.

The decision must include:
- selected implementation
- why rejected candidates were not selected
- how it will be packaged in the APK
- how `Tun2SocksController` starts and stops it
- whether fakeDNS is available in the first version
- if fakeDNS is unavailable, the documented IP-only fallback behavior
- a minimal verification command or demo plan

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07-07-android-tun2socks-selection.md
git commit -m "docs(android): select tun2socks integration path"
```

---

## Task 7: tun2socks Integration

**Files:**
- Create: `android-client/app/src/main/java/com/blockproxy/android/tun/Tun2SocksController.kt`
- Create: `android-client/app/src/main/java/com/blockproxy/android/tun/VpnNetworkSnapshot.kt`
- Modify: `android-client/app/build.gradle.kts`
- Test: `android-client/app/src/test/java/com/blockproxy/android/tun/Tun2SocksControllerTest.kt`

- [ ] **Step 1: Read selected integration path**

Read `docs/superpowers/specs/2026-07-07-android-tun2socks-selection.md`.

Do not choose a new implementation inside this task. If the selection doc is missing or does not answer packaging, ABI support, fakeDNS support, and start/stop shape, stop and finish Task 7a first.

- [ ] **Step 2: Write failing controller tests**

Cover:
- command/config includes TUN fd and local SOCKS address
- controller reports started state
- controller stops process/library on request
- startup failure is surfaced
- fakeDNS/domain mapping capability is detected or explicitly disabled

- [ ] **Step 3: Implement controller**

`Tun2SocksController` should own only tun2socks lifecycle. It should not know routing rules or tunnel details.

Inputs:
- TUN `ParcelFileDescriptor`
- local SOCKS host/port
- MTU
- optional DNS/fakeDNS settings

- [ ] **Step 4: Verify**

Run: `cd android-client && ./gradlew :app:testDebugUnitTest --tests '*Tun2SocksControllerTest'`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/tun \
        android-client/app/src/test/java/com/blockproxy/android/tun \
        android-client/app/build.gradle.kts
git commit -m "feat(android): integrate tun2socks controller"
```

---

## Task 8: Routing UI

**Files:**
- Create: `android-client/app/src/main/java/com/blockproxy/android/ui/RoutingScreen.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/ui/TunnelViewModel.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/ui/ConfigScreen.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/MainActivity.kt`
- Test: `android-client/app/src/androidTest/java/com/blockproxy/android/ui/RoutingScreenTest.kt`

- [ ] **Step 1: Write UI tests**

Cover:
- switch reflects current config
- direct tab shows direct rules
- proxy tab shows proxy rules
- save persists config
- config screen shows enabled/disabled status
- navigation opens routing screen

- [ ] **Step 2: Implement UI**

Create:
- top app bar with back/save
- switch row
- two tabs
- multiline rule text fields
- concise rule format hint

Do not add packet-level or DNS-specific settings to the UI in this task.

- [ ] **Step 3: Verify**

Run: `cd android-client && ./gradlew :app:connectedDebugAndroidTest`

Expected: pass on emulator/device.

- [ ] **Step 4: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/ui/RoutingScreen.kt \
        android-client/app/src/main/java/com/blockproxy/android/ui/TunnelViewModel.kt \
        android-client/app/src/main/java/com/blockproxy/android/ui/ConfigScreen.kt \
        android-client/app/src/main/java/com/blockproxy/android/MainActivity.kt \
        android-client/app/src/androidTest/java/com/blockproxy/android/ui/RoutingScreenTest.kt
git commit -m "feat(android): add routing settings UI"
```

---

## Task 9: VPN Service Wiring

**Files:**
- Modify: `android-client/app/src/main/java/com/blockproxy/android/service/BlockProxyVpnService.kt`
- Test: `android-client/app/src/androidTest/java/com/blockproxy/android/service/BlockProxyVpnServiceTest.kt`

- [ ] **Step 1: Update service tests**

Cover:
- VPN builder adds `0.0.0.0/0`
- service starts tunnel client
- service starts local SOCKS server before tun2socks
- service starts tun2socks with SOCKS address
- service protects outbound sockets
- service stops tun2socks, SOCKS server, tunnel client, and VPN fd

- [ ] **Step 2: Implement startup order**

Startup order:
1. Load server config, credentials, and routing config.
2. Capture `VpnNetworkSnapshot` before VPN route changes where possible.
3. Create `TunnelClient`.
4. Create `ForwardSessionRegistry`.
5. Create `RoutingEngine`.
6. Start `LocalSocksServer` on loopback.
7. Establish VPN with `addRoute("0.0.0.0", 0)`.
8. Start `Tun2SocksController` with TUN fd and local SOCKS address.
9. Observe tunnel status and update notification.

- [ ] **Step 3: Implement cleanup order**

Stop order:
1. Stop tun2socks.
2. Stop local SOCKS server.
3. Close forward sessions.
4. Stop tunnel client.
5. Close VPN fd.
6. Release wake lock and update status.

- [ ] **Step 4: Verify**

Run: `cd android-client && ./gradlew :app:testDebugUnitTest --tests '*ReverseConnectHandlerTest' --tests '*TunnelClientTest' --tests '*TunnelProtocolIntegrationTest' && ./gradlew :app:connectedDebugAndroidTest`

Expected: pass, including reverse CONNECT regression tests and instrumentation tests.

- [ ] **Step 5: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/service/BlockProxyVpnService.kt \
        android-client/app/src/androidTest/java/com/blockproxy/android/service/BlockProxyVpnServiceTest.kt
git commit -m "feat(android): wire VPN to tun2socks and SOCKS server"
```

---

## Task 10: End-To-End Validation

**Files:**
- Modify: `android-client/VALIDATION.md`
- Optional create: `docs/tunnel-testing.md` additions

- [ ] **Step 1: Document manual smoke test**

Include:
- start block-proxy server
- install Android debug build
- grant VPN permission
- start service
- verify 分流关闭全走代理
- verify direct rule
- verify proxy rule
- verify IP-only fallback behavior
- verify QUIC/UDP limitation is understood

- [ ] **Step 2: Run all automated tests**

Run: `cd android-client && ./gradlew :app:testDebugUnitTest`

Expected: pass.

- [ ] **Step 3: Run instrumentation tests**

Run: `cd android-client && ./gradlew :app:connectedDebugAndroidTest`

Expected: pass on emulator/device.

- [ ] **Step 4: Manual smoke test**

Record results in `android-client/VALIDATION.md`.

- [ ] **Step 5: Commit**

```bash
git add android-client/VALIDATION.md docs/tunnel-testing.md
git commit -m "docs(android): document forward proxy validation"
```

---

## Removed From Previous Plan

These components are intentionally removed:

- `IPv4Packet.kt`
- `TcpConnection.kt`
- `UdpSession.kt`
- `TrafficReader.kt`
- `DnsParser.kt`
- `DnsInterceptor.kt`

Reason: they implied hand-written packet/TCP handling. `tun2socks` owns that layer.
