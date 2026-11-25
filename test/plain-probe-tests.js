'use strict';

// 明文探测层的测试：8002 / 8003 的 TLS 端口在收到非 TLS 流量时，
// 不该像以前那样在握手层丢掉连接（客户端 0 字节 → ERR_EMPTY_RESPONSE），
// 而应回一个正常的 200 页面。同时不能影响真实的 TLS 流量。

const assert = require('assert');
const net = require('net');
const tls = require('tls');
const http2 = require('http2');
const fs = require('fs');
const path = require('path');
const { once } = require('events');

const { createPlainProbeFront } = require('../proxy/plain-probe');

const CERT_FILE = path.join(__dirname, '../cert/socks5_tls.crt');
const KEY_FILE = path.join(__dirname, '../cert/socks5_tls.key');

const cert = fs.readFileSync(CERT_FILE);
const key = fs.readFileSync(KEY_FILE);

function readAll(socket, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(Buffer.concat(chunks).toString('utf8'));
    }, timeoutMs);
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function sendPlain(port, requestText) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const body = readAll(socket);
    socket.on('error', reject);
    socket.on('connect', () => socket.write(requestText));
    body.then(resolve, reject);
  });
}

function parseResponse(raw) {
  const headEnd = raw.indexOf('\r\n\r\n');
  assert.ok(headEnd !== -1, `响应里没有头部结束标记: ${JSON.stringify(raw.slice(0, 80))}`);
  const head = raw.slice(0, headEnd);
  const lines = head.split('\r\n');
  return {
    statusLine: lines[0],
    statusCode: Number(lines[0].split(' ')[1]),
    headers: lines.slice(1),
    body: raw.slice(headEnd + 4),
  };
}

function createFrontedTlsServer(tlsOptions = {}) {
  const tlsServer = tls.createServer({
    cert,
    key,
    minVersion: 'TLSv1.2',
    ALPNProtocols: ['h2', 'http/1.1'],
    ...tlsOptions,
  }, (socket) => {
    // 握手成功：回显收到的首包，用于确认 TLS 路径没被破坏
    socket.on('data', (chunk) => socket.write(`tls-echo:${chunk.length}`));
    socket.on('error', () => {});
  });
  tlsServer.on('tlsClientError', (err, socket) => socket?.destroy());
  const front = createPlainProbeFront({ tlsServer, probeTimeoutMs: 2000 });
  return { front, tlsServer };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function closeServer(server) {
  if (!server || !server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

// ── 用例 ─────────────────────────────────────────────────────

async function testPlainGetReturnsDisguisePage() {
  const { front, tlsServer } = createFrontedTlsServer();
  const port = await listen(front);
  try {
    const raw = await sendPlain(port, 'GET / HTTP/1.1\r\nHost: perf.qzz.io\r\nUser-Agent: scanner\r\n\r\n');
    const res = parseResponse(raw);
    assert.strictEqual(res.statusCode, 200, `明文 GET 应返回 200，实际: ${res.statusLine}`);
    assert.ok(res.headers.some((h) => /^content-type:\s*text\/html/i.test(h)), '缺少 text/html 内容类型');
    assert.match(res.body, /Northstar Digital/i, '响应体不是伪装页');
  } finally {
    await closeServer(front);
    await closeServer(tlsServer);
  }
}

async function testPlainHeadAndPostAlsoGetThePage() {
  const { front, tlsServer } = createFrontedTlsServer();
  const port = await listen(front);
  try {
    for (const method of ['HEAD', 'POST', 'OPTIONS']) {
      const raw = await sendPlain(port, `${method} / HTTP/1.1\r\nHost: perf.qzz.io\r\n\r\n`);
      const res = parseResponse(raw);
      assert.strictEqual(res.statusCode, 200, `${method} 应返回 200，实际: ${res.statusLine}`);
    }
  } finally {
    await closeServer(front);
    await closeServer(tlsServer);
  }
}

async function testPlainUnknownPathReturns404NotSilence() {
  const { front, tlsServer } = createFrontedTlsServer();
  const port = await listen(front);
  try {
    const raw = await sendPlain(port, 'GET /.well-known/whatever HTTP/1.1\r\nHost: perf.qzz.io\r\n\r\n');
    const res = parseResponse(raw);
    assert.strictEqual(res.statusCode, 404, `未知路径应返回 404，实际: ${res.statusLine}`);
    assert.ok(res.body.length > 0, '404 也不该是空响应体');
  } finally {
    await closeServer(front);
    await closeServer(tlsServer);
  }
}

async function testPlainConnectIsForbiddenNotSilent() {
  const { front, tlsServer } = createFrontedTlsServer();
  const port = await listen(front);
  try {
    const raw = await sendPlain(port, 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
    const res = parseResponse(raw);
    assert.strictEqual(res.statusCode, 403, `明文 CONNECT 应返回 403，实际: ${res.statusLine}`);
  } finally {
    await closeServer(front);
    await closeServer(tlsServer);
  }
}

async function testMalformedPlainRequestReturns400() {
  const { front, tlsServer } = createFrontedTlsServer();
  const port = await listen(front);
  try {
    const raw = await sendPlain(port, 'not-http-at-all\r\n\r\n');
    const res = parseResponse(raw);
    assert.strictEqual(res.statusCode, 400, `垃圾请求应返回 400，实际: ${res.statusLine}`);
  } finally {
    await closeServer(front);
    await closeServer(tlsServer);
  }
}

async function testOversizedPlainHeadIsRejected() {
  const { front, tlsServer } = createFrontedTlsServer();
  const port = await listen(front);
  try {
    const raw = await sendPlain(port, 'GET /' + 'a'.repeat(20 * 1024) + ' HTTP/1.1\r\n');
    const res = parseResponse(raw);
    assert.strictEqual(res.statusCode, 431, `超长请求头应返回 431，实际: ${res.statusLine}`);
  } finally {
    await closeServer(front);
    await closeServer(tlsServer);
  }
}

async function testTlsHandshakeStillWorksThroughFront() {
  const { front, tlsServer } = createFrontedTlsServer();
  const port = await listen(front);
  try {
    const socket = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
    await once(socket, 'secureConnect');
    assert.strictEqual(socket.alpnProtocol, 'http/1.1', 'ALPN 协商被前置层破坏');
    socket.write('hello');
    const [chunk] = await once(socket, 'data');
    assert.strictEqual(chunk.toString(), 'tls-echo:5', 'TLS 路径的数据被前置层吞掉');
    socket.destroy();
  } finally {
    await closeServer(front);
    await closeServer(tlsServer);
  }
}

async function testH2AlpnStillNegotiatesThroughFront() {
  const { front, tlsServer } = createFrontedTlsServer();
  const port = await listen(front);
  try {
    const socket = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false, ALPNProtocols: ['h2', 'http/1.1'] });
    await once(socket, 'secureConnect');
    assert.strictEqual(socket.alpnProtocol, 'h2', 'h2 ALPN 协商被前置层破坏');
    socket.destroy();
  } finally {
    await closeServer(front);
    await closeServer(tlsServer);
  }
}

async function testTlsAndPlainOnSameListener() {
  const { front, tlsServer } = createFrontedTlsServer();
  const port = await listen(front);
  try {
    const [plainRaw, tlsAlpn] = await Promise.all([
      sendPlain(port, 'GET / HTTP/1.1\r\nHost: perf.qzz.io\r\n\r\n'),
      new Promise((resolve, reject) => {
        const socket = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false, ALPNProtocols: ['h2'] });
        socket.once('secureConnect', () => {
          const alpn = socket.alpnProtocol;
          socket.destroy();
          resolve(alpn);
        });
        socket.once('error', reject);
      }),
    ]);
    assert.strictEqual(parseResponse(plainRaw).statusCode, 200);
    assert.strictEqual(tlsAlpn, 'h2');
  } finally {
    await closeServer(front);
    await closeServer(tlsServer);
  }
}

