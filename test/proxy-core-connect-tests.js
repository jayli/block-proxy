'use strict';

const assert = require('assert');
const constants = require('constants');
const http = require('http');
const { Duplex, PassThrough } = require('stream');
const HttpsServerMgr = require('../proxy/proxy-core/https-server-mgr');
const ProxyServer = require('../proxy/proxy-core/proxy-server');
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

function testHttpsServerSecureOptionsDisableSslv3AndTlsv1() {
  assert.strictEqual(
    HttpsServerMgr._test.getSecureOptions(),
    constants.SSL_OP_NO_SSLv3 | constants.SSL_OP_NO_TLSv1
  );
}

function testWsReqInfoRejectsMissingHostHeader() {
  assert.throws(
    () => RequestHandler._test.getWsReqInfo({ headers: {}, url: '/chat' }),
    /missing Host header/i
  );
}

async function testFetchRemoteResponseHonorsTimeout() {
  const sockets = new Set();
  const server = http.createServer(() => {});
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const requestPromise = RequestHandler._test.fetchRemoteResponse('http', {
      hostname: '127.0.0.1',
      port,
      path: '/',
      method: 'GET',
      headers: {},
    }, '', {
      chunkSizeThreshold: 1024,
      timeout: 50,
    });

    const result = await Promise.race([
      requestPromise.then(
        () => ({ type: 'resolved' }),
        error => ({ type: 'rejected', error })
      ),
      new Promise(resolve => setTimeout(() => resolve({ type: 'timeout' }), 300))
    ]);

    assert.strictEqual(result.type, 'rejected');
    assert.strictEqual(result.error.code, 'ETIMEDOUT');
  } finally {
    sockets.forEach(socket => socket.destroy());
    await new Promise(resolve => server.close(resolve));
  }
}

function testRequestHandlerStoresTimeoutConfig() {
  const handler = new RequestHandler({
    httpServerPort: 18888,
    wsIntercept: false,
    forceProxyHttps: false,
    dangerouslyIgnoreUnauthorized: false,
    timeout: 1234,
  }, {});

  assert.strictEqual(handler.timeout, 1234);
}

function testProxyServerPassesTimeoutToRequestHandler() {
  const proxy = new ProxyServer({
    port: 18889,
    timeout: 4321,
    rule: {},
  });

  assert.strictEqual(proxy.requestHandler.timeout, 4321);
}

async function run() {
  testHttpsServerSecureOptionsDisableSslv3AndTlsv1();
  console.log('PASS testHttpsServerSecureOptionsDisableSslv3AndTlsv1');
  testWsReqInfoRejectsMissingHostHeader();
  console.log('PASS testWsReqInfoRejectsMissingHostHeader');
  await testFetchRemoteResponseHonorsTimeout();
  console.log('PASS testFetchRemoteResponseHonorsTimeout');
  testRequestHandlerStoresTimeoutConfig();
  console.log('PASS testRequestHandlerStoresTimeoutConfig');
  testProxyServerPassesTimeoutToRequestHandler();
  console.log('PASS testProxyServerPassesTimeoutToRequestHandler');
  await testConnectHeadWebSocketUsesLocalProxy();
  console.log('PASS testConnectHeadWebSocketUsesLocalProxy');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
