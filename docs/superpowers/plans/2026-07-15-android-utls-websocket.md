# Android uTLS WebSocket Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional Android client transport that keeps the existing WebSocket tunnel protocol but uses Go uTLS for a Chrome-like TLS ClientHello.

**Architecture:** Keep the Node server unchanged and keep OkHttp as the default transport. Add a Go/gomobile `utlsws` AAR that performs TCP dial, uTLS handshake, HTTP/1.1 WebSocket upgrade, and RFC6455 binary framing; wrap it in Kotlin as `NativeUtlsWebSocket : FrameSender`, then select it through a transport factory.

**Tech Stack:** Kotlin, Android DataStore, OkHttp, Go, gomobile, `github.com/refraction-networking/utls`, RFC6455 WebSocket framing, existing Android tunnel `FrameSender` protocol.

---

## Spec

Implement against:

- `docs/superpowers/specs/2026-07-15-android-utls-websocket-design.md`

Hard constraints:

- Do not modify `tunnel/server.js` or the Node WebSocket protocol.
- Keep `OKHTTP` as the default persisted transport.
- Treat native uTLS as optional until packet capture validates the fingerprint.

## File Map

Create:

- `android-client/native/utlsws/go.mod` - Go module definition.
- `android-client/native/utlsws/client.go` - exported gomobile API and connection lifecycle.
- `android-client/native/utlsws/websocket.go` - RFC6455 handshake and frame read/write.
- `android-client/native/utlsws/tls_profile.go` - uTLS profile construction.
- `android-client/native/utlsws/errors.go` - native error constants/helpers.
- `android-client/native/utlsws/build-aar.sh` - gomobile AAR build script.
- `android-client/native/utlsws/*_test.go` - Go unit tests.
- `android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelTransportMode.kt` - transport enum.
- `android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelTransportFactory.kt` - selects OkHttp vs native transport.
- `android-client/app/src/main/java/com/blockproxy/android/tunnel/NativeUtlsWebSocket.kt` - Kotlin `FrameSender` wrapper.
- `android-client/app/src/main/java/com/blockproxy/android/tunnel/UtlsWsNativeClient.kt` - Kotlin abstraction over gomobile client for tests.
- `android-client/app/src/main/java/com/blockproxy/android/tunnel/GomobileUtlsWsNativeClient.kt` - production adapter that calls generated AAR classes.
- `android-client/app/src/test/java/com/blockproxy/android/tunnel/TunnelTransportFactoryTest.kt`
- `android-client/app/src/test/java/com/blockproxy/android/tunnel/NativeUtlsWebSocketTest.kt`

Modify:

- `android-client/app/build.gradle.kts` - add local AAR file dependency.
- `android-client/app/src/main/java/com/blockproxy/android/config/ServerConfig.kt` - add transport fields.
- `android-client/app/src/main/java/com/blockproxy/android/config/ConfigRepository.kt` - persist and validate transport fields.
- `android-client/app/src/test/java/com/blockproxy/android/config/ConfigRepositoryTest.kt` - cover defaults and validation.
- `android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelClient.kt` - delegate transport creation to factory.
- `android-client/app/src/main/java/com/blockproxy/android/service/BlockProxyVpnService.kt` - track app exclusion success and fall back/error when uTLS cannot be safely used.

## Task 1: Persist Transport Configuration

**Files:**

- Create: `android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelTransportMode.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/config/ServerConfig.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/config/ConfigRepository.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/config/ConfigRepositoryTest.kt`

- [ ] **Step 1: Add failing repository validation tests**

Add tests for:

```kotlin
@Test
fun save_rejectsChromeUtlsWhenTlsDisabled() = runTest {
    val error = assertFailsWith<IllegalArgumentException> {
        repository.save(
            ServerConfig(
                serverHost = "example.com",
                useTls = false,
                transportMode = TunnelTransportMode.CHROME_UTLS,
            )
        )
    }
    assertTrue(error.message!!.contains("requires TLS"))
}

@Test
fun save_acceptsDefaultOkHttpTransport() = runTest {
    repository.save(ServerConfig(serverHost = "example.com"))
    assertEquals(TunnelTransportMode.OKHTTP, fakeDataSource.current!!.transportMode)
}
```

