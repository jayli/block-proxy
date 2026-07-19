const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const TunnelServer = require('../server');
const { FRAME_TYPES, encodeFrame, decodeFrame } = require('../protocol');

let portCounter = 18004 + (process.pid % 1000);
function nextPort() { return portCounter++; }

const cert = fs.readFileSync(path.join(__dirname, '../../cert/rootCA.crt'));
const key = fs.readFileSync(path.join(__dirname, '../../cert/rootCA.key'));

function tokenFor(username = 'admin', password = 'secret') {
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
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.setTimeout(1000, () => req.destroy(new Error('HTTPS request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function openSse(port, sessionId) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'localhost',
      port,
      path: `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}`,
      rejectUnauthorized: false,
      headers: { accept: 'text/event-stream' },
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE HTTP ${res.statusCode}`));
        return;
      }
      resolve({ req, res });
    });
    req.setTimeout(1000, () => req.destroy(new Error('SSE timeout')));
    req.on('error', reject);
  });
}

function waitForSseFrame(res, predicate) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('SSE frame timeout')), 1000);
    res.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const events = buffer.split('\n\n');
      buffer = events.pop();
      for (const event of events) {
        const dataLine = event.split('\n').find(line => line.startsWith('data:'));
        if (!dataLine) continue;
        const frame = decodeFrame(Buffer.from(dataLine.slice('data:'.length).trim(), 'base64'));
        if (predicate(frame)) {
          clearTimeout(timer);
          resolve(frame);
        }
      }
    });
  });
}

async function createSession(port) {
  const authFrame = encodeFrame({
    type: FRAME_TYPES.AUTH,
    username: 'admin',
    password: 'secret',
    capabilities: [],
  });
  const res = await request(port, 'POST', '/xhttp/create', authFrame, {
    'content-type': 'application/octet-stream',
  });
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.body.toString('utf8')).sessionId;
}

describe('TunnelServer xhttp', () => {
  let server;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it('serves the disguise homepage on /', async () => {
    const port = nextPort();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' },
    });
    await server.start();

    const res = await request(port, 'GET', '/');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body.toString('utf8'), /Northstar Digital/i);
  });

  it('creates an xhttp session and opens the SSE downlink', async () => {
    const port = nextPort();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' },
    });
    await server.start();

    const sessionId = await createSession(port);
    const { req, res } = await openSse(port, sessionId);
    const authOk = await waitForSseFrame(res, frame => frame.type === FRAME_TYPES.AUTH_OK);

    assert.equal(authOk.type, FRAME_TYPES.AUTH_OK);
    req.destroy();
  });

  it('delivers per-frame POST uploads to registered frame handlers', async () => {
    const port = nextPort();
    const received = [];
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' },
    });
    server.onFrame((frame, sessionId) => received.push({ frame, sessionId }));
    await server.start();

    const sessionId = await createSession(port);
    const res = await request(port, 'POST', `/xhttp/upload/${sessionId}/0`, encodeFrame({
      type: FRAME_TYPES.PING,
      payload: Buffer.from('hello'),
    }), {
      'content-type': 'application/octet-stream',
    });

    assert.equal(res.statusCode, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(received.length, 1);
    assert.equal(received[0].sessionId, sessionId);
    assert.equal(received[0].frame.type, FRAME_TYPES.PING);
    assert.equal(received[0].frame.payload.toString('utf8'), 'hello');
  });

  it('does not expose the legacy websocket endpoint', async () => {
    const port = nextPort();
    server = new TunnelServer({
      port,
      cert, key,
      credentials: { username: 'admin', password: 'secret' },
    });
    await server.start();

    const res = await request(port, 'GET', '/websocket');
    assert.equal(res.statusCode, 404);
  });
});
