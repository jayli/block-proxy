# Reverse Tunnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reverse tunnel capability to block-proxy, allowing external users to access internal-only domains through Server proxy via Client tunnel.

**Architecture:** Server-side TunnelServer (TLS listener on port 8004) accepts one Client connection. TunnelManager matches tunnel_domains and forwards requests through the tunnel. Client-side TunnelClient maintains persistent connection, executes requests directly (bypassing local proxy to prevent loops). TunnelServer lifecycle is owned by LocalProxy in `proxy/proxy.js`.

**Tech Stack:** Node.js (Server: tunnel/), Python 3 (Client: tunnel_client.py), TLS, custom frame protocol. Tests use Node.js built-in `node:test` runner (no external dependencies).

## Global Constraints

- Single concurrent tunnel request at a time; second request while one active returns error stream (never null/fallback)
- Pure TCP tunnel (no MITM decryption)
- Single Client connection limit per Server
- Domain whitelist only (`tunnel_domains`); tunnel domains NEVER fallback to normal connection — busy, disconnected, or failed all return error stream
- Client executes requests with forced direct connection (no local proxy, no routing engine)
- Reuse `auth_username`/`auth_password` for tunnel authentication
- Exponential backoff reconnection: 1s → 2s → 4s → ... → 60s max
- Heartbeat: Server PING every 30s, Client PONG immediately, 60s timeout both sides
- Error semantics: HTTPS CONNECT tunnel failures result in connection reset (not 502), because AnyProxy writes `200 OK` before calling `customConnect`

## Important: @bachi/anyproxy is a symlink

`node_modules/@bachi/anyproxy` is a symlink to `/Users/bachi/jaylli/anyproxy` (a separately versioned repo). Task 4 changes MUST be committed in the `@bachi/anyproxy` repo itself, then update the dependency version in block-proxy's `package.json` (or lock file). Do NOT treat it as a one-off local `node_modules` edit.

---

## Phase 1: Server-Side Protocol & Infrastructure

### Task 1: Protocol Implementation (tunnel/protocol.js)

**Files:**
- Create: `tunnel/protocol.js`
- Create: `tunnel/test/protocol.test.js`

**Interfaces:**
- Produces: `FRAME_TYPES`, `ATYP`, `encodeFrame()`, `decodeFrame()`, `encodeAddress()`, `decodeAddress()`

- [ ] **Step 1: Write failing test for frame encoding**

```javascript
// tunnel/test/protocol.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { FRAME_TYPES, ATYP, encodeFrame, decodeFrame } = require('../protocol');

describe('Protocol encodeFrame/decodeFrame', () => {
  it('should roundtrip CONNECT frame with domain address', () => {
    const frame = {
      type: FRAME_TYPES.CONNECT,
      reqid: 1,
      atyp: ATYP.DOMAIN,
      addr: 'example.com',
      port: 443
    };
    const buf = encodeFrame(frame);
    const decoded = decodeFrame(buf);
    assert.equal(decoded.type, FRAME_TYPES.CONNECT);
    assert.equal(decoded.reqid, 1);
    assert.equal(decoded.atyp, ATYP.DOMAIN);
    assert.equal(decoded.addr, 'example.com');
    assert.equal(decoded.port, 443);
  });

  it('should roundtrip CONNECT frame with IPv4 address', () => {
    const frame = {
      type: FRAME_TYPES.CONNECT,
      reqid: 2,
      atyp: ATYP.IPV4,
      addr: '10.0.1.100',
      port: 80
    };
    const buf = encodeFrame(frame);
    const decoded = decodeFrame(buf);
    assert.equal(decoded.type, FRAME_TYPES.CONNECT);
    assert.equal(decoded.atyp, ATYP.IPV4);
    assert.equal(decoded.addr, '10.0.1.100');
    assert.equal(decoded.port, 80);
  });

  it('should roundtrip DATA frame', () => {
    const frame = {
      type: FRAME_TYPES.DATA,
      reqid: 1,
      data: Buffer.from('hello world')
    };
    const buf = encodeFrame(frame);
    const decoded = decodeFrame(buf);
    assert.equal(decoded.type, FRAME_TYPES.DATA);
    assert.equal(decoded.reqid, 1);
    assert.deepEqual(decoded.data, Buffer.from('hello world'));
  });

  it('should roundtrip DATA frame with empty data', () => {
    const frame = { type: FRAME_TYPES.DATA, reqid: 5, data: Buffer.alloc(0) };
    const buf = encodeFrame(frame);
    const decoded = decodeFrame(buf);
    assert.equal(decoded.data.length, 0);
  });

  it('should roundtrip CLOSE frame', () => {
    const frame = { type: FRAME_TYPES.CLOSE, reqid: 42 };
    const buf = encodeFrame(frame);
    const decoded = decodeFrame(buf);
    assert.equal(decoded.type, FRAME_TYPES.CLOSE);
    assert.equal(decoded.reqid, 42);
  });

  it('should roundtrip CONNECT_OK frame', () => {
    const frame = { type: FRAME_TYPES.CONNECT_OK, reqid: 7 };
    const buf = encodeFrame(frame);
    const decoded = decodeFrame(buf);
    assert.equal(decoded.type, FRAME_TYPES.CONNECT_OK);
    assert.equal(decoded.reqid, 7);
  });

  it('should roundtrip CONNECT_FAILED frame', () => {
    const frame = { type: FRAME_TYPES.CONNECT_FAILED, reqid: 3 };
    const buf = encodeFrame(frame);
    const decoded = decodeFrame(buf);
    assert.equal(decoded.type, FRAME_TYPES.CONNECT_FAILED);
    assert.equal(decoded.reqid, 3);
  });

  it('should roundtrip AUTH frame', () => {
    const frame = { type: FRAME_TYPES.AUTH, username: 'admin', password: 's3cret' };
    const buf = encodeFrame(frame);
    const decoded = decodeFrame(buf);
    assert.equal(decoded.type, FRAME_TYPES.AUTH);
    assert.equal(decoded.username, 'admin');
    assert.equal(decoded.password, 's3cret');
  });

  it('should roundtrip simple frames (PING, PONG, AUTH_OK, AUTH_FAIL)', () => {
    for (const type of [FRAME_TYPES.PING, FRAME_TYPES.PONG, FRAME_TYPES.AUTH_OK, FRAME_TYPES.AUTH_FAIL]) {
      const buf = encodeFrame({ type });
      const decoded = decodeFrame(buf);
      assert.equal(decoded.type, type);
    }
  });

  it('should roundtrip ERROR frame with message', () => {
    const frame = { type: FRAME_TYPES.ERROR, message: 'Tunnel port occupied' };
    const buf = encodeFrame(frame);
    const decoded = decodeFrame(buf);
    assert.equal(decoded.type, FRAME_TYPES.ERROR);
    assert.equal(decoded.message, 'Tunnel port occupied');
  });

  it('should throw on unknown frame type', () => {
    assert.throws(() => encodeFrame({ type: 0xFF }), /Unknown frame type/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/bachi/jaylli/block-proxy && node --test tunnel/test/protocol.test.js`
Expected: FAIL with "Cannot find module '../protocol'"

- [ ] **Step 3: Implement protocol.js**

