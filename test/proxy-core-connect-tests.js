'use strict';

const assert = require('assert');
const { Duplex, PassThrough } = require('stream');
const RequestHandler = require('../proxy/proxy-core/request-handler');

class FakeClientSocket extends Duplex {
  constructor() {
    super();
    this.clientWrites = [];
  }

  _read() {}

  _write(chunk, encoding, callback) {
    this.clientWrites.push(Buffer.from(chunk));
    callback();
  }
}

function waitFor(predicate, timeoutMs = 500) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function tick() {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('timed out waiting for condition'));
        return;
      }
      setTimeout(tick, 10);
    }
    tick();
  });
}

async function testConnectHeadWebSocketUsesLocalProxy() {
  const connectTargets = [];
  const handler = new RequestHandler({
    httpServerPort: 18888,
    wsIntercept: true,
    forceProxyHttps: false,
    dangerouslyIgnoreUnauthorized: false,
    customConnect(host, port, callback) {
      connectTargets.push({ host, port });
      const stream = new PassThrough();
      process.nextTick(callback);
      return stream;
    },
  }, {
    *beforeDealHttpsRequest() {
      return null;
    },
  });

  const req = {
    url: 'example.com:443',
    httpVersion: '1.1',
    method: 'CONNECT',
  };
  const socket = new FakeClientSocket();
  const head = Buffer.from('GET /chat HTTP/1.1\r\nHost: example.com\r\n\r\n');

  handler.connectReqHandler(req, socket, head);

  await waitFor(() => connectTargets.length > 0);
  assert.deepEqual(connectTargets[0], {
    host: 'localhost',
    port: 18888,
  });
}

async function run() {
  await testConnectHeadWebSocketUsesLocalProxy();
  console.log('PASS testConnectHeadWebSocketUsesLocalProxy');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
