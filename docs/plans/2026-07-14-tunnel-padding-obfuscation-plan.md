# Tunnel Padding Obfuscation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lightweight WebSocket tunnel `PADDING` frames to reduce observable tunnel traffic size and timing regularity without breaking existing tunnel behavior.

**Architecture:** Add a dedicated link-level `PADDING` frame type (`0x30`) that carries random bytes and is silently discarded by receivers. Deploy server support first, then Android sending support; macOS remains functionally compatible without code changes and must be covered by compatibility tests. No admin UI is required.

**Tech Stack:** Node.js tunnel server (`ws`), Android Kotlin tunnel client (OkHttp WebSocket), existing macOS Python tunnel client (`websockets`) for compatibility verification, Node test suite, Android JVM tests.

---

## Scope

This plan implements application-frame padding for the WebSocket-over-TLS tunnel, not TCP-layer padding. TLS still protects frame contents. The padding changes traffic sizes and timing as seen outside TLS by adding extra encrypted WebSocket messages.

In scope:
- Server protocol support for `PADDING`.
- Server forward-compatible decode of unknown frame types.
- Server-side padding injection after DATA sends and during idle active connections.
- Android protocol support for `PADDING`.
- Android padding injection after DATA sends and during idle active connections.
- macOS compatibility verification with server-sent padding.
- Tests for protocol, server behavior, Android codec, and compatibility.

Out of scope:
- Admin UI controls.
- Runtime protocol negotiation.
- macOS padding generation.
- TLS record padding.
- Inline DATA-frame padding.

## Compatibility Rules

1. Deploy server changes first.
2. New Android clients must not be deployed against old servers unless Android padding sending is disabled.
3. Old Android clients are expected to ignore server-sent `PADDING` as `Frame.Unknown` after authentication.
4. macOS client must remain usable without code changes. It already ignores unknown frame types in normal request handling.
5. Do not extend `AUTH_OK`; old Android requires `AUTH_OK` payload length to be exactly one byte.
6. Keep `encodeFrame()` strict for unknown outbound frame types. Only `decodeFrame()` becomes forward-compatible.

## File Map

Server:
- Modify `tunnel/protocol.js`: add `FRAME_TYPES.PADDING`, encode/decode support, forward-compatible unknown decode.
- Modify `tunnel/server.js`: add padding config defaults, incoming padding discard, DATA-after-send padding, active-only periodic padding, lifecycle cleanup.
- Modify `proxy/proxy.js`: pass hidden `config.tunnel_padding` values into `TunnelServer`.
- Modify `tunnel/test/protocol.test.js`: protocol round-trip and unknown decode tests.
- Modify `tunnel/test/server.test.js`: incoming padding ignore and outgoing padding tests.

Android:
- Modify `android-client/app/src/main/java/com/blockproxy/android/tunnel/Frame.kt`: add `Frame.Padding` and `FrameType.PADDING`.
- Modify `android-client/app/src/main/java/com/blockproxy/android/tunnel/FrameCodec.kt`: encode/decode `Frame.Padding`.
- Create `android-client/app/src/main/java/com/blockproxy/android/tunnel/PaddingInjector.kt`: isolated padding generator and scheduler.
- Modify `android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelClient.kt`: create injector, handle padding, start/stop/update periodic active sender.
- Modify `android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelWebSocket.kt`: ignore padding during auth instead of treating it as a protocol error.
- Modify `android-client/app/src/main/java/com/blockproxy/android/tunnel/ForwardSession.kt`: trigger best-effort per-DATA padding after successful DATA send.
- Modify `android-client/app/src/main/java/com/blockproxy/android/tunnel/ForwardSessionRegistry.kt`: pass injector to sessions.
- Modify `android-client/app/src/main/java/com/blockproxy/android/tunnel/ReverseConnectHandler.kt`: trigger best-effort per-DATA padding after target-to-tunnel DATA sends.
- Modify `android-client/app/src/main/java/com/blockproxy/android/config/ServerConfig.kt`: hidden code-level padding config fields, no UI.
- Modify Android tunnel tests under `android-client/app/src/test/java/com/blockproxy/android/tunnel/`.

macOS:
- Do not modify `client/tunnel_client.py` unless tests reveal incompatibility.
- Add or update tests in `client/tests/test_tunnel_client.py` if existing coverage does not prove unknown `0x30` frames are ignored in normal handling.

