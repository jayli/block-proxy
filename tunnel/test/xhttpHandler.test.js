const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('crypto');
const XhttpHandler = require('../xhttpHandler');
const { FRAME_TYPES, encodeFrame, decodeFrame } = require('../protocol');

function tokenFor(username = 'admin', password = 'secret') {
  return crypto.createHash('sha256').update(`${username}:${password}`).digest('hex');
}

function sseFrames(res) {
  return res.writes
    .filter(chunk => chunk.startsWith('event: frame'))
    .map(chunk => decodeFrame(Buffer.from(chunk.split('\ndata: ')[1].trim(), 'base64')));
}

function mockRequest(method, path, body = Buffer.alloc(0)) {
  const req = new EventEmitter();
  req.method = method;
  req.url = path;
  req.emitBody = () => {
    if (body.length > 0) req.emit('data', body);
    req.emit('end');
  };
  return req;
}

function mockResponse() {
  const writes = [];
  const res = new EventEmitter();
  Object.assign(res, {
    statusCode: null,
    headers: null,
    writes,
    ended: false,
    writableEnded: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    write(chunk) {
      writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return true;
    },
    end(chunk = '') {
      if (chunk) this.write(chunk);
      this.ended = true;
      this.writableEnded = true;
    },
  });
  return res;
}

function createHandler(overrides = {}) {
  const events = [];
  const handler = new XhttpHandler({
    credentials: { username: 'admin', password: 'secret' },
    sessionTimeoutMs: 60_000,
    keepaliveMinMs: 60_000,
    keepaliveMaxMs: 60_000,
    paddingEnabled: false,
    onFrame: (frame, sessionId) => events.push({ type: 'frame', frame, sessionId }),
    onSessionCreated: (sessionId, token, info) => events.push({ type: 'created', sessionId, token, info }),
    onSessionClosed: (sessionId, token) => events.push({ type: 'closed', sessionId, token }),
    ...overrides,
  });
  return { handler, events };
}

async function createSession(handler, capabilities = [], clientId = 'client-a') {
  const req = mockRequest('POST', '/xhttp/create', encodeFrame({
    type: FRAME_TYPES.AUTH,
    username: 'admin',
    password: 'secret',
    capabilities,
    clientId,
  }));
  const res = mockResponse();
  assert.equal(handler.handleRequest(req, res), true);
  req.emitBody();
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.writes.join('')).sessionId;
}

