# Silent Mode Tunnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement silent mode for the bidirectional tunnel to reduce DPI detection by disconnecting WebSocket after 50 minutes of inactivity and using SSE control plane for wake-up signals.

**Architecture:** Server-side configurable SSE endpoint (default `/api/v1/events`) + WakeBuffer for request buffering during wake-up. Client-side `SilentModeController` orchestrates ACTIVE ↔ SLEEPING state transitions. Global heartbeat parameter change (210-270s).

**Tech Stack:** Node.js (server), Kotlin (Android client), WebSocket, SSE control plane, SHA256 token auth.

## Global Constraints

- Heartbeat interval: 210-270 seconds (random), timeout: 300 seconds
- Silent timeout: 3000 seconds (50 minutes) without DATA/CONNECT/CLOSE frames
- SSE keepalive interval: 35-45 seconds random
- SSE reconnect interval: 3-8 seconds random on disconnect/failure
- Wake buffer timeout: 10 seconds
- Silent mode check interval: 60 seconds
- Token: SHA256(username:password), no certificate validation for SSE
- Control and data paths share the same server and port; SSE host/path are configurable and routed by path.
- Backward compatibility: old clients work with new server, new clients degrade gracefully with old server

---

## Phase 1: Server-Side Infrastructure

### Task 1: Update Heartbeat Parameters (Global)

**Files:**
- Modify: `tunnel/server.js:11-13` (DEFAULT_HEARTBEAT_* constants)

**Interfaces:**
- Produces: New default heartbeat parameters used by all connections

- [ ] **Step 1: Write the test**

```javascript
// tunnel/test/server.test.js
describe('TunnelServer heartbeat parameters', () => {
  it('uses 210-270s random interval with 300s timeout', () => {
    const server = new TunnelServer({ port: 8003, cert, key, credentials });
    assert.strictEqual(server.heartbeatMin, 210);
    assert.strictEqual(server.heartbeatMax, 270);
    assert.strictEqual(server.heartbeatTimeout, 300);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tunnel/test/server.test.js`
Expected: FAIL — heartbeatMin is 15, not 210

- [ ] **Step 3: Update constants**

```javascript
// tunnel/server.js:11-13
const DEFAULT_HEARTBEAT_MIN = 210;
const DEFAULT_HEARTBEAT_MAX = 270;
const DEFAULT_HEARTBEAT_TIMEOUT = 300;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tunnel/test/server.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tunnel/server.js tunnel/test/server.test.js
git commit -m "feat(tunnel): update heartbeat to 210-270s interval, 300s timeout"
```

---

### Task 2: Add `silent_mode` AUTH Flag

**Files:**
- Modify: `tunnel/protocol.js:26` (add CAP_SILENT_MODE bit)
- Modify: `tunnel/server.js:202-247` (_handleAuth method, parse client-provided silent mode flag)

**Interfaces:**
- Consumes: CAP_PADDING constant pattern
- Produces: CAP_SILENT_MODE bit, record.silentMode flag

- [ ] **Step 1: Write the test**

```javascript
// tunnel/test/server.test.js
describe('silent_mode capability', () => {
  it('sets record.silentMode when client sends silent_mode capability', async () => {
    const server = new TunnelServer({ port: 8003, cert, key, credentials });
    const ws = await connectWebSocket(server);
    
    const authFrame = encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'user',
      password: 'pass',
      capabilities: ['padding', 'silent_mode']
    });
    ws.send(authFrame);
    
    await waitForMessage(ws); // AUTH_OK
    
    const record = server._records.get(ws);
    assert.strictEqual(record.silentMode, true);
  });
  
  it('does not set silentMode when capability absent', async () => {
    const server = new TunnelServer({ port: 8003, cert, key, credentials });
    const ws = await connectWebSocket(server);
    
    const authFrame = encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'user',
      password: 'pass',
      capabilities: ['padding']
    });
    ws.send(authFrame);
    
    await waitForMessage(ws);
    
    const record = server._records.get(ws);
    assert.strictEqual(record.silentMode, false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tunnel/test/server.test.js`
Expected: FAIL — record.silentMode is undefined

- [ ] **Step 3: Add CAP_SILENT_MODE constant**

```javascript
// tunnel/protocol.js:26-27
const CAP_PADDING = 'padding';
const CAP_SILENT_MODE = 'silent_mode';

// Update exports at line 258-270
module.exports = {
  FRAME_TYPES,
  ATYP,
  MAX_FRAME_PAYLOAD,
  MAX_DATA_CHUNK,
  CAP_PADDING,
  CAP_SILENT_MODE,
  encodeFrame,
  decodeFrame,
  encodeAddress,
  decodeAddress,
  encodeCapabilities,
  decodeCapabilities
};
```

- [ ] **Step 4: Update _handleAuth to detect silent_mode**

```javascript
// tunnel/server.js:223-227 (inside _handleAuth)
const clientCapabilities = new Set(frame.capabilities || []);
record.silentMode = clientCapabilities.has('silent_mode');

if (this.paddingEnabled && clientCapabilities.has(CAP_PADDING)) {
  record.capabilities.add(CAP_PADDING);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tunnel/test/server.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add tunnel/protocol.js tunnel/server.js tunnel/test/server.test.js
git commit -m "feat(tunnel): add silent_mode capability detection"
```

---

### Task 3: Track Silent Timeout Fallback (Server-Side)

**Files:**
- Modify: `tunnel/server.js:131-142` (record initialization, add lastDataActivityAt)
- Modify: `tunnel/server.js:160-200` (_handleWsMessage, update lastDataActivityAt on DATA/CONNECT/CLOSE)
- Modify: `tunnel/server.js:398-411` (_scheduleHeartbeat, add silent timeout check)

**Interfaces:**
- Consumes: record.silentMode flag
- Produces: record.lastDataActivityAt tracking, server-side fallback close for stale idle WS connections

- [ ] **Step 1: Write the test**