## Defaults

Server defaults:
```json
{
  "tunnel_padding": {
    "enabled": true,
    "probability": 0.3,
    "min_bytes": 64,
    "max_bytes": 512,
    "periodic_interval_min_ms": 5000,
    "periodic_interval_max_ms": 15000
  }
}
```

Android code-level defaults:
```kotlin
val paddingEnabled: Boolean = true
val paddingProbability: Float = 0.3f
val paddingMinBytes: Int = 64
val paddingMaxBytes: Int = 512
val paddingIntervalMinMs: Long = 5000
val paddingIntervalMaxMs: Long = 15000
```

No frontend UI is added. If `config.json` omits `tunnel_padding`, server defaults apply. If later rollout requires safer staged deployment, set Android `paddingEnabled = false` in code until all servers are upgraded.

## Bandwidth Budget

The default padding profile is intentionally modest. Average padding payload is roughly `(64 + 512) / 2 = 288` bytes, plus the tunnel frame length/type overhead and WebSocket/TLS transport overhead.

| Scenario | DATA frame rate | Per-DATA probability | Average padding payload | Estimated extra payload |
|----------|-----------------|----------------------|-------------------------|-------------------------|
| Light browsing | 10 frames/s | 30% | 288 B | ~0.84 KB/s |
| High-volume stream | 100 frames/s | 30% | 288 B | ~8.4 KB/s |
| Idle periodic only | 0 frames/s | N/A | 288 B | ~0.03 KB/s at 1 frame / 10 s |

These estimates are for padding payload only. Real wire overhead is slightly higher because each padding payload is wrapped by the tunnel frame, WebSocket framing, TLS records, and TCP/IP. If throughput or mobile data usage becomes a concern, reduce `probability` first, then increase `periodic_interval_min_ms` / `periodic_interval_max_ms`.

## Design Details

Frame format:
```text
[2B length big-endian][1B type=0x30][N random bytes]
```

Rules:
- `length = 1 + N`.
- `N` must be between configured `min_bytes` and `max_bytes`.
- Maximum `N` is `65534`.
- No `reqid`.
- Receivers silently discard padding after authentication.
- During Android auth, `PADDING` may be ignored defensively, but the server should not intentionally send padding before `AUTH_OK`.
- Random data must use `crypto.randomBytes()` on server and `SecureRandom` on Android.

Injection:
- Per-DATA padding: after a DATA frame send returns success, send at most one `PADDING` frame with configured probability.
- Periodic padding: only send on the currently active WebSocket. Do not send periodic padding to draining sockets.
- Draining sockets can still receive per-DATA padding if real DATA continues on that same socket.
- Padding send failures are best-effort and must not fail, delay, or retry real DATA.

## Task 1: Server Protocol Support

**Files:**
- Modify: `tunnel/protocol.js`
- Test: `tunnel/test/protocol.test.js`

- [ ] **Step 1: Add failing protocol tests**

Add tests for:
- `FRAME_TYPES.PADDING === 0x30`.
- `encodeFrame({ type: FRAME_TYPES.PADDING, data })` round-trips through `decodeFrame()`.
- Empty padding payload round-trips.
- Unknown decoded frame type returns an opaque frame instead of throwing.
- Unknown outbound encode still throws.

- [ ] **Step 2: Run protocol tests and confirm failure**

Run:
```bash
node --test tunnel/test/protocol.test.js
```

Expected before implementation: padding and unknown-decode tests fail.

- [ ] **Step 3: Implement protocol changes**

In `tunnel/protocol.js`:
- Add `PADDING: 0x30` to `FRAME_TYPES`.
- Add an `encodeFrame()` case:
```javascript
case FRAME_TYPES.PADDING: {
  const padData = frame.data || Buffer.alloc(0);
  payload = Buffer.concat([Buffer.from([frame.type]), padData]);
  break;
}
```
- Add a `decodeFrame()` case:
```javascript
case FRAME_TYPES.PADDING: {
  return { type, data: payload.slice(offset), bytesRead: 2 + length };
}
```
- Change only the `decodeFrame()` default case:
```javascript
default:
  return { type, data: payload.slice(offset), bytesRead: 2 + length };
```
- Keep `encodeFrame()` default throwing on unknown frame type.

