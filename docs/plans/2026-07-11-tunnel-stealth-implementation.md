# 隧道伪装传输实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**日期**: 2026-07-11
**设计文档**: `docs/plans/2026-07-11-tunnel-stealth-design.md`
**目标**: 先完成 HTTPS + WebSocket + 随机心跳的可用闭环，再实现 active + draining 的 NAT 轮换。
**架构**: WebSocket binary message 承载现有隧道帧；Phase A 只有一条 active 连接；Phase B 允许短暂两条连接并存，并让 manager 按连接绑定请求。
**技术栈**: Node.js `https` + `ws`，Python `websockets` + `aiohttp`，现有 `tunnel/protocol.js` 和 `client/tunnel_client.py` 帧协议。

---

## 实施边界

本计划只修改：

- `package.json`
- `package-lock.json`
- `tunnel/protocol.js`
- `tunnel/server.js`
- `tunnel/manager.js`
- `tunnel/test/protocol.test.js`
- `tunnel/test/server.test.js`
- `tunnel/test/manager.test.js`
- `client/requirements.txt`
- `client/tunnel_client.py`
- `client/tests/test_tunnel_client.py`

本期不处理 Android client，不处理真实证书、443 端口、SNI、ALPN、复杂 HTTP 行为随机化。

## Phase A: HTTPS + WebSocket + 随机心跳

### Task A1: 安装和固定依赖

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `client/requirements.txt`

- [ ] **Step 1: 添加 Node 依赖**

Run:

```bash
npm install ws@^8.16.0
```

Expected:

- `package.json` 出现 `ws`。
- `package-lock.json` 更新。

- [ ] **Step 2: 添加 Python 依赖**

Modify `client/requirements.txt`:

```text
aiohttp>=3.9
websockets>=15,<16
```

说明：本计划按当前本地环境 `websockets 15.x` 编写，使用 `additional_headers` 参数。

- [ ] **Step 3: 验证依赖文件**

Run:

```bash
git diff -- package.json package-lock.json client/requirements.txt
```

Expected: 只包含上述依赖变化。

### Task A2: 扩展 PING/PONG payload

**Files:**
- Modify: `tunnel/protocol.js`
- Modify: `tunnel/test/protocol.test.js`
- Modify: `client/tunnel_client.py`
- Modify: `client/tests/test_tunnel_client.py`

- [ ] **Step 1: 先写 Node 协议测试**

Add tests:

```javascript
test('PING supports optional payload', () => {
  const payload = Buffer.from('abc');
  const frame = encodeFrame({ type: FRAME_TYPES.PING, payload });
  const decoded = decodeFrame(frame);
  expect(decoded.type).toBe(FRAME_TYPES.PING);
  expect(decoded.payload).toEqual(payload);
});

test('PONG without payload decodes to empty buffer', () => {
  const frame = encodeFrame({ type: FRAME_TYPES.PONG });
  const decoded = decodeFrame(frame);
  expect(decoded.type).toBe(FRAME_TYPES.PONG);
  expect(decoded.payload).toEqual(Buffer.alloc(0));
});
```

- [ ] **Step 2: Run Node protocol tests and confirm failure**

Run:

```bash
npx jest tunnel/test/protocol.test.js
```

Expected: new payload assertions fail before implementation.

- [ ] **Step 3: 修改 `tunnel/protocol.js`**

Implementation rules:

- `AUTH_OK` / `AUTH_FAIL` 保持 type-only。
- `PING` / `PONG` encode 为 `[type]` 或 `[type][payload]`。
- `PING` / `PONG` decode 返回 `{ type, payload, bytesRead }`。
- 不要写 `const payload = payload...` 这种变量遮蔽代码；使用 `extraPayload` 或 `pingPayload`。

- [ ] **Step 4: 写 Python 协议测试**

Add tests:

```python
def test_ping_with_payload_roundtrip():
    buf = encode_frame(FRAME_PING, payload=b'abc')
    frame = decode_frame_from_buffer(buf)
    assert frame['type'] == FRAME_PING
    assert frame['payload'] == b'abc'

def test_pong_without_payload_roundtrip():
    buf = encode_frame(FRAME_PONG)
    frame = decode_frame_from_buffer(buf)
    assert frame['type'] == FRAME_PONG
    assert frame['payload'] == b''
```