```javascript
// tunnel/test/server.test.js
describe('silent timeout tracking', () => {
  it('updates lastDataActivityAt on DATA frame', async () => {
    const server = new TunnelServer({ port: 8003, cert, key, credentials });
    const ws = await connectAndAuth(server, ['silent_mode']);
    const record = server._records.get(ws);
    
    const initialTime = record.lastDataActivityAt;
    await delay(10);
    
    const dataFrame = encodeFrame({ type: FRAME_TYPES.DATA, reqid: 1, data: Buffer.from('test') });
    ws.send(dataFrame);
    await delay(10);
    
    assert.ok(record.lastDataActivityAt > initialTime);
  });
  
  it('does not update lastDataActivityAt on PING/PONG', async () => {
    const server = new TunnelServer({ port: 8003, cert, key, credentials });
    const ws = await connectAndAuth(server, ['silent_mode']);
    const record = server._records.get(ws);
    
    const initialTime = record.lastDataActivityAt;
    await delay(10);
    
    const pingFrame = encodeFrame({ type: FRAME_TYPES.PING, payload: Buffer.from('test') });
    ws.send(pingFrame);
    await delay(10);
    
    assert.strictEqual(record.lastDataActivityAt, initialTime);
  });
  
  it('closes connection after 50 minutes of inactivity (silent mode)', async () => {
    const server = new TunnelServer({ port: 8003, cert, key, credentials });
    const ws = await connectAndAuth(server, ['silent_mode']);
    const record = server._records.get(ws);
    
    // Simulate 50 minutes of inactivity
    record.lastDataActivityAt = Date.now() - 3_000_000;
    
    // Trigger heartbeat check
    server._sendHeartbeat();
    
    await waitForClose(ws);
    assert.strictEqual(ws.readyState, WebSocket.CLOSED);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tunnel/test/server.test.js`
Expected: FAIL — lastDataActivityAt is undefined

- [ ] **Step 3: Initialize lastDataActivityAt in record**

```javascript
// tunnel/server.js:131-142 (inside _handleWsConnection)
const record = {
  ws,
  authenticated: false,
  state: 'candidate',
  remoteAddress: socket.remoteAddress,
  remotePort: socket.remotePort,
  connectedAt: Date.now(),
  pongTime: Date.now(),
  pendingPingPayload: null,
  capabilities: new Set(),
  drainTimer: null,
  silentMode: false,
  lastDataActivityAt: Date.now(),  // Add this line
};
```

- [ ] **Step 4: Update lastDataActivityAt on DATA/CONNECT/CLOSE frames**

```javascript
// tunnel/server.js:160-200 (inside _handleWsMessage, after auth check)
// Update timestamp for DATA, CONNECT, CLOSE frames (not PING/PONG/PADDING)
if (frame.type === FRAME_TYPES.DATA || 
    frame.type === FRAME_TYPES.CONNECT || 
    frame.type === FRAME_TYPES.CLOSE) {
  record.lastDataActivityAt = Date.now();
}

// Existing PING/PONG/PADDING handling...
if (frame.type === FRAME_TYPES.PING) {
  // ...
}
```

- [ ] **Step 5: Add silent timeout check in heartbeat**

```javascript
// tunnel/server.js:413-430 (inside _sendHeartbeat, after pong timeout check)
_sendHeartbeat() {
  const now = Date.now();
  const timeoutMs = this.heartbeatTimeout * 1000;

  for (const record of this._records.values()) {
    if (!record.authenticated || (record.state !== 'active' && record.state !== 'draining')) continue;
    
    // Existing pong timeout check
    if (now - record.pongTime > timeoutMs) {
      console.log(`[Tunnel] Heartbeat timeout (${this.heartbeatTimeout}s no valid PONG), closing WS`);
      this._closeWs(record.ws, 1001, 'heartbeat timeout');
      continue;
    }
    
    // Fallback silent timeout check (only for silent_mode clients).
    // Client-side idle detection is the primary path into SLEEPING.
    if (record.silentMode && now - record.lastDataActivityAt >= 3_000_000) {
      console.log(`[Tunnel] Silent timeout (50m no data activity), closing WS`);
      this._closeWs(record.ws, 1000, 'silent-timeout');
      continue;
    }

    // Send PING...
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test tunnel/test/server.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add tunnel/server.js tunnel/test/server.test.js
git commit -m "feat(tunnel): track silent timeout (50m no data activity)"
```

---

### Task 4: Implement SSE Handler

**Files:**
- Create: `tunnel/sseControl.js`

**Interfaces:**
- Consumes: credentials (username/password)
- Produces: SseControlHandler class with handleRequest(), sendWakeSignal(), hasActiveConnection()

- [ ] **Step 1: Write the test**

```javascript
// tunnel/test/sseControl.test.js
const assert = require('assert');
const SseControlHandler = require('../sseControl');
const crypto = require('crypto');

describe('SseControlHandler', () => {
  let handler;
  let mockRes;
  const credentials = { username: 'user', password: 'pass' };
  const validToken = crypto.createHash('sha256').update('user:pass').digest('hex');

  beforeEach(() => {
    handler = new SseControlHandler();
    handler.setCredentials(credentials);
    mockRes = {
      writeHead: sinon.stub(),
      write: sinon.stub(),
      end: sinon.stub()
    };
  });

  it('returns false for non-poll paths', () => {
    const req = { method: 'GET', url: '/' };
    const result = handler.handleRequest(req, mockRes);
    assert.strictEqual(result, false);
  });

  it('returns 401 for invalid token', () => {
    const req = { method: 'GET', url: '/api/v1/events?token=invalid' };
    handler.handleRequest(req, mockRes);
    assert.strictEqual(mockRes.writeHead.firstCall.args[0], 401);
  });

  it('opens text/event-stream and sends retry prelude', () => {
    handler = new SseControlHandler({ keepaliveMinMs: 10, keepaliveMaxMs: 10 });
    handler.setCredentials(credentials);
    const req = { method: 'GET', url: `/api/v1/events?token=${validToken}` };
    
    handler.handleRequest(req, mockRes);

    assert.strictEqual(mockRes.writeHead.firstCall.args[0], 200);
    assert.strictEqual(mockRes.writeHead.firstCall.args[1]['content-type'], 'text/event-stream');
    assert.strictEqual(mockRes.write.firstCall.args[0], 'retry: 5000\n\n');
  });

  it('calls onAuthenticated when token is valid', () => {
    const onAuthenticated = sinon.stub();
    handler = new SseControlHandler({ onAuthenticated });
    handler.setCredentials(credentials);

    const req = { method: 'GET', url: `/api/v1/events?token=${validToken}` };
    handler.handleRequest(req, mockRes);

    assert.strictEqual(onAuthenticated.calledOnceWith(validToken), true);
  });

  it('closes existing SSE connection when new one arrives', () => {
    const req1 = { method: 'GET', url: `/api/v1/events?token=${validToken}` };
    const mockRes1 = { writeHead: sinon.stub(), end: sinon.stub() };
    
    handler.handleRequest(req1, mockRes1);
    assert.strictEqual(handler.hasActiveConnection(validToken), true);
    
    const req2 = { method: 'GET', url: `/api/v1/events?token=${validToken}` };
    const mockRes2 = { writeHead: sinon.stub(), end: sinon.stub() };
    
    handler.handleRequest(req2, mockRes2);
    
    assert.strictEqual(mockRes1.end.calledOnce, true);
  });

  it('sendWakeSignal writes wake event without closing SSE', () => {
    const req = { method: 'GET', url: `/api/v1/events?token=${validToken}` };
    handler.handleRequest(req, mockRes);
    
    const result = handler.sendWakeSignal(validToken);
    assert.strictEqual(result, true);
    
    assert.ok(mockRes.write.calledWith('event: wake\ndata: {}\n\n'));
    assert.strictEqual(handler.hasActiveConnection(validToken), true);
  });

  it('sendWakeSignal returns false when no active poll', () => {
    const result = handler.sendWakeSignal(validToken);
    assert.strictEqual(result, false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tunnel/test/sseControl.test.js`