Also add DataStore-specific or fake-source tests for:

- old configs with no `transport_mode` load as `OKHTTP`.
- unknown persisted `transport_mode` values load as `OKHTTP`.
- missing `utls_chrome_profile` loads as `"chrome_auto_stable"`.
- saving `CHROME_UTLS` persists both `transport_mode` and `utls_chrome_profile`.
- loading an old config preserves all existing fields while applying new defaults.

Run: `./gradlew :app:testDebugUnitTest --tests com.blockproxy.android.config.ConfigRepositoryTest`

Expected: compile fails because `TunnelTransportMode` and new fields do not exist.

- [ ] **Step 2: Add transport enum and config fields**

Create `TunnelTransportMode.kt`:

```kotlin
package com.blockproxy.android.tunnel

enum class TunnelTransportMode {
    OKHTTP,
    CHROME_UTLS,
}
```

Update `ServerConfig`:

```kotlin
val transportMode: TunnelTransportMode = TunnelTransportMode.OKHTTP,
val utlsChromeProfile: String = "chrome_auto_stable",
```

- [ ] **Step 3: Persist DataStore keys and validation**

In `DataStoreConfigDataSource`, add:

```kotlin
val KEY_TRANSPORT_MODE = stringPreferencesKey("transport_mode")
val KEY_UTLS_CHROME_PROFILE = stringPreferencesKey("utls_chrome_profile")
```

Load with safe enum parsing:

```kotlin
transportMode = prefs[KEY_TRANSPORT_MODE]
    ?.let { runCatching { TunnelTransportMode.valueOf(it) }.getOrNull() }
    ?: TunnelTransportMode.OKHTTP,
utlsChromeProfile = prefs[KEY_UTLS_CHROME_PROFILE] ?: "chrome_auto_stable",
```

Save:

```kotlin
prefs[KEY_TRANSPORT_MODE] = config.transportMode.name
prefs[KEY_UTLS_CHROME_PROFILE] = config.utlsChromeProfile
```

Validate in `ConfigRepository.save()`:

```kotlin
if (config.transportMode == TunnelTransportMode.CHROME_UTLS) {
    require(config.useTls) { "Chrome uTLS transport requires TLS" }
}
```

- [ ] **Step 4: Run focused tests**

Run: `./gradlew :app:testDebugUnitTest --tests com.blockproxy.android.config.ConfigRepositoryTest`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelTransportMode.kt \
  android-client/app/src/main/java/com/blockproxy/android/config/ServerConfig.kt \
  android-client/app/src/main/java/com/blockproxy/android/config/ConfigRepository.kt \
  android-client/app/src/test/java/com/blockproxy/android/config/ConfigRepositoryTest.kt
git commit -m "feat(android): persist tunnel transport mode"
```

## Task 2: Build Go uTLS WebSocket Core

**Files:**

- Create: `android-client/native/utlsws/go.mod`
- Create: `android-client/native/utlsws/client.go`
- Create: `android-client/native/utlsws/websocket.go`
- Create: `android-client/native/utlsws/tls_profile.go`
- Create: `android-client/native/utlsws/errors.go`
- Create: `android-client/native/utlsws/websocket_test.go`
- Create: `android-client/native/utlsws/client_test.go`

- [ ] **Step 1: Write failing Go tests for RFC6455 helpers**

Test:

- `Sec-WebSocket-Accept` calculation.
- Client frame masking.
- Server frame unmask rejection.
- Fragmented binary reassembly.
- Oversized message rejection above 65537 bytes.
- Control frame rejection above 125 bytes.
- Non-101 HTTP response includes status and a bounded body snippet in the error.
- HTTP 3xx redirect is not followed automatically and is reported as terminal failure.

Run: `cd android-client/native/utlsws && go test ./...`

Expected: FAIL because module does not exist.

- [ ] **Step 2: Create Go module**

`go.mod`:

```go
module blockproxy/utlsws

go 1.22