describe('XhttpHandler session model', () => {
  it('uses a 15 second default session reconnect window', () => {
    const { handler } = createHandler({ sessionTimeoutMs: undefined });

    assert.equal(handler._sessionTimeoutMs, 15_000);
    handler.closeAll();
  });

  it('closes the session when the upload queue overflows', async () => {
    const { handler, events } = createHandler({ maxBufferedPosts: 2 });
    const sessionId = await createSession(handler);
    const statuses = [];

    for (const seq of [5, 6, 7]) {
      const req = mockRequest('POST', `/xhttp/upload/${sessionId}/${seq}`, encodeFrame({
        type: FRAME_TYPES.PING, payload: Buffer.from(`p${seq}`),
      }));
      const res = mockResponse();
      assert.equal(handler.handleRequest(req, res), true);
      req.emitBody();
      statuses.push(res.statusCode);
    }

    assert.deepEqual(statuses, [200, 200, 503]);
    assert.equal(handler._sessions.has(sessionId), false);
    assert.ok(events.some(event => event.type === 'closed' && event.sessionId === sessionId));
    handler.closeAll();
  });

  it('closes the session when its upload queue is closed externally', async () => {
    const { handler, events } = createHandler();
    const sessionId = await createSession(handler);

    handler._sessions.get(sessionId).uploadQueue.close();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(handler._sessions.has(sessionId), false);
    assert.ok(events.some(event => event.type === 'closed' && event.sessionId === sessionId));
    handler.closeAll();
  });

  it('does not negotiate silent_mode from AUTH capabilities', async () => {
    const { handler, events } = createHandler();

    const sessionId = await createSession(handler, ['silent_mode']);

    const created = events.find(event => event.type === 'created');
    assert.equal(created.sessionId, sessionId);
    assert.deepEqual(created.info.capabilities, []);
    assert.equal(Object.hasOwn(created.info, 'silentMode'), false);
    handler.closeAll();
  });

  it('negotiates upload batch capability when advertised', async () => {
    const { handler, events } = createHandler();

    await createSession(handler, ['upload-batch-v1']);

    const created = events.find(event => event.type === 'created');
    assert.deepEqual(created.info.capabilities, ['upload-batch-v1']);
    handler.closeAll();
  });

  it('rejects stream-up upload without seq; upload is per-frame POST only', async () => {
    const { handler } = createHandler();
    const sessionId = await createSession(handler);

    const req = mockRequest('POST', `/xhttp/upload/${sessionId}`, encodeFrame({
      type: FRAME_TYPES.PING,
      payload: Buffer.from('ping'),
    }));
    const res = mockResponse();
    assert.equal(handler.handleRequest(req, res), true);
    req.emitBody();

    assert.equal(res.statusCode, 404);
    handler.closeAll();
  });

  it('accepts out-of-order per-frame POST uploads and delivers frames in seq order', async () => {
    const { handler, events } = createHandler();
    const sessionId = await createSession(handler);

    for (const [seq, payload] of [
      [1, 'second'],
      [0, 'first'],
    ]) {
      const req = mockRequest('POST', `/xhttp/upload/${sessionId}/${seq}`, encodeFrame({
        type: FRAME_TYPES.PING,
        payload: Buffer.from(payload),
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

    for (const [seq, labels] of [
      [1, ['second-a', 'second-b']],
      [0, ['first-a', 'first-b']],
    ]) {
      const req = mockRequest('POST', `/xhttp/upload/${sessionId}/${seq}`, Buffer.concat(
        labels.map(label => encodeFrame({
          type: FRAME_TYPES.PING,
          payload: Buffer.from(label),
        }))
      ));
      const res = mockResponse();
      assert.equal(handler.handleRequest(req, res), true);
      req.emitBody();
      assert.equal(res.statusCode, 200);
    }

    await new Promise(resolve => setImmediate(resolve));
    const frames = events.filter(event => event.type === 'frame').map(event => event.frame);
    assert.deepEqual(frames.map(frame => frame.payload.toString('utf8')), [
      'first-a',
      'first-b',
      'second-a',
      'second-b',
    ]);
    handler.closeAll();
  });

  it('rejects a duplicate session create while an existing session is waiting for SSE', async () => {
    const { handler } = createHandler();
    const oldSessionId = await createSession(handler);

    const createReq = mockRequest('POST', '/xhttp/create', encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret',
      capabilities: [],
      clientId: 'client-b',
    }));
    const createRes = mockResponse();
    assert.equal(handler.handleRequest(createReq, createRes), true);
    createReq.emitBody();

    assert.equal(createRes.statusCode, 409);
    assert.deepEqual(JSON.parse(createRes.writes.join('')), {
      error: 'tunnel occupied',
      message: '隧道已占用',
    });
    assert.equal(handler._sessions.has(oldSessionId), true);
    assert.equal(handler._sessions.size, 1);
    handler.closeAll();
  });

  it('rejects session create when client id is missing', () => {
    const { handler } = createHandler();
    const req = mockRequest('POST', '/xhttp/create', encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret',
      capabilities: [],
    }));
    const res = mockResponse();
    assert.equal(handler.handleRequest(req, res), true);
    req.emitBody();

    assert.equal(res.statusCode, 400);
    assert.deepEqual(JSON.parse(res.writes.join('')), {
      error: 'client id required',
    });
    assert.equal(handler._sessions.size, 0);
    handler.closeAll();
  });

  it('records the client id that owns a created session', async () => {
    const { handler } = createHandler();
    const sessionId = await createSession(handler, [], 'client-a');

    assert.equal(handler._sessions.get(sessionId).clientId, 'client-a');
    handler.closeAll();
  });

  it('keeps a disconnected SSE session reserved for the original client id and sessionId to reconnect', async () => {
    const { handler } = createHandler();
    const sessionId = await createSession(handler, [], 'client-a');

    const streamReq = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}&clientId=client-a`);
    const streamRes = mockResponse();
    assert.equal(handler.handleRequest(streamReq, streamRes), true);
    assert.equal(handler.getActiveSessionId(), sessionId);

    streamRes.emit('close');
    assert.equal(handler.getActiveSessionId(), null);

    const createReq = mockRequest('POST', '/xhttp/create', encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret',
      capabilities: [],
      clientId: 'client-b',
    }));
    const createRes = mockResponse();
    assert.equal(handler.handleRequest(createReq, createRes), true);
    createReq.emitBody();

    assert.equal(createRes.statusCode, 409);
    assert.equal(handler._sessions.has(sessionId), true);

    const wrongClientReq = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}&clientId=client-b`);
    const wrongClientRes = mockResponse();
    assert.equal(handler.handleRequest(wrongClientReq, wrongClientRes), true);
    assert.equal(wrongClientRes.statusCode, 403);
    assert.equal(handler.getActiveSessionId(), null);

    const reconnectReq = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}&clientId=client-a`);
    const reconnectRes = mockResponse();
    assert.equal(handler.handleRequest(reconnectReq, reconnectRes), true);
    assert.equal(reconnectRes.statusCode, 200);
    assert.equal(handler.getActiveSessionId(), sessionId);
    handler.closeAll();
  });

  it('releases the tunnel slot immediately when the session is explicitly closed', async () => {
    const { handler, events } = createHandler();
    const sessionId = await createSession(handler);

    const closeReq = mockRequest('POST', `/xhttp/close/${sessionId}?token=${tokenFor()}`);
    const closeRes = mockResponse();
    assert.equal(handler.handleRequest(closeReq, closeRes), true);

    assert.equal(closeRes.statusCode, 200);
    assert.deepEqual(JSON.parse(closeRes.writes.join('')), { ok: true });
    assert.equal(handler._sessions.has(sessionId), false);
    assert.ok(events.some(event => event.type === 'closed' && event.sessionId === sessionId));

    const newSessionId = await createSession(handler);
    assert.ok(newSessionId);
    handler.closeAll();
  });

  it('does not close a session when the explicit close token is invalid', async () => {
    const { handler } = createHandler();
    const sessionId = await createSession(handler);

    const closeReq = mockRequest('POST', `/xhttp/close/${sessionId}?token=bad-token`);
    const closeRes = mockResponse();
    assert.equal(handler.handleRequest(closeReq, closeRes), true);

    assert.equal(closeRes.statusCode, 401);
    assert.equal(handler._sessions.has(sessionId), true);

    const createReq = mockRequest('POST', '/xhttp/create', encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret',
      capabilities: [],
      clientId: 'client-b',
    }));
    const createRes = mockResponse();
    assert.equal(handler.handleRequest(createReq, createRes), true);
    createReq.emitBody();
    assert.equal(createRes.statusCode, 409);
    handler.closeAll();
  });

  it('rejects a new session for the same token while an SSE stream is active', async () => {
    const { handler } = createHandler();
    const sessionId = await createSession(handler);

    const streamReq = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}&clientId=client-a`);
    const streamRes = mockResponse();
    assert.equal(handler.handleRequest(streamReq, streamRes), true);
    assert.equal(streamRes.statusCode, 200);

    const createReq = mockRequest('POST', '/xhttp/create', encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret',
      capabilities: [],
      clientId: 'client-b',
    }));
    const createRes = mockResponse();
    assert.equal(handler.handleRequest(createReq, createRes), true);
    createReq.emitBody();

    assert.equal(createRes.statusCode, 409);
    assert.deepEqual(JSON.parse(createRes.writes.join('')), {
      error: 'tunnel occupied',
      message: '隧道已占用',
    });
    assert.equal(handler._sessions.size, 1);
    handler.closeAll();
  });

  it('pushes server frames over the SSE session channel', async () => {
    const { handler } = createHandler();
    const sessionId = await createSession(handler);

    const req = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}&clientId=client-a`);
    const res = mockResponse();
    assert.equal(handler.handleRequest(req, res), true);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);

    const encoded = encodeFrame({ type: FRAME_TYPES.PONG, payload: Buffer.from('ok') });
    assert.equal(handler.pushFrame(sessionId, encoded), true);

    const pushed = res.writes.find(chunk => chunk.startsWith('event: frame') && chunk.includes(encoded.toString('base64')));
    assert.ok(pushed);
    const payload = pushed.split('\ndata: ')[1].trim();
    assert.equal(decodeFrame(Buffer.from(payload, 'base64')).type, FRAME_TYPES.PONG);
    handler.closeAll();
  });

  it('keeps SSE active when the request closes but the response is still open', async () => {
    const { handler } = createHandler();
    const sessionId = await createSession(handler);

    const req = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}&clientId=client-a`);
    const res = mockResponse();
    assert.equal(handler.handleRequest(req, res), true);
    assert.equal(handler.getActiveSessionId(), sessionId);

    req.emit('close');
    assert.equal(handler.getActiveSessionId(), sessionId);

    res.emit('close');
    assert.equal(handler.getActiveSessionId(), null);
    handler.closeAll();
  });

  it('keeps the active SSE selected when a duplicate session create is rejected', async () => {
    const { handler } = createHandler({ sessionTimeoutMs: 20 });
    const oldSessionId = await createSession(handler);

    const oldReq = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${oldSessionId}&clientId=client-a`);
    const oldRes = mockResponse();
    assert.equal(handler.handleRequest(oldReq, oldRes), true);
    assert.equal(handler.getActiveSessionId(), oldSessionId);

    const duplicateCreateReq = mockRequest('POST', '/xhttp/create', encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret',
      capabilities: [],
      clientId: 'client-b',
    }));
    const duplicateCreateRes = mockResponse();
    assert.equal(handler.handleRequest(duplicateCreateReq, duplicateCreateRes), true);
    duplicateCreateReq.emitBody();
    assert.equal(duplicateCreateRes.statusCode, 409);
    assert.equal(handler.getActiveSessionId(), oldSessionId);
    assert.deepEqual(handler.getConnectionCounts(), {
      active: 1,
      candidate: 0,
      draining: 0,
      total: 1,
    });

    oldRes.emit('close');
    assert.equal(handler.getActiveSessionId(), null);

    const protectedCreateReq = mockRequest('POST', '/xhttp/create', encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret',
      capabilities: [],
      clientId: 'client-b',
    }));
    const protectedCreateRes = mockResponse();
    assert.equal(handler.handleRequest(protectedCreateReq, protectedCreateRes), true);
    protectedCreateReq.emitBody();
    assert.equal(protectedCreateRes.statusCode, 409);
    assert.equal(handler._sessions.has(oldSessionId), true);

    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(handler._sessions.has(oldSessionId), false);

    const newSessionId = await createSession(handler);
    const newReq = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${newSessionId}&clientId=client-a`);
    const newRes = mockResponse();
    assert.equal(handler.handleRequest(newReq, newRes), true);

    assert.equal(handler.getActiveSessionId(), newSessionId);
    assert.deepEqual(handler.getConnectionCounts(), {
      active: 1,
      candidate: 0,
      draining: 0,
      total: 1,
    });
    assert.equal(handler._sessions.has(newSessionId), true);
    handler.closeAll();
  });

  it('schedules PING keepalive from the last SSE write instead of fixed stream-open time', async () => {
    const { handler } = createHandler({
      keepaliveMinMs: 40,
      keepaliveMaxMs: 40,
    });
    const sessionId = await createSession(handler);

    const req = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}&clientId=client-a`);
    const res = mockResponse();
    assert.equal(handler.handleRequest(req, res), true);

    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(handler.pushFrame(sessionId, encodeFrame({ type: FRAME_TYPES.PONG, payload: Buffer.from('ok') })), true);

    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(sseFrames(res).some(frame => frame.type === FRAME_TYPES.PING), false);

    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(sseFrames(res).some(frame => frame.type === FRAME_TYPES.PING), true);
    handler.closeAll();
  });

  it('retries a missing PONG before the next keepalive', async () => {
    const { handler } = createHandler({
      keepaliveMinMs: 100, keepaliveMaxMs: 100,
    });
    handler._pongProbeTimeoutMs = 40;
    const sessionId = await createSession(handler);
    const req = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}&clientId=client-a`);
    const res = mockResponse();
    assert.equal(handler.handleRequest(req, res), true);

    await new Promise(resolve => setTimeout(resolve, 110));
    assert.equal(sseFrames(res).filter(frame => frame.type === FRAME_TYPES.PING).length, 1);

    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(sseFrames(res).filter(frame => frame.type === FRAME_TYPES.PING).length, 2);
    handler.closeAll();
  });

  it('closes after the PONG retry limit', async () => {
    const { handler, events } = createHandler({
      keepaliveMinMs: 1, keepaliveMaxMs: 1,
    });
    handler._pongProbeTimeoutMs = 10;
    handler._pongProbeMaxAttempts = 2;
    const sessionId = await createSession(handler);
    const req = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}&clientId=client-a`);
    const res = mockResponse();
    assert.equal(handler.handleRequest(req, res), true);

    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(handler._sessions.has(sessionId), false);
    assert.equal(events.filter(event => event.type === 'closed' && event.sessionId === sessionId).length, 1);
    handler.closeAll();
  });

  it('stops the PONG probe when DATA arrives', async () => {
    const { handler } = createHandler({
      keepaliveMinMs: 100, keepaliveMaxMs: 100,
    });
    handler._pongProbeTimeoutMs = 40;
    const sessionId = await createSession(handler);
    const req = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}&clientId=client-a`);
    const res = mockResponse();
    assert.equal(handler.handleRequest(req, res), true);

    await new Promise(resolve => setTimeout(resolve, 110));
    const session = handler._sessions.get(sessionId);
    assert.equal(session.pingAttempts, 1);

    const uploadReq = mockRequest('POST', `/xhttp/upload/${sessionId}/0`, encodeFrame({
      type: FRAME_TYPES.DATA, reqid: 0x8000, data: Buffer.from('alive'),
    }));
    const uploadRes = mockResponse();
    assert.equal(handler.handleRequest(uploadReq, uploadRes), true);
    uploadReq.emitBody();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(session.pingAttempts, 0);
    assert.equal(session.pongProbeTimer, null);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(sseFrames(res).filter(frame => frame.type === FRAME_TYPES.PING).length, 1);
    handler.closeAll();
  });

  it('clears the outstanding nonce when a matching PONG arrives', async () => {
    const { handler } = createHandler({
      keepaliveMinMs: 100, keepaliveMaxMs: 100,
    });
    handler._pongProbeTimeoutMs = 40;
    const sessionId = await createSession(handler);
    const req = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}&clientId=client-a`);
    const res = mockResponse();
    assert.equal(handler.handleRequest(req, res), true);

    await new Promise(resolve => setTimeout(resolve, 110));
    const session = handler._sessions.get(sessionId);
    const ping = sseFrames(res).find(frame => frame.type === FRAME_TYPES.PING);
    assert.ok(ping);

    const uploadReq = mockRequest('POST', `/xhttp/upload/${sessionId}/0`, encodeFrame({
      type: FRAME_TYPES.PONG, payload: ping.payload,
    }));
    const uploadRes = mockResponse();
    assert.equal(handler.handleRequest(uploadReq, uploadRes), true);
    uploadReq.emitBody();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(session.lastPingPayload, null);
    assert.equal(session.pingAttempts, 0);
    assert.equal(session.pongProbeTimer, null);
    handler.closeAll();
  });

  it('treats a mismatched PONG as activity without clearing its nonce', async () => {
    const { handler } = createHandler({
      keepaliveMinMs: 100, keepaliveMaxMs: 100,
    });
    handler._pongProbeTimeoutMs = 40;
    const sessionId = await createSession(handler);
    const req = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}&clientId=client-a`);
    const res = mockResponse();
    assert.equal(handler.handleRequest(req, res), true);

    await new Promise(resolve => setTimeout(resolve, 110));
    const session = handler._sessions.get(sessionId);
    const outstandingNonce = Buffer.from(session.lastPingPayload);
    const beforePong = Date.now();
    const uploadReq = mockRequest('POST', `/xhttp/upload/${sessionId}/0`, encodeFrame({
      type: FRAME_TYPES.PONG, payload: Buffer.from('late-pong'),
    }));
    const uploadRes = mockResponse();
    assert.equal(handler.handleRequest(uploadReq, uploadRes), true);
    uploadReq.emitBody();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.ok(session.lastActivityAt >= beforePong);
    assert.equal(session.pingAttempts, 0);
    assert.equal(session.pongProbeTimer, null);
    assert.deepEqual(session.lastPingPayload, outstandingNonce);
    handler.closeAll();
  });

  it('clears the PONG probe when the SSE stream closes', async () => {
    const { handler } = createHandler({
      keepaliveMinMs: 5, keepaliveMaxMs: 5,
    });
    handler._pongProbeTimeoutMs = 100;
    const sessionId = await createSession(handler);
    const req = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}&clientId=client-a`);
    const res = mockResponse();
    assert.equal(handler.handleRequest(req, res), true);

    await new Promise(resolve => setTimeout(resolve, 15));
    const session = handler._sessions.get(sessionId);
    assert.equal(session.pingAttempts, 1);
    const pingCount = sseFrames(res).filter(frame => frame.type === FRAME_TYPES.PING).length;

    res.emit('close');
    assert.equal(session.pongProbeTimer, null);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(sseFrames(res).filter(frame => frame.type === FRAME_TYPES.PING).length, pingCount);
    handler.closeAll();
  });

  it('clears the PONG probe when the session closes', async () => {
    const { handler, events } = createHandler({
      keepaliveMinMs: 5, keepaliveMaxMs: 5,
    });
    handler._pongProbeTimeoutMs = 100;
    const sessionId = await createSession(handler);
    const req = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}&clientId=client-a`);
    const res = mockResponse();
    assert.equal(handler.handleRequest(req, res), true);

    await new Promise(resolve => setTimeout(resolve, 15));
    const session = handler._sessions.get(sessionId);
    assert.equal(session.pingAttempts, 1);
    const pingCount = sseFrames(res).filter(frame => frame.type === FRAME_TYPES.PING).length;

    handler._closeSession(sessionId);
    assert.equal(session.pongProbeTimer, null);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(sseFrames(res).filter(frame => frame.type === FRAME_TYPES.PING).length, pingCount);
    assert.equal(events.filter(event => event.type === 'closed' && event.sessionId === sessionId).length, 1);
    handler.closeAll();
  });

  it('sends a PING keepalive and keeps a session alive after matching PONG', async () => {
    const { handler } = createHandler({
      keepaliveMinMs: 20, keepaliveMaxMs: 20, livenessTimeoutMs: 70, livenessSweepMs: 10,
    });
    const sessionId = await createSession(handler);
    const req = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}&clientId=client-a`);
    const res = mockResponse();
    assert.equal(handler.handleRequest(req, res), true);

    await new Promise(resolve => setTimeout(resolve, 30));
    const ping = sseFrames(res).find(frame => frame.type === FRAME_TYPES.PING);
    assert.ok(ping);

    const upReq = mockRequest('POST', `/xhttp/upload/${sessionId}/0`, encodeFrame({
      type: FRAME_TYPES.PONG, payload: ping.payload,
    }));
    const upRes = mockResponse();
    assert.equal(handler.handleRequest(upReq, upRes), true);
    upReq.emitBody();

    await new Promise(resolve => setTimeout(resolve, 45));
    assert.equal(handler._sessions.has(sessionId), true);
    handler.closeAll();
  });

  it('closes an SSE session that does not answer PING within the liveness timeout', async () => {
    const { handler, events } = createHandler({
      keepaliveMinMs: 20, keepaliveMaxMs: 20, livenessTimeoutMs: 50, livenessSweepMs: 10,
    });
    const sessionId = await createSession(handler);
    const req = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}&clientId=client-a`);
    const res = mockResponse();
    assert.equal(handler.handleRequest(req, res), true);

    await new Promise(resolve => setTimeout(resolve, 90));
    assert.equal(handler._sessions.has(sessionId), false);
    assert.ok(events.some(event => event.type === 'closed' && event.sessionId === sessionId));
    handler.closeAll();
  });

  it('allows a new session to take over a stale session', async () => {
    const { handler, events } = createHandler({
      takeoverGraceMs: 30, livenessTimeoutMs: 60_000, livenessSweepMs: 60_000,
    });
    const oldSessionId = await createSession(handler, [], 'client-a');
    const req = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${oldSessionId}&clientId=client-a`);
    const res = mockResponse();
    assert.equal(handler.handleRequest(req, res), true);
    await new Promise(resolve => setTimeout(resolve, 45));

    const newSessionId = await createSession(handler, [], 'client-b');
    assert.notEqual(newSessionId, oldSessionId);
    assert.equal(handler._sessions.has(oldSessionId), false);
    assert.ok(events.some(event => event.type === 'closed' && event.sessionId === oldSessionId));
    handler.closeAll();
  });

  it('allows the same client id to take over its own zombie session waiting for SSE', async () => {
    const { handler, events } = createHandler();
    const oldSessionId = await createSession(handler, [], 'client-a');

    const newSessionId = await createSession(handler, [], 'client-a');

    assert.notEqual(newSessionId, oldSessionId);
    assert.equal(handler._sessions.has(oldSessionId), false);
    assert.equal(handler._sessions.has(newSessionId), true);
    assert.ok(events.some(event => event.type === 'closed' && event.sessionId === oldSessionId));
    handler.closeAll();
  });

  it('keeps the same client id session coexisting as draining when a new session is created', async () => {
    const { handler } = createHandler();
    const oldSessionId = await createSession(handler, [], 'client-a');
    const oldStreamReq = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${oldSessionId}&clientId=client-a`);
    const oldStreamRes = mockResponse();
    assert.equal(handler.handleRequest(oldStreamReq, oldStreamRes), true);
    assert.equal(handler.getActiveSessionId(), oldSessionId);

    const newSessionId = await createSession(handler, [], 'client-a');
    const newStreamReq = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${newSessionId}&clientId=client-a`);
    const newStreamRes = mockResponse();
    assert.equal(handler.handleRequest(newStreamReq, newStreamRes), true);

    assert.notEqual(newSessionId, oldSessionId);
    assert.equal(handler._sessions.has(oldSessionId), true);
    assert.equal(handler._sessions.has(newSessionId), true);
    assert.equal(handler.getActiveSessionId(), newSessionId);
    assert.deepEqual(handler.getConnectionCounts(), {
      active: 1,
      candidate: 0,
      draining: 1,
      total: 2,
    });
    handler.closeAll();
  });

  it('honors response padding probability and size options', () => {
    const { handler: disabled } = createHandler({
      paddingEnabled: true,
      paddingProbability: 0,
    });
    assert.deepEqual(disabled._buildPaddingHeaders(), {});

    const { handler: enabled } = createHandler({
      paddingEnabled: true,
      paddingProbability: 1,
      paddingMinBytes: 16,
      paddingMaxBytes: 16,
    });
    const headers = enabled._buildPaddingHeaders();
    assert.ok(headers['x-padding']);
    assert.equal(Buffer.from(headers['x-padding'], 'base64').length, 16);
  });
});
