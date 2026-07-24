# xhttp Upload Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize Android-to-Node xhttp uploads with HTTP/1.1 connection reuse, negotiated multi-frame POST batching, and optional HTTP/2 fallback-safe support.

**Architecture:** Keep the tunnel packet-up: Android sends bounded POST uploads, and Node reorders uploads by POST sequence. Add batch support by concatenating existing encoded frames inside one POST body, so individual frame wire format stays unchanged. Add HTTP/2 as an optional negotiated transport with HTTP/1.1 compatibility preserved by `allowHTTP1` and client fallback.

**Tech Stack:** Android Kotlin, OkHttp, kotlinx.coroutines, JUnit; Node.js `https`/`http2`, `node:test`; existing `tunnel/protocol.js`, `XhttpHandler`, `XhttpUploadScheduler`, `XhttpTransport`, and native uTLS fallback.

---

## Implementation Notes

Do not commit this plan document until the owner approves it. The task-level commit steps below are for the later implementation phase.

Keep scope limited to:

- `tunnel/*`
- `tunnel/test/*`
- `android-client/app/src/main/java/com/blockproxy/android/tunnel/*`
- `android-client/app/src/test/java/com/blockproxy/android/tunnel/*`

Do not change macOS, iOS, proxy-core, routing, MITM, admin UI, or general app behavior.

## File Structure

- Modify `tunnel/protocol.js`
  - Add upload capability constants.
  - Add a helper to decode concatenated encoded frames from one POST body.
- Modify `tunnel/xhttpHandler.js`
  - Negotiate `upload-batch-v1` and later `upload-h2-v1`.
  - Consume one or more frames from each upload queue payload.
  - Avoid payload logging.
- Modify `tunnel/server.js`
  - Add HTTP/2 server support with `allowHTTP1`.
  - Keep the existing handler call path for HTTP/1.1.
- Modify `tunnel/test/protocol.test.js`
  - Cover multi-frame body decode.
- Modify `tunnel/test/xhttpHandler.test.js`
  - Cover capability negotiation, batch delivery, malformed body behavior, and out-of-order batch ordering.
- Modify `tunnel/test/server.test.js`
  - Cover HTTP/1.1 compatibility and HTTP/2 create/upload/stream basics.
- Modify `android-client/app/src/main/java/com/blockproxy/android/tunnel/FrameCodec.kt`
  - Add upload capability constants and optional multi-frame encode/decode helpers for tests.
- Modify `android-client/app/src/main/java/com/blockproxy/android/tunnel/XhttpTransport.kt`
  - Update connection pool defaults.
  - Carry negotiated upload options into scheduler.
  - Add h2-capable OkHttp factory option.
- Modify `android-client/app/src/main/java/com/blockproxy/android/tunnel/XhttpSession.kt`
  - Advertise upload capabilities.
  - Parse negotiated capabilities from create response or early CAPABILITIES frame, depending on chosen implementation.
- Modify `android-client/app/src/main/java/com/blockproxy/android/tunnel/XhttpUploadScheduler.kt`
  - Add batch mode while preserving four workers and priority queues.
- Modify `android-client/app/src/main/java/com/blockproxy/android/tunnel/XhttpUploadClient.kt`
  - Add lightweight upload RTT/protocol diagnostics if practical.
- Modify `android-client/app/src/test/java/com/blockproxy/android/tunnel/XhttpUploadSchedulerTest.kt`
  - Add batching tests.
- Modify `android-client/app/src/test/java/com/blockproxy/android/tunnel/XhttpTransportTest.kt`
  - Add connection pool and protocol-selection tests where feasible.
- Add `android-client/app/src/test/java/com/blockproxy/android/tunnel/XhttpSessionTest.kt` if session capability parsing cannot be covered cleanly in existing tests.

## Task 1: Node Batch Decode Helper and Capabilities

**Files:**
- Modify: `tunnel/protocol.js`
- Modify: `tunnel/test/protocol.test.js`

- [ ] **Step 1: Add failing protocol tests**

Add tests in `tunnel/test/protocol.test.js`:

```js
it('decodes concatenated encoded frames from an upload body', () => {
  const first = encodeFrame({ type: FRAME_TYPES.PING, payload: Buffer.from('a') });
  const second = encodeFrame({ type: FRAME_TYPES.PING, payload: Buffer.from('b') });

  const frames = decodeFrames(Buffer.concat([first, second]));

  assert.equal(frames.length, 2);
  assert.equal(frames[0].payload.toString('utf8'), 'a');
  assert.equal(frames[1].payload.toString('utf8'), 'b');
});

it('rejects malformed concatenated frame bodies', () => {
  const good = encodeFrame({ type: FRAME_TYPES.PING, payload: Buffer.from('a') });
  const truncated = good.subarray(0, good.length - 1);

  assert.throws(() => decodeFrames(truncated), /Incomplete frame/);
});
```

Import `decodeFrames` from `../protocol`. Expect the tests to fail because the helper is not exported yet.

- [ ] **Step 2: Run failing Node protocol tests**

Run:

```bash
node --test tunnel/test/protocol.test.js
```

Expected: FAIL with `decodeFrames` missing or not a function.

- [ ] **Step 3: Implement protocol constants and helper**

In `tunnel/protocol.js`, add:

```js
const CAP_UPLOAD_BATCH = 'upload-batch-v1';
const CAP_UPLOAD_H2 = 'upload-h2-v1';

function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 2) {
      throw new Error('Incomplete frame header');
    }
    const length = buffer.readUInt16BE(offset);
    const end = offset + 2 + length;
    if (end > buffer.length) {
      throw new Error('Incomplete frame');
    }
    const frameBuffer = buffer.slice(offset, end);
    frames.push(decodeFrame(frameBuffer));
    offset = end;
  }
  return frames;
}
```

Export `CAP_UPLOAD_BATCH`, `CAP_UPLOAD_H2`, and `decodeFrames`.

- [ ] **Step 4: Run protocol tests**

Run:

```bash
node --test tunnel/test/protocol.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit checkpoint**

Implementation phase only:

```bash
git add tunnel/protocol.js tunnel/test/protocol.test.js
git commit -m "feat(tunnel): decode batched xhttp upload frames"
```

## Task 2: Node Upload Batch Consumption

**Files:**
- Modify: `tunnel/xhttpHandler.js`
- Modify: `tunnel/test/xhttpHandler.test.js`

- [ ] **Step 1: Add failing handler tests**

Add tests in `tunnel/test/xhttpHandler.test.js`:

```js
it('negotiates upload batch capability when advertised', async () => {
  const { handler, events } = createHandler();

  await createSession(handler, ['upload-batch-v1']);

  const created = events.find(event => event.type === 'created');
  assert.deepEqual(created.info.capabilities, ['upload-batch-v1']);
  handler.closeAll();
});

it('accepts batched upload bodies and delivers frames in body order', async () => {
  const { handler, events } = createHandler();
  const sessionId = await createSession(handler, ['upload-batch-v1']);
  const body = Buffer.concat([
    encodeFrame({ type: FRAME_TYPES.PING, payload: Buffer.from('first') }),
    encodeFrame({ type: FRAME_TYPES.PING, payload: Buffer.from('second') }),
  ]);

  const req = mockRequest('POST', `/xhttp/upload/${sessionId}/0`, body);
  const res = mockResponse();
  assert.equal(handler.handleRequest(req, res), true);
  req.emitBody();

  assert.equal(res.statusCode, 200);
  await new Promise(resolve => setImmediate(resolve));
  const frames = events.filter(event => event.type === 'frame').map(event => event.frame);
  assert.deepEqual(frames.map(frame => frame.payload.toString('utf8')), ['first', 'second']);
  handler.closeAll();
});

