# Android uTLS WebSocket Transport Design

**Date**: 2026-07-15
**Status**: Draft for review
**Scope**: Android client only (`android-client/`)
**Base branch**: `main`

## Problem Statement

The Android client currently uses OkHttp WebSocket for the tunnel transport. This works with the existing Node tunnel server, but OkHttp's TLS ClientHello does not look like Chrome/Chromium. The gRPC/Cronet experiment is not suitable because it requires protocol and deployment assumptions that do not hold behind the current CDN setup.

We need a client-side-only transport option that preserves the existing WebSocket tunnel protocol while producing a Chrome-like TLS ClientHello.

## Goals

- Keep the Node tunnel server unchanged.
- Keep the existing `wss://host:port/websocket` tunnel protocol unchanged.
- Add an Android client transport that uses Go `uTLS` to emit a Chrome-like TLS ClientHello.
- Keep OkHttp WebSocket as the default and fallback transport.
- Reuse existing tunnel authentication, frame encoding, padding, heartbeat, rotation, forward sessions, and reverse sessions.
- Preserve Cloudflare CDN IP override behavior: connect to selected edge IP while keeping SNI and HTTP `Host` as the configured domain.
- Make JA3/JA4 verification a first-class part of rollout.

## Non-Goals

- Do not change `tunnel/server.js`.
- Do not add gRPC, HTTP/2 streaming, or Cronet transport in this change.
- Do not remove OkHttp.
- Do not claim exact Chrome identity beyond the observable TLS ClientHello without packet capture validation.
- Do not implement per-file-descriptor `VpnService.protect(fd)` in the first milestone unless testing proves `addDisallowedApplication(packageName)` is insufficient.
- Do not build a general-purpose WebSocket library. Implement only what the tunnel protocol needs.

## Existing Main-Branch Baseline

The main branch already has a useful transport boundary:

- `TunnelClient` owns lifecycle, reconnect, rotation, CF IP state, and frame routing.
- `TunnelWebSocket` implements OkHttp WebSocket and exposes `FrameSender`.
- Each tunnel WebSocket message carries exactly one encoded tunnel frame.
- The server is an HTTPS server with `ws` on `config.wsPath`, default `/websocket`.
- The server expects RFC 6455 binary messages and rejects text messages.

This design keeps that boundary and adds another `FrameSender` implementation.

## Recommended Architecture

Add a selectable transport:

```text
TunnelClient
  -> TunnelTransportFactory
      -> TunnelWebSocket            OkHttp, existing default
      -> NativeUtlsWebSocket        Go uTLS + custom WebSocket, new optional transport
```

`TunnelClient` should not know WebSocket implementation details. It should ask a factory to create a `FrameSender` for one connection attempt. The factory chooses OkHttp or uTLS from `ServerConfig`.

The uTLS implementation is split into two layers:

```text
Kotlin
  NativeUtlsWebSocket : FrameSender
  UtlsWsClientAdapter
  UtlsWsListener

Go / gomobile AAR
  utlsws.Client
  utlsws.Conn
  TCP dial + optional dial IP override
  uTLS handshake
  HTTP/1.1 WebSocket Upgrade
  RFC 6455 binary frame read/write
```

## Configuration

Add a persisted transport mode:

```kotlin
enum class TunnelTransportMode {
    OKHTTP,
    CHROME_UTLS,
}
```

Add to `ServerConfig`:

```kotlin
val transportMode: TunnelTransportMode = TunnelTransportMode.OKHTTP
val utlsChromeProfile: String = "chrome_auto_stable"
```

The initial UI can hide this behind a debug setting or advanced setting. The implementation must continue to default to OkHttp to avoid breaking existing users.

Persist these fields in `DataStoreConfigDataSource` with explicit keys:

```kotlin
val KEY_TRANSPORT_MODE = stringPreferencesKey("transport_mode")
val KEY_UTLS_CHROME_PROFILE = stringPreferencesKey("utls_chrome_profile")
```

Load behavior:

- Missing `transport_mode` defaults to `OKHTTP`.
- Unknown `transport_mode` values default to `OKHTTP`.
- Missing `utls_chrome_profile` defaults to `"chrome_auto_stable"`.

Save behavior:

- Always persist the selected mode and profile with the rest of `ServerConfig`.

Validation:

- `CHROME_UTLS` requires `useTls == true`.
- `CHROME_UTLS` is allowed with `allowInsecure == true`, but the packet-capture checklist must record whether certificate validation was disabled because that may change observed behavior.

## Go Native Module

Create:

```text
android-client/native/utlsws/
  go.mod
  client.go
  websocket.go
  tls_profile.go
  errors.go
  build-aar.sh
```

The Go module should use:

- `github.com/refraction-networking/utls` for TLS ClientHello control.
- Standard `net` for TCP dial.
- A small local RFC 6455 implementation rather than a broad dependency, unless a dependency demonstrably preserves the provided `net.Conn` and does not hide TLS/dial behavior.

### Go API Shape

The exported API must be small enough for gomobile and should avoid relying on complex struct field mapping from Kotlin/Java. Prefer an options object with setters:

```go
type Listener interface {
    OnOpen()
    OnBinaryMessage(data []byte)
    OnClosed(code int, reason string)
    OnFailure(message string)
}

type Options struct {}

func NewOptions() *Options
func (o *Options) SetURL(value string)
func (o *Options) SetDialHost(value string)
func (o *Options) SetServerName(value string)
func (o *Options) SetHostHeader(value string)
func (o *Options) SetAllowInsecure(value bool)
func (o *Options) SetChromeProfile(value string)
func (o *Options) SetConnectTimeoutMillis(value int)
func (o *Options) SetReadBufferBytes(value int)
func (o *Options) AddHeader(name string, value string)
func (o *Options) SetInitialBinaryMessage(data []byte)

type Conn struct {}

func Connect(options *Options, listener Listener) (*Conn, error)
func (c *Conn) SendBinary(data []byte) bool
func (c *Conn) Close(code int, reason string)
```

`Url` remains `wss://configured-host:port/path` for logging and request construction. `DialHost` may be a Cloudflare IP. `ServerName` must remain the configured domain without port. `HostHeader` must be the HTTP authority: `serverHost` for default HTTPS port 443, and `serverHost:serverPort` for any non-default port.

`SetInitialBinaryMessage()` carries the pre-encoded AUTH frame. Native Go must send this binary message immediately after the WebSocket upgrade succeeds and before it calls `OnOpen()`. This avoids a race where `OnOpen()` fires before Kotlin stores the returned `Conn`.

`SendBinary()` must be safe to call from multiple Kotlin coroutine paths. The Go connection must serialize writes through exactly one writer path, either with a mutex or a bounded writer queue. Sends after close must return `false`. The first implementation should use a bounded queue or bounded pending-byte counter so tunnel overload cannot grow memory without limit.

The initial bound should be explicit and conservative:

- maximum queued messages: 256
- maximum queued bytes: 4 MiB

If either bound is exceeded, `SendBinary()` returns `false` without blocking. This is preferable to unbounded memory growth in a long-running VPN service.

### Native Object Lifetime and Byte Ownership

The Go `Conn` may hold a Java/Kotlin listener proxy, and Kotlin `NativeUtlsWebSocket` may hold the Go `Conn`. To avoid cross-language reference cycles, every terminal path must break both references:

- Go `Close()`, reader failure, and remote close must stop the read loop, stop the writer loop, nil out the stored listener reference, and release connection state.
- Kotlin `NativeUtlsWebSocket.close()`, native failure, and native close callbacks must clear its `Conn` reference after the close is observed.
- `onDisconnect` must still be emitted at most once.

Go lifecycle should use a single connection-level close primitive:

- `context.WithCancel` or an equivalent done channel to signal reader/writer shutdown.
- `sync.Once` to make terminal cleanup idempotent.
- a bounded writer channel that is closed only by the cleanup path.
- read loop exits on read error, close frame, or context cancellation.
- writer loop exits on close signal, queue close, or write error.
- cleanup waits for loops to exit where practical, but must not block Kotlin callback threads indefinitely.