- [ ] **Step 4: Run protocol tests**

Run:
```bash
node --test tunnel/test/protocol.test.js
```

Expected: all protocol tests pass.

## Task 2: Server Padding Engine

**Files:**
- Modify: `tunnel/server.js`
- Modify: `proxy/proxy.js`
- Test: `tunnel/test/server.test.js`

- [ ] **Step 1: Add failing server tests**

Add tests for:
- Authenticated server ignores incoming `PADDING` and keeps connection open.
- Incoming `PADDING` is not dispatched to `TunnelManager` frame handlers.
- With `paddingProbability: 1`, sending a DATA frame sends DATA plus PADDING on the same WebSocket.
- Periodic padding sends only to active connection, not draining connection.
- `stop()` clears the padding timer.

- [ ] **Step 2: Run server tests and confirm failure**

Run:
```bash
node --test tunnel/test/server.test.js
```

Expected before implementation: padding tests fail.

- [ ] **Step 3: Add hidden server padding config**

In `TunnelServer` constructor, add normalized config:
```javascript
this.paddingEnabled = options.paddingEnabled ?? true;
this.paddingProbability = Math.max(0, Math.min(1, options.paddingProbability ?? 0.3));
this.paddingMinBytes = Math.max(0, Math.min(65534, options.paddingMinBytes ?? 64));
this.paddingMaxBytes = Math.max(this.paddingMinBytes, Math.min(65534, options.paddingMaxBytes ?? 512));
this.paddingIntervalMinMs = Math.max(0, options.paddingIntervalMinMs ?? 5000);
this.paddingIntervalMaxMs = Math.max(this.paddingIntervalMinMs, options.paddingIntervalMaxMs ?? 15000);
this._paddingTimer = null;
```

In `proxy/proxy.js`, pass values from `config.tunnel_padding` into `new TunnelServer({ ... })`. No UI changes.

- [ ] **Step 4: Ignore inbound padding**

In `_handleWsMessage()`, after PING/PONG handling and before `_frameHandlers` dispatch:
```javascript
if (frame.type === FRAME_TYPES.PADDING) {
  return;
}
```

- [ ] **Step 5: Add per-DATA padding**

Add `_randomPaddingBytes()` and `_maybePadAfterSend(ws)`:
```javascript
_randomPaddingBytes() {
  const size = this.paddingMinBytes +
    Math.floor(Math.random() * (this.paddingMaxBytes - this.paddingMinBytes + 1));
  return crypto.randomBytes(size);
}

_maybePadAfterSend(ws) {
  if (!this.paddingEnabled) return;
  if (Math.random() >= this.paddingProbability) return;
  this._sendWsFrame(ws, {
    type: FRAME_TYPES.PADDING,
    data: this._randomPaddingBytes(),
  }).catch(() => {});
}
```

Modify `sendFrame()` so successful DATA sends trigger `_maybePadAfterSend()` without changing the DATA result:
```javascript
return this._sendWsFrame(targetWs, frame).then((ok) => {
  if (ok && frame.type === FRAME_TYPES.DATA) this._maybePadAfterSend(targetWs);
  return ok;
});
```

Apply the same wrapping to the `targetSocket` branch.

- [ ] **Step 6: Add active-only periodic padding**

Implement `_startPeriodicPadding()`, `_schedulePeriodicPadding()`, `_sendPeriodicPadding()`, and `_stopPeriodicPadding()`.

Important behavior:
- Start after successful auth, next to `_startHeartbeat()`.
- Stop in `stop()`.
- Stop when `_clientSockets.size === 0`.
- `_sendPeriodicPadding()` must only send to records where `record.authenticated && record.state === 'active'`.
- Do not send periodic padding to `draining` records.

- [ ] **Step 7: Run server tests**

Run:
```bash
node --test tunnel/test/protocol.test.js tunnel/test/server.test.js
```

Expected: all tests pass.

## Task 3: Android Frame Support

