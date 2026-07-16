const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('crypto');
const SseControlHandler = require('../sseControl');

function tokenFor(username = 'admin', password = 'secret') {
  return crypto.createHash('sha256').update(`${username}:${password}`).digest('hex');
}

function mockResponse() {
  const writes = [];
  return {
    statusCode: null,
    headers: null,
    writes,
    ended: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
    end(chunk = '') {
      if (chunk) writes.push(String(chunk));
      this.ended = true;
    },
  };
}

function mockRequest(path) {
  const req = new EventEmitter();
  req.url = path;
  req.method = 'GET';
  return req;
}

describe('SseControlHandler', () => {
  it('opens text/event-stream and registers authenticated sleeping client', () => {
    let authenticatedToken = null;
    const handler = new SseControlHandler({
      keepaliveMinMs: 60_000,
      keepaliveMaxMs: 60_000,
      onAuthenticated: (token) => { authenticatedToken = token; },
    });
    handler.setCredentials({ username: 'admin', password: 'secret' });

    const token = tokenFor();
    const res = mockResponse();
    assert.equal(handler.handleRequest(mockRequest(`/api/v1/events?token=${token}`), res), true);

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    assert.equal(res.writes[0], 'retry: 5000\n\n');
    assert.equal(authenticatedToken, token);
    assert.equal(handler.hasActiveConnection(token), true);
  });

  it('returns 401 for invalid token', () => {
    const handler = new SseControlHandler();
    handler.setCredentials({ username: 'admin', password: 'secret' });
    const res = mockResponse();

    assert.equal(handler.handleRequest(mockRequest('/api/v1/events?token=bad'), res), true);

    assert.equal(res.statusCode, 401);
    assert.equal(handler.hasActiveConnection('bad'), false);
  });

  it('closes existing connection before marking new connection authenticated', () => {
    const events = [];
    const handler = new SseControlHandler({
      keepaliveMinMs: 60_000,
      keepaliveMaxMs: 60_000,
      onAuthenticated: () => events.push('auth'),
      onDisconnected: () => events.push('disconnect'),
    });
    handler.setCredentials({ username: 'admin', password: 'secret' });
    const token = tokenFor();

    const req1 = mockRequest(`/api/v1/events?token=${token}`);
    const res1 = mockResponse();
    handler.handleRequest(req1, res1);
    events.length = 0;

    const req2 = mockRequest(`/api/v1/events?token=${token}`);
    const res2 = mockResponse();
    handler.handleRequest(req2, res2);
    req1.emit('close');

    assert.equal(res1.ended, true);
    assert.deepEqual(events, ['auth']);
    assert.equal(handler.hasActiveConnection(token), true);
  });

  it('sends wake event without closing SSE connection', () => {
    const handler = new SseControlHandler({ keepaliveMinMs: 60_000, keepaliveMaxMs: 60_000 });
    handler.setCredentials({ username: 'admin', password: 'secret' });
    const token = tokenFor();
    const res = mockResponse();
    handler.handleRequest(mockRequest(`/api/v1/events?token=${token}`), res);

    assert.equal(handler.sendWakeSignal(token), true);

    assert.equal(res.writes.at(-1), 'event: wake\ndata: {}\n\n');
    assert.equal(res.ended, false);
  });
});
