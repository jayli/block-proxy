'use strict';

const assert = require('assert');
const constants = require('constants');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const tls = require('tls');
const { Duplex, PassThrough } = require('stream');
const HttpsServerMgr = require('../proxy/proxy-core/https-server-mgr');
const ProxyServer = require('../proxy/proxy-core/proxy-server');
const RequestHandler = require('../proxy/proxy-core/request-handler');
const util = require('../proxy/proxy-core/util');
const LocalProxy = require('../proxy/proxy');

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

class HalfOpenUpstream extends Duplex {
  constructor() {
    super({ allowHalfOpen: true, autoDestroy: false });
    this.received = [];
  }

  _read() {}

  _write(chunk, encoding, callback) {
    this.received.push(Buffer.from(chunk));
    callback();
  }
}

class TrackingHttpAgent extends http.Agent {
  constructor() {
    super({ keepAlive: false });
    this.createConnectionCalls = 0;
  }

  createConnection(options, callback) {
    this.createConnectionCalls += 1;
    return super.createConnection(options, callback);
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

async function testConnectHandlerSupportsAsyncCustomConnect() {
  const connectTargets = [];
  const handler = new RequestHandler({
    httpServerPort: 18888,
    wsIntercept: true,
    forceProxyHttps: false,
    dangerouslyIgnoreUnauthorized: false,
    customConnect(host, port, callback) {
      connectTargets.push({ host, port });
      return new Promise((resolve) => {
        const stream = new PassThrough();
        process.nextTick(() => {
          callback();
          resolve(stream);
        });
      });
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
  await waitFor(() => socket.clientWrites.length > 0);
  assert.deepEqual(connectTargets[0], {
    host: 'localhost',
    port: 18888,
  });
  assert.match(Buffer.concat(socket.clientWrites).toString('utf8'), /^HTTP\/1\.1 200 /);
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

async function testTunnelConnectWaitsForCustomConnectReadyBefore200() {
  let readyCallback;
  const connectTargets = [];
  const handler = new RequestHandler({
    httpServerPort: 18888,
    wsIntercept: true,
    forceProxyHttps: false,
    dangerouslyIgnoreUnauthorized: false,
    isTunnelDomain(host) {
      return host === 'example.com';
    },
    customConnect(host, port, callback) {
      connectTargets.push({ host, port });
      readyCallback = callback;
      return new PassThrough();
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

  handler.connectReqHandler(req, socket, Buffer.alloc(0));

  await waitFor(() => connectTargets.length > 0);
  assert.deepEqual(connectTargets[0], {
    host: 'example.com',
    port: '443',
  });
  assert.strictEqual(socket.clientWrites.length, 0);

  readyCallback();

  await waitFor(() => socket.clientWrites.length > 0);
  assert.match(Buffer.concat(socket.clientWrites).toString('utf8'), /^HTTP\/1\.1 200 OK\r\nX-Tunnel-Relay: 1\r\n\r\n/);
}

async function testTunnelConnectFailureHandlesClientResetAfter502() {
  const handler = new RequestHandler({
    httpServerPort: 18888,
    wsIntercept: true,
    forceProxyHttps: false,
    dangerouslyIgnoreUnauthorized: false,
    isTunnelDomain(host) {
      return host === 'example.com';
    },
    customConnect() {
      throw new Error('tunnel-disconnected');
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

  handler.connectReqHandler(req, socket, Buffer.alloc(0));

  await waitFor(() => socket.clientWrites.length > 0);
  assert.match(Buffer.concat(socket.clientWrites).toString('utf8'), /^HTTP\/1\.1 502\r\n/);
  assert.doesNotThrow(() => {
    const err = new Error('read ECONNRESET');
    err.code = 'ECONNRESET';
    socket.emit('error', err);
  });
}

async function testTunnelConnectPipesClientDataAfterReady() {
  let readyCallback;
  const tunnelStream = new PassThrough();
  const received = [];
  tunnelStream.on('data', chunk => received.push(Buffer.from(chunk)));

  const handler = new RequestHandler({
    httpServerPort: 18888,
    wsIntercept: true,
    forceProxyHttps: false,
    dangerouslyIgnoreUnauthorized: false,
    isTunnelDomain(host) {
      return host === 'example.com';
    },
    customConnect(host, port, callback) {
      readyCallback = callback;
      return tunnelStream;
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

  handler.connectReqHandler(req, socket, Buffer.alloc(0));
  await waitFor(() => typeof readyCallback === 'function');
  readyCallback();
  await waitFor(() => socket.clientWrites.length > 0);

  socket.emit('data', Buffer.from('clienthello'));

  await waitFor(() => received.length > 0);
  assert.equal(Buffer.concat(received).toString('utf8'), 'clienthello');
}

async function testConnectDestroysUpstreamWhenClientSocketCloses() {
  let readyCallback;
  const upstream = new PassThrough();
  const handler = new RequestHandler({
    httpServerPort: 18888,
    wsIntercept: false,
    forceProxyHttps: false,
    dangerouslyIgnoreUnauthorized: false,
    customConnect(host, port, callback) {
      readyCallback = callback;
      return upstream;
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

  handler.connectReqHandler(req, socket, Buffer.from('clienthello'));
  await waitFor(() => typeof readyCallback === 'function');
  readyCallback();
  await waitFor(() => socket.clientWrites.length > 0);

  socket.destroy();

  await waitFor(() => upstream.destroyed);
  assert.strictEqual(upstream.destroyed, true);
}

async function testConnectKeepsUpstreamOpenAfterClientHalfClose() {
  let readyCallback;
  const upstream = new HalfOpenUpstream();
  const handler = new RequestHandler({
    httpServerPort: 18888,
    wsIntercept: false,
    forceProxyHttps: false,
    dangerouslyIgnoreUnauthorized: false,
    customConnect(host, port, callback) {
      readyCallback = callback;
      return upstream;
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

  handler.connectReqHandler(req, socket, Buffer.from('clienthello'));
  await waitFor(() => typeof readyCallback === 'function');
  readyCallback();
  await waitFor(() => socket.clientWrites.length > 0);

  socket.emit('end');
  await waitFor(() => upstream.writableEnded);
  assert.strictEqual(upstream.destroyed, false);

  upstream.push(Buffer.from('server-response'));
  await waitFor(() => Buffer.concat(socket.clientWrites).includes(Buffer.from('server-response')));
  upstream.destroy();
  socket.destroy();
}

async function testConnectDestroysLateAsyncUpstreamAfterClientCloses() {
  let resolveConnection;
  const upstream = new PassThrough();
  const handler = new RequestHandler({
    httpServerPort: 18888,
    wsIntercept: false,
    forceProxyHttps: false,
    dangerouslyIgnoreUnauthorized: false,
    customConnect(host, port, callback) {
      return new Promise(resolve => {
        resolveConnection = () => {
          callback();
          resolve(upstream);
        };
      });
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

  handler.connectReqHandler(req, socket, Buffer.from('clienthello'));
  await waitFor(() => typeof resolveConnection === 'function');
  socket.destroy();
  resolveConnection();

  await waitFor(() => upstream.destroyed);
  assert.strictEqual(upstream.destroyed, true);
}

async function testConnectDestroysClientSocketWhenUpstreamCloses() {
  let readyCallback;
  const upstream = new HalfOpenUpstream();
  const handler = new RequestHandler({
    httpServerPort: 18888,
    wsIntercept: false,
    forceProxyHttps: false,
    dangerouslyIgnoreUnauthorized: false,
    customConnect(host, port, callback) {
      readyCallback = callback;
      return upstream;
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

  handler.connectReqHandler(req, socket, Buffer.from('clienthello'));
  await waitFor(() => typeof readyCallback === 'function');
  readyCallback();
  await waitFor(() => socket.clientWrites.length > 0);

  // 目标端先关闭：先收到 FIN（readable EOF），随后连接彻底关闭。
  // 此时必须销毁 client socket，否则半关闭 socket 会滞留并泄漏 fd。
  upstream.push(null);
  await waitFor(() => upstream.readableEnded);
  upstream.destroy();
  await waitFor(() => upstream.destroyed);

  await waitFor(() => socket.destroyed);
  assert.strictEqual(socket.destroyed, true);
}

async function testConnectDrainsClientAfterUpstreamFinWithoutClose() {
  let readyCallback;
  const upstream = new HalfOpenUpstream();
  const handler = new RequestHandler({
    httpServerPort: 18888,
    wsIntercept: false,
    forceProxyHttps: false,
    dangerouslyIgnoreUnauthorized: false,
    halfCloseDrainIdleTimeoutMs: 40,
    halfCloseDrainMaxTimeoutMs: 120,
    customConnect(host, port, callback) {
      readyCallback = callback;
      return upstream;
    },
  }, {
    *beforeDealHttpsRequest() { return null; },
    *onConnectError() {},
    *onClientSocketError() {},
  });
  const req = { url: 'example.com:443', httpVersion: '1.1', method: 'CONNECT' };
  const socket = new FakeClientSocket({ allowHalfOpen: true, autoDestroy: false });

  handler.connectReqHandler(req, socket, Buffer.from('clienthello'));
  await waitFor(() => typeof readyCallback === 'function');
  readyCallback();
  await waitFor(() => socket.clientWrites.length > 0);

  upstream.push(null);
  await waitFor(() => upstream.readableEnded);
  await waitFor(() => socket.destroyed, 500);
}

async function testConnectDestroysClientSocketWhenClientEndsWithoutData() {
  const connectTargets = [];
  let connectErrorCalls = 0;
  const handler = new RequestHandler({
    httpServerPort: 18888,
    wsIntercept: false,
    forceProxyHttps: false,
    dangerouslyIgnoreUnauthorized: false,
    customConnect(host, port, callback) {
      connectTargets.push({ host, port });
      return new PassThrough();
    },
  }, {
    *beforeDealHttpsRequest() { return null; },
    *onConnectError() { connectErrorCalls += 1; },
    *onClientSocketError() {},
  });
  const req = { url: 'example.com:443', httpVersion: '1.1', method: 'CONNECT' };
  const socket = new FakeClientSocket();

  handler.connectReqHandler(req, socket, Buffer.alloc(0));

  await waitFor(() => socket.clientWrites.length > 0);
  socket.emit('end');

  await waitFor(() => socket.destroyed, 500);
  assert.strictEqual(socket.destroyed, true);
  assert.strictEqual(connectTargets.length, 0);
  assert.strictEqual(connectErrorCalls, 0);
}

async function testConnectClosesServerSocketWhenClientFinWithoutData() {
  const proxyPort = await util.getFreePort();
  const proxy = new ProxyServer({
    port: proxyPort,
    dangerouslyIgnoreUnauthorized: true,
    rule: {
      *beforeDealHttpsRequest() {
        return false;
      },
    },
  });

  let socket;
  try {
    await new Promise((resolve, reject) => {
      proxy.once('ready', resolve);
      proxy.once('error', reject);
      proxy.start();
    });

    socket = net.connect(proxyPort, '127.0.0.1');
    const closedPromise = new Promise(resolve => socket.once('close', () => resolve(true)));
    await new Promise(resolve => socket.once('connect', resolve));
    socket.write('CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n');
    await new Promise((resolve) => {
      socket.on('data', function onData(chunk) {
        if (chunk.toString().includes('200')) {
          socket.removeListener('data', onData);
          socket.end();
          resolve();
        }
      });
    });

    const closed = await Promise.race([
      closedPromise,
      new Promise(resolve => setTimeout(() => resolve(false), 2000)),
    ]);

    assert.strictEqual(closed, true, 'server must close CONNECT socket when client FINs without sending data');
  } finally {
    if (socket && !socket.destroyed) socket.destroy();
    await proxy.close();
  }
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

async function testFetchRemoteResponseUsesProvidedAgent() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Content-Length': '2',
    });
    res.end('ok');
  });
  const agent = new TrackingHttpAgent();

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const response = await RequestHandler._test.fetchRemoteResponse('http', {
      hostname: '127.0.0.1',
      port,
      path: '/',
      method: 'GET',
      headers: {},
      agent,
    }, '', {
      chunkSizeThreshold: 1024,
      timeout: 1000,
    });

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.toString('utf8'), 'ok');
    assert.strictEqual(agent.createConnectionCalls, 1);
  } finally {
    agent.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

async function testChainProxyConnectFailureDoesNotFallbackDirect() {
  const unusedPort = await util.getFreePort();
  LocalProxy._test.setChainProxyConfigForTest({
    enabled: '1',
    type: 'http',
    address: `127.0.0.1:${unusedPort}`,
  });

  try {
    const options = LocalProxy._test.getAnyProxyOptions();
    await assert.rejects(
      options.customConnect('example.test', 443, () => {}),
      /ECONNREFUSED|Chain proxy/i
    );
  } finally {
    LocalProxy._test.setChainProxyConfigForTest({
      enabled: '0',
      type: 'http',
      address: '',
    });
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

function testRequestHandlerStoresHalfCloseDrainConfig() {
  const defaults = new RequestHandler({ httpServerPort: 18888 }, {});
  assert.strictEqual(defaults.halfCloseDrainIdleTimeoutMs, 30_000);
  assert.strictEqual(defaults.halfCloseDrainMaxTimeoutMs, 300_000);

  const configured = new RequestHandler({
    httpServerPort: 18888,
    halfCloseDrainIdleTimeoutMs: 123,
    halfCloseDrainMaxTimeoutMs: 456,
  }, {});
  assert.strictEqual(configured.halfCloseDrainIdleTimeoutMs, 123);
  assert.strictEqual(configured.halfCloseDrainMaxTimeoutMs, 456);
}

function testProxyServerPassesTimeoutToRequestHandler() {
  const proxy = new ProxyServer({
    port: 18889,
    timeout: 4321,
    rule: {},
  });

  assert.strictEqual(proxy.requestHandler.timeout, 4321);
}

function testChainProxyAddressParserValidatesInput() {
  const parsed = LocalProxy._test.parseChainProxyAddress('user:pass@example.test:1080');

  assert.deepStrictEqual(parsed, {
    username: 'user',
    password: 'pass',
    host: 'example.test',
    port: 1080,
  });
  assert.strictEqual(LocalProxy._test.parseChainProxyAddress('example.test'), null);
  assert.strictEqual(LocalProxy._test.parseChainProxyAddress('example.test:not-a-port'), null);
  assert.strictEqual(LocalProxy._test.parseChainProxyAddress('example.test:70000'), null);
}

function testChainProxyAgentCacheReusesAgents() {
  LocalProxy._test.clearChainProxyAgentCache();

  const config = {
    type: 'http',
    username: 'user',
    password: 'pass',
    host: 'example.test',
    port: 8080,
  };
  const first = LocalProxy._test.getChainProxyAgent(false, config);
  const second = LocalProxy._test.getChainProxyAgent(false, config);
  const third = LocalProxy._test.getChainProxyAgent(true, config);

  assert.strictEqual(first, second);
  assert.notStrictEqual(first, third);
  LocalProxy._test.clearChainProxyAgentCache();
}

function testSocks5ConnectResponseLengthParser() {
  assert.strictEqual(
    LocalProxy._test.getSocks5ConnectResponseLength(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x01, 0xbb])),
    10
  );
  assert.strictEqual(
    LocalProxy._test.getSocks5ConnectResponseLength(Buffer.from([0x05, 0x00, 0x00, 0x03, 4, 0x74, 0x65])),
    null
  );
  assert.strictEqual(
    LocalProxy._test.getSocks5ConnectResponseLength(Buffer.from([0x05, 0x00, 0x00, 0x03, 4, 0x74, 0x65, 0x73, 0x74, 0x01, 0xbb])),
    11
  );
  assert.strictEqual(
    LocalProxy._test.getSocks5ConnectResponseLength(Buffer.from([0x05, 0x00, 0x00, 0x04, ...Buffer.alloc(16), 0x01, 0xbb])),
    22
  );
  assert.strictEqual(
    LocalProxy._test.getSocks5ConnectResponseLength(Buffer.from([0x05, 0x00, 0x00, 0x09, 0, 0])),
    -1
  );
}

function testEnsureRootCAReplacesMismatchedCache() {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'block-proxy-ca-'));
  const certDir = path.join(tmpDir, 'certificates');
  const srcDir = path.join(tmpDir, 'src');
  fs.mkdirSync(certDir, { recursive: true });
  fs.mkdirSync(srcDir, { recursive: true });

  const srcCrt = path.join(srcDir, 'rootCA.crt');
  const srcKey = path.join(srcDir, 'rootCA.key');
  const targetCrt = path.join(certDir, 'rootCA.crt');
  const targetKey = path.join(certDir, 'rootCA.key');
  const staleDomainCrt = path.join(certDir, 'youtubei.googleapis.com.crt');
  const staleDomainKey = path.join(certDir, 'youtubei.googleapis.com.key');

  fs.copyFileSync(path.join(__dirname, '../cert/rootCA.crt'), srcCrt);
  fs.copyFileSync(path.join(__dirname, '../cert/rootCA.key'), srcKey);
  fs.writeFileSync(targetCrt, fs.readFileSync(path.join(__dirname, '../cert/socks5_tls.crt')));
  fs.writeFileSync(targetKey, fs.readFileSync(path.join(__dirname, '../cert/socks5_tls.key')));
  fs.writeFileSync(staleDomainCrt, 'stale cert');
  fs.writeFileSync(staleDomainKey, 'stale key');

  try {
    const result = LocalProxy._test.ensureRootCA({
      anyproxyDir: certDir,
      srcCrt,
      srcKey,
    });

    assert.strictEqual(result, 'replaced');
    assert.strictEqual(fs.readFileSync(targetCrt, 'utf8'), fs.readFileSync(srcCrt, 'utf8'));
    assert.strictEqual(fs.readFileSync(targetKey, 'utf8'), fs.readFileSync(srcKey, 'utf8'));
    assert.strictEqual(fs.existsSync(staleDomainCrt), false);
    assert.strictEqual(fs.existsSync(staleDomainKey), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testMitmConnectForwardsHttpsRequest() {
  const key = fs.readFileSync(path.join(__dirname, '../cert/rootCA.key'));
  const cert = fs.readFileSync(path.join(__dirname, '../cert/rootCA.crt'));
  const upstream = https.createServer({ key, cert }, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Content-Length': '4',
    });
    res.end('pong');
  });

  // Ensure certificates/ has rootCA for node-easy-cert (now project-local)
  const certDir = path.join(__dirname, '../certificates');
  fs.mkdirSync(certDir, { recursive: true });
  const needCleanup = !fs.existsSync(path.join(certDir, 'rootCA.crt'));
  if (needCleanup) {
    fs.copyFileSync(path.join(__dirname, '../cert/rootCA.crt'), path.join(certDir, 'rootCA.crt'));
    fs.copyFileSync(path.join(__dirname, '../cert/rootCA.key'), path.join(certDir, 'rootCA.key'));
  }
  // Re-init cert-lifecycle so it picks up the new certDir
  const certLifecycle = require('../proxy/proxy-core/cert-lifecycle');
  certLifecycle.init({ certDir, mitmRegistry: null });

  const proxyPort = await util.getFreePort();
  const proxy = new ProxyServer({
    port: proxyPort,
    dangerouslyIgnoreUnauthorized: true,
    rule: {
      *beforeDealHttpsRequest() {
        return true;
      },
      *beforeSendResponse() {
        return null;
      },
    },
  });

  try {
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = upstream.address().port;
    await new Promise((resolve, reject) => {
      proxy.once('ready', resolve);
      proxy.once('error', reject);
      proxy.start();
    });

    const connectReq = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: 'example.test:443',
    });

    const response = await new Promise((resolve, reject) => {
      connectReq.once('connect', (res, socket) => {
        assert.strictEqual(res.statusCode, 200);
        const tlsSocket = tls.connect({
          socket,
          servername: 'example.test',
          rejectUnauthorized: false,
        }, () => {
          tlsSocket.write([
            'GET /ping HTTP/1.1',
            `Host: 127.0.0.1:${upstreamPort}`,
            'Connection: close',
            '',
            '',
          ].join('\r\n'));
        });

        let data = '';
        tlsSocket.setEncoding('utf8');
        tlsSocket.on('data', chunk => {
          data += chunk;
        });
        tlsSocket.once('end', () => resolve(data));
        tlsSocket.once('error', reject);
      });
      connectReq.once('error', reject);
      connectReq.end();
    });

    assert.match(response, /^HTTP\/1\.1 200 OK/i);
    assert.match(response, /\r\n\r\npong$/);
  } finally {
    await proxy.close();
    await new Promise(resolve => upstream.close(resolve));
  }
}

function testStripAltSvcHeaderRemovesAllCases() {
  const { stripAltSvcHeader } = RequestHandler._test;

  // 标准大小写
  const h1 = { 'Alt-Svc': 'h3=":443"; ma=2592000', 'Content-Type': 'text/plain' };
  stripAltSvcHeader(h1);
  assert.strictEqual(h1['Alt-Svc'], undefined);
  assert.strictEqual(h1['Content-Type'], 'text/plain');

  // 全小写（Node http 响应头常见形式）
  const h2 = { 'alt-svc': 'h3=":443"', 'content-length': '0' };
  stripAltSvcHeader(h2);
  assert.strictEqual(h2['alt-svc'], undefined);
  assert.strictEqual(h2['content-length'], '0');

  // 全大写 / 混合大小写
  const h3 = { 'ALT-SVC': 'h3=":443"' };
  stripAltSvcHeader(h3);
  assert.strictEqual(Object.keys(h3).length, 0);

  // 不应误删其他以 alt 开头的头
  const h4 = { 'Alt-Used': 'example.com', 'Alt-Svc': 'h3=":443"' };
  stripAltSvcHeader(h4);
  assert.strictEqual(h4['Alt-Used'], 'example.com');
  assert.strictEqual(h4['Alt-Svc'], undefined);

  // 空/异常输入不抛错
  stripAltSvcHeader(null);
  stripAltSvcHeader(undefined);
  stripAltSvcHeader({});
}

async function testMitmStripsAltSvcFromUpstreamResponse() {
  const key = fs.readFileSync(path.join(__dirname, '../cert/rootCA.key'));
  const cert = fs.readFileSync(path.join(__dirname, '../cert/rootCA.crt'));
  // 上游源站在响应里携带 Alt-Svc（模拟真实站点宣告 h3 支持）
  const upstream = https.createServer({ key, cert }, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Content-Length': '4',
      'Alt-Svc': 'h3=":443"; ma=2592000,h3-29=":443"; ma=2592000',
    });
    res.end('pong');
  });

  const certDir = path.join(__dirname, '../certificates');
  fs.mkdirSync(certDir, { recursive: true });
  const needCleanup = !fs.existsSync(path.join(certDir, 'rootCA.crt'));
  if (needCleanup) {
    fs.copyFileSync(path.join(__dirname, '../cert/rootCA.crt'), path.join(certDir, 'rootCA.crt'));
    fs.copyFileSync(path.join(__dirname, '../cert/rootCA.key'), path.join(certDir, 'rootCA.key'));
  }
  const certLifecycle = require('../proxy/proxy-core/cert-lifecycle');
  certLifecycle.init({ certDir, mitmRegistry: null });

  const proxyPort = await util.getFreePort();
  const proxy = new ProxyServer({
    port: proxyPort,
    dangerouslyIgnoreUnauthorized: true,
    rule: {
      *beforeDealHttpsRequest() {
        return true;
      },
      *beforeSendResponse() {
        return null;
      },
    },
  });

  try {
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = upstream.address().port;
    await new Promise((resolve, reject) => {
      proxy.once('ready', resolve);
      proxy.once('error', reject);
      proxy.start();
    });

    const connectReq = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: 'example.test:443',
    });

    const response = await new Promise((resolve, reject) => {
      connectReq.once('connect', (res, socket) => {
        assert.strictEqual(res.statusCode, 200);
        const tlsSocket = tls.connect({
          socket,
          servername: 'example.test',
          rejectUnauthorized: false,
        }, () => {
          tlsSocket.write([
            'GET /ping HTTP/1.1',
            `Host: 127.0.0.1:${upstreamPort}`,
            'Connection: close',
            '',
            '',
          ].join('\r\n'));
        });

        let data = '';
        tlsSocket.setEncoding('utf8');
        tlsSocket.on('data', chunk => {
          data += chunk;
        });
        tlsSocket.once('end', () => resolve(data));
        tlsSocket.once('error', reject);
      });
      connectReq.once('error', reject);
      connectReq.end();
    });

    assert.match(response, /^HTTP\/1\.1 200 OK/i);
    assert.match(response, /\r\n\r\npong$/);
    // 关键断言：Alt-Svc 必须被剥离，否则客户端会学到 h3 入口绕过代理
    assert.ok(!/alt-svc/i.test(response), 'Alt-Svc header must be stripped from MITM responses');
  } finally {
    await proxy.close();
    await new Promise(resolve => upstream.close(resolve));
  }
}

async function run() {
  testHttpsServerSecureOptionsDisableSslv3AndTlsv1();
  console.log('PASS testHttpsServerSecureOptionsDisableSslv3AndTlsv1');
  testWsReqInfoRejectsMissingHostHeader();
  console.log('PASS testWsReqInfoRejectsMissingHostHeader');
  await testFetchRemoteResponseHonorsTimeout();
  console.log('PASS testFetchRemoteResponseHonorsTimeout');
  await testFetchRemoteResponseUsesProvidedAgent();
  console.log('PASS testFetchRemoteResponseUsesProvidedAgent');
  await testChainProxyConnectFailureDoesNotFallbackDirect();
  console.log('PASS testChainProxyConnectFailureDoesNotFallbackDirect');
  testRequestHandlerStoresTimeoutConfig();
  console.log('PASS testRequestHandlerStoresTimeoutConfig');
  testRequestHandlerStoresHalfCloseDrainConfig();
  console.log('PASS testRequestHandlerStoresHalfCloseDrainConfig');
  testProxyServerPassesTimeoutToRequestHandler();
  console.log('PASS testProxyServerPassesTimeoutToRequestHandler');
  testChainProxyAddressParserValidatesInput();
  console.log('PASS testChainProxyAddressParserValidatesInput');
  testChainProxyAgentCacheReusesAgents();
  console.log('PASS testChainProxyAgentCacheReusesAgents');
  testSocks5ConnectResponseLengthParser();
  console.log('PASS testSocks5ConnectResponseLengthParser');
  testEnsureRootCAReplacesMismatchedCache();
  console.log('PASS testEnsureRootCAReplacesMismatchedCache');
  await testConnectHeadWebSocketUsesLocalProxy();
  console.log('PASS testConnectHeadWebSocketUsesLocalProxy');
  await testConnectHandlerSupportsAsyncCustomConnect();
  console.log('PASS testConnectHandlerSupportsAsyncCustomConnect');
  await testTunnelConnectWaitsForCustomConnectReadyBefore200();
  console.log('PASS testTunnelConnectWaitsForCustomConnectReadyBefore200');
  await testTunnelConnectFailureHandlesClientResetAfter502();
  console.log('PASS testTunnelConnectFailureHandlesClientResetAfter502');
  await testTunnelConnectPipesClientDataAfterReady();
  console.log('PASS testTunnelConnectPipesClientDataAfterReady');
  await testConnectDestroysUpstreamWhenClientSocketCloses();
  console.log('PASS testConnectDestroysUpstreamWhenClientSocketCloses');
  await testConnectKeepsUpstreamOpenAfterClientHalfClose();
  console.log('PASS testConnectKeepsUpstreamOpenAfterClientHalfClose');
  await testConnectDestroysLateAsyncUpstreamAfterClientCloses();
  console.log('PASS testConnectDestroysLateAsyncUpstreamAfterClientCloses');
  await testConnectDestroysClientSocketWhenUpstreamCloses();
  console.log('PASS testConnectDestroysClientSocketWhenUpstreamCloses');
  await testConnectDrainsClientAfterUpstreamFinWithoutClose();
  console.log('PASS testConnectDrainsClientAfterUpstreamFinWithoutClose');
  await testConnectDestroysClientSocketWhenClientEndsWithoutData();
  console.log('PASS testConnectDestroysClientSocketWhenClientEndsWithoutData');
  await testConnectClosesServerSocketWhenClientFinWithoutData();
  console.log('PASS testConnectClosesServerSocketWhenClientFinWithoutData');
  await testMitmConnectForwardsHttpsRequest();
  console.log('PASS testMitmConnectForwardsHttpsRequest');
  testStripAltSvcHeaderRemovesAllCases();
  console.log('PASS testStripAltSvcHeaderRemovesAllCases');
  await testMitmStripsAltSvcFromUpstreamResponse();
  console.log('PASS testMitmStripsAltSvcFromUpstreamResponse');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