async function testSilentConnectionIsDroppedAfterProbeTimeout() {
  const tlsServer = tls.createServer({ cert, key }, () => {});
  tlsServer.on('tlsClientError', (err, socket) => socket?.destroy());
  const front = createPlainProbeFront({ tlsServer, probeTimeoutMs: 150 });
  const port = await listen(front);
  try {
    const socket = net.connect(port, '127.0.0.1');
    await once(socket, 'connect');
    const startedAt = Date.now();
    await once(socket, 'close');
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 100, `静默连接应等够探测窗口才断开，实际 ${elapsed}ms`);
    assert.ok(elapsed < 1500, `静默连接断开太慢: ${elapsed}ms`);
  } finally {
    await closeServer(front);
    await closeServer(tlsServer);
  }
}

// 直接打 http2.createSecureServer 的前置层：确认 h2 服务器也能被 emit('connection') 驱动
async function testFrontWorksWithHttp2SecureServer() {
  const h2Server = http2.createSecureServer({ cert, key, minVersion: 'TLSv1.2', allowHTTP1: true }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('h2-ok');
  });
  h2Server.on('tlsClientError', (err, socket) => socket?.destroy());
  const front = createPlainProbeFront({ tlsServer: h2Server, probeTimeoutMs: 2000 });
  const port = await listen(front);
  try {
    const raw = await sendPlain(port, 'GET / HTTP/1.1\r\nHost: perf.qzz.io\r\n\r\n');
    assert.strictEqual(parseResponse(raw).statusCode, 200, '明文请求没有被前置层接管');

    const client = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
    await once(client, 'connect');
    const req = client.request({ ':method': 'GET', ':path': '/' });
    let status = null;
    let body = '';
    req.setEncoding('utf8');
    req.on('response', (headers) => { status = headers[':status']; });
    req.on('data', (chunk) => { body += chunk; });
    await once(req, 'end');
    client.close();
    assert.strictEqual(status, 200, 'h2 请求经过前置层后失败');
    assert.strictEqual(body, 'h2-ok');
  } finally {
    await closeServer(front);
    await closeServer(h2Server);
  }
}

(async () => {
  await testPlainGetReturnsDisguisePage();
  await testPlainHeadAndPostAlsoGetThePage();
  await testPlainUnknownPathReturns404NotSilence();
  await testPlainConnectIsForbiddenNotSilent();
  await testMalformedPlainRequestReturns400();
  await testOversizedPlainHeadIsRejected();
  await testTlsHandshakeStillWorksThroughFront();
  await testH2AlpnStillNegotiatesThroughFront();
  await testTlsAndPlainOnSameListener();
  await testSilentConnectionIsDroppedAfterProbeTimeout();
  await testFrontWorksWithHttp2SecureServer();
  console.log('plain probe tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});