it('reorders batched uploads by POST seq before decoding frames', async () => {
  const { handler, events } = createHandler();
  const sessionId = await createSession(handler, ['upload-batch-v1']);

  for (const [seq, label] of [[1, 'second'], [0, 'first']]) {
    const req = mockRequest('POST', `/xhttp/upload/${sessionId}/${seq}`, encodeFrame({
      type: FRAME_TYPES.PING,
      payload: Buffer.from(label),
    }));
    const res = mockResponse();
    assert.equal(handler.handleRequest(req, res), true);
    req.emitBody();
    assert.equal(res.statusCode, 200);
  }

  await new Promise(resolve => setImmediate(resolve));
  const frames = events.filter(event => event.type === 'frame').map(event => event.frame);
  assert.deepEqual(frames.map(frame => frame.payload.toString('utf8')), ['first', 'second']);
  handler.closeAll();
});
```

- [ ] **Step 2: Run failing handler tests**

Run:

```bash
node --test tunnel/test/xhttpHandler.test.js
```

Expected: FAIL on missing capability negotiation or single-frame decode behavior.

- [ ] **Step 3: Implement capability negotiation**

In `tunnel/xhttpHandler.js`:

- Import `CAP_UPLOAD_BATCH`, `CAP_UPLOAD_H2`, and `decodeFrames`.
- When building `serverCapabilities`, add `CAP_UPLOAD_BATCH` if the client advertised it.
- Add `CAP_UPLOAD_H2` only after Task 3 adds h2 server support. For now leave h2 disabled or guarded behind an internal option.

Keep padding negotiation unchanged.

- [ ] **Step 4: Implement multi-frame consume**

Replace the single `decodeFrame(payload)` call in `_startConsumeLoop()` with:

```js
let frames;
try {
  frames = decodeFrames(payload);
} catch (e) {
  console.warn(`[xhttp] Upload batch decode error in session ${session.sessionId}:`, e.message);
  continue;
}

for (const frame of frames) {
  try {
    this._onFrame(frame, session.sessionId);
  } catch (e) {
    console.error(`[xhttp] onFrame error for session ${session.sessionId}:`, e.message);
  }
}
```

This keeps legacy single-frame POSTs valid because they decode as a one-frame batch.

- [ ] **Step 5: Run handler tests**

Run:

```bash
node --test tunnel/test/xhttpHandler.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit checkpoint**

Implementation phase only:

```bash
git add tunnel/xhttpHandler.js tunnel/test/xhttpHandler.test.js
git commit -m "feat(tunnel): accept batched xhttp uploads"
```

## Task 3: Node HTTP/2 Server Compatibility

**Files:**
- Modify: `tunnel/server.js`
- Modify: `tunnel/xhttpHandler.js`
- Modify: `tunnel/test/server.test.js`

- [ ] **Step 1: Add failing HTTP/2 server tests**

In `tunnel/test/server.test.js`, import `http2` and add helpers using `http2.connect()` against the test TLS server.

Add a test:

```js
it('accepts xhttp create over HTTP/2 while preserving HTTP/1.1 compatibility', async () => {
  const port = nextPort();
  server = new TunnelServer({
    port,
    cert, key,
    credentials: { username: 'admin', password: 'secret' },
  });
  await server.start();

  const client = http2.connect(`https://localhost:${port}`, { rejectUnauthorized: false });
  try {
    const authFrame = encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret',
      capabilities: ['upload-h2-v1'],
    });
    const res = await h2Request(client, 'POST', '/xhttp/create', authFrame, {
      'content-type': 'application/octet-stream',
      'content-length': String(authFrame.length),
    });
    assert.equal(res.status, 200);
    assert.ok(JSON.parse(res.body.toString('utf8')).sessionId);
  } finally {
    client.close();
  }

  const h1SessionId = await createSession(port);
  assert.ok(h1SessionId);
});
```

Implement `h2Request()` in the test file as a local test helper that collects `response` headers and body bytes.

- [ ] **Step 2: Run failing server tests**

Run:

```bash
node --test tunnel/test/server.test.js
```

Expected: FAIL because the server is HTTP/1.1-only.

- [ ] **Step 3: Add HTTP/2 server with HTTP/1.1 fallback**

In `tunnel/server.js`, use:

```js
const http2 = require('http2');

this._server = http2.createSecureServer({
  key: this.key,
  cert: this.cert,
  minVersion: 'TLSv1.2',
  allowHTTP1: true,
}, (req, res) => this._handleHttpRequest(req, res));
```

Preserve stop/start semantics.

- [ ] **Step 4: Make SSE headers h2-safe**

In `tunnel/xhttpHandler.js`, avoid sending `connection: keep-alive` when `req.httpVersionMajor === 2` or `req.httpVersion === '2.0'`.

Use a small helper:

```js
_isHttp2(req) {
  return req.httpVersionMajor === 2 || String(req.httpVersion).startsWith('2');
}
```

Then build response headers conditionally.

- [ ] **Step 5: Enable h2 capability on h2-supported sessions**

After server h2 support lands, negotiate `CAP_UPLOAD_H2` when:

- client advertises `upload-h2-v1`
- server option does not disable h2

Do not require the current create request itself to be h2. The capability means the server can accept h2.

- [ ] **Step 6: Run server tests**

Run:

```bash
node --test tunnel/test/server.test.js tunnel/test/xhttpHandler.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit checkpoint**