Expected: FAIL — sseControl.js does not exist

- [ ] **Step 3: Implement SseControlHandler**

```javascript
// tunnel/sseControl.js
const crypto = require('crypto');

class SseControlHandler {
  constructor(options = {}) {
    this._connections = new Map(); // token → { res, keepaliveTimer }
    this._credentials = null;
    this._path = options.path || '/api/v1/events';
    this._keepaliveMinMs = options.keepaliveMinMs || 35_000;
    this._keepaliveMaxMs = options.keepaliveMaxMs || 45_000;
    this._onAuthenticated = options.onAuthenticated || (() => {});
    this._onDisconnected = options.onDisconnected || (() => {});
  }

  setCredentials(credentials) {
    this._credentials = credentials;
  }

  handleRequest(req, res) {
    const url = new URL(req.url, 'https://localhost');

    if (url.pathname !== this._path) return false;
    if (req.method !== 'GET') {
      this._send(res, 405, { error: 'method not allowed' });
      return true;
    }

    const token = url.searchParams.get('token');
    if (!this._verifyToken(token)) {
      this._send(res, 401, { error: 'invalid token' });
      return true;
    }

    this._closeExistingConnection(token);
    this._onAuthenticated(token);

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 5000\n\n');

    const connection = { res, keepaliveTimer: null };
    this._connections.set(token, connection);
    this._scheduleKeepalive(token);

    if (typeof req.on === 'function') {
      req.on('close', () => {
        if (this._connections.get(token) === connection) {
          this._closeExistingConnection(token);
          this._onDisconnected(token);
        }
      });
    }
    return true;
  }

  sendWakeSignal(token) {
    const connection = this._connections.get(token);
    if (!connection) return false;

    connection.res.write('event: wake\ndata: {}\n\n');
    return true;
  }

  hasActiveConnection(token) {
    return this._connections.has(token);
  }

  clearConnection(token) {
    this._closeExistingConnection(token);
  }

  _verifyToken(token) {
    if (!token || !this._credentials) return false;
    const expected = crypto
      .createHash('sha256')
      .update(`${this._credentials.username}:${this._credentials.password}`)
      .digest('hex');
    return token === expected;
  }

  _closeExistingConnection(token) {
    const existing = this._connections.get(token);
    if (existing) {
      if (existing.keepaliveTimer) clearTimeout(existing.keepaliveTimer);
      this._connections.delete(token);
      try { existing.res.end(); } catch (_) {}
    }
  }

  _scheduleKeepalive(token) {
    const connection = this._connections.get(token);
    if (!connection) return;
    const delay = this._keepaliveMinMs + Math.floor(Math.random() * (this._keepaliveMaxMs - this._keepaliveMinMs + 1));
    connection.keepaliveTimer = setTimeout(() => {
      const current = this._connections.get(token);
      if (!current) return;
      current.res.write(': keepalive\n\n');
      this._scheduleKeepalive(token);
    }, delay);
    connection.keepaliveTimer.unref();
  }

  _send(res, statusCode, body) {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });
    res.end(payload);
  }
}

module.exports = SseControlHandler;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tunnel/test/sseControl.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tunnel/sseControl.js tunnel/test/sseControl.test.js
git commit -m "feat(tunnel): implement SseControlHandler with jittered idle timeout and wake signal"
```

---

### Task 5: Implement WakeBuffer

**Files:**
- Create: `tunnel/wakeBuffer.js`

**Interfaces:**
- Consumes: SseControlHandler.sendWakeSignal()
- Produces: WakeBuffer class with waitForTunnel(), onTunnelReconnected(), onClientDisconnected()

- [ ] **Step 1: Write the test**

```javascript
// tunnel/test/wakeBuffer.test.js
const assert = require('assert');
const WakeBuffer = require('../wakeBuffer');

describe('WakeBuffer', () => {
  let wakeBuffer;
  let mockSseControlHandler;

  beforeEach(() => {
    mockSseControlHandler = {
      sendWakeSignal: sinon.stub().returns(true)
    };
    wakeBuffer = new WakeBuffer({
      sseControlHandler: mockSseControlHandler,
      wakeTimeout: 10_000
    });
  });

  it('waitForTunnel calls sendWakeSignal', async () => {
    const clientToken = 'abc123';
    
    const promise = wakeBuffer.waitForTunnel(clientToken);
    
    assert.strictEqual(mockSseControlHandler.sendWakeSignal.calledOnce, true);
    assert.strictEqual(mockSseControlHandler.sendWakeSignal.firstCall.args[0], clientToken);
    
    wakeBuffer.onTunnelReconnected(clientToken);
    await promise;
  });

  it('waitForTunnel rejects when client offline', async () => {
    mockSseControlHandler.sendWakeSignal.returns(false);
    const clientToken = 'abc123';
    
    try {
      await wakeBuffer.waitForTunnel(clientToken);
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.message, 'client-offline');
    }
  });

  it('waitForTunnel resolves immediately on onTunnelReconnected', async () => {
    const clientToken = 'abc123';
    
    const promise = wakeBuffer.waitForTunnel(clientToken);
    
    // Simulate tunnel reconnected
    wakeBuffer.onTunnelReconnected(clientToken);
    
    await promise; // Should resolve without error
  });

  it('waitForTunnel rejects after 3 wake attempts', async () => {
    const clientToken = 'abc123';
    
    const promise = wakeBuffer.waitForTunnel(clientToken);
    
    try {
      await promise;
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.message, 'wake-timeout after 3 attempts');
    }
    assert.strictEqual(mockSseControlHandler.sendWakeSignal.callCount, 3);
  }).timeout(38_000); // 3 * 10s plus 2 retry gaps

  it('reuses same promise for concurrent waitForTunnel calls', async () => {
    const clientToken = 'abc123';
    
    const promise1 = wakeBuffer.waitForTunnel(clientToken);
    const promise2 = wakeBuffer.waitForTunnel(clientToken);
    
    assert.strictEqual(promise1, promise2);
    assert.strictEqual(mockSseControlHandler.sendWakeSignal.calledOnce, true);
    
    wakeBuffer.onTunnelReconnected(clientToken);
    await promise1;
    await promise2;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tunnel/test/wakeBuffer.test.js`
