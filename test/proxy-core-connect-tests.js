'use strict';

const assert = require('assert');
const constants = require('constants');
const fs = require('fs');
const http = require('http');
const https = require('https');
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
  fs.writeFileSync(targetCrt, fs.readFileSync(path.join(__dirname, '../cert/tunnel_tls.crt')));
  fs.writeFileSync(targetKey, fs.readFileSync(path.join(__dirname, '../cert/tunnel_tls.key')));
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
  testEnsureRootCAReplacesMismatchedCache();
  console.log('PASS testEnsureRootCAReplacesMismatchedCache');
  await testConnectHeadWebSocketUsesLocalProxy();
  console.log('PASS testConnectHeadWebSocketUsesLocalProxy');
  await testMitmConnectForwardsHttpsRequest();
  console.log('PASS testMitmConnectForwardsHttpsRequest');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
