const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const http2 = require('http2');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const TunnelServer = require('../server');
const { FRAME_TYPES, encodeFrame, decodeFrame } = require('../protocol');

const H2_OPEN = 1;
const H2_CLOSED = 3;

let portCounter = 18004 + (process.pid % 1000);
function nextPort() { return portCounter++; }

const cert = fs.readFileSync(path.join(__dirname, '../../cert/rootCA.crt'));
const key = fs.readFileSync(path.join(__dirname, '../../cert/rootCA.key'));

function getHttps(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'localhost',
      port,
      path: requestPath,
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.setTimeout(1000, () => req.destroy(new Error('HTTPS request timeout')));
    req.on('error', reject);
  });
}

function connectClient(port) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://localhost:${port}`, {
      rejectUnauthorized: false,
    });
    const stream = client.request({
      ':method': 'POST',
      ':path': '/h2-tunnel',
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
    }, { endStream: false });
    const h2 = new H2TestClient(client, stream);

    stream.on('response', (headers) => {
      if (headers[':status'] !== 200) {
        reject(new Error(`HTTP/2 tunnel status ${headers[':status']}`));
        return;
      }
      resolve(h2);
    });
    stream.on('error', reject);
    client.on('error', reject);
    setTimeout(() => reject(new Error('HTTP/2 connect timeout')), 1000);
  });
}

class H2TestClient extends EventEmitter {
  constructor(client, stream) {
    super();
    this.client = client;
    this.stream = stream;
    this.readyState = H2_OPEN;
    this._buffer = Buffer.alloc(0);

    stream.on('data', (chunk) => this._onData(Buffer.from(chunk)));
    stream.on('close', () => {
      this.readyState = H2_CLOSED;
      this.emit('close');
    });
    stream.on('error', (err) => this.emit('error', err));
  }

  send(data) {
    this.stream.write(data);
  }

  close() {
    if (this.readyState === H2_CLOSED) return;
    this.readyState = H2_CLOSED;
    try { this.stream.close(); } catch (_) {}
    try { this.client.close(); } catch (_) {}
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (this._buffer.length >= 2) {
      const len = this._buffer.readUInt16BE(0);
      if (this._buffer.length < 2 + len) return;
      const frameBytes = this._buffer.slice(0, 2 + len);
      this._buffer = this._buffer.slice(2 + len);
      this.emit('message', frameBytes);
    }
  }
}

function readFrame(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('readFrame timeout')), 5000);
    const onMessage = (chunk) => {
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      try {
        resolve(decodeFrame(Buffer.from(chunk)));
      } catch (e) {
        reject(e);
      }
    };
    ws.on('message', onMessage);
  });
}

function waitForClose(ws) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === H2_CLOSED) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('HTTP/2 stream close timeout')), 1000);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function authenticate(ws, username = 'admin', password = 'secret') {
  const pending = readFrame(ws);
  ws.send(encodeFrame({
    type: FRAME_TYPES.AUTH,
    username,
    password
  }));
  return pending;
}

async function authenticateWithCapabilities(ws, capabilities, username = 'admin', password = 'secret') {
  const pendingAuth = readFrame(ws);
  ws.send(encodeFrame({
    type: FRAME_TYPES.AUTH,
    username,
    password,
    capabilities,
  }));
  const authResponse = await pendingAuth;
  const negotiated = await readFrame(ws);
  return { authResponse, negotiated };
}

function sendAuth(ws, username = 'admin', password = 'secret') {
  ws.send(encodeFrame({
    type: FRAME_TYPES.AUTH,
    username,
    password
  }));
}

function closeWs(ws) {
  if (ws.readyState === H2_OPEN) {
    ws.close();
  }
}

async function captureConsoleLog(fn) {
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => {
    logs.push(args.join(' '));
    originalLog.apply(console, args);
  };
  try {
    await fn(logs);
  } finally {
    console.log = originalLog;
  }
  return logs;
}

