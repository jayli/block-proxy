const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const TunnelServer = require('../tunnel/server');
const TunnelManager = require('../tunnel/manager');
const { FRAME_TYPES, encodeFrame, decodeFrame } = require('../tunnel/protocol');

const PORT = 28004;
const cert = fs.readFileSync(path.join(__dirname, '../cert/rootCA.crt'));
const key = fs.readFileSync(path.join(__dirname, '../cert/rootCA.key'));

function tokenFor(username, password) {
  return crypto.createHash('sha256').update(`${username}:${password}`).digest('hex');
}

function request(port, method, requestPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'localhost',
      port,
      path: requestPath,
      method,
      rejectUnauthorized: false,
      headers: {
        ...(body ? { 'content-length': body.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks),
      }));
    });
    req.setTimeout(1000, () => req.destroy(new Error('HTTPS request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function createSession(port, username, password) {
  const res = await request(port, 'POST', '/xhttp/create', encodeFrame({
    type: FRAME_TYPES.AUTH,
    username,
    password,
    capabilities: [],
  }), {
    'content-type': 'application/octet-stream',
  });
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.body.toString('utf8')).sessionId;
}

async function uploadFrame(port, sessionId, seq, frame) {
  const res = await request(port, 'POST', `/xhttp/upload/${sessionId}/${seq}`, encodeFrame(frame), {
    'content-type': 'application/octet-stream',
  });
  assert.equal(res.statusCode, 200);
}

function openSse(port, sessionId, username, password) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'localhost',
      port,
      path: `/xhttp/stream?token=${tokenFor(username, password)}&sessionId=${sessionId}`,
      rejectUnauthorized: false,
      headers: { accept: 'text/event-stream' },
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE HTTP ${res.statusCode}`));
        return;
      }
      resolve({ req, res, readFrame: createSseFrameReader(res) });
    });
    req.setTimeout(1000, () => req.destroy(new Error('SSE timeout')));
    req.on('error', reject);
  });
}

function createSseFrameReader(res) {
  const queue = [];
  const waiters = [];
  let buffer = '';

  res.on('data', chunk => {
    buffer += chunk.toString('utf8');
    while (buffer.includes('\n\n')) {
      const events = buffer.split('\n\n');
      buffer = events.pop();
      for (const event of events) {
        const dataLine = event.split('\n').find(line => line.startsWith('data:'));
        if (!dataLine) continue;
        const frame = decodeFrame(Buffer.from(dataLine.slice('data:'.length).trim(), 'base64'));
        const waiter = waiters.shift();
        if (waiter) {
          waiter.resolve(frame);
        } else {
          queue.push(frame);
        }
      }
    }
  });

  return () => new Promise((resolve, reject) => {
    const frame = queue.shift();
    if (frame) {
      resolve(frame);
      return;
    }
    const waiter = { resolve, reject };
    waiters.push(waiter);
    setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index !== -1) {
        waiters.splice(index, 1);
        reject(new Error('SSE frame timeout'));
      }
    }, 1500);
  });
}

async function authenticateClient(port, username, password) {
  const sessionId = await createSession(port, username, password);
  const sse = await openSse(port, sessionId, username, password);
  const authOk = await sse.readFrame();
  assert.equal(authOk.type, FRAME_TYPES.AUTH_OK);
  let seq = 0;
  return {
    sessionId,
    readFrame: sse.readFrame,
    sendFrame: frame => uploadFrame(port, sessionId, seq++, frame),
    close: () => sse.req.destroy(),
  };
}

describe('Tunnel end-to-end', () => {
  let server;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it('should complete full CONNECT -> CONNECT_OK -> DATA -> CLOSE cycle', async () => {
    let manager;
    server = new TunnelServer({
      port: PORT, cert, key,
      credentials: { username: 'test', password: 'test' },
      onConnect: (sessionId) => { manager.setConnected(sessionId, true); },
      onDisconnect: (sessionId) => { manager.setConnected(sessionId, false); },
    });
    manager = new TunnelManager(server, { tunnel_domains: ['internal.test.com'] });
    await server.start();

    const client = await authenticateClient(PORT, 'test', 'test');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(manager.isAvailable(), true);

    const dataReceived = [];
    let connectCallbackCalled = false;
    let streamClosed = false;

    const stream = manager.forward('internal.test.com', 443, () => {
      connectCallbackCalled = true;
    });
    stream.on('data', chunk => dataReceived.push(chunk));
    stream.on('end', () => { streamClosed = true; });

    const connectFrame = await client.readFrame();
    assert.equal(connectFrame.type, FRAME_TYPES.CONNECT);
    assert.equal(connectFrame.addr, 'internal.test.com');
    assert.equal(connectFrame.port, 443);
    const reqid = connectFrame.reqid;

    await client.sendFrame({ type: FRAME_TYPES.CONNECT_OK, reqid });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(connectCallbackCalled, true);

    await client.sendFrame({ type: FRAME_TYPES.DATA, reqid, data: Buffer.from('response-data') });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(dataReceived.length, 1);
    assert.equal(dataReceived[0].toString(), 'response-data');

    await client.sendFrame({ type: FRAME_TYPES.CLOSE, reqid });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(streamClosed, true);

    const stream2 = manager.forward('internal.test.com', 443, () => {});
    assert.ok(stream2, 'Manager should accept another forward after CLOSE');
    stream2.destroy();
    client.close();
  });

  it('should return error stream when disconnected', async () => {
    server = new TunnelServer({
      port: PORT + 1, cert, key,
      credentials: { username: 'test', password: 'test' },
    });
    const manager = new TunnelManager(server, { tunnel_domains: ['a.com'] });

    assert.equal(manager.matchesTunnelDomain('a.com'), true);
    assert.equal(manager.isAvailable(), false);

    const stream = manager.forward('a.com', 443, () => {});
    const [err] = await once(stream, 'error');
    assert.equal(err.message, 'tunnel-disconnected');
  });

  it('should support multiple concurrent forwards over one active xhttp session', async () => {
    let manager;
    server = new TunnelServer({
      port: PORT + 2, cert, key,
      credentials: { username: 'test', password: 'test' },
      onConnect: (sessionId) => { manager.setConnected(sessionId, true); },
      onDisconnect: (sessionId) => { manager.setConnected(sessionId, false); },
    });
    manager = new TunnelManager(server, { tunnel_domains: ['a.com'] });
    await server.start();

    const client = await authenticateClient(PORT + 2, 'test', 'test');
    await new Promise(r => setTimeout(r, 50));

    const stream1 = manager.forward('a.com', 443, () => {});
    const stream2 = manager.forward('b.com', 443, () => {});
    assert.ok(stream1);
    assert.ok(stream2);

    const frame1 = await client.readFrame();
    const frame2 = await client.readFrame();
    assert.equal(frame1.type, FRAME_TYPES.CONNECT);
    assert.equal(frame2.type, FRAME_TYPES.CONNECT);

    await client.sendFrame({ type: FRAME_TYPES.CONNECT_OK, reqid: frame1.reqid });
    await client.sendFrame({ type: FRAME_TYPES.CONNECT_OK, reqid: frame2.reqid });
    await client.sendFrame({ type: FRAME_TYPES.CLOSE, reqid: frame1.reqid });
    await client.sendFrame({ type: FRAME_TYPES.CLOSE, reqid: frame2.reqid });
    client.close();
  });
});