require github.com/refraction-networking/utls v1.6.7
```

Run: `cd android-client/native/utlsws && go mod tidy`

- [ ] **Step 3: Implement WebSocket framing**

Implement in `websocket.go`:

- handshake request writer using ordered headers.
- accept-key validation.
- binary frame writer with client masking.
- read loop for binary, ping, pong, close.
- fragmented binary reassembly.
- hard max complete binary message size of 65537 bytes.
- hard max control payload size of 125 bytes.

Keep this layer independent of uTLS so Go tests can use `net.Pipe()`.

- [ ] **Step 4a: Implement uTLS profile and TCP dial settings**

`tls_profile.go`:

- build `utls.Config` with `ServerName`.
- honor `AllowInsecure`.
- pin ALPN to `http/1.1` for milestone 1.
- apply connect timeout from options.
- enable `TCP_NODELAY` where supported.
- enable TCP keepalive where supported.

Run: `cd android-client/native/utlsws && go test ./...`

Expected: PASS for existing tests; new dial-specific tests can use helper-level unit tests where possible.

- [ ] **Step 4b: Implement exported gomobile API and connect/open ordering**

`client.go`:

- expose `Listener`, `Options`, `Conn`.
- implement setters, including `SetInitialBinaryMessage`.
- `Connect()` dials `DialHost` or URL host, performs uTLS handshake, performs WS upgrade, sends initial AUTH binary message, then calls `OnOpen()`.
- copy the initial AUTH byte slice before storing it.
- do not call `OnOpen()` before `Connect()` has a usable `Conn` ready to return.

Add Go tests for:

- initial message is sent before `OnOpen()`.
- mutating the initial AUTH buffer after `SetInitialBinaryMessage()` does not affect sent bytes.

- [ ] **Step 4c: Implement bounded writer and close lifecycle**

Implement:

- one writer path per connection.
- maximum queued messages: 256.
- maximum queued bytes: 4 MiB.
- queue-full `SendBinary()` returns `false` without blocking.
- send-after-close returns `false`.
- terminal cleanup uses `sync.Once`.
- cleanup cancels reader/writer loops and nils the listener reference.

Add Go tests for:

- concurrent `SendBinary()` calls are serialized into complete WebSocket messages.
- queue-full behavior returns `false`.
- send-after-close returns `false`.
- close during concurrent send does not panic.
- reader failure stops writer loop and nils listener.
- remote close stops loops and nils listener.
- outbound byte slice mutation after `SendBinary()` does not affect sent bytes.
- inbound read-buffer reuse does not mutate data after `OnBinaryMessage()`.

- [ ] **Step 5: Run Go tests**

Run: `cd android-client/native/utlsws && go test ./...`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add android-client/native/utlsws
git commit -m "feat(android): add utls websocket native core"
```

## Task 3: Add gomobile AAR Build Integration

**Files:**

- Create: `android-client/native/utlsws/build-aar.sh`
- Modify: `android-client/app/build.gradle.kts`
- Generated local artifact: `android-client/app/libs/utlsws.aar`

- [ ] **Step 1: Add build script**

Create `build-aar.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
command -v gomobile >/dev/null 2>&1 || {
  echo "gomobile is required. Install with: go install golang.org/x/mobile/cmd/gomobile@latest && gomobile init" >&2
  exit 1
}

go mod tidy
mkdir -p ../../app/libs
gomobile bind -target=android -androidapi 26 -o ../../app/libs/utlsws.aar .
```

- [ ] **Step 2: Add Gradle dependency**

In `android-client/app/build.gradle.kts`:

```kotlin
dependencies {
    implementation(files("libs/utlsws.aar"))
}
```

Do not add an app-level repository block because `settings.gradle.kts` uses `RepositoriesMode.FAIL_ON_PROJECT_REPOS`.

- [ ] **Step 3: Build AAR**

Run: `cd android-client/native/utlsws && bash build-aar.sh`

Expected: `android-client/app/libs/utlsws.aar` exists.

Record the generated AAR size:

```bash
ls -lh android-client/app/libs/utlsws.aar
```

Expected: note the size in the task notes. If it is larger than expected, defer optimization until functional validation unless it blocks APK installation.

- [ ] **Step 4: Verify Android build still configures**