async function expectPortReusable(port) {
  const probe = new TunnelServer({
    port,
    cert, key,
    credentials: { username: 'admin', password: 'secret' }
  });
  await probe.start();
  await probe.stop();
}

async function readUntil(ws, predicate) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const frame = await readFrame(ws);
    if (predicate(frame)) return frame;
  }
  throw new Error('matching frame timeout');
}

async function waitForCondition(predicate, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('condition timeout');
}

describe('TunnelServer HTTP/1.1 compatibility', () => {
  let server;

  afterEach(async () => {
    if (server) { await server.stop(); server = null; }
  });

  it('rejects HTTP/1.1 GET / because tunnel port is HTTP/2 only', async () => {
    const port = nextPort();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' }
    });
    await server.start();

    const res = await getHttps(port, '/');
    assert.equal(res.statusCode, 403);
  });

  it('rejects HTTP/1.1 GET /index.html', async () => {
    const port = nextPort();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' }
    });
    await server.start();

    const res = await getHttps(port, '/index.html');
    assert.equal(res.statusCode, 403);
  });

  it('rejects HTTP/1.1 GET unknown path', async () => {
    const port = nextPort();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' }
    });
    await server.start();

    const res = await getHttps(port, '/products/2026/report.html');
    assert.equal(res.statusCode, 403);
  });
});