- [ ] **Step 5: 修改 `client/tunnel_client.py` 协议函数**

Implementation rules:

- `encode_frame(FRAME_PING, payload=b'...')` 支持可选 payload。
- `encode_frame(FRAME_PONG, payload=b'...')` 支持可选 payload。
- `_decode_payload()` 对 PING/PONG 返回 `payload` 字段。

- [ ] **Step 6: Run protocol tests**

Run:

```bash
npx jest tunnel/test/protocol.test.js
pytest client/tests/test_tunnel_client.py -q
```

Expected: protocol 相关测试通过。

### Task A3: 服务端改为 HTTPS + WebSocket

**Files:**
- Modify: `tunnel/server.js`
- Modify: `tunnel/test/server.test.js`

- [ ] **Step 1: 写 server 行为测试**

Cover:

- `GET /` returns 200 HTML。
- `GET /favicon.ico` returns 200 icon。
- `/ws` auth success returns `AUTH_OK`。
- bad auth returns `AUTH_FAIL` or closes with policy code。
- unauthenticated non-auth frame is ignored or rejected。
- `stop()` releases the listening server.

- [ ] **Step 2: Run server tests and confirm failure**

Run:

```bash
npx jest tunnel/test/server.test.js
```

Expected: HTTPS/WS tests fail before implementation.

- [ ] **Step 3: 用 `https.createServer()` 重写监听层**

Required structure:

```javascript
const https = require('https');
const { WebSocketServer } = require('ws');

this._server = https.createServer({
  key: this.key,
  cert: this.cert,
  minVersion: 'TLSv1.2',
  sessionTimeout: 300,
}, (req, res) => this._handleHttpRequest(req, res));

this._wss = new WebSocketServer({
  server: this._server,
  path: this.wsPath || '/ws',
  maxPayload: 2 ** 16,
});
```

Do not use a separate `tls.createServer()` that manually emits `connection` into an HTTP server.

- [ ] **Step 4: 实现 HTTP 伪装路由**

Required behavior:

- `/` and `/index.html`: HTML。
- `/favicon.ico`: icon bytes。
- unknown path: normal 404。
- Keep content small and static for Phase A.

- [ ] **Step 5: 实现 WebSocket auth 和 frame dispatch**

Rules:

- `_clientWs` stores current active WS in Phase A。
- `_authenticated` starts false。
- First valid frame must be `FRAME_AUTH`。
- On auth success: send `AUTH_OK`, mark connected, call `onConnect(ws, remoteAddress, remotePort)`。
- On auth failure: send `AUTH_FAIL`, close。
- On `FRAME_PONG`: update `_pongTime` and verify payload if a pending ping payload is tracked。
- Other authenticated frames call registered frame handlers with `(frame, ws)`。

- [ ] **Step 6: 实现随机心跳**

Rules:

- Use recursive `setTimeout` instead of fixed `setInterval`。
- Interval from config or default 15-40 seconds。
- Server sends `FRAME_PING` with random 8-40 byte payload。
- Client PONG must echo payload。
- 60 seconds without valid PONG closes the WS。
- Stop clears timer.

- [ ] **Step 7: 修正 `sendFrame(frame, targetSocket)`**

Rules:

- If `targetSocket` is provided and is not current active WS, return resolved false or no-op。
- If no active WS, reject or resolve no-op consistently with manager expectations。
- Use `ws.send(data, callback)`。
- Production behavior: log send errors at debug/warn level and resolve `false` so manager cleanup can continue without throwing from unrelated streams。
- Test behavior: expose the false result or rejected test helper path so send errors are asserted rather than silently ignored。

- [ ] **Step 8: 修正 `stop()`**

Rules:

- Stop heartbeat。
- Close active WS。
- Close `WebSocketServer`。
- Close underlying HTTPS server stored in `this._server`。
- Resolve only after server close callback fires.

- [ ] **Step 9: Run server tests**

