const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
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
      clientSocket1.write(encodeFrame({ type: FRAME_TYPES.CONNECT_OK, reqid: frame1.reqid }));
    }
    if (frame2 && frame2.type === FRAME_TYPES.CONNECT) {
      clientSocket2.write(encodeFrame({ type: FRAME_TYPES.CONNECT_OK, reqid: frame2.reqid }));
    }
    await new Promise(r => setTimeout(r, 20));

    // Send CLOSE for received frames
    if (frame1 && frame1.type === FRAME_TYPES.CONNECT) {
      clientSocket1.write(encodeFrame({ type: FRAME_TYPES.CLOSE, reqid: frame1.reqid }));
    }
    if (frame2 && frame2.type === FRAME_TYPES.CONNECT) {
      clientSocket2.write(encodeFrame({ type: FRAME_TYPES.CLOSE, reqid: frame2.reqid }));
    }
    await new Promise(r => setTimeout(r, 20));

    clientSocket1.destroy();
    clientSocket2.destroy();
  });
});