describe('TunnelServer HTTP/2 stream', () => {
  let server;

  afterEach(async () => {
    if (server) { await server.stop(); server = null; }
  });

  it('authenticates client and sends AUTH_OK over /h2-tunnel', async () => {
    const port = nextPort();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' }
    });
    await server.start();

    const ws = await connectClient(port);
    const response = await authenticate(ws);
    assert.equal(response.type, FRAME_TYPES.AUTH_OK);
    closeWs(ws);
  });

  it('accepts a maximum-sized DATA frame over HTTP/2 stream', async () => {
    const port = nextPort();
    let receivedFrame = null;
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' }
    });
    server.onFrame((frame) => { receivedFrame = frame; });
    await server.start();

    const ws = await connectClient(port);
    assert.equal((await authenticate(ws)).type, FRAME_TYPES.AUTH_OK);

    const maxData = Buffer.alloc(65535 - 3, 0x61);
    ws.send(encodeFrame({
      type: FRAME_TYPES.DATA,
      reqid: 7,
      data: maxData,
    }));

    await waitForCondition(() => receivedFrame !== null, 1000);
    assert.equal(receivedFrame.type, FRAME_TYPES.DATA);
    assert.equal(receivedFrame.reqid, 7);
    assert.equal(receivedFrame.data.length, maxData.length);
    closeWs(ws);
  });

  it('rejects bad auth', async () => {
    const port = nextPort();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' }
    });
    await server.start();

    const ws = await connectClient(port);
    const response = await authenticate(ws, 'admin', 'bad');
    assert.equal(response.type, FRAME_TYPES.AUTH_FAIL);
    await waitForClose(ws);
  });

  it('closes unauthenticated clients that send non-auth frames', async () => {
    const port = nextPort();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' }
    });
    await server.start();

    const ws = await connectClient(port);
    ws.send(encodeFrame({ type: FRAME_TYPES.PING }));
    await waitForClose(ws);
  });

  it('sends random heartbeat PING payload and accepts matching PONG', async () => {
    const port = nextPort();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' },
      heartbeatMin: 0.01,
      heartbeatMax: 0.02,
      heartbeatTimeout: 1,
    });
    await server.start();

    const ws = await connectClient(port);
    const response = await authenticate(ws);
    assert.equal(response.type, FRAME_TYPES.AUTH_OK);

    const ping = await readUntil(ws, frame => frame.type === FRAME_TYPES.PING);
    assert.ok(ping.payload.length >= 8);
    ws.send(encodeFrame({ type: FRAME_TYPES.PONG, payload: ping.payload }));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(ws.readyState, H2_OPEN);
    closeWs(ws);
  });

  it('ignores authenticated PADDING frames without dispatching to handlers', async () => {
    const port = nextPort();
    let handlerCalls = 0;
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' },
    });
    server.onFrame(() => { handlerCalls += 1; });
    await server.start();

    const ws = await connectClient(port);
    assert.equal((await authenticate(ws)).type, FRAME_TYPES.AUTH_OK);

    ws.send(encodeFrame({ type: FRAME_TYPES.PADDING, data: Buffer.from('noise') }));
    await new Promise(r => setTimeout(r, 50));

    assert.equal(handlerCalls, 0);
    assert.equal(ws.readyState, H2_OPEN);
    closeWs(ws);
  });

  it('does not send PADDING by default even when probability is one', async () => {
    const port = nextPort();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' },
      paddingProbability: 1,
      paddingMinBytes: 4,
      paddingMaxBytes: 4,
    });
    await server.start();

    const ws = await connectClient(port);
    assert.equal((await authenticate(ws)).type, FRAME_TYPES.AUTH_OK);

    const ok = await server.sendFrame({
      type: FRAME_TYPES.DATA,
      reqid: 7,
      data: Buffer.from('hello'),
    });
    assert.equal(ok, true);

    const dataFrame = await readUntil(ws, frame => frame.type === FRAME_TYPES.DATA);
    assert.equal(dataFrame.reqid, 7);
    assert.deepEqual(dataFrame.data, Buffer.from('hello'));
    await assert.rejects(
      readUntil(ws, frame => frame.type === FRAME_TYPES.PADDING),
      /readFrame timeout|matching frame timeout/
    );
    closeWs(ws);
  });

  it('sends PADDING only after padding is negotiated', async () => {
    const port = nextPort();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' },
      paddingEnabled: true,
      paddingProbability: 1,
      paddingMinBytes: 4,
      paddingMaxBytes: 4,
    });
    await server.start();

    const ws = await connectClient(port);
    const { authResponse, negotiated } = await authenticateWithCapabilities(ws, ['padding']);
    assert.equal(authResponse.type, FRAME_TYPES.AUTH_OK);
    assert.equal(negotiated.type, FRAME_TYPES.CAPABILITIES);
    assert.deepEqual(negotiated.capabilities, ['padding']);

    const ok = await server.sendFrame({
      type: FRAME_TYPES.DATA,
      reqid: 7,
      data: Buffer.from('hello'),
    });
    assert.equal(ok, true);

    const dataFrame = await readUntil(ws, frame => frame.type === FRAME_TYPES.DATA);
    const paddingFrame = await readUntil(ws, frame => frame.type === FRAME_TYPES.PADDING);
    assert.equal(dataFrame.reqid, 7);
    assert.deepEqual(dataFrame.data, Buffer.from('hello'));
    assert.equal(paddingFrame.data.length, 4);
    closeWs(ws);
  });

  it('logs when padding is negotiated', async () => {
    const port = nextPort();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' },
    });
    await server.start();

    const ws = await connectClient(port);
    const logs = await captureConsoleLog(async (capturedLogs) => {
      const { authResponse, negotiated } = await authenticateWithCapabilities(ws, ['padding']);
      assert.equal(authResponse.type, FRAME_TYPES.AUTH_OK);
      assert.equal(negotiated.type, FRAME_TYPES.CAPABILITIES);
      await waitForCondition(
        () => capturedLogs.some(line => line.includes('[Tunnel] Padding negotiated')),
        1000
      );
    });

    assert.ok(logs.some(line => line.includes('[Tunnel] Padding negotiated')));
    closeWs(ws);
  });

  it('does not carry padding negotiation across reconnects', async () => {
    const port = nextPort();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' },
      paddingEnabled: true,
      paddingProbability: 1,
      paddingMinBytes: 4,
      paddingMaxBytes: 4,
    });
    await server.start();

    const ws1 = await connectClient(port);
    const negotiated1 = await authenticateWithCapabilities(ws1, ['padding']);
    assert.equal(negotiated1.authResponse.type, FRAME_TYPES.AUTH_OK);
    assert.equal(negotiated1.negotiated.type, FRAME_TYPES.CAPABILITIES);
    closeWs(ws1);
    await waitForClose(ws1);

    const ws2 = await connectClient(port);
    assert.equal((await authenticate(ws2)).type, FRAME_TYPES.AUTH_OK);

    const ok = await server.sendFrame({
      type: FRAME_TYPES.DATA,
      reqid: 9,
      data: Buffer.from('after-reconnect'),
    });
    assert.equal(ok, true);

    const dataFrame = await readUntil(ws2, frame => frame.type === FRAME_TYPES.DATA);
    assert.equal(dataFrame.reqid, 9);
    await assert.rejects(
      readUntil(ws2, frame => frame.type === FRAME_TYPES.PADDING),
      /readFrame timeout|matching frame timeout/
    );
    closeWs(ws2);
  });

  it('stop releases the listening port', async () => {
    const port = nextPort();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' }
    });
    await server.start();
    await server.stop();
    server = null;
    await expectPortReusable(port);
  });

});