Implementation phase only:

```bash
git add tunnel/server.js tunnel/xhttpHandler.js tunnel/test/server.test.js tunnel/test/xhttpHandler.test.js
git commit -m "feat(tunnel): support optional xhttp HTTP2"
```

## Task 4: Android Connection Pool Defaults

**Files:**
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/XhttpTransport.kt`
- Modify: `android-client/app/src/test/java/com/blockproxy/android/tunnel/XhttpTransportTest.kt`

- [ ] **Step 1: Add failing connection pool test**

In `XhttpTransportTest.kt`, add:

```kotlin
@Test
fun `default xhttp client keeps reusable upload connections`() {
    val client = XhttpTransport.createOkHttpClient(
        allowInsecure = false,
        protect = null,
    )

    assertTrue(client.connectionPool.connectionCount() >= 0)
    assertTrue(client.protocols.contains(okhttp3.Protocol.HTTP_1_1))
}
```

If OkHttp does not expose enough pool settings for a direct assertion, add package-visible constants in `XhttpTransport`:

```kotlin
internal const val XHTTP_CONNECTION_POOL_SIZE = 4
internal const val XHTTP_CONNECTION_KEEPALIVE_SECONDS = 60L
```

Then test those constants.

- [ ] **Step 2: Run failing Android tunnel tests**

Run:

```bash
cd android-client && ./gradlew :app:testPhoneDebugUnitTest --tests com.blockproxy.android.tunnel.XhttpTransportTest
```

Expected: FAIL if constants or new behavior are not present.

- [ ] **Step 3: Implement reusable connection pool**

In `XhttpTransport.kt`:

```kotlin
internal const val XHTTP_CONNECTION_POOL_SIZE = 4
internal const val XHTTP_CONNECTION_KEEPALIVE_SECONDS = 60L
```

Change:

```kotlin
.connectionPool(ConnectionPool(0, 1, TimeUnit.MILLISECONDS))
```

to:

```kotlin
.connectionPool(ConnectionPool(
    XHTTP_CONNECTION_POOL_SIZE,
    XHTTP_CONNECTION_KEEPALIVE_SECONDS,
    TimeUnit.SECONDS,
))
```

Keep `DEFAULT_MAX_CONCURRENT_POSTS = 4` unchanged in `XhttpUploadScheduler`.

- [ ] **Step 4: Run Android tunnel tests**

Run:

```bash
cd android-client && ./gradlew :app:testPhoneDebugUnitTest --tests com.blockproxy.android.tunnel.XhttpTransportTest --tests com.blockproxy.android.tunnel.XhttpUploadSchedulerTest
```

Expected: PASS.

- [ ] **Step 5: Commit checkpoint**

Implementation phase only:

```bash
git add android-client/app/src/main/java/com/blockproxy/android/tunnel/XhttpTransport.kt android-client/app/src/test/java/com/blockproxy/android/tunnel/XhttpTransportTest.kt
git commit -m "feat(android): reuse xhttp upload connections"
```

## Task 5: Android Batch Upload Scheduler

**Files:**
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/FrameCodec.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/XhttpUploadScheduler.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/XhttpTransport.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/XhttpSession.kt`
- Modify: `android-client/app/src/test/java/com/blockproxy/android/tunnel/XhttpUploadSchedulerTest.kt`
- Add if needed: `android-client/app/src/test/java/com/blockproxy/android/tunnel/XhttpSessionTest.kt`

- [ ] **Step 1: Add failing scheduler batch tests**

In `XhttpUploadSchedulerTest.kt`, extend `BlockingUploadClient` to store raw bodies and add tests:

```kotlin
@Test
fun `batches forward data frames until max frame count`() = runTest {
    val uploadClient = RecordingUploadClient()
    val scheduler = XhttpUploadScheduler(
        scope = this,
        baseUrl = "https://example.com/xhttp",
        sessionId = "sid",
        uploadClient = uploadClient,
        batchEnabled = true,
        batchFlushMs = 10_000L,
        batchMaxBytes = 16 * 1024,
        batchMaxFrames = 2,
        maxConcurrentPosts = 1,
    )

    val first = async { scheduler.sendFrame(FrameCodec.encode(Frame.Data(0x8000, byteArrayOf(1)))) }
    val second = async { scheduler.sendFrame(FrameCodec.encode(Frame.Data(0x8001, byteArrayOf(2)))) }
    runCurrent()

    assertTrue(first.await())
    assertTrue(second.await())
    assertEquals(1, uploadClient.bodies.size)
    assertEquals(2, FrameCodec.decodeMany(uploadClient.bodies[0]).size)
    scheduler.close()
}

@Test
fun `control frame flushes separately from queued data`() = runTest {
    val uploadClient = RecordingUploadClient()
    val scheduler = XhttpUploadScheduler(
        scope = this,
        baseUrl = "https://example.com/xhttp",
        sessionId = "sid",
        uploadClient = uploadClient,
        batchEnabled = true,
        batchFlushMs = 10_000L,
        maxConcurrentPosts = 1,
    )

    val data = async { scheduler.sendFrame(FrameCodec.encode(Frame.Data(0x8000, byteArrayOf(1)))) }
    runCurrent()
    val close = async { scheduler.sendFrame(FrameCodec.encode(Frame.Close(0x8000))) }
    runCurrent()

    assertTrue(data.await())
    assertTrue(close.await())
    assertEquals(2, uploadClient.bodies.size)
    assertEquals(1, FrameCodec.decodeMany(uploadClient.bodies[0]).size)
    assertTrue(FrameCodec.decodeMany(uploadClient.bodies[1]).single() is Frame.Close)
    scheduler.close()
}
```

Add `RecordingUploadClient` for tests if `BlockingUploadClient` is too coupled to single-frame assumptions.

- [ ] **Step 2: Add failing capability test**

Add a test that creates an `XhttpSession` auth frame with capabilities including `upload-batch-v1`. If `XhttpSession` is hard to unit test, extract capability construction to an internal function on `FrameCodec` or a small `XhttpCapabilities` object and test that instead.

- [ ] **Step 3: Run failing Android scheduler tests**

Run:

```bash
cd android-client && ./gradlew :app:testPhoneDebugUnitTest --tests com.blockproxy.android.tunnel.XhttpUploadSchedulerTest
```

Expected: FAIL because batching parameters and `FrameCodec.decodeMany()` do not exist yet.

- [ ] **Step 4: Add Android capability constants and decodeMany**

In `FrameCodec.kt`:

```kotlin
const val CAP_UPLOAD_BATCH = "upload-batch-v1"
const val CAP_UPLOAD_H2 = "upload-h2-v1"

fun decodeMany(body: ByteArray): List<Frame> {
    val frames = mutableListOf<Frame>()
    var offset = 0
    while (offset < body.size) {
        if (body.size - offset < 2) {
            throw IllegalArgumentException("Incomplete frame header")
        }
        val length = ((body[offset].toInt() and 0xFF) shl 8) or
            (body[offset + 1].toInt() and 0xFF)
        val end = offset + 2 + length
        if (end > body.size) {
            throw IllegalArgumentException("Incomplete frame")
        }
        frames.add(decode(body.copyOfRange(offset, end)))
        offset = end
    }
    return frames
}
```

- [ ] **Step 5: Implement batch mode in scheduler**

Add constructor parameters to `XhttpUploadScheduler`:

```kotlin
private val batchEnabled: Boolean = false,
private val batchFlushMs: Long = 10L,
private val batchMaxBytes: Int = 16 * 1024,
private val batchMaxFrames: Int = 32,
```

Keep default behavior compatible: `batchEnabled = false`.

Implement batching inside the worker path with these constraints:

- Non-batch mode keeps current behavior.
- Batch mode combines only frames selected by the same priority lane.
- CONTROL, CONNECT, and CLOSE trigger immediate POST.
- Each batch gets one `seq`.
- `sendFrame()` completes only after the POST carrying that frame succeeds or fails.
- If a batch POST fails, complete every task in that batch with `false`.