Run: `./gradlew :app:compileDebugKotlin`

Expected: PASS or fails only because Kotlin adapter has not been written yet. If it fails due to dependency resolution, fix the AAR dependency before continuing.

- [ ] **Step 5: Decide AAR artifact policy and commit**

Default policy: do not commit `android-client/app/libs/utlsws.aar` unless the team explicitly accepts repository growth. Prefer adding it to `.gitignore` and making `build-aar.sh` a required local build step. If CI later needs reproducible builds, publish the AAR to a local Maven repository or release artifact store.

If not committing the AAR, add or update `.gitignore`:

```text
android-client/app/libs/utlsws.aar
```

Commit script and Gradle wiring:

```bash
git add android-client/native/utlsws/build-aar.sh android-client/app/build.gradle.kts .gitignore
git commit -m "build(android): add utls websocket aar"
```

## Task 4: Implement Kotlin Native WebSocket Wrapper

**Files:**

- Create: `android-client/app/src/main/java/com/blockproxy/android/tunnel/UtlsWsNativeClient.kt`
- Create: `android-client/app/src/main/java/com/blockproxy/android/tunnel/GomobileUtlsWsNativeClient.kt`
- Create: `android-client/app/src/main/java/com/blockproxy/android/tunnel/NativeUtlsWebSocket.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/tunnel/NativeUtlsWebSocketTest.kt`

- [ ] **Step 1: Write failing Kotlin tests with fake native client**

Test:

- native wrapper sends AUTH by passing it as initial binary message.
- `AUTH_OK` completes `connect()`.
- `AUTH_FAIL` maps to `TunnelAuthFailedException`.
- `ERROR` maps to `TunnelOccupiedException`.
- malformed auth maps to `TunnelProtocolException`.
- `onDisconnect` fires at most once.
- `sendFrame()` serializes through the native client and returns false after close.
- connect failure and timeout complete the deferred exceptionally.
- close while connect is pending does not emit duplicate disconnects.
- concurrent `sendFrame()` and `close()` are safe and return deterministic false after close.

Run: `./gradlew :app:testDebugUnitTest --tests com.blockproxy.android.tunnel.NativeUtlsWebSocketTest`

Expected: FAIL because wrapper classes do not exist.

- [ ] **Step 2: Add native client abstraction**

Create `UtlsWsNativeClient.kt` with interfaces that do not reference generated gomobile classes:

```kotlin
interface UtlsWsNativeClient {
    fun connect(options: UtlsWsOptions, listener: UtlsWsListener): UtlsWsConnection
}

interface UtlsWsConnection {
    fun sendBinary(data: ByteArray): Boolean
    fun close(code: Int, reason: String)
}

interface UtlsWsListener {
    fun onOpen()
    fun onBinaryMessage(data: ByteArray)
    fun onClosed(code: Int, reason: String)
    fun onFailure(message: String)
}
```

Include `UtlsWsOptions` as a Kotlin data class with URL, dial host, server name, host header, headers, profile, insecure flag, initial message, and size settings.

- [ ] **Step 3: Implement production gomobile adapter**

`GomobileUtlsWsNativeClient` maps `UtlsWsOptions` to generated `utlsws.Options` setters and wraps returned `utlsws.Conn`.

This file is the only Kotlin file that should import generated gomobile classes.

- [ ] **Step 4: Implement `NativeUtlsWebSocket`**

Requirements:

- implements `FrameSender`.
- uses a `Mutex` or single callback lock for auth state.
- completes connect deferred exactly once.
- clears native connection reference on close/failure.
- does not call suspend functions from native callbacks.
- copies inbound `ByteArray` before forwarding if needed.
- maintains `isOpen` only after `AUTH_OK`.

- [ ] **Step 5: Run wrapper tests**

Run: `./gradlew :app:testDebugUnitTest --tests com.blockproxy.android.tunnel.NativeUtlsWebSocketTest`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/tunnel/UtlsWsNativeClient.kt \
  android-client/app/src/main/java/com/blockproxy/android/tunnel/GomobileUtlsWsNativeClient.kt \
  android-client/app/src/main/java/com/blockproxy/android/tunnel/NativeUtlsWebSocket.kt \
  android-client/app/src/test/java/com/blockproxy/android/tunnel/NativeUtlsWebSocketTest.kt