describe('TunnelServer HTTP/2 tunnel', () => {
  let server;

  afterEach(async () => {
    if (server) { await server.stop(); server = null; }
  });

  it('authenticates client and sends AUTH_OK over /h2-tunnel', async () => {
    const port = nextPort();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' }
    });
    await server.start();

    const h2 = await connectClient(port);
    const pending = readFrame(h2);
    h2.send(encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret',
    }));
    const response = await pending;
    assert.equal(response.type, FRAME_TYPES.AUTH_OK);
    h2.close();
  });
});

describe('TunnelServer callbacks', () => {
  let server;

  afterEach(async () => {
    if (server) { await server.stop(); server = null; }
  });

  it('calls onConnect after successful auth', async () => {
    const port = nextPort();
    let connectedSocket = null;
    let connectedAddr = null;
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' },
      onConnect: (socket, addr) => {
        connectedSocket = socket;
        connectedAddr = addr;
      }
    });
    await server.start();

    const ws = await connectClient(port);
    await authenticate(ws);

    await new Promise(r => setTimeout(r, 50));
    assert.ok(connectedSocket, 'onConnect should have been called with socket');
    assert.ok(connectedAddr, 'onConnect should have been called with addr');
    closeWs(ws);
  });

  it('calls onDisconnect when client closes', async () => {
    const port = nextPort();
    let disconnected = false;
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' },
      onDisconnect: () => { disconnected = true; }
    });
    await server.start();

    const ws = await connectClient(port);
    await authenticate(ws);

    closeWs(ws);
    await new Promise(r => setTimeout(r, 100));
    assert.ok(disconnected, 'onDisconnect should have been called');
  });
});

