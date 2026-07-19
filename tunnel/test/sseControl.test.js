const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const SseControlHandler = require('../sseControl');

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

function mockRequest(method, path) {
  const req = new EventEmitter();
  req.method = method;
  req.url = path;
  return req;
}

describe('SseControlHandler migration adapter', () => {
  it('returns 410 for the legacy SSE control endpoint', () => {
    const handler = new SseControlHandler();
    const res = mockResponse();

    assert.equal(handler.handleRequest(mockRequest('GET', '/api/v1/events?token=abc'), res), true);

    assert.equal(res.statusCode, 410);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(res.writes.join('')), { error: 'migrated to xhttp', mode: 'xhttp' });
  });

  it('delegates xhttp paths to the bound xhttp handler', () => {
    const handler = new SseControlHandler();
    let delegated = false;
    handler.setXhttpHandler({
      handleRequest(req, res) {
        delegated = true;
        res.writeHead(204, {});
        res.end();
        return true;
      },
    });
    const res = mockResponse();

    assert.equal(handler.handleRequest(mockRequest('GET', '/xhttp/stream'), res), true);

    assert.equal(delegated, true);
    assert.equal(res.statusCode, 204);
  });

});
