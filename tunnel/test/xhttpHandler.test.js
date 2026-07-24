const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('crypto');
const XhttpHandler = require('../xhttpHandler');
const { FRAME_TYPES, encodeFrame, decodeFrame } = require('../protocol');

function tokenFor(username = 'admin', password = 'secret') {
  return crypto.createHash('sha256').update(`${username}:${password}`).digest('hex');
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

async function createSession(handler, capabilities = []) {
  const req = mockRequest('POST', '/xhttp/create', encodeFrame({
    type: FRAME_TYPES.AUTH,
    username: 'admin',
    password: 'secret',
    capabilities,
  }));
  const res = mockResponse();
  assert.equal(handler.handleRequest(req, res), true);
  req.emitBody();
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.writes.join('')).sessionId;
}

describe('XhttpHandler session model', () => {
  it('does not negotiate silent_mode from AUTH capabilities', async () => {
    const { handler, events } = createHandler();

    const sessionId = await createSession(handler, ['silent_mode']);

    const created = events.find(event => event.type === 'created');
    assert.equal(created.sessionId, sessionId);
    assert.deepEqual(created.info.capabilities, []);
    assert.equal(Object.hasOwn(created.info, 'silentMode'), false);
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

  it('keeps older sessions alive when a new session is created for the same token', async () => {
    const { handler, events } = createHandler();
    const oldSessionId = await createSession(handler);
    const newSessionId = await createSession(handler);

    assert.notEqual(oldSessionId, newSessionId);
    assert.equal(handler._sessions.has(oldSessionId), true);
    assert.equal(handler._sessions.has(newSessionId), true);

    const oldUploadReq = mockRequest('POST', `/xhttp/upload/${oldSessionId}/0`, encodeFrame({
      type: FRAME_TYPES.PING,
      payload: Buffer.from('old'),
    }));
    const oldUploadRes = mockResponse();
    assert.equal(handler.handleRequest(oldUploadReq, oldUploadRes), true);
    oldUploadReq.emitBody();
    assert.equal(oldUploadRes.statusCode, 200);

    await new Promise(resolve => setImmediate(resolve));
    assert.ok(events.some(event =>
      event.type === 'frame' &&
      event.sessionId === oldSessionId &&
      event.frame.payload.toString('utf8') === 'old'
    ));
    assert.equal(events.some(event => event.type === 'closed' && event.sessionId === oldSessionId), false);
    handler.closeAll();
  });

  it('rejects a new session for the same token while an SSE stream is active', async () => {
    const { handler } = createHandler();
    const sessionId = await createSession(handler);

    const streamReq = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}`);
    const streamRes = mockResponse();
    assert.equal(handler.handleRequest(streamReq, streamRes), true);
    assert.equal(streamRes.statusCode, 200);

    const createReq = mockRequest('POST', '/xhttp/create', encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret',
      capabilities: [],
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

    const req = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}`);
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

    const req = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}`);
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
    const { handler } = createHandler();
    const oldSessionId = await createSession(handler);

    const oldReq = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${oldSessionId}`);
    const oldRes = mockResponse();
    assert.equal(handler.handleRequest(oldReq, oldRes), true);
    assert.equal(handler.getActiveSessionId(), oldSessionId);

    const duplicateCreateReq = mockRequest('POST', '/xhttp/create', encodeFrame({
      type: FRAME_TYPES.AUTH,
      username: 'admin',
      password: 'secret',
      capabilities: [],
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

    const newSessionId = await createSession(handler);
    const newReq = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${newSessionId}`);
    const newRes = mockResponse();
    assert.equal(handler.handleRequest(newReq, newRes), true);

    assert.equal(handler.getActiveSessionId(), newSessionId);
    assert.deepEqual(handler.getConnectionCounts(), {
      active: 1,
      candidate: 0,
      draining: 0,
      total: 2,
    });
    assert.equal(handler._sessions.has(newSessionId), true);
    handler.closeAll();
  });

  it('schedules keepalive from the last SSE write instead of fixed stream-open time', async () => {
    const { handler } = createHandler({
      keepaliveMinMs: 40,
      keepaliveMaxMs: 40,
    });
    const sessionId = await createSession(handler);

    const req = mockRequest('GET', `/xhttp/stream?token=${tokenFor()}&sessionId=${sessionId}`);
    const res = mockResponse();
    assert.equal(handler.handleRequest(req, res), true);

    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(handler.pushFrame(sessionId, encodeFrame({ type: FRAME_TYPES.PONG, payload: Buffer.from('ok') })), true);

    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(res.writes.some(chunk => chunk === ': keepalive\n\n'), false);

    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(res.writes.some(chunk => chunk === ': keepalive\n\n'), true);
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