The simplest implementation is to make `UploadTask.seq` nullable until a batch is assembled, assign the POST seq at send time, and post a concatenated body.

- [ ] **Step 6: Wire negotiated batch mode into transport**

In `XhttpTransport`, add an `uploadBatchEnabled` constructor parameter and pass it into `XhttpUploadScheduler`.

In `XhttpSession`, advertise `FrameCodec.CAP_UPLOAD_BATCH` in `Frame.Auth`. Parse negotiated capabilities and pass `uploadBatchEnabled = negotiatedCapabilities.contains(FrameCodec.CAP_UPLOAD_BATCH)` to `XhttpTransport`.

If negotiated capabilities are currently only received as an SSE `CAPABILITIES` frame after transport start, choose one of two implementation strategies:

- Preferred: extend `/xhttp/create` JSON response to include `capabilities`, while keeping `sessionId` unchanged for old clients.
- Fallback: create transport with batch disabled, then enable batch after the `CAPABILITIES` frame is received.

Use the preferred create-response strategy if it is small and keeps compatibility.

- [ ] **Step 7: Run Android scheduler tests**

Run:

```bash
cd android-client && ./gradlew :app:testPhoneDebugUnitTest --tests com.blockproxy.android.tunnel.XhttpUploadSchedulerTest --tests com.blockproxy.android.tunnel.XhttpTransportTest
```

Expected: PASS.

- [ ] **Step 8: Run Node compatibility tests after create response change**

If `/xhttp/create` now returns capabilities, run:

```bash
node --test tunnel/test/xhttpHandler.test.js tunnel/test/server.test.js
```

Expected: PASS, including old tests that parse only `sessionId`.

- [ ] **Step 9: Commit checkpoint**

Implementation phase only:

```bash
git add android-client/app/src/main/java/com/blockproxy/android/tunnel/FrameCodec.kt android-client/app/src/main/java/com/blockproxy/android/tunnel/XhttpUploadScheduler.kt android-client/app/src/main/java/com/blockproxy/android/tunnel/XhttpTransport.kt android-client/app/src/main/java/com/blockproxy/android/tunnel/XhttpSession.kt android-client/app/src/test/java/com/blockproxy/android/tunnel/XhttpUploadSchedulerTest.kt android-client/app/src/test/java/com/blockproxy/android/tunnel/XhttpTransportTest.kt tunnel/xhttpHandler.js tunnel/test/xhttpHandler.test.js tunnel/test/server.test.js
# If created, also add:
# git add android-client/app/src/test/java/com/blockproxy/android/tunnel/XhttpSessionTest.kt
git commit -m "feat(android): batch xhttp upload frames"
```

## Task 6: Android HTTP/2 Mode and Fallback

**Files:**
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/XhttpTransport.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/XhttpSession.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelClient.kt`
- Modify: `android-client/app/src/test/java/com/blockproxy/android/tunnel/XhttpTransportTest.kt`
- Add or modify: `android-client/app/src/test/java/com/blockproxy/android/tunnel/XhttpSessionTest.kt`

- [ ] **Step 1: Add failing h2 protocol-selection tests**

In `XhttpTransportTest.kt`, add tests for a new factory parameter:

```kotlin
@Test
fun `h1 client pins HTTP 1_1`() {
    val client = XhttpTransport.createOkHttpClient(
        allowInsecure = false,
        protect = null,
        preferHttp2 = false,
    )

    assertEquals(listOf(okhttp3.Protocol.HTTP_1_1), client.protocols)
}

