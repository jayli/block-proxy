const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const TunnelServer = require('../server');
const { FRAME_TYPES, encodeFrame, decodeFrame } = require('../protocol');

let portCounter = 18004;
function nextPort() { return portCounter++; }

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
    const port = nextPort();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' }
    });
    await server.start();

    const socket = await connectClient(port);
    socket.write(encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret'
    }));

    const response = await readFrame(socket);
    assert.equal(response.type, FRAME_TYPES.AUTH_OK);
    socket.destroy();
  });

  it('should accept second client (dual mode) and reject third', async () => {
    const port = nextPort();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' }
    });
    await server.start();

    // First client connects and authenticates
    const socket1 = await connectClient(port);
    socket1.write(encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret'
    }));
    const authResp1 = await readFrame(socket1);
    assert.equal(authResp1.type, FRAME_TYPES.AUTH_OK);

    // Second client connects — should be accepted (dual mode)
    const socket2 = await connectClient(port);
    socket2.write(encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret'
    }));
    const authResp2 = await readFrame(socket2);
    assert.equal(authResp2.type, FRAME_TYPES.AUTH_OK);

    // Third client connects — should be rejected (limit is 2)
    const socket3 = await connectClient(port);
    socket3.write(encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret'
    }));
    const errorResp = await readFrame(socket3);
    assert.equal(errorResp.type, FRAME_TYPES.ERROR);
    assert.match(errorResp.message, /limit/i);

    socket1.destroy();
    socket2.destroy();
    socket3.destroy();
  });

  it('should call onConnect after successful auth', async () => {
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

    const socket = await connectClient(port);
    socket.write(encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret'
    }));
    await readFrame(socket);

    // Give onConnect a tick to fire
    await new Promise(r => setTimeout(r, 50));
    assert.ok(connectedSocket, 'onConnect should have been called with socket');
    assert.ok(connectedAddr, 'onConnect should have been called with addr');

    socket.destroy();
  });

  it('should call onDisconnect when client closes', async () => {
    const port = nextPort();
    let disconnected = false;
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' },
      onDisconnect: () => { disconnected = true; }
    });
    await server.start();

    const socket = await connectClient(port);
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