describe('TunnelServer rotation state', () => {
  let server;

  afterEach(async () => {
    if (server) { await server.stop(); server = null; }
  });

  it('promotes a second authenticated H2 stream to active and drains the old active', async () => {
    const port = nextPort();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' },
      rotationDrainTimeout: 0.05,
    });
    await server.start();

    const ws1 = await connectClient(port);
    assert.equal((await authenticate(ws1)).type, FRAME_TYPES.AUTH_OK);
    assert.deepEqual(server.getConnectionCounts(), {
      active: 1, candidate: 0, draining: 0, total: 1
    });
    const firstActive = server.getActiveSocket();

    const ws2 = await connectClient(port);
    sendAuth(ws2);
    await waitForCondition(() => server.getConnectionCounts().draining === 1);
    const counts = server.getConnectionCounts();
    assert.equal(counts.active, 1);
    assert.equal(counts.draining, 1);
    assert.equal(counts.total, 2);
    assert.notEqual(server.getActiveSocket(), firstActive);

    await waitForCondition(() => server.getConnectionCounts().draining === 0);
    assert.equal(server.getConnectionCounts().draining, 0);
    closeWs(ws1);
    closeWs(ws2);
  });

  it('rejects a third authenticated H2 stream while active and draining already exist', async () => {
    const port = nextPort();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' },
      rotationDrainTimeout: 1,
    });
    await server.start();

    const ws1 = await connectClient(port);
    assert.equal((await authenticate(ws1)).type, FRAME_TYPES.AUTH_OK);
    const ws2 = await connectClient(port);
    assert.equal((await authenticate(ws2)).type, FRAME_TYPES.AUTH_OK);

    const ws3 = await connectClient(port);
    const response = await authenticate(ws3);
    assert.equal(response.type, FRAME_TYPES.ERROR);
    assert.match(response.message, /limit/i);

    closeWs(ws1);
    closeWs(ws2);
    closeWs(ws3);
  });

  it('keeps draining H2 stream open after timeout while bound requests remain', async () => {
    const port = nextPort();
    let oldWs;
    let activeRequests = 1;
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' },
      rotationDrainTimeout: 0.05,
    });
    server.setActiveRequestChecker((socket) => socket === oldWs ? activeRequests : 0);
    await server.start();

    const ws1 = await connectClient(port);
    assert.equal((await authenticate(ws1)).type, FRAME_TYPES.AUTH_OK);
    oldWs = server.getActiveSocket();

    const ws2 = await connectClient(port);
    assert.equal((await authenticate(ws2)).type, FRAME_TYPES.AUTH_OK);
    await waitForCondition(() => server.getConnectionCounts().draining === 1);

    await new Promise(r => setTimeout(r, 120));
    assert.equal(server.getConnectionCounts().draining, 1);
    assert.notEqual(ws1.readyState, H2_CLOSED);

    activeRequests = 0;
    await waitForCondition(() => server.getConnectionCounts().draining === 0);
    assert.equal(server.getConnectionCounts().draining, 0);

    closeWs(ws1);
    closeWs(ws2);
  });

  it('closes draining H2 stream after bound requests become idle', async () => {
    const port = nextPort();
    let oldWs;
    let lastActivityAt = Date.now();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' },
      rotationDrainTimeout: 0.05,
      rotationDrainIdleTimeout: 0.1,
    });
    server.setActiveRequestChecker((socket) => socket === oldWs
      ? { activeCount: 1, lastActivityAt }
      : { activeCount: 0, lastActivityAt: 0 });
    await server.start();

    const ws1 = await connectClient(port);
    assert.equal((await authenticate(ws1)).type, FRAME_TYPES.AUTH_OK);
    oldWs = server.getActiveSocket();

    const ws2 = await connectClient(port);
    assert.equal((await authenticate(ws2)).type, FRAME_TYPES.AUTH_OK);
    await waitForCondition(() => server.getConnectionCounts().draining === 1);

    lastActivityAt = Date.now();
    await new Promise(r => setTimeout(r, 80));
    assert.equal(server.getConnectionCounts().draining, 1);
    assert.notEqual(ws1.readyState, H2_CLOSED);

    lastActivityAt = Date.now() - 1000;
    await waitForCondition(() => server.getConnectionCounts().draining === 0, 1500);

    closeWs(ws1);
    closeWs(ws2);
  });

  it('does not run drain checker after server stop', async () => {
    const port = nextPort();
    let drainChecks = 0;
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' },
      rotationDrainTimeout: 0.05,
    });
    server.setActiveRequestChecker(() => {
      drainChecks += 1;
      return 1;
    });
    await server.start();

    const ws1 = await connectClient(port);
    assert.equal((await authenticate(ws1)).type, FRAME_TYPES.AUTH_OK);
    const ws2 = await connectClient(port);
    assert.equal((await authenticate(ws2)).type, FRAME_TYPES.AUTH_OK);
    await waitForCondition(() => server.getConnectionCounts().draining === 1);

    await server.stop();
    server = null;
    await new Promise(r => setTimeout(r, 120));

    assert.equal(drainChecks, 0);
    closeWs(ws1);
    closeWs(ws2);
  });
});