Expected: FAIL — wakeBuffer.js does not exist

- [ ] **Step 3: Implement WakeBuffer**

```javascript
// tunnel/wakeBuffer.js
class WakeBuffer {
  constructor(options) {
    this._sseControlHandler = options.sseControlHandler;
    this._wakeTimeout = options.wakeTimeout || 10_000;
    this._maxWakeAttempts = options.maxWakeAttempts || 3;
    this._retryIntervalMs = options.retryIntervalMs || 3_000;
    this._buffers = new Map(); // clientToken → { promise, resolve, reject, timer }
  }

  waitForTunnel(clientToken) {
    let buf = this._buffers.get(clientToken);
    if (buf && buf.promise) {
      return buf.promise;
    }

    buf = { promise: null, resolve: null, timer: null };
    this._buffers.set(clientToken, buf);

    const promise = this._wakeWithRetry(clientToken, buf).finally(() => {
      this._cleanup(clientToken);
    });
    buf.promise = promise;
    return promise;
  }

  onTunnelReconnected(clientToken) {
    const buf = this._buffers.get(clientToken);
    if (!buf) return;

    if (buf.timer) clearTimeout(buf.timer);
    if (buf.resolve) buf.resolve();
  }

  onClientDisconnected(clientToken) {
    const buf = this._buffers.get(clientToken);
    if (buf && buf.reject) {
      buf.reject(new Error('client-offline'));
    }
    this._cleanup(clientToken);
  }

  _cleanup(clientToken) {
    const buf = this._buffers.get(clientToken);
    if (buf) {
      if (buf.timer) clearTimeout(buf.timer);
      this._buffers.delete(clientToken);
    }
  }

  async _wakeWithRetry(clientToken, buf) {
    for (let attempt = 1; attempt <= this._maxWakeAttempts; attempt++) {
      const result = await this._tryWake(clientToken, buf);
      if (result === 'ready') return;
      if (result === 'client-offline') throw new Error('client-offline');

      if (attempt < this._maxWakeAttempts) {
        await delay(this._retryIntervalMs);
      }
    }
    throw new Error('wake-timeout after 3 attempts');
  }

  _tryWake(clientToken, buf) {
    return new Promise((resolve, reject) => {
      buf.resolve = () => resolve('ready');
      buf.reject = reject;
      buf.timer = setTimeout(() => resolve('timeout'), this._wakeTimeout);
      buf.timer.unref();

      const woke = this._sseControlHandler.sendWakeSignal(clientToken);
      if (!woke) {
        clearTimeout(buf.timer);
        resolve('client-offline');
      }
    });
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = WakeBuffer;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tunnel/test/wakeBuffer.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tunnel/wakeBuffer.js tunnel/test/wakeBuffer.test.js
git commit -m "feat(tunnel): implement WakeBuffer with 10s timeout and promise reuse"
```

---

### Task 6: Integrate SSE into TunnelServer

**Files:**
- Modify: `tunnel/server.js:18-44` (constructor, instantiate SseControlHandler)
- Modify: `tunnel/server.js:122-124` (_handleHttpRequest, route to SseControlHandler first)
- Modify: `tunnel/server.js:202-247` (_handleAuth, detect silent_mode)

**Interfaces:**
- Consumes: SseControlHandler class
- Produces: Integrated SSE routing in HTTPS server

- [ ] **Step 1: Write the test**