`[]byte` crossing gomobile must be treated as mutable shared data. Go must copy inbound WebSocket payloads before invoking `OnBinaryMessage()` if the read buffer will be reused. Go must copy the initial AUTH payload and any `SendBinary()` argument before queueing or writing if the caller could mutate it after the call returns.

### uTLS Profile

Use a fixed Chrome-like profile for the first release, not a constantly changing randomized profile. Stability matters more than novelty for a tunnel.

Initial profile behavior:

- ClientHello: Chrome stable preset from uTLS, or a pinned known-good Chrome preset available in the selected uTLS version.
- ALPN: milestone 1 must pin `http/1.1`. The existing server protocol is HTTP/1.1 WebSocket Upgrade, and offering `h2` risks negotiating an application protocol that cannot carry the unchanged tunnel protocol. Only consider `h2,http/1.1` after packet capture proves it is required and an explicit compatibility test proves the CDN/origin path still uses HTTP/1.1 WebSocket Upgrade.
- SNI: configured `serverHost`.
- TLS versions: whatever the selected Chrome profile offers.
- Certificate validation: normal validation unless `allowInsecure` is true.

`HelloRandomized` should not be the default because random handshakes are harder to debug and may produce unstable compatibility.

## WebSocket Handshake

The native transport must perform a standard HTTP/1.1 WebSocket upgrade:

```http
GET /websocket HTTP/1.1
Host: yc.perf.qzz.io:8003
Connection: Upgrade
Pragma: no-cache
Cache-Control: no-cache
User-Agent: <Chrome-like UA if configured>
Upgrade: websocket
Origin: https://yc.perf.qzz.io
Sec-WebSocket-Version: 13
Accept-Encoding: gzip, deflate, br
Accept-Language: zh-CN,zh;q=0.9,en;q=0.8
Sec-WebSocket-Key: <random base64 nonce>
```

The exact header set and order should be configurable from Kotlin because header order can affect HTTP fingerprinting. The server does not require these browser-like headers, but adding them makes the handshake less OkHttp-like.

The client must validate:

- HTTP status is `101`.
- `Upgrade` is `websocket`.
- `Connection` includes `Upgrade`.
- `Sec-WebSocket-Accept` matches the nonce.

Non-101 responses are terminal connection failures. The native layer should read a small bounded response body snippet, up to 4 KiB, and include status code plus snippet in `OnFailure()` for diagnostics. HTTP redirects must not be followed automatically in milestone 1 because redirecting a tunnel endpoint changes SNI, Host, and fingerprint assumptions.

After upgrade, the native layer reads and writes RFC 6455 frames:

- Only binary messages are delivered to Kotlin.
- Client-to-server frames must be masked.
- Server-to-client masked frames should be treated as protocol errors.
- Ping from server should be answered with Pong by native code.
- Pong can be ignored.
- Close should call `OnClosed`.
- Fragmented binary messages should be reassembled before delivery.
- Complete binary messages must be capped at `FrameCodec.MAX_PAYLOAD_SIZE + 2` bytes, currently 65537 bytes. Oversized single-frame or fragmented messages are protocol errors and must close the connection.
- Control frame payloads must be capped at the RFC 6455 limit of 125 bytes.

## Kotlin Integration

Create:

```text
android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelTransportMode.kt
android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelTransportFactory.kt
android-client/app/src/main/java/com/blockproxy/android/tunnel/NativeUtlsWebSocket.kt
```

`NativeUtlsWebSocket` implements `FrameSender` and mirrors `TunnelWebSocket` authentication behavior:

1. Pass the pre-encoded AUTH frame into native options via `SetInitialBinaryMessage()`.
2. Native Go connects, completes WebSocket upgrade, sends AUTH, then calls `OnOpen()`.
3. Kotlin decodes the first binary frames until `AUTH_OK`.
4. Call `onAuthSuccess`.
5. Forward all post-auth binary messages to `onFrame`.
6. Map auth errors to existing exceptions:
   - `AUTH_FAIL` -> `TunnelAuthFailedException`
   - `ERROR` -> `TunnelOccupiedException`
   - malformed auth frame -> `TunnelProtocolException`