git commit -m "feat(android): wrap native utls websocket transport"
```

## Task 5: Add Transport Factory and TunnelClient Integration

**Files:**

- Create: `android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelTransportFactory.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/tunnel/TunnelTransportFactoryTest.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelClient.kt`

- [ ] **Step 1: Write failing factory tests**

Test:

- default config creates OkHttp transport.
- `CHROME_UTLS` creates native transport.
- CF mode passes selected IP as `dialHost`.
- SNI is bare host.
- Host header is `host:port` for non-443 ports and bare host for 443.
- custom headers are forwarded in order.
- native AUTH success calls `cfIpSelector.markConnected()` and `onCfIpChanged(selectedIp)`.
- failed native candidate calls `cfIpSelector.markCandidateFailed()`.
- active native disconnect still flows through existing `handleCfDisconnect()` behavior.

Run: `./gradlew :app:testDebugUnitTest --tests com.blockproxy.android.tunnel.TunnelTransportFactoryTest`

Expected: FAIL.

- [ ] **Step 2: Implement factory**

Factory inputs:

- `ServerConfig`
- `authPayload`
- callbacks currently passed to `TunnelWebSocket`
- existing OkHttp client
- `CfIpSelector?`
- `CfIpDns?`
- `UtlsWsNativeClient`

Factory output: a connected or connectable transport object used by `TunnelClient.establishConnection()`.

Keep HTTP disguise unchanged and still executed with OkHttp before transport creation.

Core factory logic:

```kotlin
val selectedIp = if (config.cfCdnEnabled) cfIpSelector?.selectForLookup() else null
val dialHost = selectedIp ?: config.serverHost
val serverName = config.serverHost
val hostHeader = if (config.serverPort == 443) {
    config.serverHost
} else {
    "${config.serverHost}:${config.serverPort}"
}
```

Use `dialHost` only for TCP dial. Use `serverName` for TLS SNI and certificate validation. Use `hostHeader` for HTTP/1.1 `Host`.

- [ ] **Step 3: Refactor `TunnelClient.establishConnection()`**

Keep existing behavior:

- create frame channel before connection.
- register channel in `onAuthSuccess`.
- call `cfIpSelector.markConnected()` on auth success.
- call `markCandidateFailed()` on connection failure.
- preserve rotation and drain behavior.

Replace direct `TunnelWebSocket(...)` creation with factory creation.

- [ ] **Step 4: Run focused tests**

Run:

```bash
./gradlew :app:testDebugUnitTest --tests com.blockproxy.android.tunnel.TunnelTransportFactoryTest
./gradlew :app:testDebugUnitTest --tests com.blockproxy.android.tunnel.NativeUtlsWebSocketTest
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelTransportFactory.kt \
  android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelClient.kt \
  android-client/app/src/test/java/com/blockproxy/android/tunnel/TunnelTransportFactoryTest.kt