```javascript
// tunnel/test/server.test.js
describe('SSE integration', () => {
  it('routes /api/v1/events to SseControlHandler', async () => {
    const server = new TunnelServer({ port: 8003, cert, key, credentials, sseKeepaliveMinMs: 10, sseKeepaliveMaxMs: 10 });
    await server.start();
    
    const token = crypto.createHash('sha256').update('user:pass').digest('hex');
    const response = await fetch(`https://localhost:8003/api/v1/events?token=${token}`, {
      method: 'GET'
    });
    
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get('content-type').includes('text/event-stream'));
    const reader = response.body.getReader();
    const firstChunk = await reader.read();
    const text = Buffer.from(firstChunk.value).toString('utf8');
    assert.ok(text.includes('retry: 5000'));
    reader.cancel();
    
    await server.stop();
  });

  it('routes / to disguise handler', async () => {
    const server = new TunnelServer({ port: 8003, cert, key, credentials });
    await server.start();
    
    const response = await fetch('https://localhost:8003/', { method: 'GET' });
    assert.strictEqual(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes('Northstar Digital'));
    
    await server.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tunnel/test/server.test.js`
Expected: FAIL — /api/v1/events returns 404 (disguise handler)

- [ ] **Step 3: Import and instantiate SseControlHandler**

```javascript
// tunnel/server.js:1-6 (top of file)
const https = require('https');
const crypto = require('crypto');
const wsModule = require('ws');
const { FRAME_TYPES, MAX_FRAME_PAYLOAD, CAP_PADDING, encodeFrame, decodeFrame } = require('./protocol');
const { handleDisguiseRequest } = require('./disguiseResponse');
const SseControlHandler = require('./sseControl');

// tunnel/server.js:18-44 (inside constructor, after credentials are assigned)
this._sseControlHandler = new SseControlHandler({
  path: options.ssePath || options.tunnel_sse_path || '/api/v1/events',
  keepaliveMinMs: options.sseKeepaliveMinMs || options.tunnel_sse_keepalive_min_ms || 35_000,
  keepaliveMaxMs: options.sseKeepaliveMaxMs || options.tunnel_sse_keepalive_max_ms || 45_000,
  onAuthenticated: (token) => {
    if (this._tunnelManager && typeof this._tunnelManager.markClientSleeping === 'function') {
      this._tunnelManager.markClientSleeping(token);
    }
  },
  onDisconnected: (token) => {
    if (this._tunnelManager && typeof this._tunnelManager.markClientSseDisconnected === 'function') {
      this._tunnelManager.markClientSseDisconnected(token);
    }
  },
});
this._sseControlHandler.setCredentials(this.credentials);
```

- [ ] **Step 4: Keep SseControl credentials initialized before any AUTH**

```javascript
// tunnel/server.js:202-247 (_handleAuth remains responsible for WS auth only)
const { ws } = record;
const { username, password } = frame;

if (username !== this.credentials.username || password !== this.credentials.password) {
  // ...existing auth logic...
}
```

- [ ] **Step 5: Route HTTP requests to SseControlHandler first**

```javascript
// tunnel/server.js:122-124 (_handleHttpRequest)
_handleHttpRequest(req, res) {
  if (this._sseControlHandler.handleRequest(req, res)) return;
  handleDisguiseRequest(req, res);
}
```

- [ ] **Step 6: Expose getSseControlHandler method**

```javascript
// tunnel/server.js (after getConnectionCounts method, around line 391)
getSseControlHandler() {
  return this._sseControlHandler;
}
```

- [ ] **Step 7: Add SSE disconnect marker**

```javascript
markClientSseDisconnected(token) {
  // SSE 断线只表示控制面暂时不可用。
  // 保留 _silentModeClients 历史，等待客户端 3-8s jitter 后重新建立 SSE。
  this._sleepingClients.delete(token);
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node --test tunnel/test/server.test.js`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add tunnel/server.js tunnel/test/server.test.js
git commit -m "feat(tunnel): integrate SseControlHandler into TunnelServer HTTP routing"
```

---

### Task 7: Integrate WakeBuffer into TunnelManager

**Files:**
- Modify: `tunnel/manager.js:9-20` (constructor, instantiate WakeBuffer)
- Modify: `tunnel/manager.js:34-83` (forward() method, check silent mode when disconnected)
- Modify: `tunnel/manager.js:369-394` (setConnected(), notify WakeBuffer on connect/disconnect)

**Interfaces:**
- Consumes: WakeBuffer class, TunnelServer.getSseControlHandler()
- Produces: Integrated wake-up logic in forward() method

- [ ] **Step 1: Write the test**

```javascript
// tunnel/test/manager.test.js
describe('WakeBuffer integration', () => {
  it('waits for tunnel when client is in silent mode and disconnected', async () => {
    const mockServer = {
      getSseControlHandler: () => mockSseControlHandler,
      onFrame: () => {}
    };
    const manager = new TunnelManager(mockServer, config);
    
    const clientToken = 'abc123';
    manager._silentModeClients.add(clientToken);
    manager._sleepingClients.add(clientToken);
    
    const stream = manager.forward('example.com', 443, callback);
    
    // Stream should be returned synchronously and remain pending while wake runs
    assert.ok(stream.isTunnelStream);
    
    // Simulate tunnel reconnected
    manager._wakeBuffer.onTunnelReconnected(clientToken);
    
    // Stream should now proceed (callback called)
    await delay(100);
    assert.ok(callback.called);
  });

  it('returns error stream when client offline (no SSE)', async () => {
    mockSseControlHandler.sendWakeSignal.returns(false);
    const mockServer = {
      getSseControlHandler: () => mockSseControlHandler,
      onFrame: () => {}
    };
    const manager = new TunnelManager(mockServer, config);
    
    const clientToken = 'abc123';
    manager._silentModeClients.add(clientToken);
    manager._sleepingClients.add(clientToken);
    
    const stream = manager.forward('example.com', 443, callback);
    
    stream.on('error', (err) => {
      assert.strictEqual(err.message, 'client-offline');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tunnel/test/manager.test.js`
Expected: FAIL — WakeBuffer not integrated

- [ ] **Step 3: Import WakeBuffer and instantiate in constructor**

```javascript
// tunnel/manager.js:1-4 (top of file)
const { Duplex } = require('stream');
const net = require('net');
const { FRAME_TYPES, ATYP, MAX_DATA_CHUNK } = require('./protocol');
const WakeBuffer = require('./wakeBuffer');

// tunnel/manager.js:9-20 (inside constructor, after line 19)
this._sseControlHandler = tunnelServer.getSseControlHandler();
this._wakeBuffer = new WakeBuffer({
  sseControlHandler: this._sseControlHandler,
  wakeTimeout: 10_000
});
this._clientTokens = new Map(); // socket → clientToken
this._silentModeClients = new Set(); // clientToken set
this._sleepingClients = new Set(); // token set for clients currently in SSE sleep
```

- [ ] **Step 4: Add helper methods to compute and check client token**

```javascript
// tunnel/manager.js (after getStatus() method, around line 348)
_computeToken() {
  const crypto = require('crypto');
  return crypto
    .createHash('sha256')
    .update(`${this._server.credentials.username}:${this._server.credentials.password}`)
    .digest('hex');
}

_getSleepingClientToken() {
  // Single-client deployment: one credential token identifies the sleeping client.
  const token = this._computeToken();
  return this._sleepingClients.has(token) ? token : null;
}

_isSilentModeClient(clientToken) {
  return this._silentModeClients.has(clientToken);
}

_isSleepingClient(clientToken) {
  return this._sleepingClients.has(clientToken);
}

markClientSleeping(clientToken) {
  if (this._isSilentModeClient(clientToken) || this._silentModeClients.size === 0) {
    this._silentModeClients.add(clientToken);
    this._sleepingClients.add(clientToken);
  }
}
```

- [ ] **Step 5: Modify forward() to check silent mode when disconnected**

```javascript
// tunnel/manager.js:34-83 (forward() method, replace lines 35-42)
forward(host, port, callback) {
  const createErrorStream = (code) => {
    const { Duplex } = require('stream');
    const stream = new Duplex({ read() {}, write(c, e, cb) { cb(); } });
    process.nextTick(() => stream.destroy(new Error(code)));
    return stream;
  };

  if (!this._connected) {
    // Check if this is a silent mode client
    const clientToken = this._getSleepingClientToken();
    if (clientToken && this._isSleepingClient(clientToken)) {
      return this._createPendingWakeStream(clientToken, host, port, callback);
    }
    return createErrorStream('tunnel-disconnected');
  }

  // ...existing forward logic (line 44 onwards)...
}

_createPendingWakeStream(clientToken, host, port, callback) {
  // Pending stream has no reqid yet. Reqid is allocated only after WS wake succeeds.
  const stream = new TunnelDuplex(this, null);
  stream.isPendingWakeStream = true;
  this._waitAndForward(clientToken, host, port, callback, stream).catch((err) => {
    stream.destroy(err);
  });
  return stream;
}

async _waitAndForward(clientToken, host, port, callback, pendingStream) {
  try {
    await this._wakeBuffer.waitForTunnel(clientToken);
    // Tunnel reconnected, now forward normally
    if (!this._connected) {
      pendingStream.destroy(new Error('tunnel-disconnected'));
      return;
    }
    this._bindForwardStreamAfterWake(pendingStream, host, port, callback);
  } catch (err) {
    pendingStream.destroy(err.message === 'client-offline'
      ? new Error('client-offline')
      : new Error('tunnel-wake-timeout'));
  }
}

_bindForwardStreamAfterWake(pendingStream, host, port, callback) {
  // Equivalent to the existing connected branch of forward(), starting at reqid allocation:
  // 1. Allocate a fresh server-side reqid
  // 2. Send CONNECT frame for host/port over the reconnected WS
  // 3. Bridge pendingStream reads/writes/errors/closes to the active tunnel stream for that reqid
  // 4. Register the activeRequests cleanup path used by normal forward()
}
```

Concurrency rule: `TunnelManager` does not add a separate `_wakeInProgress` flag. Multiple pending forward calls for the same sleeping `clientToken` all call `WakeBuffer.waitForTunnel(clientToken)`, which returns the same in-flight promise and therefore does not send duplicate `wake` events while WS is rebuilding.

- [ ] **Step 6: Update setConnected() to track client tokens and notify WakeBuffer**

```javascript
// tunnel/manager.js:369-394 (setConnected() method)
setConnected(socket, connected, clientAddress) {
  if (connected) {
    this._connected = true;
    this._clientAddress = clientAddress || this._clientAddress;
    
    // Track client token
    const record = this._server._records.get(socket);
    if (record) {
      const token = this._computeToken();
      this._clientTokens.set(socket, token);
      
      if (record.silentMode) {
        this._silentModeClients.add(token);
      }
      this._sleepingClients.delete(token);
      
      // Notify WakeBuffer that tunnel is reconnected
      this._wakeBuffer.onTunnelReconnected(token);
    }
  } else {
    // Clean up client token
    const token = this._clientTokens.get(socket);
    if (token) {
      this._wakeBuffer.onClientDisconnected(token);
      this._clientTokens.delete(socket);
    }
    
    // ...existing cleanup logic (line 375 onwards)...
    for (const [reqid, entry] of this._activeRequests) {
      if (entry.socket === socket) {
        if (entry.timeout) clearTimeout(entry.timeout);
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        if (entry._anyproxySocket && !entry._anyproxySocket.destroyed) {
          entry._anyproxySocket.destroy();
        }
        if (entry.direction === 'reverse') {
          entry.stream.destroy(new Error('tunnel-disconnected'));
        }
        this._activeRequests.delete(reqid);
      }
    }
    const activeSocket = this._selectSocket();
    this._connected = Boolean(activeSocket);
    if (!this._connected) {
      this._clientAddress = null;
    }
  }
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `node --test tunnel/test/manager.test.js`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add tunnel/manager.js tunnel/test/manager.test.js
git commit -m "feat(tunnel): integrate WakeBuffer into TunnelManager forward() with silent mode support"
```

---

## Phase 2: Client-Side Core Modules

### Task 8: Add `silent_mode` Capability to Client

**Files:**
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/FrameCodec.kt:9` (add CAP_SILENT_MODE)
- Modify: `android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelClient.kt:240-293` (establishConnection, add silent_mode to capabilities)

**Interfaces:**
- Consumes: CAP_PADDING constant pattern
- Produces: CAP_SILENT_MODE constant, silent_mode in AUTH frame capabilities

- [ ] **Step 1: Write the test**

```kotlin
// android-client/app/src/test/java/com/blockproxy/android/tunnel/FrameCodecTest.kt
@Test
fun `encode AUTH frame with silent_mode capability`() {
  val frame = Frame.Auth(
    username = "user",
    password = "pass",
    capabilities = listOf(FrameCodec.CAP_PADDING, FrameCodec.CAP_SILENT_MODE)
  )
  val encoded = FrameCodec.encode(frame)
  val decoded = FrameCodec.decode(encoded)
  
  assert(decoded is Frame.Auth)
  assert((decoded as Frame.Auth).capabilities.contains(FrameCodec.CAP_SILENT_MODE))
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd android-client && ./gradlew testPhoneDebugUnitTest --tests '*FrameCodecTest*'`
Expected: FAIL — CAP_SILENT_MODE not defined

- [ ] **Step 3: Add CAP_SILENT_MODE constant**

```kotlin
// android-client/app/src/main/java/com/blockproxy/android/tunnel/FrameCodec.kt:9-10
const val CAP_PADDING = "padding"
const val CAP_SILENT_MODE = "silent_mode"
```

- [ ] **Step 4: Update TunnelClient to include silent_mode in capabilities**

```kotlin
// android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelClient.kt:253 (inside establishConnection)
val authCapabilities = buildList {
  if (config.paddingEnabled) add(FrameCodec.CAP_PADDING)
  if (config.silentMode) add(FrameCodec.CAP_SILENT_MODE)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd android-client && ./gradlew testPhoneDebugUnitTest --tests '*FrameCodecTest*'`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/tunnel/FrameCodec.kt \
        android-client/app/src/main/java/com/blockproxy/android/tunnel/TunnelClient.kt \
        android-client/app/src/test/java/com/blockproxy/android/tunnel/FrameCodecTest.kt
git commit -m "feat(android): add silent_mode capability to AUTH frame"
```

---

### Task 9: Implement SseControlClient

**Files:**
- Create: `android-client/app/src/main/java/com/blockproxy/android/tunnel/SseControlClient.kt`
- Create: `android-client/app/src/test/java/com/blockproxy/android/tunnel/SseControlClientTest.kt`

**Interfaces:**
- Consumes: ServerConfig (sseHost, ssePort, ssePath), TunnelCredentials, OkHttpClient
- Produces: SseControlClient class with connectAndRead() method returning SseControlResult enum

- [ ] **Step 1: Write the test**

```kotlin
// android-client/app/src/test/java/com/blockproxy/android/tunnel/SseControlClientTest.kt
package com.blockproxy.android.tunnel

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.security.MessageDigest

class SseControlClientTest {
  private lateinit var mockServer: MockWebServer
  private lateinit var client: SseControlClient
  private val credentials = TunnelCredentials("user", "pass")
  private val validToken = MessageDigest.getInstance("SHA-256")
    .digest("user:pass".toByteArray())
    .joinToString("") { "%02x".format(it) }

  @Before
  fun setup() {
    mockServer = MockWebServer()
    mockServer.start()
    
    val config = ServerConfig(
      serverHost = mockServer.hostName,
      serverPort = mockServer.port,
      sseHost = mockServer.hostName,
      ssePort = mockServer.port,
      ssePath = "/api/v1/events"
    )
    
    val okHttpClient = OkHttpClient.Builder().build()
    client = SseControlClient(config, credentials, okHttpClient)
  }

  @After
  fun tearDown() {
    mockServer.shutdown()
  }

  @Test
  fun `connectAndRead returns Wake when SSE wake event arrives`() = runBlocking {
    mockServer.enqueue(MockResponse()
      .setResponseCode(200)
      .setHeader("Content-Type", "text/event-stream")
      .setBody("retry: 5000\n\nevent: wake\ndata: {}\n\n"))
    
    val result = client.connectAndRead()
    
    assertEquals(SseControlResult.Wake, result)
  }

  @Test
  fun `connectAndRead returns Disconnected when SSE stream ends without wake`() = runBlocking {
    mockServer.enqueue(MockResponse()
      .setResponseCode(200)
      .setHeader("Content-Type", "text/event-stream")
      .setBody(": keepalive\n\n"))
    
    val result = client.connectAndRead()
    
    assertEquals(SseControlResult.Disconnected, result)
  }

  @Test
  fun `connectAndRead returns Failed when 200 response is not event stream`() = runBlocking {
    mockServer.enqueue(MockResponse()
      .setResponseCode(200)
      .setHeader("Content-Type", "text/html")
      .setBody("<html></html>"))
    
    val result = client.connectAndRead()
    
    assertEquals(SseControlResult.Failed, result)
  }

  @Test
  fun `connectAndRead returns AuthFailed on 401`() = runBlocking {
    mockServer.enqueue(MockResponse().setResponseCode(401))
    
    val result = client.connectAndRead()
    
    assertEquals(SseControlResult.AuthFailed, result)
  }

  @Test
  fun `connectAndRead returns NotSupported on 404`() = runBlocking {
    mockServer.enqueue(MockResponse().setResponseCode(404))
    
    val result = client.connectAndRead()
    
    assertEquals(SseControlResult.NotSupported, result)
  }

  @Test
  fun `connectAndRead returns Failed on network error`() = runBlocking {
    mockServer.shutdown() // Force network error
    
    val result = client.connectAndRead()
    
    assertEquals(SseControlResult.Failed, result)
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd android-client && ./gradlew testPhoneDebugUnitTest --tests '*SseControlClientTest*'`
Expected: FAIL — SseControlClient class does not exist

- [ ] **Step 3: Implement SseControlClient**

```kotlin
// android-client/app/src/main/java/com/blockproxy/android/tunnel/SseControlClient.kt
package com.blockproxy.android.tunnel

import com.blockproxy.android.config.ServerConfig
import com.blockproxy.android.config.TunnelCredentials
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Call
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStream
import java.io.InputStreamReader
import java.security.MessageDigest

enum class SseControlResult {
  Wake, Disconnected, AuthFailed, NotSupported, Failed
}

class SseControlClient(
  private val config: ServerConfig,
  private val credentials: TunnelCredentials,
  private val okHttpClient: OkHttpClient
) {
  private val token: String = sha256("${credentials.username}:${credentials.password}")
  private var currentCall: Call? = null

  fun connectAndRead(): SseControlResult {
    val url = buildUrl()
    
    val request = Request.Builder()
      .url(url)
      .header("Accept", "text/event-stream")
      .header("Cache-Control", "no-cache")
      .get()
      .build()

    return try {
      val call = okHttpClient.newCall(request)
      currentCall = call
      call.execute().use { response ->
        when (response.code) {
          200 -> {
            val contentType = response.header("Content-Type").orEmpty()
            if (!contentType.startsWith("text/event-stream")) {
              SseControlResult.Failed
            } else {
              readSseEvents(response.body?.byteStream())
            }
          }
          401 -> SseControlResult.AuthFailed
          404 -> SseControlResult.NotSupported
          else -> SseControlResult.Failed
        }
      }
    } catch (e: IOException) {
      SseControlResult.Failed
    } catch (e: Exception) {
      SseControlResult.Failed
    } finally {
      currentCall = null
    }
  }

  private fun readSseEvents(stream: InputStream?): SseControlResult {
    if (stream == null) return SseControlResult.Failed

    return try {
      val reader = BufferedReader(InputStreamReader(stream))
      var eventType: String? = null
      while (true) {
        val line = reader.readLine() ?: return SseControlResult.Disconnected
        when {
          line.isEmpty() -> {
            if (eventType == "wake") return SseControlResult.Wake
            eventType = null
          }
          line.startsWith("event:") -> eventType = line.substringAfter("event:").trim()
          line.startsWith(":") -> Unit
          line.startsWith("data:") -> Unit
        }
      }
    } catch (e: IOException) {
      SseControlResult.Disconnected
    } catch (e: Exception) {
      SseControlResult.Failed
    }
  }

  fun stop() {
    currentCall?.cancel()
    currentCall = null
  }

  private fun buildUrl(): String {
    val host = config.sseHost.ifBlank { config.serverHost }
    val port = config.ssePort
    val path = config.ssePath
    val scheme = if (config.useTls) "https" else "http"
    return "$scheme://$host:$port$path?token=$token"
  }

  private fun sha256(input: String): String {
    return MessageDigest.getInstance("SHA-256")
      .digest(input.toByteArray())
      .joinToString("") { "%02x".format(it) }
  }
}
```

Result handling contract:

| Scenario | Result | Client action |
| --- | --- | --- |
| HTTP request fails before SSE stream is established, or 200 response is not `text/event-stream` | `Failed` | Retry SSE after 3-8s jitter |
| SSE stream is established and later ends or throws `IOException` while reading | `Disconnected` | Retry SSE after 3-8s jitter |
| HTTP 401 | `AuthFailed` | Stop SSE reconnect and report auth error |
| HTTP 404 | `NotSupported` | Fall back to continuous WS |

- [ ] **Step 4: Run test to verify it passes**

Run: `cd android-client && ./gradlew testPhoneDebugUnitTest --tests '*SseControlClientTest*'`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add android-client/app/src/main/java/com/blockproxy/android/tunnel/SseControlClient.kt \
        android-client/app/src/test/java/com/blockproxy/android/tunnel/SseControlClientTest.kt
git commit -m "feat(android): implement SseControlClient with wake/disconnect/auth/not-supported handling"
```

---

## Phase 3: Configuration and UI

*(Tasks 10-15 will cover ServerConfig, ConfigRepository, TunnelViewModel, ConfigScreen UI, TunnelStatus enum, and BlockProxyVpnService integration)*

Due to length constraints, I'll provide the remaining tasks in a condensed format. Each follows the same TDD pattern as above.

### Task 10: Add Silent Mode Fields to ServerConfig

- Add `silentMode: Boolean = false`, `sseHost: String = ""`, `ssePort: Int = 8003`, `ssePath: String = "/api/v1/events"` to `ServerConfig` data class
- Write test for default values
- Commit: `feat(android): add silent mode config fields to ServerConfig`

### Task 11: Update ConfigRepository and DataStore

- Add preference keys: `KEY_SILENT_MODE`, `KEY_SSE_HOST`, `KEY_SSE_PORT`, `KEY_SSE_PATH`
- Update `DataStoreConfigDataSource` to read/write these fields
- Write test for persistence, including existing `ServerConfig` fields so saving silent mode does not regress padding/transport configuration
- Commit: `feat(android): persist silent mode config in DataStore`

### Task 12: Update TunnelViewModel

- Add `silentMode` and `sseHost` StateFlow fields to `ConfigUiState`
- Add `updateSilentMode()` and `updateSseHost()` methods
- Write test for state updates
- Commit: `feat(android): add silent mode state to TunnelViewModel`

### Task 13: Add Silent Mode UI to ConfigScreen

- Add "静默模式" section with Switch and SSE host input field
- Input field enabled only when Switch is on
- Write UI test (optional, can skip for now)
- Commit: `feat(android): add silent mode UI controls to ConfigScreen`

### Task 14: Add Sleeping Status to TunnelStatus

- Add `Sleeping("静默中")` enum value
- Update all switch/when expressions that handle TunnelStatus
- Write test for new status
- Commit: `feat(android): add Sleeping status for silent mode`

### Task 15: Implement SilentModeController

- Create `SilentModeController.kt` with State enum (ACTIVE, SLEEPING, RECONNECTING, DISABLED)
- Implement `start()`, `stop()`, `monitorIdleTimeout()`, `enterSleeping()`, `startSseControlLoop()`
- Use 50 minute idle timeout (`3_000_000ms`); SSE is only entered after `silentMode=true && idleMs >= 3_000_000`; SSE disconnect/failure reconnects after 3-8s random delay
- Handle SSE terminal statuses explicitly: `AuthFailed` stops SSE reconnect and reports authentication error; `NotSupported` disables silent listening for this server and falls back to continuous WS
- If WS fails after an SSE wake, return to SLEEPING and reconnect SSE; all other WS failures keep the original WS reconnect logic
- Do not persist sleeping state across process restarts; on app/service startup always begin with ACTIVE WS, then enter SLEEPING only after a fresh 50 minute idle window
- Add `TunnelClient.awaitConnected(timeoutMs: Long): Boolean` using the tunnel status flow so `SilentModeController` can distinguish wake success from auth/occupied/failure terminal states

```kotlin
suspend fun awaitConnected(timeoutMs: Long): Boolean {
  return withTimeoutOrNull(timeoutMs) {
    status.first {
      it == TunnelStatus.Connected ||
        it == TunnelStatus.AuthFailed ||
        it == TunnelStatus.Occupied
    }
  }?.let { it == TunnelStatus.Connected } ?: false
}
```

- Write test for state transitions
- Commit: `feat(android): implement SilentModeController state machine`

### Task 16: Integrate SilentModeController into BlockProxyVpnService

- Modify `setupTunnel()` to create `SilentModeController` and call `silentController.start()` instead of `client.start()`
- Pass `sseControlClient` to controller
- Build SSE `OkHttpClient` separately from the tunnel client: no VPN protect callback and no TLS certificate validation
- Write test for integration
- Commit: `feat(android): integrate SilentModeController into VPN service`

---

## Phase 4: Integration Testing

### Task 17: End-to-End Silent Mode Test

- Write integration test: ACTIVE → 50m idle → SLEEPING → SSE → wake signal → ACTIVE
- Test with both silent mode enabled and disabled
- Test backward compatibility (old client + new server)
- Commit: `test: add end-to-end silent mode integration tests`

---

## Summary

This plan implements silent mode for the bidirectional tunnel with:
- **Server-side**: SSE endpoint, WakeBuffer for request buffering, silent timeout fallback, passive state sync through WS AUTH flag and SSE registration
- **Client-side**: SseControlClient, SilentModeController state machine, UI controls
- **Global changes**: Heartbeat 210-270s, silent timeout 50m, SSE 35-45s keepalive with 3-8s jittered reconnects

Total: 17 tasks across 4 phases. Each task is independently testable and committable.
