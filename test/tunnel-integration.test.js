const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { EventEmitter } = require('node:events');
const fs = require('fs');
const http2 = require('http2');
const path = require('path');
const TunnelServer = require('../tunnel/server');
const TunnelManager = require('../tunnel/manager');
const { FRAME_TYPES, ATYP, encodeFrame, decodeFrame } = require('../tunnel/protocol');

const PORT = 28004;
const cert = fs.readFileSync(path.join(__dirname, '../cert/rootCA.crt'));
const key = fs.readFileSync(path.join(__dirname, '../cert/rootCA.key'));

function connectClient(port) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://localhost:${port}`, {
      rejectUnauthorized: false,
    });
    const stream = client.request({
      ':method': 'POST',
      ':path': '/h2-tunnel',
      'content-type': 'application/octet-stream',
    }, { endStream: false });
    const h2 = new H2TestClient(client, stream);
    stream.on('response', (headers) => {
      if (headers[':status'] !== 200) {
        reject(new Error(`HTTP/2 tunnel status ${headers[':status']}`));
        return;
      }
      resolve(h2);
    });
    stream.once('error', reject);
    client.once('error', reject);
  });
}

class H2TestClient extends EventEmitter {
  constructor(client, stream) {
    super();
    this.client = client;
    this.stream = stream;
    this._buffer = Buffer.alloc(0);
    stream.on('data', (chunk) => this._onData(Buffer.from(chunk)));
    stream.on('close', () => this.emit('close'));
    stream.on('error', (err) => this.emit('error', err));
  }

  send(data) {
    this.stream.write(data);
  }

  close() {
    try { this.stream.close(); } catch (_) {}
    try { this.stream.destroy(); } catch (_) {}
    try { this.client.destroy(); } catch (_) {}
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (this._buffer.length >= 2) {
      const length = this._buffer.readUInt16BE(0);
      if (this._buffer.length < 2 + length) return;
      const frameBytes = this._buffer.slice(0, 2 + length);
      this._buffer = this._buffer.slice(2 + length);
      this.emit('message', frameBytes);
    }
  }
}

function readFrame(client) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('readFrame timeout')), 5000);
    const onMessage = (chunk) => {
      clearTimeout(timer);
      client.removeListener('message', onMessage);
      try { resolve(decodeFrame(Buffer.from(chunk))); } catch (e) { reject(e); }
    };
    client.on('message', onMessage);
  });
}

async function authenticateClient(port, user, pass) {
  const ws = await connectClient(port);
  ws.send(encodeFrame({ type: FRAME_TYPES.AUTH, username: user, password: pass }));
  const resp = await readFrame(ws);
  assert.equal(resp.type, FRAME_TYPES.AUTH_OK);
  return ws;
}

describe('Tunnel end-to-end', () => {
  let server;

  afterEach(async () => { if (server) { await server.stop(); server = null; } });

  it('should complete full CONNECT -> CONNECT_OK -> DATA -> CLOSE cycle', async () => {
    let manager;
    server = new TunnelServer({
      port: PORT, cert, key,
      credentials: { username: 'test', password: 'test' },
      onConnect: (socket, addr, port) => { manager.setConnected(socket, true, `${addr}:${port}`); },
      onDisconnect: (socket) => { manager.setConnected(socket, false); }
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
    clientSocket.send(encodeFrame({ type: FRAME_TYPES.CONNECT_OK, reqid }));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(connectCallbackCalled, true, 'callback should fire on CONNECT_OK');

    // Client sends DATA
    clientSocket.send(encodeFrame({ type: FRAME_TYPES.DATA, reqid, data: Buffer.from('response-data') }));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(dataReceived.length, 1);
    assert.equal(dataReceived[0].toString(), 'response-data');

    // Client sends CLOSE
    clientSocket.send(encodeFrame({ type: FRAME_TYPES.CLOSE, reqid }));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(streamClosed, true);

    // Manager should be free again
    const stream2 = manager.forward('internal.test.com', 443, () => {});
    assert.ok(stream2, 'Manager should be free after CLOSE');
    stream2.destroy();

    clientSocket.close();
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

  it('should support multiple concurrent forwards with dual connections', async () => {
    let manager;
    server = new TunnelServer({
      port: PORT + 2, cert, key,
      credentials: { username: 'test', password: 'test' },
      onConnect: (socket, addr, port) => { manager.setConnected(socket, true, `${addr}:${port}`); },
      onDisconnect: (socket) => { manager.setConnected(socket, false); }
    });
    manager = new TunnelManager(server, { tunnel_domains: ['a.com'] });
    await server.start();

    // Establish dual connections
    const clientSocket1 = await authenticateClient(PORT + 2, 'test', 'test');
    const clientSocket2 = await authenticateClient(PORT + 2, 'test', 'test');
    await new Promise(r => setTimeout(r, 50)); // let onConnect fire

    // First forward succeeds
    const stream1 = manager.forward('a.com', 443, () => {});
    assert.ok(stream1);

    // Second forward also succeeds (dual connections allow concurrent forwards)
    const stream2 = manager.forward('b.com', 443, () => {});
    assert.ok(stream2, 'Dual connections should allow concurrent forwards');

    // Read CONNECT frames from both sockets (round-robin distributes them)
    // Use allSettled to handle cases where one socket might not receive a frame
    const results = await Promise.allSettled([
      Promise.race([readFrame(clientSocket1), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000))]),
      Promise.race([readFrame(clientSocket2), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000))])
    ]);

    const frame1 = results[0].status === 'fulfilled' ? results[0].value : null;
    const frame2 = results[1].status === 'fulfilled' ? results[1].value : null;

    // At least one should be a CONNECT frame (could be both on same socket or distributed)
    const hasConnect = (frame1 && frame1.type === FRAME_TYPES.CONNECT) ||
                       (frame2 && frame2.type === FRAME_TYPES.CONNECT);
    assert.ok(hasConnect, 'At least one socket should receive a CONNECT frame');

    // Send CONNECT_OK for received frames
    if (frame1 && frame1.type === FRAME_TYPES.CONNECT) {
      clientSocket1.send(encodeFrame({ type: FRAME_TYPES.CONNECT_OK, reqid: frame1.reqid }));
    }
    if (frame2 && frame2.type === FRAME_TYPES.CONNECT) {
      clientSocket2.send(encodeFrame({ type: FRAME_TYPES.CONNECT_OK, reqid: frame2.reqid }));
    }
    await new Promise(r => setTimeout(r, 20));

    // Send CLOSE for received frames
    if (frame1 && frame1.type === FRAME_TYPES.CONNECT) {
      clientSocket1.send(encodeFrame({ type: FRAME_TYPES.CLOSE, reqid: frame1.reqid }));
    }
    if (frame2 && frame2.type === FRAME_TYPES.CONNECT) {
      clientSocket2.send(encodeFrame({ type: FRAME_TYPES.CLOSE, reqid: frame2.reqid }));
    }
    await new Promise(r => setTimeout(r, 20));

    stream1.destroy();
    stream2.destroy();
    clientSocket1.close();
    clientSocket2.close();
  });
});