git commit -m "feat(android): select tunnel websocket transport"
```

## Task 6: Handle VPN App Exclusion Failure

**Files:**

- Modify: `android-client/app/src/main/java/com/blockproxy/android/service/BlockProxyVpnService.kt`
- Test: `android-client/app/src/androidTest/java/com/blockproxy/android/service/BlockProxyVpnServiceTest.kt` or a new JVM-testable helper.

- [ ] **Step 1: Extract decision helper and write failing tests**

Create a small pure function or internal helper:

```kotlin
internal fun effectiveTransportMode(
    requested: TunnelTransportMode,
    appExclusionSucceeded: Boolean,
): TunnelTransportMode
```

Expected behavior:

- `OKHTTP` stays `OKHTTP`.
- `CHROME_UTLS` stays `CHROME_UTLS` only when app exclusion succeeded.
- `CHROME_UTLS` falls back to `OKHTTP` when app exclusion failed.

Run focused test.

Expected: FAIL.

- [ ] **Step 2: Track app exclusion result**

Change VPN setup so `addDisallowedApplication(packageName)` success is recorded. Prefer a small result holder:

```kotlin
private data class VpnInterfaceResult(
    val descriptor: ParcelFileDescriptor,
    val appExclusionSucceeded: Boolean,
)
```

Update setup code to use this result instead of a bare `ParcelFileDescriptor?`.

- [ ] **Step 3: Apply safe fallback**

Before creating `TunnelClient`, derive effective config:

```kotlin
val effectiveConfig = if (
    config.transportMode == TunnelTransportMode.CHROME_UTLS &&
    !vpnResult.appExclusionSucceeded
) {
    Log.w(TAG, "Chrome uTLS transport requires app VPN exclusion; falling back to OkHttp")
    config.copy(transportMode = TunnelTransportMode.OKHTTP)
} else {
    config
}
```

Pass `effectiveConfig` to `TunnelClient`.

- [ ] **Step 4: Run tests**

Run relevant service/helper tests.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/service/BlockProxyVpnService.kt \
  android-client/app/src/test/java/com/blockproxy/android/service
git commit -m "fix(android): guard native transport against vpn loop"
```

## Task 7: Verification, Capture Checklist, and Build

**Files:**

- Modify or create docs if needed:
  - `docs/superpowers/specs/2026-07-15-android-utls-websocket-design.md`
  - optional `docs/superpowers/specs/2026-07-15-android-utls-websocket-verification.md`

- [ ] **Step 1: Run unit tests**

Run:

```bash
./gradlew :app:testDebugUnitTest
cd android-client/native/utlsws && go test ./...
```

Expected: PASS.

- [ ] **Step 2: Compile Android**

Run:

```bash
./gradlew :app:compileDebugKotlin
```

Expected: PASS.

- [ ] **Step 3: Build debug APK**

Run:

```bash
./gradlew :app:assembleDebug
```

Expected: PASS and APK at `android-client/app/build/outputs/apk/debug/BlockProxyClient-android.apk`.

- [ ] **Step 4: Build release APK to verify R8/ProGuard**

Run:

```bash
./gradlew :app:assembleRelease
```

Expected: PASS. If R8 strips gomobile bridge classes or listener interfaces, add keep rules for the generated `utlsws` package and adapter callback types in `android-client/app/proguard-rules.pro`.

- [ ] **Step 5: Record APK size delta**

Compare APK sizes before and after adding `utlsws.aar`:

```bash
ls -lh android-client/app/build/outputs/apk/debug/BlockProxyClient-android.apk
```

Expected: record the size delta in the verification notes. If the delta is unacceptable, evaluate ABI splits or `abiFilters` after functional validation.

- [ ] **Step 6: Manual integration test**

Checklist:

- Start existing `main` Node tunnel server.
- Connect with default OkHttp transport and verify baseline.
- Enable `CHROME_UTLS` through debug config or temporary switch.
- Verify AUTH_OK.
- Browse through VPN tunnel.
- Trigger rotation and verify old connection drains.
- Enable CF CDN mode and verify selected CF IP is shown.
- Stop VPN and verify native connection closes.

- [ ] **Step 7: Packet capture verification**

Capture and record:

- JA3 hash.
- JA4 string if available.
- SNI.
- ALPN.
- TLS extension order and GREASE behavior.
- WebSocket HTTP header order and Host authority.
- Server still receives `/websocket` binary tunnel frames.

Do not mark the feature as Chrome-like until capture confirms the expected ClientHello.

- [ ] **Step 8: Rollback check**

Verify rollback behavior:

- default config remains `OKHTTP`.
- changing persisted `transportMode` back to `OKHTTP` bypasses all native uTLS code.
- if native uTLS is unstable, disabling the hidden/debug config is sufficient to return to the previous OkHttp path.
- if a runtime kill switch is added later, it should only force `OKHTTP`; it must not alter server config or credentials.

- [ ] **Step 9: Final commit for verification docs**

```bash
git add docs/superpowers/specs/2026-07-15-android-utls-websocket-design.md docs/superpowers/plans/2026-07-15-android-utls-websocket.md
git commit -m "docs: plan android utls websocket transport"
```