**Files:**
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/Frame.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/FrameCodec.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/tunnel/FrameCodecTest.kt`

- [ ] **Step 1: Add failing Android codec tests**

Add tests for:
- `Frame.Padding` encode/decode round-trip.
- Empty padding payload.
- Unknown `0x30` no longer decodes as `Frame.Unknown`; it decodes as `Frame.Padding`.
- `Frame.Unknown` behavior for unrelated unknown types remains unchanged.

- [ ] **Step 2: Run Android codec tests and confirm failure**

Run:
```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.tunnel.FrameCodecTest"
```

Expected before implementation: padding tests fail.

- [ ] **Step 3: Implement frame classes**

In `Frame.kt`, add:
```kotlin
class Padding(val data: ByteArray) : Frame() {
    override fun equals(other: Any?): Boolean =
        other is Padding && data.contentEquals(other.data)
    override fun hashCode(): Int = data.contentHashCode()
}
```

In `FrameType`, add:
```kotlin
PADDING(0x30),
```

- [ ] **Step 4: Implement codec support**

In `FrameCodec.encodePayload()`, add:
```kotlin
is Frame.Padding -> {
    val result = ByteArray(1 + frame.data.size)
    result[0] = FrameType.PADDING.code.toByte()
    System.arraycopy(frame.data, 0, result, 1, frame.data.size)
    result
}
```

In `FrameCodec.decodePayload()`, add:
```kotlin
FrameType.PADDING.code -> {
    Frame.Padding(payload.copyOfRange(1, payload.size))
}
```

- [ ] **Step 5: Run Android codec tests**

Run:
```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.tunnel.FrameCodecTest"
```

Expected: codec tests pass.

## Task 4: Android Padding Injector

**Files:**
- Create: `android-client/app/src/main/java/com/blockproxy/android/tunnel/PaddingInjector.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/config/ServerConfig.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/tunnel/PaddingInjectorTest.kt`

- [ ] **Step 1: Add failing injector tests**

Create tests for:
- Probability `0.0f` sends no padding.
- Probability `1.0f` sends padding.
- Padding size is within configured bounds.
- Periodic padding sends to active sender.
- `updateSender()` moves periodic padding to new active sender.
- `stopPeriodic()` cancels future sends.
- Sender failure does not throw to caller.

- [ ] **Step 2: Run injector tests and confirm failure**

Run:
```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.tunnel.PaddingInjectorTest"
```

Expected before implementation: test class or symbols fail.

- [ ] **Step 3: Add hidden config fields**

In `ServerConfig.kt`, add code-level fields:
```kotlin
val paddingEnabled: Boolean = true,
val paddingProbability: Float = 0.3f,
val paddingMinBytes: Int = 64,
val paddingMaxBytes: Int = 512,
val paddingIntervalMinMs: Long = 5000,
val paddingIntervalMaxMs: Long = 15000,
```

No UI or repository changes are required unless constructor call sites need new named arguments.

- [ ] **Step 4: Implement `PaddingInjector`**

The injector must:
- Use `SecureRandom` for bytes.
- Clamp invalid config values.
- Provide `onDataSent(sender)` as best-effort and non-fatal.
- Provide `startPeriodic(sender)`, `updateSender(sender)`, and `stopPeriodic()`.
- Send encoded `Frame.Padding` through `FrameSender.sendFrame()`.
- Never throw padding send failures to tunnel data paths.

Use `clientScope.launch` for opportunistic sends where needed so real DATA is not blocked by padding.

- [ ] **Step 5: Run injector tests**

Run:
```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.tunnel.PaddingInjectorTest"
```

Expected: injector tests pass.

## Task 5: Android Tunnel Integration

**Files:**
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelClient.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelWebSocket.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/ForwardSession.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/ForwardSessionRegistry.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/ReverseConnectHandler.kt`
- Test: existing Android tunnel tests plus new focused tests as needed.

- [ ] **Step 1: Add failing integration tests**

Add or update tests to prove:
- `TunnelClient.handleFrames()` ignores `Frame.Padding`.
- `TunnelWebSocket.handleAuthResponse()` ignores `Frame.Padding` during auth and waits for `AUTH_OK`.
- `ForwardSession.sendData()` triggers injector after DATA.
- `ReverseConnectHandler.RequestSession.relayLoop()` triggers injector after DATA.
- Rotation updates periodic padding to the new active sender.

- [ ] **Step 2: Run Android tunnel tests and confirm failure**

Run:
```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.tunnel.*"
```

Expected before integration: new tests fail.

- [ ] **Step 3: Wire injector into `TunnelClient`**

Create `PaddingInjector` from `ServerConfig`.