@Test
fun `h2 preferred client allows HTTP 2 with HTTP 1_1 fallback`() {
    val client = XhttpTransport.createOkHttpClient(
        allowInsecure = false,
        protect = null,
        preferHttp2 = true,
    )

    assertTrue(client.protocols.contains(okhttp3.Protocol.HTTP_2))
    assertTrue(client.protocols.contains(okhttp3.Protocol.HTTP_1_1))
}
```

- [ ] **Step 2: Run failing h2 tests**

Run:

```bash
cd android-client && ./gradlew :app:testPhoneDebugUnitTest --tests com.blockproxy.android.tunnel.XhttpTransportTest
```

Expected: FAIL because `preferHttp2` does not exist.

- [ ] **Step 3: Add h2-capable OkHttp factory option**

Change `XhttpTransport.createOkHttpClient()` signature:

```kotlin
fun createOkHttpClient(
    allowInsecure: Boolean,
    protect: ((Socket) -> Boolean)?,
    preferHttp2: Boolean = false,
): OkHttpClient
```

Use:

```kotlin
val protocols = if (preferHttp2) {
    listOf(Protocol.HTTP_2, Protocol.HTTP_1_1)
} else {
    listOf(Protocol.HTTP_1_1)
}
```

- [ ] **Step 4: Wire h2 as disabled-by-default**

In `TunnelClient`, keep current calls using `preferHttp2 = false`.

Add an internal path that can build h2-preferred clients after `upload-h2-v1` is negotiated and an implementation flag enables it. If there is no existing config field, use a private constant:

```kotlin
private const val XHTTP_H2_ENABLED = false
```

Do not expose UI or config changes in this implementation.

- [ ] **Step 5: Implement fallback session rebuild**

In `XhttpSession` or `TunnelClient`, keep fallback simple:

- Try h2 only when `XHTTP_H2_ENABLED` is true.
- On create/SSE/upload establishment failure, discard that transport and retry once with h1 clients.
- Log `upload.fallback_reason`.

Avoid fallback loops. One h2 attempt plus one h1 attempt is enough.

- [ ] **Step 6: Run Android tunnel tests**

Run:

```bash
cd android-client && ./gradlew :app:testPhoneDebugUnitTest --tests com.blockproxy.android.tunnel.XhttpTransportTest --tests com.blockproxy.android.tunnel.XhttpUploadSchedulerTest
```

Expected: PASS.

- [ ] **Step 7: Commit checkpoint**

Implementation phase only:

```bash
git add android-client/app/src/main/java/com/blockproxy/android/tunnel/XhttpTransport.kt android-client/app/src/main/java/com/blockproxy/android/tunnel/XhttpSession.kt android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelClient.kt android-client/app/src/test/java/com/blockproxy/android/tunnel/XhttpTransportTest.kt
# If created, also add:
# git add android-client/app/src/test/java/com/blockproxy/android/tunnel/XhttpSessionTest.kt
git commit -m "feat(android): add optional xhttp HTTP2 fallback"
```

## Task 7: Full Verification

**Files:**
- No planned source changes unless tests expose issues.

- [ ] **Step 1: Run all Node tunnel tests**

Run:

```bash
node --test tunnel/test/*.test.js
```

Expected: PASS.

- [ ] **Step 2: Run Android phone unit tests for tunnel package**

Run:

```bash
cd android-client && ./gradlew :app:testPhoneDebugUnitTest --tests 'com.blockproxy.android.tunnel.*'
```

Expected: PASS.

- [ ] **Step 3: Run Android emulator unit tests for tunnel package**

Run:

```bash
cd android-client && ./gradlew :app:testEmulatorDebugUnitTest --tests 'com.blockproxy.android.tunnel.*'
```

Expected: PASS.

- [ ] **Step 4: Build Android debug APKs**

Run:

```bash
cd android-client && ./gradlew :app:assemblePhoneDebug :app:assembleEmulatorDebug
```

Expected: PASS and debug APKs generated.

- [ ] **Step 5: Manual CDN smoke checks**

Run an Android client through each route:

- direct origin, h1 batch
- Cloudflare CDN, h1 batch
- Alibaba Cloud CDN, h1 batch
- optional Cloudflare h2 if `XHTTP_H2_ENABLED` is temporarily enabled

Expected:

- `/xhttp/create` succeeds.
- SSE stays connected for at least several minutes.
- LLM-style token output reaches Node without visible stalls.
- Upload diagnostics show batch frame counts above 1 for token streams.
- h2 failures fall back to h1 without leaving stale sessions active.

- [ ] **Step 6: Final implementation commit**

Implementation phase only, after all verification passes:

```bash
git status --short
git commit --allow-empty -m "test: verify xhttp upload optimization"
```

Use this only if the implementation workflow wants an explicit verification checkpoint. Otherwise skip the empty commit.