```javascript
// tunnel/protocol.js

const FRAME_TYPES = {
  CONNECT:        0x01,
  DATA:           0x02,
  CLOSE:          0x03,
  CONNECT_OK:     0x04,
  PING:           0x10,
  PONG:           0x11,
  AUTH:           0x20,
  AUTH_OK:        0x21,
  AUTH_FAIL:      0x22,
  ERROR:          0x23,
  CONNECT_FAILED: 0x81,
};

const ATYP = {
  IPV4:   0x01,
  DOMAIN: 0x03,
  IPV6:   0x04,
};

function encodeAddress(atyp, addr) {
  if (atyp === ATYP.IPV4) {
    const parts = addr.split('.').map(Number);
    return Buffer.from([atyp, ...parts]);
  }
  if (atyp === ATYP.DOMAIN) {
    const addrBuf = Buffer.from(addr, 'utf8');
    return Buffer.concat([Buffer.from([atyp, addrBuf.length]), addrBuf]);
  }
  if (atyp === ATYP.IPV6) {
    // addr is a 16-byte buffer or hex string
    const addrBuf = Buffer.isBuffer(addr) ? addr : Buffer.from(addr.replace(/:/g, ''), 'hex');
    return Buffer.concat([Buffer.from([atyp]), addrBuf]);
  }
  throw new Error(`Unknown ATYP: 0x${atyp.toString(16)}`);
}

function decodeAddress(buffer, offset) {
  const atyp = buffer[offset++];
  if (atyp === ATYP.IPV4) {
    const addr = `${buffer[offset]}.${buffer[offset+1]}.${buffer[offset+2]}.${buffer[offset+3]}`;
    return { atyp, addr, bytesRead: 5 }; // 1 atyp + 4 bytes
  }
  if (atyp === ATYP.DOMAIN) {
    const len = buffer[offset];
    const addr = buffer.slice(offset + 1, offset + 1 + len).toString('utf8');
    return { atyp, addr, bytesRead: 2 + len }; // 1 atyp + 1 len + N bytes
  }
  if (atyp === ATYP.IPV6) {
    const addr = buffer.slice(offset, offset + 16).toString('hex');
    return { atyp, addr, bytesRead: 17 }; // 1 atyp + 16 bytes
  }
  throw new Error(`Unknown ATYP: 0x${atyp.toString(16)}`);
}

function encodeFrame(frame) {
  let payload;

  switch (frame.type) {
    case FRAME_TYPES.CONNECT: {
      const addrBuf = encodeAddress(frame.atyp, frame.addr);
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(frame.port, 0);
      payload = Buffer.concat([
        Buffer.from([frame.type, frame.reqid >> 8, frame.reqid & 0xFF]),
        addrBuf,
        portBuf
      ]);
      break;
    }

    case FRAME_TYPES.DATA: {
      payload = Buffer.concat([
        Buffer.from([frame.type, frame.reqid >> 8, frame.reqid & 0xFF]),
        frame.data
      ]);
      break;
    }

    case FRAME_TYPES.CLOSE:
    case FRAME_TYPES.CONNECT_OK:
    case FRAME_TYPES.CONNECT_FAILED: {
      payload = Buffer.from([
        frame.type, frame.reqid >> 8, frame.reqid & 0xFF
      ]);
      break;
    }

    case FRAME_TYPES.PING:
    case FRAME_TYPES.PONG:
    case FRAME_TYPES.AUTH_OK:
    case FRAME_TYPES.AUTH_FAIL: {
      payload = Buffer.from([frame.type]);
      break;
    }

    case FRAME_TYPES.AUTH: {
      const uBuf = Buffer.from(frame.username, 'utf8');
      const pBuf = Buffer.from(frame.password, 'utf8');
      payload = Buffer.concat([
        Buffer.from([frame.type, uBuf.length]),
        uBuf,
        Buffer.from([pBuf.length]),
        pBuf
      ]);
      break;
    }

    case FRAME_TYPES.ERROR: {
      const mBuf = Buffer.from(frame.message || '', 'utf8');
      payload = Buffer.concat([
        Buffer.from([frame.type, mBuf.length]),
        mBuf
      ]);
      break;
    }

    default:
      throw new Error(`Unknown frame type: 0x${frame.type.toString(16)}`);
  }

  const header = Buffer.alloc(2);
  header.writeUInt16BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) throw new Error('Buffer too short');

  const length = buffer.readUInt16BE(0);
  if (buffer.length < 2 + length) throw new Error('Incomplete frame');

  const payload = buffer.slice(2, 2 + length);
  const type = payload[0];
  let offset = 1;

  switch (type) {
    case FRAME_TYPES.CONNECT: {
      const reqid = (payload[offset] << 8) | payload[offset + 1];
      offset += 2;
      const addrResult = decodeAddress(payload, offset);
      offset += addrResult.bytesRead;
      const port = payload.readUInt16BE(offset);
      return { type, reqid, atyp: addrResult.atyp, addr: addrResult.addr, port, bytesRead: 2 + length };
    }

    case FRAME_TYPES.DATA: {
      const reqid = (payload[offset] << 8) | payload[offset + 1];
      offset += 2;
      return { type, reqid, data: payload.slice(offset), bytesRead: 2 + length };
    }

    case FRAME_TYPES.CLOSE:
    case FRAME_TYPES.CONNECT_OK:
    case FRAME_TYPES.CONNECT_FAILED: {
      const reqid = (payload[offset] << 8) | payload[offset + 1];
      return { type, reqid, bytesRead: 2 + length };
    }

    case FRAME_TYPES.PING:
    case FRAME_TYPES.PONG:
    case FRAME_TYPES.AUTH_OK:
    case FRAME_TYPES.AUTH_FAIL: {
      return { type, bytesRead: 2 + length };
    }

    case FRAME_TYPES.AUTH: {
      const uLen = payload[offset++];
      const username = payload.slice(offset, offset + uLen).toString('utf8');
      offset += uLen;
      const pLen = payload[offset++];
      const password = payload.slice(offset, offset + pLen).toString('utf8');
      return { type, username, password, bytesRead: 2 + length };
    }

    case FRAME_TYPES.ERROR: {
      const mLen = payload[offset++];
      const message = payload.slice(offset, offset + mLen).toString('utf8');
      return { type, message, bytesRead: 2 + length };
    }

    default:
      throw new Error(`Unknown frame type: 0x${type.toString(16)}`);
  }
}

module.exports = { FRAME_TYPES, ATYP, encodeFrame, decodeFrame, encodeAddress, decodeAddress };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/bachi/jaylli/block-proxy && node --test tunnel/test/protocol.test.js`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add tunnel/
git commit -m "feat(tunnel): implement frame protocol with CONNECT_OK support"
```

---

### Task 2: TunnelServer (tunnel/server.js)

**Files:**
- Create: `tunnel/server.js`
- Create: `tunnel/test/server.test.js`

**Interfaces:**
- Consumes: `FRAME_TYPES`, `encodeFrame()`, `decodeFrame()` from `tunnel/protocol.js`
- Produces: `TunnelServer` class with `start()`, `stop()`, `sendFrame()`, `onFrame()`, `onConnect`, `onDisconnect`

- [ ] **Step 1: Write failing test for TLS connection and authentication**

```javascript
// tunnel/test/server.test.js
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const TunnelServer = require('../server');
const { FRAME_TYPES, encodeFrame, decodeFrame } = require('../protocol');

const PORT = 18004;
const cert = fs.readFileSync(path.join(__dirname, '../../cert/rootCA.crt'));
const key = fs.readFileSync(path.join(__dirname, '../../cert/rootCA.key'));

function connectClient(port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(port, 'localhost', { rejectUnauthorized: false }, () => {
      resolve(socket);
    });
    socket.on('error', reject);
  });
}

function readFrame(socket) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 2) {
        const len = buf.readUInt16BE(0);
        if (buf.length >= 2 + len) {
          socket.removeListener('data', onData);
          try {
            resolve(decodeFrame(buf));
          } catch (e) {
            reject(e);
          }
        }
      }
    };
    socket.on('data', onData);
    setTimeout(() => reject(new Error('readFrame timeout')), 5000);
  });
}

describe('TunnelServer', () => {
  let server;

  afterEach(async () => {
    if (server) { await server.stop(); server = null; }
  });

  it('should authenticate client and send AUTH_OK', async () => {
    server = new TunnelServer({
      port: PORT,
      cert, key,
      credentials: { username: 'admin', password: 'secret' }
    });
    await server.start();

    const socket = await connectClient(PORT);
    socket.write(encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret'
    }));

    const response = await readFrame(socket);
    assert.equal(response.type, FRAME_TYPES.AUTH_OK);
    socket.destroy();
  });

  it('should reject second client with ERROR frame', async () => {
    server = new TunnelServer({
      port: PORT,
      cert, key,
      credentials: { username: 'admin', password: 'secret' }
    });
    await server.start();

    // First client connects and authenticates
    const socket1 = await connectClient(PORT);
    socket1.write(encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret'
    }));
    const authResp = await readFrame(socket1);
    assert.equal(authResp.type, FRAME_TYPES.AUTH_OK);

    // Second client connects — should be rejected
    const socket2 = await connectClient(PORT);
    socket2.write(encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret'
    }));
    const errorResp = await readFrame(socket2);
    assert.equal(errorResp.type, FRAME_TYPES.ERROR);
    assert.match(errorResp.message, /occupied/i);

    socket1.destroy();
    socket2.destroy();
  });

  it('should call onConnect after successful auth', async () => {
    let connectedAddr = null;
    server = new TunnelServer({
      port: PORT,
      cert, key,
      credentials: { username: 'admin', password: 'secret' },
      onConnect: (addr) => { connectedAddr = addr; }
    });
    await server.start();

    const socket = await connectClient(PORT);
    socket.write(encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret'
    }));
    await readFrame(socket);

    // Give onConnect a tick to fire
    await new Promise(r => setTimeout(r, 50));
    assert.ok(connectedAddr, 'onConnect should have been called');

    socket.destroy();
  });

  it('should call onDisconnect when client closes', async () => {
    let disconnected = false;
    server = new TunnelServer({
      port: PORT,
      cert, key,
      credentials: { username: 'admin', password: 'secret' },
      onDisconnect: () => { disconnected = true; }
    });
    await server.start();

    const socket = await connectClient(PORT);
    socket.write(encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret'
    }));
    await readFrame(socket);

    socket.destroy();
    await new Promise(r => setTimeout(r, 100));
    assert.ok(disconnected, 'onDisconnect should have been called');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/bachi/jaylli/block-proxy && node --test tunnel/test/server.test.js`
Expected: FAIL with "Cannot find module '../server'"

- [ ] **Step 3: Implement TunnelServer**

```javascript
// tunnel/server.js
const tls = require('tls');
const { FRAME_TYPES, encodeFrame, decodeFrame } = require('./protocol');