In `handleFrames()`, add an explicit branch:
```kotlin
is Frame.Padding -> { /* silently discard */ }
```

Start periodic padding only after the connection is authenticated and promoted active. Stop it in `stop()` and when active connection lifecycle ends. On rotation, call `paddingInjector.updateSender(candidate)` after the candidate becomes active.

- [ ] **Step 4: Make auth path padding-tolerant**

In `TunnelWebSocket.handleAuthResponse()`, add:
```kotlin
is Frame.Padding -> {
    // Ignore padding during auth and keep waiting for AUTH_OK.
}
```

Ensure this does not complete or fail the auth deferred.

- [ ] **Step 5: Wire per-DATA padding**

Pass `PaddingInjector` into:
- `ForwardSessionRegistry`, then `ForwardSession`.
- `ReverseConnectHandler`, then `RequestSession`.

After successful DATA sends, trigger best-effort padding:
```kotlin
val sent = sender.sendFrame(FrameCodec.encode(Frame.Data(reqid, data)))
if (sent) paddingInjector.onDataSent(sender)
```

If `onDataSent()` is implemented as fire-and-forget, call it after DATA send success and ignore failures.

- [ ] **Step 6: Run Android tunnel tests**

Run:
```bash
cd android-client
./gradlew :app:testDebugUnitTest --tests "com.blockproxy.android.tunnel.*"
```

Expected: tunnel tests pass.

## Task 6: macOS Compatibility Verification

**Files:**
- Prefer no production changes.
- Test: `client/tests/test_tunnel_client.py`

- [ ] **Step 1: Add or confirm macOS unknown-frame tests**

Test that `_decode_payload()` returns `{'type': 0x30}` for `PADDING` payload and that request handling ignores unknown frame types in the normal post-auth loop.

- [ ] **Step 2: Run macOS client tests**

Run:
```bash
python3 -m pytest client/tests/test_tunnel_client.py
```

Expected: macOS remains compatible without production code changes.

- [ ] **Step 3: Only patch macOS if compatibility test fails**

If needed, add only minimal explicit ignore support:
- `FRAME_PADDING = 0x30`.
- `_decode_payload()` sets `data` for padding.
- `_handle_requests()` has `elif frame['type'] == FRAME_PADDING: pass`.

Do not add macOS padding generation in this phase.

## Task 7: End-to-End Verification

**Files:**
- Existing tests only unless gaps are found.

- [ ] **Step 1: Run server tunnel tests**

Run:
```bash
node --test tunnel/test/protocol.test.js tunnel/test/server.test.js tunnel/test/manager.test.js test/tunnel-integration.test.js
```

Expected: all pass.

- [ ] **Step 2: Run Android unit tests**

Run:
```bash
cd android-client
./gradlew :app:testDebugUnitTest
```

Expected: all pass.

- [ ] **Step 3: Compile Android**

Run:
```bash
cd android-client
./gradlew :app:compileDebugKotlin
```

Expected: build succeeds.

- [ ] **Step 4: Run macOS tunnel tests**

Run:
```bash
python3 -m pytest client/tests/test_tunnel_client.py
```

Expected: pass.

- [ ] **Step 5: Manual smoke test**

Start the server with default hidden padding config. Connect Android client. Send traffic through the tunnel.

Verify:
- Data transfer succeeds.
- Server logs show no frame decode errors.
- Android logs show no `TunnelProtocolException`.
- macOS client can still connect and transfer traffic to the updated server.

## Rollout Notes

Recommended deployment:
1. Deploy server.
2. Verify old Android and macOS clients still work.
3. Deploy Android with padding enabled.
4. Verify Android traffic still transfers through forward and reverse tunnel flows.

Known incompatibility:
- New Android with padding enabled can break against an old unpatched server because old `tunnel/protocol.js` throws on unknown frame type. This is acceptable only if server rollout is controlled and happens first.

## Success Criteria

- Existing tunnel functionality is unchanged for CONNECT, DATA, CLOSE, heartbeat, and rotation.
- Server ignores incoming `PADDING`.
- Android ignores incoming `PADDING`, including during auth.
- Server emits padding after DATA and periodically on active connections.
- Android emits padding after DATA and periodically on the active connection.
- Periodic padding is not sent to draining connections.
- macOS remains compatible without production code changes.
- All listed tests pass.