`TunnelClient.establishConnection()` should keep one shared path for frame channel creation and callback wiring. The only transport-specific decision should be delegated to `TunnelTransportFactory`.

### Callback Threading

The Go layer may invoke listener callbacks from its reader goroutine. `NativeUtlsWebSocket` must treat all native callbacks as cross-thread callbacks:

- Use one Kotlin-side mutex or single-threaded callback dispatcher for auth state transitions.
- Complete the `CompletableDeferred<FrameSender>` exactly once.
- Call `onDisconnect` at most once per native connection.
- Preserve the existing ordering expectation: `onAuthSuccess` registers the frame channel before any post-auth frame is delivered.
- Do not call suspend functions directly from native callbacks. Push bytes into a coroutine-safe channel or complete deferred state, then let `TunnelClient` continue using its existing coroutine loop.

## Cloudflare CDN IP Override

OkHttp currently uses `CfIpDns`. Native uTLS cannot use OkHttp DNS, so the factory should use `CfIpSelector` directly:

```text
if CF mode enabled:
  dialHost = cfIpSelector.selectForLookup() ?: serverHost
  serverName = serverHost
  hostHeader = serverHost[:serverPort when non-default]
else:
  dialHost = serverHost
  serverName = serverHost
  hostHeader = serverHost[:serverPort when non-default]
```

On authenticated connection:

```kotlin
cfIpSelector?.markConnected()
onCfIpChanged(selectedIp)
```

On failed candidate:

```kotlin
cfIpSelector?.markCandidateFailed()
```

On unexpected active disconnect, reuse the existing `handleCfDisconnect()` behavior in `TunnelClient`.

## VPN Loop Prevention

Main already uses two defenses:

- `VpnService.Builder.addDisallowedApplication(packageName)`
- OkHttp `ProtectedSocketFactory` with `VpnService.protect(socket)`

The first milestone may rely on `addDisallowedApplication(packageName)` for Go sockets only when app exclusion is known to have succeeded, because gomobile-created sockets still belong to the app UID and should be excluded by the kernel VPN rule.

`BlockProxyVpnService.establishVpnInterface()` must track whether `addDisallowedApplication(packageName)` succeeded. If it fails and `transportMode == CHROME_UTLS`, the service must reject uTLS mode and either:

- fall back to OkHttp transport, where `ProtectedSocketFactory` still calls `VpnService.protect(socket)`, or
- enter a clear error state telling the user that native uTLS transport requires app-level VPN exclusion on this device.

If device testing shows native sockets still enter the VPN, add a second milestone:

```text
Go net.Dialer.Control
  -> obtain fd before connect
  -> exported native protect callback
  -> Kotlin/JNI calls VpnService.protect(fd)
```

This is intentionally not in the first milestone because it adds JNI/fd lifetime complexity.

## HTTP Disguise

Main currently performs HTTP disguise requests with OkHttp before WebSocket connection. Keep that behavior unchanged in the first milestone, even when `CHROME_UTLS` is selected.

Reason: the disguise requests are best-effort and non-fatal. The hard requirement is making the tunnel WebSocket ClientHello Chrome-like. Replacing disguise requests with native uTLS can be a later improvement if packet capture shows the mixed OkHttp/uTLS pattern is harmful.

## TCP Socket Options

The native TCP connection should be tuned for an interactive tunnel:

- Set connect timeout from `ConnectTimeoutMillis`.
- Enable `TCP_NODELAY` after dialing where supported.
- Enable TCP keepalive where supported, with platform defaults unless Go exposes a safe per-platform setting.
- Do not add a normal read timeout after the WebSocket is established; liveness is governed by the existing application heartbeat.

## Build Integration

Use a checked-in build script:

```text
android-client/native/utlsws/build-aar.sh
```

The script should:

- Verify `gomobile` is installed.
- Run `go mod tidy`.
- Build Android AAR for `arm64-v8a`, `armeabi-v7a`, and `x86_64` if practical.
- Copy output to `android-client/app/libs/utlsws.aar`.