Run:

```bash
npx jest tunnel/test/server.test.js tunnel/test/protocol.test.js
```

Expected: pass。

### Task A4: manager 保留连接绑定并适配单 active

**Files:**
- Modify: `tunnel/manager.js`
- Modify: `tunnel/test/manager.test.js`

- [ ] **Step 1: 写 manager 测试**

Cover:

- `_selectSocket()` returns current active WS。
- `forward()` stores selected WS in `_activeRequests`。
- DATA/CLOSE for an existing reqid uses the entry-bound WS。
- Disconnect of one WS only clears entries bound to that WS。

- [ ] **Step 2: 修改 manager**

Rules:

- Remove round-robin for Phase A。
- Do not remove request-to-connection binding。
- `getStatus().connections` reads from server connection state through a method if possible, not private Set assumptions。
- Avoid direct references to removed `_clientSockets`。

- [ ] **Step 3: Run manager tests**

Run:

```bash
npx jest tunnel/test/manager.test.js
```

Expected: pass。

### Task A5: Python client 改为 WebSocket 单 active

**Files:**
- Modify: `client/tunnel_client.py`
- Modify: `client/tests/test_tunnel_client.py`

- [ ] **Step 1: 写 client lifecycle 测试**

Cover:

- `_establish_connection()` awaits `ws.send(AUTH)`。
- `http_disguise=True` performs `GET /`, delay, `GET /favicon.ico`, delay, then WS connect。
- `FRAME_PING` with payload sends `FRAME_PONG` with same payload。
- `stop()` cancels `_read_task`, `_heartbeat_task`, relay tasks and closes `_ws`。
- auth failed remains terminal `auth_failed`。
- occupied remains terminal `occupied`。

- [ ] **Step 2: 替换连接状态字段**

Phase A fields:

```python
self._ws = None
self._read_task = None
self._heartbeat_task = None
self._active_writers = {}
self._forward_requests = {}
self._relay_tasks = set()
```

Remove or stop using:

- `_tunnel_writers`
- `_tunnel_readers`
- `_rr_counter`
- `_connection_tasks`
- `_replenishing`
- `_replenish_task`

- [ ] **Step 3: 实现 `_establish_connection()`**

Rules:

- If `http_disguise` is true, use `aiohttp` for the full lightweight disguise sequence:
  - `GET /`
  - sleep random 0.5-2s
  - `GET /favicon.ico`
  - sleep random 0.5-2s
  - then connect WS
- Connect with `websockets.connect(..., ssl=self._ssl_ctx, ping_interval=None, ping_timeout=None, additional_headers=...)`。
- Always `await ws.send(encode_frame(FRAME_AUTH, ...))`。
- Wait for `AUTH_OK` / `AUTH_FAIL` / `ERROR`。
- Return the WS object only after auth succeeds。

- [ ] **Step 4: 实现 `_connect_and_serve()`**

Rules:

- Establish WS。
- Mark connected。
- Start `_read_task` and `_heartbeat_task`。
- Await read task。
- In finally, clear connected state, cancel tasks, close WS, fail pending forward requests, close reverse writers。
- `stop()` must not directly `await ws.close()` because it is called from a different thread. It should use `call_soon_threadsafe` to set `_running=False`, cancel/read wake tasks, and schedule an async close task on the loop. `_connect_and_serve()` remains responsible for final cleanup in `finally`。

- [ ] **Step 5: 实现 `_handle_requests()`**

Rules:

- `msg = await self._ws.recv()`。
- Decode each complete WS message as one tunnel frame。
- PING -> PONG with same payload。
- CONNECT -> start reverse `_handle_connect(frame)`。
- CONNECT_OK / CONNECT_FAILED -> signal matching forward request。
- DATA -> route to forward queue or reverse target writer。
- CLOSE -> close matching forward/reverse side。

- [ ] **Step 6: 实现 `_heartbeat_loop()`**

Rules:

- Default server-driven heartbeat is enough. If client heartbeat is kept, make it configurable and disabled by default。
- If enabled, send random PING payload at random interval。
- Do not create two independent mandatory heartbeat streams unless tests cover it。
- When client PING is disabled, the client still immediately replies to every server PING with PONG carrying the same payload. This provides client-to-server traffic for ordinary NAT mappings. If a deployment has single-direction idle cleanup, enable client PING by config。

- [ ] **Step 7: 修改 `_forward_connect_async()`**

Rules:

- Use current `_ws` instead of selected writer。
- Store `ws` in the forward request entry。
- All DATA/CLOSE for that reqid must use the entry-bound ws。
- Remove round-robin logging。

- [ ] **Step 8: 修改 `_handle_connect()`**

Rules:

- Use entry-bound ws for CONNECT_OK / DATA / CLOSE。
- On target connect failure, send CONNECT_FAILED if ws is still open。
- Do not send on a closed WS during shutdown without catching exceptions。

- [ ] **Step 9: 修改 latency measurement**

Rules:

- `_measure_latency_async()` uses `_ws`。
- It records request entry with `ws`。
- It sends CLOSE after measurement if WS is still open。

- [ ] **Step 10: Run client tests**

Run:

```bash
pytest client/tests/test_tunnel_client.py -q
```

Expected: pass。

### Task A6: Phase A 集成验证

**Files:**
- No source files unless bugs are found.

- [ ] **Step 1: Run unit tests**

Run:

```bash
npx jest tunnel/test/protocol.test.js tunnel/test/server.test.js tunnel/test/manager.test.js
pytest client/tests/test_tunnel_client.py -q
```

Expected: pass。

- [ ] **Step 2: Start server manually**

Run the existing server start command for this repo.

Expected:

- Tunnel listens on configured `8003`。
- No startup exception。

- [ ] **Step 3: Verify HTTP disguise**

Run:

```bash
curl -k https://127.0.0.1:8003/
curl -k https://127.0.0.1:8003/favicon.ico --output /tmp/tunnel-favicon.ico
```

Expected:

- `/` returns HTML。
- `/favicon.ico` returns bytes。

- [ ] **Step 4: Verify Python client connection**

Run Python client with existing local config.

Expected:

- status becomes `connected`。
- server logs auth success。
- no fixed 30s heartbeat pattern remains。

- [ ] **Step 5: Verify proxy behavior**

Manual checks:

- Forward proxy through tunnel works。
- Reverse proxy through tunnel works。
- Stop client frees server slot quickly。
- Restart client reconnects successfully。

## Phase B: active + candidate/draining NAT 轮换

Implement Phase B only after Phase A passes.

### Task B1: 服务端连接状态机

**Files:**
- Modify: `tunnel/server.js`
- Modify: `tunnel/test/server.test.js`

- [ ] **Step 1: 写状态机测试**

Cover:

- First authenticated WS becomes `active`。
- Second authenticated WS becomes `candidate`, then promoted to `active`。
- Old active becomes `draining`。
- Third authenticated WS is rejected while active + draining already exist。
- Draining closes after timeout。

- [ ] **Step 2: 实现连接记录**

Use records similar to:

```javascript
{
  ws,
  state: 'active' | 'candidate' | 'draining',
  authenticated: true,
  remoteAddress,
  remotePort,
  connectedAt,
  promotionDeadline,
  drainTimer,
  pongTime,
}
```

- [ ] **Step 3: 实现 promotion**

Rules:

- New authenticated candidate becomes active immediately。
- Existing active becomes draining。
- Candidate must not remain in candidate state after auth success; promotion is synchronous with successful auth。
- Keep `promotionDeadline` as defensive cleanup for unexpected async failures, and close stale candidates after the deadline。
- `onConnect` fires for new active。
- `onDisconnect` for old active should not mark manager disconnected while a new active exists。

- [ ] **Step 4: Run server tests**

Run:

```bash
npx jest tunnel/test/server.test.js
```

Expected: pass。

### Task B2: manager 支持 active/draining

**Files:**
- Modify: `tunnel/manager.js`
- Modify: `tunnel/test/manager.test.js`

- [ ] **Step 1: 写请求绑定测试**

Cover:

- New `forward()` requests use new active after promotion。
- Existing entries bound to draining continue sending to draining。
- Disconnect draining clears only entries bound to draining。
- Disconnect active while draining exists updates availability correctly。

- [ ] **Step 2: 修改 selection 和 status**

Rules:

- `_selectSocket()` returns server active WS only。
- `_activeRequests` entry remains the source of truth for existing reqid。
- `isAvailable()` true only when active exists。
- Status reports active/draining counts。

- [ ] **Step 3: Run manager tests**

Run:

```bash
npx jest tunnel/test/manager.test.js
```

Expected: pass。

### Task B3: Python client NAT 轮换

**Files:**
- Modify: `client/tunnel_client.py`
- Modify: `client/tests/test_tunnel_client.py`

- [ ] **Step 1: 写轮换测试**

Cover:

- Rotation disabled by default。
- Rotation failure keeps old `_active_ws`。
- Rotation success switches new requests to new `_active_ws`。
- Old WS is closed after drain timeout。
- Pending forward requests stay bound to the WS they started on。

- [ ] **Step 2: 添加 Phase B 状态**

Use:

```python
self._active_ws = None
self._candidate_ws = None
self._draining_ws = None
self._rotation_task = None
```

Keep `_ws` only as a compatibility alias if needed; prefer `_active_ws` internally.

- [ ] **Step 3: 实现 `_rotation_loop()`**

Rules:

- Runs only when `rotation_enabled` is true。
- Sleep random `rotation_min` to `rotation_max`。
- Calls `_rotation_cycle()`。
- Cancellation during stop must not leak tasks。

- [ ] **Step 4: 实现 `_rotation_cycle()`**

Rules:

- Establish candidate using same auth path。
- If candidate fails, close it and keep active。
- If candidate succeeds, assign candidate as active。
- Old active becomes draining。
- Start a read loop for new active before closing old。
- Do not cancel old read loop until draining closes。
- Close old after drain timeout or after no entries reference it。

- [ ] **Step 5: Bind forward/reverse requests to WS**

Rules:

- Each forward request entry stores `ws`。
- Each reverse active writer entry stores `ws` if needed。
- DATA/CLOSE sends use entry-bound `ws`。
- New requests always use current active。

- [ ] **Step 6: Run client tests**

Run:

```bash
pytest client/tests/test_tunnel_client.py -q
```

Expected: pass。

### Task B4: Phase B 集成验证

**Files:**
- No source files unless bugs are found.

- [ ] **Step 1: Run all unit tests**

Run:

```bash
npx jest tunnel/test/protocol.test.js tunnel/test/server.test.js tunnel/test/manager.test.js
pytest client/tests/test_tunnel_client.py -q
```

Expected: pass。

- [ ] **Step 2: Enable short rotation interval in test config**

Use temporary config:

```python
rotation_enabled = True
rotation_min = 20
rotation_max = 30
rotation_drain_timeout = 5
```

- [ ] **Step 3: Run manual tunnel session**

Expected:

- Initial connection active。
- After interval, second connection authenticates。
- New active takes new requests。
- Old draining closes。
- Existing traffic does not hard fail during successful rotation。

- [ ] **Step 4: Failure simulation**

Temporarily block candidate connection or use bad credentials in a test-only path.

Expected:

- Rotation logs failure。
- Old active remains connected。
- Forward and reverse proxy continue working。

## 回滚

服务端 rollback:

```bash
git checkout HEAD -- package.json package-lock.json tunnel/protocol.js tunnel/server.js tunnel/manager.js tunnel/test/protocol.test.js tunnel/test/server.test.js tunnel/test/manager.test.js
```

客户端 rollback:

```bash
git checkout HEAD -- client/requirements.txt client/tunnel_client.py client/tests/test_tunnel_client.py
```

## 最终完成条件

- Phase A tests pass。
- Phase A manual forward/reverse proxy passes。
- Phase B tests pass if rotation is implemented。
- Phase B manual rotation passes if rotation is implemented。
- No server port leak after stop/restart。
- No Python task/socket leak after client stop。
- Documentation clearly states that 8003/self-signed TLS remain known exposure points for a later task。