class TunnelServer {
  constructor(options) {
    this.port = options.port;
    this.cert = options.cert;
    this.key = options.key;
    this.credentials = options.credentials;
    this.onConnect = options.onConnect || (() => {});
    this.onDisconnect = options.onDisconnect || (() => {});

    this._frameHandlers = [];
    this._clientSocket = null;
    this._server = null;

    // Per-socket receive buffer: Map<socket, Buffer>
    this._socketBuffers = new Map();

    // Heartbeat state
    this._pingTimer = null;
    this._lastPongTime = 0;
  }

  start() {
    return new Promise((resolve) => {
      const tlsOptions = {
        key: this.key,
        cert: this.cert,
        minVersion: 'TLSv1.2'
      };

      this._server = tls.createServer(tlsOptions, (socket) => {
        this._handleConnection(socket);
      });

      this._server.listen(this.port, () => {
        console.log(`[Tunnel] Server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    this._stopHeartbeat();
    if (this._clientSocket) {
      this._clientSocket.destroy();
      this._clientSocket = null;
    }
    // Destroy all pending sockets
    for (const [socket] of this._socketBuffers) {
      socket.destroy();
    }
    this._socketBuffers.clear();
    if (!this._server) return Promise.resolve();

    const server = this._server;
    this._server = null;
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  _handleConnection(socket) {
    // Single client limit
    if (this._clientSocket) {
      const errorFrame = encodeFrame({
        type: FRAME_TYPES.ERROR,
        message: 'Tunnel port occupied'
      });
      // Use socket.end() to ensure the error frame is sent before closing
      socket.end(errorFrame);
      return;
    }

    // Per-socket buffer
    this._socketBuffers.set(socket, Buffer.alloc(0));

    socket.on('data', (chunk) => {
      const buf = this._socketBuffers.get(socket);
      if (!buf) return;
      this._socketBuffers.set(socket, Buffer.concat([buf, chunk]));
      this._processBuffer(socket);
    });

    socket.on('close', () => {
      this._socketBuffers.delete(socket);
      if (this._clientSocket === socket) {
        this._clientSocket = null;
        this._stopHeartbeat();
        console.log('[Tunnel] Client disconnected');
        this.onDisconnect();
      }
    });

    socket.on('error', (err) => {
      console.error('[Tunnel] Socket error:', err.message);
    });
  }

  _processBuffer(socket) {
    let buf = this._socketBuffers.get(socket);
    if (!buf) return;

    while (buf.length >= 2) {
      const length = buf.readUInt16BE(0);
      if (buf.length < 2 + length) break;

      const frameData = buf.slice(0, 2 + length);
      buf = buf.slice(2 + length);
      this._socketBuffers.set(socket, buf);

      try {
        const frame = decodeFrame(frameData);

        if (frame.type === FRAME_TYPES.AUTH && !this._clientSocket) {
          this._handleAuth(socket, frame);
        } else if (this._clientSocket === socket) {
          // Only update heartbeat on PONG frames (spec: "60s without PONG → disconnect")
          if (frame.type === FRAME_TYPES.PONG) {
            this._lastPongTime = Date.now();
          }
          // Forward to handlers
          this._frameHandlers.forEach(handler => handler(frame));
        }
      } catch (err) {
        console.error('[Tunnel] Frame decode error:', err.message);
      }
    }
  }

  _handleAuth(socket, frame) {
    const { username, password } = frame;

    if (username === this.credentials.username &&
        password === this.credentials.password) {
      this._clientSocket = socket;
      socket.write(encodeFrame({ type: FRAME_TYPES.AUTH_OK }));
      console.log('[Tunnel] Client authenticated:', socket.remoteAddress);
      this._startHeartbeat();
      this.onConnect(socket.remoteAddress, socket.remotePort);
    } else {
      socket.write(encodeFrame({ type: FRAME_TYPES.AUTH_FAIL }));
      socket.destroy();
    }
  }

  sendFrame(frame) {
    if (!this._clientSocket) {
      throw new Error('No client connected');
    }
    this._clientSocket.write(encodeFrame(frame));
  }

  onFrame(handler) {
    this._frameHandlers.push(handler);
  }

  // --- Heartbeat ---

  _startHeartbeat() {
    this._stopHeartbeat();
    this._lastPongTime = Date.now();

    // Send PING every 30s
    this._pingTimer = setInterval(() => {
      if (!this._clientSocket) { this._stopHeartbeat(); return; }

      // Check if we received PONG within 60s
      if (Date.now() - this._lastPongTime > 60000) {
        console.log('[Tunnel] Heartbeat timeout (60s no PONG), disconnecting');
        this._clientSocket.destroy();
        return;
      }

      try {
        this.sendFrame({ type: FRAME_TYPES.PING });
      } catch (e) {
        // ignore
      }
    }, 30000);
  }

  _stopHeartbeat() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }
}

module.exports = TunnelServer;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/bachi/jaylli/block-proxy && node --test tunnel/test/server.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add tunnel/
git commit -m "feat(tunnel): implement TunnelServer with per-socket buffer, heartbeat, and callbacks"
```

---

### Task 3: TunnelManager (tunnel/manager.js)

**Files:**
- Create: `tunnel/manager.js`
- Create: `tunnel/test/manager.test.js`

**Interfaces:**
- Consumes: `TunnelServer`, `FRAME_TYPES`, `ATYP`, `encodeFrame()`
- Produces: `TunnelManager` class with `matchesTunnelDomain()`, `isAvailable()`, `forward()`, `reloadConfig()`, `getStatus()`

- [ ] **Step 1: Write failing test for domain matching and availability**

```javascript
// tunnel/test/manager.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const TunnelManager = require('../manager');
const { FRAME_TYPES } = require('../protocol');

function createMockServer() {
  const handlers = [];
  return {
    onFrame: (h) => handlers.push(h),
    sendFrame: () => {},
    // For testing: simulate incoming frame
    _emit: (frame) => handlers.forEach(h => h(frame)),
    _handlers: handlers
  };
}

describe('TunnelManager.matchesTunnelDomain', () => {
  it('should match exact domain', () => {
    const manager = new TunnelManager(createMockServer(), { tunnel_domains: ['example.com'] });
    assert.equal(manager.matchesTunnelDomain('example.com'), true);
    assert.equal(manager.matchesTunnelDomain('other.com'), false);
  });

  it('should match subdomain', () => {
    const manager = new TunnelManager(createMockServer(), { tunnel_domains: ['example.com'] });
    assert.equal(manager.matchesTunnelDomain('sub.example.com'), true);
    assert.equal(manager.matchesTunnelDomain('deep.sub.example.com'), true);
  });

  it('should NOT match partial domain suffix', () => {
    const manager = new TunnelManager(createMockServer(), { tunnel_domains: ['example.com'] });
    assert.equal(manager.matchesTunnelDomain('notexample.com'), false);
    assert.equal(manager.matchesTunnelDomain('example.com.evil.com'), false);
  });

  it('should match regardless of connection state', () => {
    const manager = new TunnelManager(createMockServer(), { tunnel_domains: ['a.com'] });
    // Even when not connected, domain matching is pure string comparison
    assert.equal(manager.matchesTunnelDomain('a.com'), true);
    assert.equal(manager.isAvailable(), false);
  });
});

describe('TunnelManager.isAvailable', () => {
  it('should be false when no client connected', () => {
    const manager = new TunnelManager(createMockServer(), { tunnel_domains: [] });
    assert.equal(manager.isAvailable(), false);
  });

  it('should be true after setConnected(true)', () => {
    const manager = new TunnelManager(createMockServer(), { tunnel_domains: [] });
    manager.setConnected(true, '127.0.0.1:12345');
    assert.equal(manager.isAvailable(), true);
  });
});

describe('TunnelManager.forward', () => {
  it('should return error stream when busy (single concurrent)', async () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: ['a.com'] });
    manager.setConnected(true);

    // First forward should return a stream
    const stream1 = manager.forward('a.com', 443, () => {});
    assert.ok(stream1, 'First forward should return stream');

    // Second forward while first is active should return error stream (never null!)
    const stream2 = manager.forward('b.com', 443, () => {});
    assert.ok(stream2, 'Second forward should return error stream');
    const [busyErr] = await once(stream2, 'error');
    assert.equal(busyErr.message, 'tunnel-busy');

    // Clean up
    stream1.destroy();
  });

  it('should return error stream when disconnected', async () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: ['a.com'] });
    // Not connected

    const stream = manager.forward('a.com', 443, () => {});
    assert.ok(stream, 'Disconnected forward should return error stream');
    const [disconnectedErr] = await once(stream, 'error');
    assert.equal(disconnectedErr.message, 'tunnel-disconnected');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/bachi/jaylli/block-proxy && node --test tunnel/test/manager.test.js`
Expected: FAIL with "Cannot find module '../manager'"

- [ ] **Step 3: Implement TunnelManager**

```javascript
// tunnel/manager.js
const { Duplex } = require('stream');
const { FRAME_TYPES, ATYP } = require('./protocol');

class TunnelManager {
  constructor(tunnelServer, config) {
    this._server = tunnelServer;
    this._tunnelDomains = config.tunnel_domains || [];
    this._reqidCounter = 0;
    this._activeRequest = null; // Single concurrent: only one active { reqid, stream }
    this._connected = false;
    this._clientAddress = null;

    this._server.onFrame((frame) => this._handleFrame(frame));
  }

  matchesTunnelDomain(host) {
    return this._tunnelDomains.some(domain => {
      if (host === domain) return true;
      if (host.endsWith('.' + domain)) return true;
      return false;
    });
  }

  isAvailable() {
    return this._connected;
  }

  forward(host, port, callback) {
    const createErrorStream = (code) => {
      const { Duplex } = require('stream');
      const stream = new Duplex({ read() {}, write(c, e, cb) { cb(); } });
      process.nextTick(() => stream.destroy(new Error(code)));
      return stream;
    };

    if (!this._connected) return createErrorStream('tunnel-disconnected');

    // Single concurrent: reject if already busy
    if (this._activeRequest) return createErrorStream('tunnel-busy');

    const reqid = this._allocateReqid();
    const stream = new TunnelDuplex(this, reqid);

    this._activeRequest = { reqid, stream, confirmed: false };

    // Send CONNECT frame
    this._server.sendFrame({
      type: FRAME_TYPES.CONNECT,
      reqid,
      atyp: ATYP.DOMAIN,
      addr: host,
      port
    });

    // Wait for CONNECT_OK or CONNECT_FAILED, timeout 30s
    const timeout = setTimeout(() => {
      if (this._activeRequest && this._activeRequest.reqid === reqid && !this._activeRequest.confirmed) {
        console.log(`[Tunnel] CONNECT timeout for ${host}:${port} (reqid=${reqid})`);
        this._activeRequest = null;
        stream.destroy(new Error('tunnel-connect-timeout'));
      }
    }, 30000);

    stream.once('tunnel-connect-ok', () => {
      clearTimeout(timeout);
      callback();
    });

    stream.once('error', () => {
      clearTimeout(timeout);
    });

    return stream;
  }

  _allocateReqid() {
    this._reqidCounter++;
    if (this._reqidCounter > 0xFFFF) this._reqidCounter = 1;
    return this._reqidCounter;
  }

  _handleFrame(frame) {
    if (!this._activeRequest) return;
    if (frame.reqid !== undefined && frame.reqid !== this._activeRequest.reqid) return;

    switch (frame.type) {
      case FRAME_TYPES.CONNECT_OK: {
        this._activeRequest.confirmed = true;
        this._activeRequest.stream.emit('tunnel-connect-ok');
        break;
      }

      case FRAME_TYPES.DATA: {
        this._activeRequest.stream.push(frame.data);
        break;
      }

      case FRAME_TYPES.CLOSE: {
        this._activeRequest.stream.push(null); // EOF
        this._activeRequest = null;
        break;
      }

      case FRAME_TYPES.CONNECT_FAILED: {
        this._activeRequest.stream.destroy(new Error('tunnel-connect-failed'));
        this._activeRequest = null;
        break;
      }
    }
  }

  _sendData(reqid, data) {
    if (!this._activeRequest || this._activeRequest.reqid !== reqid) return;
    this._server.sendFrame({ type: FRAME_TYPES.DATA, reqid, data });
  }

  _sendClose(reqid) {
    if (!this._activeRequest || this._activeRequest.reqid !== reqid) return;
    this._server.sendFrame({ type: FRAME_TYPES.CLOSE, reqid });
    this._activeRequest = null;
  }

  reloadConfig(config) {
    this._tunnelDomains = config.tunnel_domains || [];
  }

  getStatus() {
    return {
      connected: this._connected,
      clientAddress: this._clientAddress,
      activeRequest: this._activeRequest ? this._activeRequest.reqid : null
    };
  }

  setConnected(connected, clientAddress) {
    this._connected = connected;
    this._clientAddress = clientAddress || null;

    if (!connected && this._activeRequest) {
      this._activeRequest.stream.destroy(new Error('tunnel-disconnected'));
      this._activeRequest = null;
    }
  }
}

class TunnelDuplex extends Duplex {
  constructor(manager, reqid) {
    super();
    this._manager = manager;
    this._reqid = reqid;
  }

  _read() {
    // Data is pushed via manager._handleFrame
  }

  _write(chunk, encoding, callback) {
    this._manager._sendData(this._reqid, chunk);
    callback();
  }

  _final(callback) {
    this._manager._sendClose(this._reqid);
    callback();
  }
}

module.exports = TunnelManager;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/bachi/jaylli/block-proxy && node --test tunnel/test/manager.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add tunnel/
git commit -m "feat(tunnel): implement TunnelManager with single-concurrent forward and CONNECT_OK"
```

---

### Task 4: Modify @bachi/anyproxy to support customConnect

**Files:**
- Modify: `node_modules/@bachi/anyproxy/lib/requestHandler.js` (around line 877) — **this is a symlink to `/Users/bachi/jaylli/anyproxy`**

**⚠️ Commit location:** Changes MUST be committed in the `@bachi/anyproxy` repo (`/Users/bachi/jaylli/anyproxy`), NOT in block-proxy. After committing there, update block-proxy's `package.json` dependency version or lock file.

**Interfaces:**
- Produces: `reqHandlerCtx.customConnect(host, port, callback)` hook

- [ ] **Step 1: Read the current net.connect code**

Read `node_modules/@bachi/anyproxy/lib/requestHandler.js` around line 870-900 to find the exact `net.connect` call in the CONNECT tunnel path.

- [ ] **Step 2: Add customConnect hook**

Replace the `net.connect` block (approximately):

```javascript
// BEFORE (original):
return new Promise((resolve, reject) => {
  const conn = net.connect(serverInfo.port, serverInfo.host, () => {
    if (global._throttle && !shouldIntercept) {
      requestStream.pipe(conn);
      conn.pipe(global._throttle.throttle()).pipe(cltSocket);
    } else {
      requestStream.pipe(conn);
      conn.pipe(cltSocket);
    }
    resolve();
  });

  conn.on('error', (e) => { reject(e); });
  // ... socketMap registration
});

// AFTER (with customConnect hook):
return new Promise((resolve, reject) => {
  const setupPipe = (conn) => {
    if (global._throttle && !shouldIntercept) {
      requestStream.pipe(conn);
      conn.pipe(global._throttle.throttle()).pipe(cltSocket);
    } else {
      requestStream.pipe(conn);
      conn.pipe(cltSocket);
    }
    resolve();
  };

  let conn;
  if (reqHandlerCtx.customConnect) {
    conn = reqHandlerCtx.customConnect(serverInfo.host, serverInfo.port, () => {
      setupPipe(conn);
    });
  }

  if (!conn) {
    conn = net.connect(serverInfo.port, serverInfo.host, () => {
      setupPipe(conn);
    });
  }

  conn.on('error', (e) => { reject(e); });
  // ... socketMap registration (unchanged)
});
```

**Key points:**
- `customConnect(host, port, callback)` returns a Duplex stream or null
- If null, falls back to `net.connect`
- The callback is called when the stream is ready for piping (same semantics as `net.connect` callback)
- `conn.on('error')` is registered on the returned stream, so error stream from TunnelManager will trigger reject

- [ ] **Step 3: Commit in @bachi/anyproxy repo**

```bash
cd /Users/bachi/jaylli/anyproxy
git add lib/requestHandler.js
git commit -m "feat: add customConnect hook for reverse tunnel support"
```

Then update block-proxy to use the new version:

```bash
cd /Users/bachi/jaylli/block-proxy
# Update package.json @bachi/anyproxy version or run pnpm i to refresh lock file
git add package.json pnpm-lock.yaml
git commit -m "chore: update @bachi/anyproxy for customConnect hook"
```

---

### Task 5: Integrate TunnelManager into LocalProxy (proxy/proxy.js)

**Files:**
- Modify: `proxy/proxy.js`

**Interfaces:**
- Consumes: `TunnelServer`, `TunnelManager`
- Produces: `customConnect` option in AnyProxy

- [ ] **Step 1: Add imports and module-level variables**

```javascript
// At top of proxy/proxy.js
const TunnelServer = require('../tunnel/server');
const TunnelManager = require('../tunnel/manager');
```

Add near other module-level variables:

```javascript
let tunnelServer = null;
let tunnelManager = null;
```

- [ ] **Step 2: Add initTunnel and closeTunnel functions**

```javascript
async function initTunnel(config) {
  await closeTunnel();
  const enableTunnel = config.enable_tunnel || "0";
  const tunnelPort = config.tunnel_port || 8004;
  if (enableTunnel !== "1") return;

  tunnelServer = new TunnelServer({
    port: tunnelPort,
    cert: TLS_CERT,
    key: TLS_KEY,
    credentials: {
      username: config.auth_username,
      password: config.auth_password
    },
    onConnect: (addr, port) => {
      tunnelManager.setConnected(true, `${addr}:${port}`);
      console.log(`[Tunnel] Client connected: ${addr}:${port}`);
    },
    onDisconnect: () => {
      tunnelManager.setConnected(false);
      console.log('[Tunnel] Client disconnected');
    }
  });

  tunnelManager = new TunnelManager(tunnelServer, config);
  await tunnelServer.start();
  console.log(`[Tunnel] Server started on port ${tunnelPort}`);
}

async function closeTunnel() {
  if (tunnelServer) {
    await tunnelServer.stop();
    tunnelServer = null;
    tunnelManager = null;
  }
}
```

- [ ] **Step 3: Add customConnect to AnyProxy options**

In `getAnyProxyOptions()`, add to the options object:

```javascript
customConnect: (host, port, callback) => {
  if (tunnelManager && tunnelManager.matchesTunnelDomain(host)) {
    // forward() always returns a stream: either a real Duplex or an error stream
    // (tunnel-disconnected, tunnel-busy, tunnel-connect-failed, tunnel-connect-timeout)
    // Error streams trigger conn.on('error') → reject() → connection reset to client
    return tunnelManager.forward(host, port, callback);
  }
  return null; // Non-tunnel domain → normal net.connect
}
```

**⚠️ Critical:** `customConnect` must NEVER return null for a tunnel domain. Returning null causes AnyProxy to fallback to `net.connect()`, leaking the internal domain to the public internet. `TunnelManager.forward()` guarantees non-null return (error stream on all failure paths).

- [ ] **Step 4: Integrate tunnel lifecycle into LocalProxy**

LocalProxy is an object literal with `init()`, `start(callback)`, `restart(callback)`. There is no `close()` method. Config is loaded inside `LocalProxy.start()`, so tunnel startup belongs in `start()`, not in `init()`.

```javascript
// In LocalProxy.start(), immediately after:
// const config = await loadConfig();
// await rebuildRuleRegistry(config);
await initTunnel(config);

// In LocalProxy.restart(), BEFORE calling start():
// Add closeTunnel() call at the beginning of restart()
restart: async function(callback) {
  await closeTunnel();  // ← Add this
  // ... existing restart logic
}

// Also call closeTunnel() in the process exit handler if one exists
```

**⚠️ Note:** `proxy/fs.js` has no `_fillDefaults` or `DEFAULT_CONFIG`. It only provides `readConfig()`/`writeConfig()`. Default values for tunnel fields should be handled where config is consumed (e.g., `initTunnel()` should use `config.enable_tunnel || "0"`).

- [ ] **Step 6: Commit**

```bash
git add proxy/
git commit -m "feat(proxy): integrate TunnelManager into LocalProxy lifecycle"
```

---

### Task 6: Update config schema (server/express.js and config consumers)

**Files:**
- Modify: `server/express.js` (add import validation)
- Modify: `config.json` (add tunnel fields)
- Consume defaults in `proxy/proxy.js` / `tunnel/manager.js`

**Interfaces:**
- Produces: `enable_tunnel`, `tunnel_port`, `tunnel_domains` config fields

- [ ] **Step 1: Handle tunnel config defaults where consumed**

`proxy/fs.js` has no default-filling mechanism — it only provides `readConfig()`/`writeConfig()`. Tunnel defaults are handled at consumption points:

```javascript
// In tunnel/server.js or tunnel/manager.js constructor:
this._tunnelDomains = config.tunnel_domains || [];
// In initTunnel():
const tunnelPort = config.tunnel_port || 8004;
const enableTunnel = config.enable_tunnel || "0";
```

Ensure `config.json` includes the fields (add manually or via API):

```json
{
  "enable_tunnel": "0",
  "tunnel_port": 8004,
  "tunnel_domains": []
}
```

- [ ] **Step 2: Add config import validation in server/express.js**

In the `POST /api/config/import` endpoint, add to the validation schema:

```javascript
enable_tunnel:  { type: 'string',  validate: v => v === "0" || v === "1" },
tunnel_port:    { type: 'number',  validate: v => Number.isInteger(v) && v >= 1 && v <= 65535 },
tunnel_domains: { type: 'array',   validate: v => v.every(item => typeof item === 'string') }
```

- [ ] **Step 3: Commit**

```bash
git add proxy/ server/
git commit -m "feat(config): add tunnel fields with defaults and import validation"
```

---

## Phase 2: Client-Side Implementation

### Task 7: Client Config Support

**Files:**
- Modify: `client/config.py`

**Interfaces:**
- Produces: `tunnel` section in `DEFAULT_CONFIG`

- [ ] **Step 1: Add tunnel section to DEFAULT_CONFIG**

```python
# In client/config.py, add to DEFAULT_CONFIG:
"tunnel": {
    "enabled": False,
    "server_address": "",
    "server_port": 8004
}
```

- [ ] **Step 2: Commit**

```bash
git add client/
git commit -m "feat(client): add tunnel config section"
```

---

### Task 8: TunnelClient (client/tunnel_client.py)

**Files:**
- Create: `client/tunnel_client.py`
- Create: `client/tests/test_tunnel_client.py`

**Interfaces:**
- Consumes: config dict (`server` + `tunnel` sections)
- Produces: `TunnelClient` class with `start()`, `stop()`, status callbacks

- [ ] **Step 1: Write failing test for frame protocol**

```python
# client/tests/test_tunnel_client.py
import struct
import pytest
from tunnel_client import (
    FRAME_CONNECT, FRAME_DATA, FRAME_CLOSE, FRAME_CONNECT_OK,
    FRAME_CONNECT_FAILED, FRAME_AUTH, FRAME_AUTH_OK, FRAME_ERROR,
    ATYP_DOMAIN, ATYP_IPV4,
    encode_frame, decode_frame_from_buffer
)

class TestEncodeFrame:
    def test_auth_frame(self):
        buf = encode_frame(FRAME_AUTH, username='admin', password='secret')
        # 2-byte length prefix + payload
        length = struct.unpack('!H', buf[:2])[0]
        assert buf[2] == FRAME_AUTH

    def test_connect_ok_frame(self):
        buf = encode_frame(FRAME_CONNECT_OK, reqid=7)
        length = struct.unpack('!H', buf[:2])[0]
        assert length == 3  # type(1) + reqid(2)
        assert buf[2] == FRAME_CONNECT_OK
        reqid = struct.unpack('!H', buf[3:5])[0]
        assert reqid == 7

    def test_connect_failed_frame(self):
        buf = encode_frame(FRAME_CONNECT_FAILED, reqid=3)
        assert buf[2] == FRAME_CONNECT_FAILED

    def test_connect_frame_with_domain(self):
        buf = encode_frame(FRAME_CONNECT, reqid=1, atyp=ATYP_DOMAIN,
                          addr='example.com', port=443)
        assert buf[2] == FRAME_CONNECT

class TestDecodeFrame:
    def test_decode_connect_ok(self):
        buf = encode_frame(FRAME_CONNECT_OK, reqid=42)
        frame = decode_frame_from_buffer(buf)
        assert frame['type'] == FRAME_CONNECT_OK
        assert frame['reqid'] == 42

    def test_decode_connect(self):
        buf = encode_frame(FRAME_CONNECT, reqid=1, atyp=ATYP_DOMAIN,
                          addr='internal.corp.net', port=443)
        frame = decode_frame_from_buffer(buf)
        assert frame['type'] == FRAME_CONNECT
        assert frame['reqid'] == 1
        assert frame['addr'] == 'internal.corp.net'
        assert frame['port'] == 443

    def test_decode_data(self):
        data = b'hello world'
        buf = encode_frame(FRAME_DATA, reqid=5, data=data)
        frame = decode_frame_from_buffer(buf)
        assert frame['type'] == FRAME_DATA
        assert frame['reqid'] == 5
        assert frame['data'] == data

    def test_decode_error(self):
        buf = encode_frame(FRAME_ERROR, message='Port occupied')
        frame = decode_frame_from_buffer(buf)
        assert frame['type'] == FRAME_ERROR
        assert frame['message'] == 'Port occupied'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/bachi/jaylli/block-proxy/client && python -m pytest tests/test_tunnel_client.py -v`
Expected: FAIL with "ModuleNotFoundError"

- [ ] **Step 3: Implement frame protocol and TunnelClient**

```python
# client/tunnel_client.py
import struct
import asyncio
import ssl
import threading
import logging

logger = logging.getLogger('tunnel_client')

# Frame types
FRAME_CONNECT        = 0x01
FRAME_DATA           = 0x02
FRAME_CLOSE          = 0x03
FRAME_CONNECT_OK     = 0x04
FRAME_PING           = 0x10
FRAME_PONG           = 0x11
FRAME_AUTH           = 0x20
FRAME_AUTH_OK        = 0x21
FRAME_AUTH_FAIL      = 0x22
FRAME_ERROR          = 0x23
FRAME_CONNECT_FAILED = 0x81

# Address types
ATYP_IPV4   = 0x01
ATYP_DOMAIN = 0x03
ATYP_IPV6   = 0x04

CONNECT_TIMEOUT = 30  # seconds for target connection
IDLE_TIMEOUT = 60     # seconds without data → disconnect


class TunnelOccupiedError(Exception):
    """Server tunnel port is occupied by another client."""
    pass


def encode_frame(frame_type, **kwargs):
    """Encode a frame with 2-byte length prefix."""
    payload = bytearray([frame_type])

    if frame_type == FRAME_AUTH:
        u = kwargs['username'].encode('utf-8')
        p = kwargs['password'].encode('utf-8')
        payload.extend(struct.pack('B', len(u)))
        payload.extend(u)
        payload.extend(struct.pack('B', len(p)))
        payload.extend(p)

    elif frame_type in (FRAME_CONNECT_OK, FRAME_CONNECT_FAILED, FRAME_CLOSE):
        payload.extend(struct.pack('!H', kwargs['reqid']))

    elif frame_type == FRAME_CONNECT:
        payload.extend(struct.pack('!H', kwargs['reqid']))
        atyp = kwargs['atyp']
        payload.append(atyp)
        if atyp == ATYP_DOMAIN:
            addr_bytes = kwargs['addr'].encode('utf-8')
            payload.append(len(addr_bytes))
            payload.extend(addr_bytes)
        elif atyp == ATYP_IPV4:
            parts = kwargs['addr'].split('.')
            payload.extend(bytes(int(p) for p in parts))
        payload.extend(struct.pack('!H', kwargs['port']))

    elif frame_type == FRAME_DATA:
        payload.extend(struct.pack('!H', kwargs['reqid']))
        payload.extend(kwargs['data'])

    # PING, PONG, AUTH_OK, AUTH_FAIL: just the type byte

    elif frame_type == FRAME_ERROR:
        msg = kwargs.get('message', '').encode('utf-8')
        payload.append(len(msg))
        payload.extend(msg)

    header = struct.pack('!H', len(payload))
    return header + bytes(payload)


def decode_frame_from_buffer(buf):
    """Decode a single frame from a complete buffer (with length prefix)."""
    if len(buf) < 2:
        raise ValueError('Buffer too short')
    length = struct.unpack('!H', buf[:2])[0]
    if len(buf) < 2 + length:
        raise ValueError('Incomplete frame')
    return _decode_payload(buf[2:2+length])


async def read_frame(reader):
    """Read and decode one frame from an asyncio StreamReader."""
    header = await reader.readexactly(2)
    length = struct.unpack('!H', header)[0]
    payload = await reader.readexactly(length)
    return _decode_payload(payload)


def _decode_payload(payload):
    """Decode a frame payload (without length prefix)."""
    frame_type = payload[0]
    result = {'type': frame_type}
    offset = 1

    if frame_type == FRAME_CONNECT:
        reqid = struct.unpack('!H', payload[offset:offset+2])[0]
        offset += 2
        atyp = payload[offset]
        offset += 1

        if atyp == ATYP_DOMAIN:
            addr_len = payload[offset]
            offset += 1
            addr = payload[offset:offset+addr_len].decode('utf-8')
            offset += addr_len
        elif atyp == ATYP_IPV4:
            addr = '.'.join(str(b) for b in payload[offset:offset+4])
            offset += 4
        elif atyp == ATYP_IPV6:
            # Store raw bytes, not commonly used
            addr = payload[offset:offset+16].hex()
            offset += 16
        else:
            raise ValueError(f'Unsupported ATYP: {atyp}')

        port = struct.unpack('!H', payload[offset:offset+2])[0]
        result.update(reqid=reqid, atyp=atyp, addr=addr, port=port)

    elif frame_type in (FRAME_DATA, FRAME_CLOSE, FRAME_CONNECT_OK, FRAME_CONNECT_FAILED):
        reqid = struct.unpack('!H', payload[offset:offset+2])[0]
        result['reqid'] = reqid
        if frame_type == FRAME_DATA:
            result['data'] = payload[offset+2:]

    elif frame_type == FRAME_ERROR:
        msg_len = payload[offset]
        offset += 1
        result['message'] = payload[offset:offset+msg_len].decode('utf-8')

    # PING, PONG, AUTH_OK, AUTH_FAIL: no additional fields

    return result


class TunnelClient:
    """Reverse tunnel client. Connects to Server, receives CONNECT requests,
    executes them directly (bypassing local proxy to prevent loops)."""

    def __init__(self, config, on_status_change):
        """
        config: full config dict with 'server' and 'tunnel' sections.
        on_status_change: callback(status: str, detail: str) -> None.
            status values: 'connecting', 'connected', 'reconnecting',
                          'occupied', 'disconnected'
        """
        self._tunnel_cfg = config['tunnel']
        self._server_cfg = config['server']
        self._on_status_change = on_status_change
        self._running = False
        self._thread = None
        self._loop = None
        self._ssl_ctx = None
        self._tunnel_writer = None  # Current tunnel connection writer (for stop())
        self._main_task = None

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._run_thread, daemon=True, name='TunnelClient')
        self._thread.start()

    def stop(self):
        self._running = False
        # Cross-thread shutdown: wake the event loop by closing any active writer
        # and cancelling the main task if it is sleeping during backoff.
        if self._loop and self._loop.is_running():
            def _request_stop():
                if self._tunnel_writer and not self._tunnel_writer.is_closing():
                    self._tunnel_writer.close()
                if self._main_task and not self._main_task.done():
                    self._main_task.cancel()
            self._loop.call_soon_threadsafe(_request_stop)
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None

    def _run_thread(self):
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)

        # Build SSL context
        if self._server_cfg.get('tls'):
            self._ssl_ctx = ssl.create_default_context()
            if self._server_cfg.get('allowInsecure'):
                self._ssl_ctx.check_hostname = False
                self._ssl_ctx.verify_mode = ssl.CERT_NONE

        try:
            self._main_task = self._loop.create_task(self._run_loop())
            self._loop.run_until_complete(self._main_task)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f'Tunnel loop error: {e}')
        finally:
            self._main_task = None
            self._loop.close()

    async def _run_loop(self):
        """Main reconnection loop with exponential backoff."""
        backoff = 1

        while self._running:
            try:
                self._on_status_change('connecting', '')
                await self._connect_and_serve()
                backoff = 1  # Reset on success
            except TunnelOccupiedError as e:
                self._on_status_change('occupied', str(e))
                logger.error(f'Tunnel occupied: {e}')
                break  # Don't retry
            except Exception as e:
                logger.error(f'Tunnel connection failed: {e}')
                self._on_status_change('reconnecting', f'{backoff}s')
                try:
                    await asyncio.sleep(backoff)
                except asyncio.CancelledError:
                    break
                backoff = min(backoff * 2, 60)

        self._on_status_change('disconnected', '')

    async def _connect_and_serve(self):
        """Connect, authenticate, handle requests."""
        addr = self._tunnel_cfg.get('server_address') or self._server_cfg['address']
        port = self._tunnel_cfg.get('server_port', 8004)

        logger.info(f'Connecting to tunnel {addr}:{port}')

        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(
                addr, port,
                ssl=self._ssl_ctx,
                server_hostname=addr if self._ssl_ctx else None
            ),
            timeout=10
        )

        self._tunnel_writer = writer

        try:
            # Send AUTH
            writer.write(encode_frame(
                FRAME_AUTH,
                username=self._server_cfg.get('username', ''),
                password=self._server_cfg.get('password', '')
            ))
            await writer.drain()

            # Read response
            response = await read_frame(reader)

            if response['type'] == FRAME_AUTH_OK:
                logger.info('Tunnel authenticated')
                self._on_status_change('connected', '')
                await self._handle_requests(reader, writer)
            elif response['type'] == FRAME_ERROR:
                raise TunnelOccupiedError(response.get('message', 'Port occupied'))
            elif response['type'] == FRAME_AUTH_FAIL:
                raise Exception('Authentication failed')
            else:
                raise Exception(f'Unexpected response: {response["type"]:#x}')
        finally:
            self._tunnel_writer = None
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass

    async def _handle_requests(self, reader, writer):
        """Main frame processing loop. Handles PING/PONG, CONNECT, DATA, CLOSE."""
        active_writers = {}  # reqid → target_writer

        while self._running:
            try:
                frame = await asyncio.wait_for(read_frame(reader), timeout=IDLE_TIMEOUT)

                if frame['type'] == FRAME_PING:
                    writer.write(encode_frame(FRAME_PONG))
                    await writer.drain()

                elif frame['type'] == FRAME_CONNECT:
                    asyncio.ensure_future(
                        self._handle_connect(frame, writer, active_writers)
                    )

                elif frame['type'] == FRAME_DATA:
                    reqid = frame['reqid']
                    tw = active_writers.get(reqid)
                    if tw and not tw.is_closing():
                        tw.write(frame['data'])
                        await tw.drain()

                elif frame['type'] == FRAME_CLOSE:
                    reqid = frame['reqid']
                    tw = active_writers.pop(reqid, None)
                    if tw:
                        tw.close()

            except asyncio.TimeoutError:
                logger.warning('Tunnel heartbeat timeout (60s no data)')
                break
            except (ConnectionResetError, BrokenPipeError, OSError) as e:
                logger.error(f'Tunnel connection lost: {e}')
                break
            except asyncio.IncompleteReadError:
                logger.error('Tunnel connection closed by server')
                break

        # Clean up active target connections
        for reqid, tw in active_writers.items():
            tw.close()
        active_writers.clear()

    async def _handle_connect(self, frame, tunnel_writer, active_writers):
        """Handle a CONNECT request: connect to target directly, relay data."""
        reqid = frame['reqid']
        addr = frame['addr']
        port = frame['port']

        logger.info(f'CONNECT {reqid}: {addr}:{port}')

        try:
            # DIRECT connection — bypasses local proxy and routing engine
            target_reader, target_writer = await asyncio.wait_for(
                asyncio.open_connection(addr, port),
                timeout=CONNECT_TIMEOUT
            )
        except Exception as e:
            logger.error(f'CONNECT failed {reqid}: {e}')
            tunnel_writer.write(encode_frame(FRAME_CONNECT_FAILED, reqid=reqid))
            await tunnel_writer.drain()
            return

        # Send CONNECT_OK confirmation
        tunnel_writer.write(encode_frame(FRAME_CONNECT_OK, reqid=reqid))
        await tunnel_writer.drain()

        active_writers[reqid] = target_writer

        # Read from target → send as DATA frames
        try:
            while True:
                data = await target_reader.read(65536)
                if not data:
                    break
                tunnel_writer.write(encode_frame(FRAME_DATA, reqid=reqid, data=data))
                await tunnel_writer.drain()
        except (ConnectionResetError, BrokenPipeError, OSError) as e:
            logger.debug(f'Target read ended {reqid}: {e}')
        finally:
            active_writers.pop(reqid, None)
            target_writer.close()
            tunnel_writer.write(encode_frame(FRAME_CLOSE, reqid=reqid))
            await tunnel_writer.drain()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/bachi/jaylli/block-proxy/client && python -m pytest tests/test_tunnel_client.py -v`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add client/
git commit -m "feat(client): implement TunnelClient with CONNECT_OK and direct connection"
```

---

### Task 9: TunnelWindow UI (client/tunnel_window.py)

**Files:**
- Create: `client/tunnel_window.py`

**Interfaces:**
- Consumes: config dict, tunnel status from parent process
- Produces: TunnelWindowController class (PyObjC)

- [ ] **Step 1: Implement TunnelWindowController**

Follow the existing pattern from `client/config_window.py`. Key UI elements:

1. **NSSwitch** — "启用反向隧道" toggle
2. **NSTextField** — 隧道服务器地址 (server_address, placeholder: "同代理地址")
3. **NSTextField** — 隧道服务器端口 (server_port, default 8004)
4. **NSTextField** (read-only) — 连接状态 with color indicator
5. **NSButton** — "应用并重启代理"

Status display mapping:
- `connected` → `● 已连接` (green)
- `connecting` → `● 连接中...` (orange)
- `reconnecting` → `● 重连中 (Ns)` (orange)
- `occupied` → `● 连接失败: 隧道端口已被占用` (red)
- `disconnected` → `● 未连接` (gray)

On "apply": save config, exit subprocess (parent detects change and restarts proxy).

- [ ] **Step 2: Add main entry point**

```python
# At end of tunnel_window.py
if __name__ == '__main__':
    import sys, json
    from AppKit import NSApplication

    config_path = sys.argv[1] if len(sys.argv) > 1 else None
    config = {}
    if config_path:
        with open(config_path) as f:
            config = json.load(f)

    app = NSApplication.sharedApplication()
    controller = TunnelWindowController.alloc().init()
    controller.loadConfig(config)
    controller.showWindow()
    app.run()
```

- [ ] **Step 3: Commit**

```bash
git add client/
git commit -m "feat(client): add TunnelWindow UI for tunnel configuration"
```

---

### Task 10: Integrate TunnelClient into app.py

**Files:**
- Modify: `client/app.py`

**Interfaces:**
- Consumes: `TunnelClient`
- Produces: menu item, lifecycle integration, status callback

**⚠️ Code patterns (from actual codebase):**
- Config: `self.config` (Config object), `self.config.data` (dict), `self.config.config_path` (path)
- ProxyCore: `self.proxy` (ProxyCore instance), started via `self.proxy.start(self.config.data, config_dir=...)`
- No `_config` or `_config_dir` attributes

- [ ] **Step 1: Add import and attributes**

```python
from tunnel_client import TunnelClient
```

In `AppController` init section (near `self.proxy = ProxyCore()`):

```python
self.tunnel_client = None
self._tunnel_menu_item = None
```

- [ ] **Step 2: Add tunnel menu item**

```python
# In buildMenu, after existing items:
self._tunnel_menu_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
    "隧道配置", None, ""
)
self._tunnel_menu_item.setTarget_(self)
self._tunnel_menu_item.setAction_(objc.selector(
    self.openTunnelWindow_, signature=b'v@:@'
))
menu.addItem_(self._tunnel_menu_item)
```

- [ ] **Step 3: Start TunnelClient in _connect**

```python
# After self.proxy.start(...):
if self.config.data.get('tunnel', {}).get('enabled'):
    self.tunnel_client = TunnelClient(
        self.config.data,
        on_status_change=self._on_tunnel_status_change
    )
    self.tunnel_client.start()
```

- [ ] **Step 4: Stop TunnelClient in _disconnect**

```python
# After self.proxy.stop():
if self.tunnel_client:
    self.tunnel_client.stop()
    self.tunnel_client = None
```

- [ ] **Step 5: Add status callback**

```python
def _on_tunnel_status_change(self, status, detail=""):
    title_map = {
        'connected':    '隧道配置 (已连接)',
        'connecting':   '隧道配置 (连接中...)',
        'reconnecting': f'隧道配置 (重连中 {detail})',
        'occupied':     '隧道配置 (端口被占)',
        'disconnected': '隧道配置'
    }
    title = title_map.get(status, '隧道配置')
    self._tunnel_menu_item.performSelectorOnMainThread_withObject_waitUntilDone_(
        'setTitle:', title, False
    )
```

- [ ] **Step 6: Add openTunnelWindow_ action**

```python
@objc.python_method
def openTunnelWindow_(self, sender):
    import subprocess
    config_path = self.config.config_path
    tunnel_window_path = os.path.join(os.path.dirname(__file__), 'tunnel_window.py')
    subprocess.Popen([sys.executable, tunnel_window_path, config_path])
```

- [ ] **Step 7: Commit**

```bash
git add client/
git commit -m "feat(client): integrate TunnelClient with app lifecycle and menu"
```

---

## Phase 3: Integration & Testing

### Task 11: End-to-end server-side test

**Files:**
- Create: `test/tunnel-integration.test.js`

- [ ] **Step 1: Write integration test covering full CONNECT → CONNECT_OK → DATA → CLOSE cycle**

```javascript
// test/tunnel-integration.test.js
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const TunnelServer = require('../tunnel/server');
const TunnelManager = require('../tunnel/manager');
const { FRAME_TYPES, ATYP, encodeFrame, decodeFrame } = require('../tunnel/protocol');

const PORT = 28004;
const cert = fs.readFileSync(path.join(__dirname, '../cert/rootCA.crt'));
const key = fs.readFileSync(path.join(__dirname, '../cert/rootCA.key'));

function connectClient(port) {
  return new Promise((resolve, reject) => {
    const s = tls.connect(port, 'localhost', { rejectUnauthorized: false }, () => resolve(s));
    s.on('error', reject);
  });
}

function readFrame(socket) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 2) {
        const len = buf.readUInt16BE(0);
        if (buf.length >= 2 + len) {
          socket.removeListener('data', onData);
          try { resolve(decodeFrame(buf)); } catch (e) { reject(e); }
        }
      }
    };
    socket.on('data', onData);
    setTimeout(() => reject(new Error('readFrame timeout')), 5000);
  });
}

async function authenticateClient(port, user, pass) {
  const socket = await connectClient(port);
  socket.write(encodeFrame({ type: FRAME_TYPES.AUTH, username: user, password: pass }));
  const resp = await readFrame(socket);
  assert.equal(resp.type, FRAME_TYPES.AUTH_OK);
  return socket;
}

describe('Tunnel end-to-end', () => {
  let server;

  afterEach(async () => { if (server) { await server.stop(); server = null; } });

  it('should complete full CONNECT → CONNECT_OK → DATA → CLOSE cycle', async () => {
    let manager;
    server = new TunnelServer({
      port: PORT, cert, key,
      credentials: { username: 'test', password: 'test' },
      onConnect: (addr, port) => { manager.setConnected(true, `${addr}:${port}`); },
      onDisconnect: () => { manager.setConnected(false); }
    });
    manager = new TunnelManager(server, { tunnel_domains: ['internal.test.com'] });
    await server.start();

    // Client connects and authenticates
    const clientSocket = await authenticateClient(PORT, 'test', 'test');
    await new Promise(r => setTimeout(r, 50)); // let onConnect fire
    assert.equal(manager.isAvailable(), true);

    // Manager initiates a CONNECT
    const dataReceived = [];
    let connectCallbackCalled = false;
    let streamClosed = false;

    const stream = manager.forward('internal.test.com', 443, () => {
      connectCallbackCalled = true;
    });
    assert.ok(stream, 'forward should return stream when available');

    stream.on('data', (chunk) => dataReceived.push(chunk));
    stream.on('end', () => { streamClosed = true; });

    // Client receives CONNECT frame
    const connectFrame = await readFrame(clientSocket);
    assert.equal(connectFrame.type, FRAME_TYPES.CONNECT);
    assert.equal(connectFrame.addr, 'internal.test.com');
    assert.equal(connectFrame.port, 443);
    const reqid = connectFrame.reqid;

    // Client sends CONNECT_OK
    clientSocket.write(encodeFrame({ type: FRAME_TYPES.CONNECT_OK, reqid }));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(connectCallbackCalled, true, 'callback should fire on CONNECT_OK');

    // Client sends DATA
    clientSocket.write(encodeFrame({ type: FRAME_TYPES.DATA, reqid, data: Buffer.from('response-data') }));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(dataReceived.length, 1);
    assert.equal(dataReceived[0].toString(), 'response-data');

    // Client sends CLOSE
    clientSocket.write(encodeFrame({ type: FRAME_TYPES.CLOSE, reqid }));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(streamClosed, true);

    // Manager should be free again
    const stream2 = manager.forward('internal.test.com', 443, () => {});
    assert.ok(stream2, 'Manager should be free after CLOSE');
    stream2.destroy();

    clientSocket.destroy();
  });

  it('should return error stream when disconnected', async () => {
    server = new TunnelServer({
      port: PORT + 1, cert, key,
      credentials: { username: 'test', password: 'test' }
    });
    const manager = new TunnelManager(server, { tunnel_domains: ['a.com'] });

    assert.equal(manager.matchesTunnelDomain('a.com'), true);
    assert.equal(manager.isAvailable(), false);

    // forward returns error stream when not available
    const stream = manager.forward('a.com', 443, () => {});
    assert.ok(stream, 'Should return error stream');
    const [err] = await once(stream, 'error');
    assert.equal(err.message, 'tunnel-disconnected');
  });

  it('should reject second concurrent forward (busy)', async () => {
    let manager;
    server = new TunnelServer({
      port: PORT + 2, cert, key,
      credentials: { username: 'test', password: 'test' },
      onConnect: () => { manager.setConnected(true); },
      onDisconnect: () => { manager.setConnected(false); }
    });
    manager = new TunnelManager(server, { tunnel_domains: ['a.com'] });
    await server.start();

    const clientSocket = await authenticateClient(PORT + 2, 'test', 'test');
    await new Promise(r => setTimeout(r, 50)); // let onConnect fire

    // First forward succeeds
    const stream1 = manager.forward('a.com', 443, () => {});
    assert.ok(stream1);

    // Second forward while busy returns error stream
    const stream2 = manager.forward('b.com', 443, () => {});
    assert.ok(stream2, 'Busy manager should return error stream');
    const [err] = await once(stream2, 'error');
    assert.equal(err.message, 'tunnel-busy');

    // Clean up: client sends CONNECT_OK for first request, then CLOSE
    const frame = await readFrame(clientSocket);
    clientSocket.write(encodeFrame({ type: FRAME_TYPES.CONNECT_OK, reqid: frame.reqid }));
    await new Promise(r => setTimeout(r, 20));
    clientSocket.write(encodeFrame({ type: FRAME_TYPES.CLOSE, reqid: frame.reqid }));
    await new Promise(r => setTimeout(r, 20));

    // Now manager is free again
    const stream3 = manager.forward('a.com', 443, () => {});
    assert.ok(stream3);
    stream3.destroy();

    clientSocket.destroy();
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd /Users/bachi/jaylli/block-proxy && node --test test/tunnel-integration.test.js`
Expected: PASS (3 tests)

- [ ] **Step 3: Commit**

```bash
git add test/
git commit -m "test(tunnel): add end-to-end integration test"
```

---

### Task 12: Manual verification guide

**Files:**
- Create: `docs/tunnel-testing.md`

- [ ] **Step 1: Write manual testing guide**

```markdown
# Reverse Tunnel Manual Testing

## Setup

1. Server: set `enable_tunnel: "1"`, `tunnel_port: 8004`,
   `tunnel_domains: ["internal.example.com"]` in config.json. Restart.

2. Client: set `tunnel.enabled: true` in config.json.
   Restart.

## Test Cases

### 1. Connection
- Client menu shows "隧道配置 (已连接)"
- Server logs: "[Tunnel] Client authenticated"

### 2. Tunnel domain forwarding
- Browser → Server proxy → `https://internal.example.com`
- Request appears in Client logs
- Response returned to browser

### 3. Non-tunnel domain (no interference)
- Browser → `https://google.com`
- Normal proxy behavior, no tunnel involvement

### 4. Client disconnect → tunnel domain blocked
- Stop Client
- Visit tunnel domain → connection reset (not DNS leak!)
- Restart Client → auto-reconnect

### 5. Port occupied
- Start second Client
- Shows "隧道端口已被占用", stops retrying

### 6. Server restart
- Restart Server while Client connected
- Client detects disconnect, reconnects within backoff cycle

### 7. Heartbeat
- Block Client's network temporarily (>60s)
- Server should detect and clean up
- Restore network → Client reconnects
```

- [ ] **Step 2: Commit**

```bash
git add docs/
git commit -m "docs(tunnel): add manual testing guide"
```

---

## Summary

This plan implements reverse tunnel capability across 12 tasks in 3 phases:

**Phase 1 — Server-side (Tasks 1-6):**
1. Protocol: frame encode/decode with CONNECT_OK (node:test)
2. TunnelServer: TLS, per-socket buffer, heartbeat, callbacks (node:test)
3. TunnelManager: domain matching, single-concurrent forward, CONNECT_OK wait (node:test)
4. @bachi/anyproxy: customConnect hook (3-line modification)
5. proxy.js: LocalProxy lifecycle owns TunnelServer
6. Config: tunnel fields, defaults, import validation

**Phase 2 — Client-side (Tasks 7-10):**
7. Config: tunnel section
8. TunnelClient: CONNECT_OK, direct connection, heartbeat (pytest)
9. TunnelWindow: PyObjC UI
10. App integration: menu, lifecycle, status

**Phase 3 — Testing (Tasks 11-12):**
11. End-to-end integration test (node:test)
12. Manual verification guide

Each task follows TDD: failing test → implementation → passing test → commit.