`android-client/settings.gradle.kts` uses `RepositoriesMode.FAIL_ON_PROJECT_REPOS`, so do not add an app-level `repositories { flatDir { ... } }` block. The first implementation should use a direct local AAR file dependency:

```kotlin
dependencies {
    implementation(files("libs/utlsws.aar"))
}
```

If direct AAR files become difficult to maintain, move to a local Maven repository declared under `dependencyResolutionManagement.repositories` in `settings.gradle.kts`.

The AAR may materially increase APK size. Expect roughly 15-25 MB before APK compression when building three ABIs, depending on gomobile and uTLS dependencies. Implementation should record the actual size delta. If size is excessive, consider `abiFilters` or release-channel-specific ABI splits after functional validation.

Release builds must verify that R8/ProGuard does not strip gomobile bridge classes. If the generated AAR does not provide sufficient consumer rules, add keep rules for the generated `utlsws` package and listener interfaces.

## Testing Strategy

### Go Unit Tests

Use Go tests for:

- WebSocket accept key calculation.
- Header construction and order.
- Frame masking and unmasking.
- Binary fragmentation reassembly.
- Close frame encode/decode.
- Ping-to-pong behavior.

### Kotlin Unit Tests

Use JVM tests for:

- `TunnelTransportFactory` chooses OkHttp by default.
- `TunnelTransportFactory` chooses native uTLS when configured.
- CF mode passes selected IP as native `dialHost` while preserving `serverName` and `hostHeader`.
- Native auth response mapping matches existing OkHttp behavior.

Use a fake native adapter interface so tests do not load the AAR.

### Integration Tests

Add a manual or automated Android integration checklist:

1. Start existing Node tunnel server from `main`.
2. Connect with OkHttp mode and verify baseline still works.
3. Connect with Chrome uTLS mode and verify AUTH_OK.
4. Browse through VPN tunnel.
5. Trigger rotation and verify old connection drains.
6. Enable CF CDN mode and verify selected CF IP is displayed.
7. Stop service and verify native connection closes.

### Packet Capture Verification

Before declaring success, capture traffic and compare:

- JA3 hash.
- JA4 string if available.
- TLS extension order and GREASE behavior.
- SNI.
- ALPN.
- HTTP WebSocket request header order.
- Server sees normal `/websocket` binary tunnel frames.

Verification commands/tools can include Wireshark, `tshark`, or a local JA3 capture server. The exact command should be documented during implementation after the capture environment is chosen.

## Rollout Plan

Milestone 1: Native transport prototype

- Build Go uTLS WebSocket AAR.
- Connect to existing server.
- Send and receive binary messages.
- Verify basic JA3.

Milestone 2: Kotlin transport integration

- Add `NativeUtlsWebSocket`.
- Add transport factory.
- Add config field defaulting to OkHttp.
- Keep UI hidden or debug-only.
- Verify tunnel auth and browsing.

Milestone 3: CF CDN compatibility

- Pass selected CF IP as dial host.
- Preserve SNI and Host.
- Preserve existing selector state transitions.
- Verify rotation.

Milestone 4: Hardening

- Add tests.
- Improve close/error mapping.
- Decide whether fd-level `VpnService.protect(fd)` is required.
- Add advanced UI toggle after stable testing.

## Risks

- uTLS only controls ClientHello. It does not automatically make the app indistinguishable from Chrome at JA4, TCP, HTTP, or traffic-timing layers.
- Go/gomobile increases APK size and build complexity.
- Native callbacks must be carefully serialized so `FrameSender` state matches existing coroutine expectations.
- Some Android devices may require fd-level `VpnService.protect(fd)` despite app-level exclusion.
- Chrome uTLS presets may lag current Chrome and should be pinned and verified rather than assumed.

## Open Questions

- Which exact Chrome profile should be pinned for the first implementation?
- Should `CHROME_UTLS` be exposed in UI immediately or kept as a debug/hidden setting until capture validation passes?
- Which packet capture tool should be standardized for JA3/JA4 regression checks?
