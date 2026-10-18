'use strict';

// 8002「公网代理」端口的 HTTP/2 测试：
// ALPN 协商出 h2 → 解密后的 TLS socket 交给 http2 解析，一条连接上多流复用；
// 协商不到 h2（http/1.1 或无 ALPN）时必须原样落回首字节分发。

const assert = require('assert');
const net = require('net');
const tls = require('tls');
const http2 = require('http2');
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const Socks5 = require('../socks5/server');

const CERT_FILE = path.join(__dirname, '../cert/socks5_tls.crt');
const KEY_FILE = path.join(__dirname, '../cert/socks5_tls.key');
const silentLogger = { log: () => {}, warn: () => {} };

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 假的下游 HTTP 代理（127.0.0.1:8001 的角色）───────────────
async function createDownstreamProxy() {
  const received = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.removeListener('data', onData);
      received.push({
        head: buffer.slice(0, end).toString('latin1'),
        rest: buffer.slice(end + 4),
      });
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.pipe(socket);
    };
    socket.on('data', onData);
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port, received };
}

async function createFailingDownstreamProxy(statusLine) {
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write(`${statusLine}\r\nContent-Length: 0\r\n\r\n`);
      socket.end();
    });
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port };
}

async function createAbortingDownstreamProxy() {
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      setTimeout(() => socket.destroy(new Error('upstream boom')), 10);
    });
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port };
}

function createFakeAttacker() {
  const counts = { access: 0, good: 0, bad: 0 };
  const ips = [];
  return {
    counts,
    ips,
    isBadGuy: () => false,
    countIPAccess: (ip) => { counts.access += 1; ips.push(ip); },
    setGoodGuy: () => { counts.good += 1; },
  };
}

// ── 被测服务：8002（TLS + ALPN）─────────────────────────────
async function createTestServer(options = {}) {
  const dispatcher = Socks5._test.createPublicProxyDispatcher({
    authCredentials: { username: '', password: '' },
    handshakeTimeoutMs: 500,
    maxTcpConnects: 200,
    logger: silentLogger,
    ...options,
  });
  const counts = { tlsConnections: 0 };
  const sockets = new Set();
  const server = tls.createServer({
    cert: fs.readFileSync(CERT_FILE),
    key: fs.readFileSync(KEY_FILE),
    minVersion: 'TLSv1.2',
    ALPNProtocols: ['h2', 'http/1.1'],
  }, dispatcher.handleConnection);
  server.on('secureConnection', (socket) => {
    counts.tlsConnections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (err, socket) => socket && socket.destroy());
  server.on('tlsClientError', (err, socket) => socket && socket.destroy());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, dispatcher, counts, sockets, port: server.address().port };
}

async function closeNetServer(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function closeTestServer(ctx) {
  if (ctx.dispatcher && typeof ctx.dispatcher.close === 'function') ctx.dispatcher.close();
  // tls.Server 没有 closeAllConnections()：h2 会话会一直占着解密后的 socket，
  // 不主动销毁 server.close() 永远不回调。
  for (const socket of ctx.sockets) socket.destroy();
  ctx.sockets.clear();
  await new Promise((resolve) => ctx.server.close(resolve));
}

async function readBytes(socket, size) {
  const chunks = [];
  let total = 0;
  return withTimeout(new Promise((resolve) => {
    const onData = (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= size) {
        socket.removeListener('data', onData);
        resolve(Buffer.concat(chunks, total));
      }
    };
    socket.on('data', onData);
  }), 3000, `readBytes(${size})`);
}

function connectTls(port, alpn) {
  const options = { host: '127.0.0.1', port, rejectUnauthorized: false };
  if (alpn) options.ALPNProtocols = alpn;
  return tls.connect(options);
}

async function connectH2(port) {
  const socket = connectTls(port, ['h2']);
  await once(socket, 'secureConnect');
  assert.strictEqual(socket.alpnProtocol, 'h2');
  const session = http2.connect(`https://127.0.0.1:${port}`, {
    createConnection: () => socket,
    rejectUnauthorized: false,
  });
  session.on('error', () => {});
  await once(session, 'connect');
  return session;
}

function openTunnel(session, target, headers = {}) {
  const req = session.request({ ':method': 'CONNECT', ':authority': target, ...headers });
  req.on('error', () => {});
  return req;
}

function awaitStatus(stream) {
  return withTimeout(new Promise((resolve) => {
    stream.once('response', (headers) => resolve(headers[':status']));
  }), 3000, 'response');
}

async function readExactly(stream, size) {
  const chunks = [];
  let total = 0;
  return withTimeout(new Promise((resolve) => {
    const onData = (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= size) {
        stream.removeListener('data', onData);
        resolve(Buffer.concat(chunks, total));
      }
    };
    stream.on('data', onData);
    stream.once('end', () => {
      stream.removeListener('data', onData);
      resolve(Buffer.concat(chunks, total));
    });
  }), 5000, `readExactly(${size})`);
}

async function writeAll(stream, buffer) {
  const chunkSize = 64 * 1024;
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    const chunk = buffer.slice(offset, offset + chunkSize);
    if (!stream.write(chunk)) await once(stream, 'drain');
  }
}

// ── h2 用例 ─────────────────────────────────────────────────

async function testH2TunnelsTwoStreamsOverOneConnection() {
  const downstream = await createDownstreamProxy();
  const ctx = await createTestServer({ downstreamProxyPort: downstream.port });
  const session = await connectH2(ctx.port);
  try {
    const a = openTunnel(session, `127.0.0.1:${downstream.port}`);
    const b = openTunnel(session, `127.0.0.1:${downstream.port}`);
    assert.strictEqual(await awaitStatus(a), 200);
    assert.strictEqual(await awaitStatus(b), 200);

    a.write('alpha');
    b.write('beta');
    assert.strictEqual((await readExactly(a, 5)).toString(), 'alpha');
    assert.strictEqual((await readExactly(b, 4)).toString(), 'beta');

    // 两条流复用同一条 TLS 连接
    assert.strictEqual(ctx.counts.tlsConnections, 1);
  } finally {
    session.close();
    await closeTestServer(ctx);
    await closeNetServer(downstream.server);
  }
}

async function testH2StripsProxyAuthorizationDownstream() {
  const downstream = await createDownstreamProxy();
  const ctx = await createTestServer({
    downstreamProxyPort: downstream.port,
    authCredentials: { username: 'user', password: 'pass' },
    attacker: createFakeAttacker(),
  });
  const session = await connectH2(ctx.port);
  try {
    const expected = 'Basic ' + Buffer.from('user:pass').toString('base64');
    const stream = openTunnel(session, `127.0.0.1:${downstream.port}`, {
      'proxy-authorization': expected,
    });
    assert.strictEqual(await awaitStatus(stream), 200);
    const head = downstream.received[0].head.toLowerCase();
    assert.ok(head.startsWith(`connect 127.0.0.1:${downstream.port}`), head);
    assert.ok(!head.includes('proxy-authorization'), head);
  } finally {
    session.close();
    await closeTestServer(ctx);
    await closeNetServer(downstream.server);
  }
}

async function testH2RejectsMissingCredentialsWith407() {
  const downstream = await createDownstreamProxy();
  const attacker = createFakeAttacker();
  const ctx = await createTestServer({
    downstreamProxyPort: downstream.port,
    authCredentials: { username: 'user', password: 'pass' },
    attacker,
  });
  const session = await connectH2(ctx.port);
  try {
    const stream = openTunnel(session, `127.0.0.1:${downstream.port}`);
    const status = await awaitStatus(stream);
    assert.strictEqual(status, 407);
    assert.strictEqual(attacker.counts.access, 1);
    // 包装 Duplex 后仍要还原真实客户端 IP，否则限频会把所有人算成一个 IP
    assert.deepStrictEqual(attacker.ips, ['127.0.0.1']);
    assert.strictEqual(downstream.received.length, 0);
  } finally {
    session.close();
    await closeTestServer(ctx);
    await closeNetServer(downstream.server);
  }
}

async function testH2RejectsWrongCredentialsWith407() {
  const downstream = await createDownstreamProxy();
  const attacker = createFakeAttacker();
  const ctx = await createTestServer({
    downstreamProxyPort: downstream.port,
    authCredentials: { username: 'user', password: 'pass' },
    attacker,
  });
  const session = await connectH2(ctx.port);
  try {
    const stream = openTunnel(session, `127.0.0.1:${downstream.port}`, {
      'proxy-authorization': 'Basic ' + Buffer.from('user:wrong').toString('base64'),
    });
    assert.strictEqual(await awaitStatus(stream), 407);
    assert.strictEqual(attacker.counts.access, 1);
    assert.strictEqual(attacker.counts.good, 0);
  } finally {
    session.close();
    await closeTestServer(ctx);
    await closeNetServer(downstream.server);
  }
}

async function testH2NonConnectMethodIs501() {
  const downstream = await createDownstreamProxy();
  const ctx = await createTestServer({ downstreamProxyPort: downstream.port });
  const session = await connectH2(ctx.port);
  try {
    const req = session.request({
      ':method': 'GET',
      ':path': '/',
      ':scheme': 'https',
      ':authority': 'example.com',
    });
    req.on('error', () => {});
    req.end();
    assert.strictEqual(await awaitStatus(req), 501);
  } finally {
    session.close();
    await closeTestServer(ctx);
    await closeNetServer(downstream.server);
  }
}

async function testH2MalformedAuthorityIs400() {
  const downstream = await createDownstreamProxy();
  const ctx = await createTestServer({ downstreamProxyPort: downstream.port });
  const session = await connectH2(ctx.port);
  try {
    const stream = openTunnel(session, ':::');
    assert.strictEqual(await awaitStatus(stream), 400);
  } finally {
    session.close();
    await closeTestServer(ctx);
    await closeNetServer(downstream.server);
  }
}

async function testH2OverLimitIs503() {
  const downstream = await createDownstreamProxy();
  const ctx = await createTestServer({
    downstreamProxyPort: downstream.port,
    maxTcpConnects: 1,
  });
  const first = await connectH2(ctx.port);
  const second = await connectH2(ctx.port);
  try {
    assert.strictEqual(await awaitStatus(openTunnel(first, `127.0.0.1:${downstream.port}`)), 200);
    // 全局并发上限（不是单会话流数）：第二条会话的流也要被 503 拒掉
    assert.strictEqual(await awaitStatus(openTunnel(second, `127.0.0.1:${downstream.port}`)), 503);
  } finally {
    first.close();
    second.close();
    await closeTestServer(ctx);
    await closeNetServer(downstream.server);
  }
}

async function testH2DownstreamFailurePassesStatusThrough() {
  const downstream = await createFailingDownstreamProxy('HTTP/1.1 502 Bad Gateway');
  const ctx = await createTestServer({ downstreamProxyPort: downstream.port });
  const session = await connectH2(ctx.port);
  try {
    const stream = openTunnel(session, '127.0.0.1:9');
    assert.strictEqual(await awaitStatus(stream), 502);
  } finally {
    session.close();
    await closeTestServer(ctx);
    await closeNetServer(downstream.server);
  }
}

async function testH2LargePayloadEcho() {
  const downstream = await createDownstreamProxy();
  const ctx = await createTestServer({ downstreamProxyPort: downstream.port });
  const session = await connectH2(ctx.port);
  try {
    const stream = openTunnel(session, `127.0.0.1:${downstream.port}`);
    assert.strictEqual(await awaitStatus(stream), 200);
    const payload = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
    const received = readExactly(stream, payload.length);
    await writeAll(stream, payload);
    const echoed = await received;
    assert.strictEqual(echoed.length, payload.length);
    assert.ok(echoed.equals(payload), '1MB echo payload mismatch');
  } finally {
    session.close();
    await closeTestServer(ctx);
    await closeNetServer(downstream.server);
  }
}

async function testH2SessionSurvivesIdleBeyondHandshakeTimeout() {
  const downstream = await createDownstreamProxy();
  const ctx = await createTestServer({
    downstreamProxyPort: downstream.port,
    handshakeTimeoutMs: 200,
  });
  const session = await connectH2(ctx.port);
  try {
    await sleep(500);
    const stream = openTunnel(session, `127.0.0.1:${downstream.port}`);
    assert.strictEqual(await awaitStatus(stream), 200);
    stream.write('still-alive');
    assert.strictEqual((await readExactly(stream, 11)).toString(), 'still-alive');
  } finally {
    session.close();
    await closeTestServer(ctx);
    await closeNetServer(downstream.server);
  }
}

// ── 回退（老客户端 / 老路径）用例 ───────────────────────────

async function testAlpnHttp11StillUsesHttp1Connect() {
  const downstream = await createDownstreamProxy();
  const ctx = await createTestServer({ downstreamProxyPort: downstream.port });
  const socket = connectTls(ctx.port, ['http/1.1']);
  try {
    await once(socket, 'secureConnect');
    assert.strictEqual(socket.alpnProtocol, 'http/1.1');
    socket.write(`CONNECT 127.0.0.1:${downstream.port} HTTP/1.1\r\nHost: 127.0.0.1:${downstream.port}\r\n\r\n`);
    const [head] = await once(socket, 'data');
    assert.ok(head.toString().startsWith('HTTP/1.1 200'), head.toString());
    socket.write('ping');
    const [echo] = await once(socket, 'data');
    assert.strictEqual(echo.toString(), 'ping');
  } finally {
    socket.destroy();
    await closeTestServer(ctx);
    await closeNetServer(downstream.server);
  }
}

async function testNoAlpnStillReachesSocks5() {
  const downstream = await createDownstreamProxy();
  const ctx = await createTestServer({ downstreamProxyPort: downstream.port });
  const socket = connectTls(ctx.port, null);
  try {
    await once(socket, 'secureConnect');
    assert.strictEqual(socket.alpnProtocol, false);
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    const [method] = await once(socket, 'data');
    assert.deepStrictEqual([...method], [0x05, 0x00]);

    const request = Buffer.from([
      0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1,
      (downstream.port >> 8) & 0xff, downstream.port & 0xff,
    ]);
    socket.write(request);
    const [reply] = await once(socket, 'data');
    assert.strictEqual(reply[0], 0x05);
    assert.strictEqual(reply[1], 0x00);
    socket.write('ping');
    const [echo] = await once(socket, 'data');
    assert.strictEqual(echo.toString(), 'ping');
  } finally {
    socket.destroy();
    await closeTestServer(ctx);
    await closeNetServer(downstream.server);
  }
}

async function testMixedSocks5AndH2OnSameTlsPort() {
  const downstream = await createDownstreamProxy();
  const ctx = await createTestServer({ downstreamProxyPort: downstream.port });
  const socks = connectTls(ctx.port, null);
  await once(socks, 'secureConnect');
  const session = await connectH2(ctx.port);
  try {
    socks.write(Buffer.from([0x05, 0x01, 0x00]));
    await once(socks, 'data');
    socks.write(Buffer.from([
      0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1,
      (downstream.port >> 8) & 0xff, downstream.port & 0xff,
    ]));
    const reply = await readBytes(socks, 10);
    assert.strictEqual(reply[0], 0x05);
    assert.strictEqual(reply[1], 0x00);

    const stream = openTunnel(session, `127.0.0.1:${downstream.port}`);
    assert.strictEqual(await awaitStatus(stream), 200);
    stream.write('h2');
    assert.strictEqual((await readExactly(stream, 2)).toString(), 'h2');
  } finally {
    socks.destroy();
    session.close();
    await closeTestServer(ctx);
    await closeNetServer(downstream.server);
  }
}

async function testH2DownstreamAbortEndsStream() {
  const downstream = await createAbortingDownstreamProxy();
  const ctx = await createTestServer({ downstreamProxyPort: downstream.port });
  const session = await connectH2(ctx.port);
  try {
    const stream = openTunnel(session, '127.0.0.1:9');
    assert.strictEqual(await awaitStatus(stream), 200);
    // 隧道建立后下游异常断开：客户端必须立刻收到结束/重置，而不是挂到空闲超时
    await withTimeout(new Promise((resolve) => {
      stream.once('end', resolve);
      stream.once('close', resolve);
      stream.once('aborted', resolve);
    }), 1500, 'downstream abort should end the h2 stream');
  } finally {
    session.close();
    await closeTestServer(ctx);
    await closeNetServer(downstream.server);
  }
}

async function testAlpnH2WithSocks5ClientStillWorks() {
  const downstream = await createDownstreamProxy();
  const ctx = await createTestServer({ downstreamProxyPort: downstream.port });
  // xray/v2rayU 常把 h2 放进 ALPN 却仍说 SOCKS5：必须继续按首字节分发
  const socket = connectTls(ctx.port, ['h2', 'http/1.1']);
  try {
    await once(socket, 'secureConnect');
    assert.strictEqual(socket.alpnProtocol, 'h2');
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    const method = await readBytes(socket, 2);
    assert.deepStrictEqual([...method], [0x05, 0x00]);
    socket.write(Buffer.from([
      0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1,
      (downstream.port >> 8) & 0xff, downstream.port & 0xff,
    ]));
    const reply = await readBytes(socket, 10);
    assert.strictEqual(reply[1], 0x00);
    socket.write('ping');
    assert.strictEqual((await readBytes(socket, 4)).toString(), 'ping');
  } finally {
    socket.destroy();
    await closeTestServer(ctx);
    await closeNetServer(downstream.server);
  }
}

async function testAlpnH2WithHttp11ClientStillWorks() {
  const downstream = await createDownstreamProxy();
  const ctx = await createTestServer({ downstreamProxyPort: downstream.port });
  const socket = connectTls(ctx.port, ['h2', 'http/1.1']);
  try {
    await once(socket, 'secureConnect');
    assert.strictEqual(socket.alpnProtocol, 'h2');
    socket.write(`CONNECT 127.0.0.1:${downstream.port} HTTP/1.1\r\nHost: 127.0.0.1:${downstream.port}\r\n\r\n`);
    const head = await readBytes(socket, 39);
    assert.ok(head.toString().startsWith('HTTP/1.1 200'), head.toString());
    socket.write('ping');
    assert.strictEqual((await readBytes(socket, 4)).toString(), 'ping');
  } finally {
    socket.destroy();
    await closeTestServer(ctx);
    await closeNetServer(downstream.server);
  }
}

async function testGarbageAfterAlpnH2DoesNotCrashServer() {
  const downstream = await createDownstreamProxy();
  const ctx = await createTestServer({ downstreamProxyPort: downstream.port });
  try {
    // 公网扫描器：宣告 h2 却发非 h2 数据，必须只断开这一条连接
    const bad = connectTls(ctx.port, ['h2']);
    await once(bad, 'secureConnect');
    bad.on('error', () => {});
    bad.write('GARBAGE NOT HTTP/2\r\n\r\n');
    await withTimeout(new Promise((resolve) => {
      if (bad.destroyed) return resolve();
      bad.once('close', resolve);
    }).catch(() => {}), 2000, 'garbage close').catch(() => {});

    // 正常 h2 客户端不受影响
    const session = await connectH2(ctx.port);
    const stream = openTunnel(session, `127.0.0.1:${downstream.port}`);
    assert.strictEqual(await awaitStatus(stream), 200);
    session.close();
  } finally {
    await closeTestServer(ctx);
    await closeNetServer(downstream.server);
  }
}

async function testH2DoesNotRequirePathOrSchemeHeaders() {
  const downstream = await createDownstreamProxy();
  const ctx = await createTestServer({ downstreamProxyPort: downstream.port });
  const session = await connectH2(ctx.port);
  try {
    // Node 服务端会以 RST_STREAM(PROTOCOL_ERROR) 拒绝带 :scheme/:path 的 CONNECT，
    // 这里断言只用 :method + :authority 就能建隧道。
    const stream = openTunnel(session, `127.0.0.1:${downstream.port}`);
    assert.strictEqual(await awaitStatus(stream), 200);
  } finally {
    session.close();
    await closeTestServer(ctx);
    await closeNetServer(downstream.server);
  }
}

async function run() {
  const tests = [
    testH2TunnelsTwoStreamsOverOneConnection,
    testH2StripsProxyAuthorizationDownstream,
    testH2RejectsMissingCredentialsWith407,
    testH2RejectsWrongCredentialsWith407,
    testH2NonConnectMethodIs501,
    testH2MalformedAuthorityIs400,
    testH2OverLimitIs503,
    testH2DownstreamFailurePassesStatusThrough,
    testH2LargePayloadEcho,
    testH2SessionSurvivesIdleBeyondHandshakeTimeout,
    testH2DoesNotRequirePathOrSchemeHeaders,
    testH2DownstreamAbortEndsStream,
    testAlpnH2WithSocks5ClientStillWorks,
    testAlpnH2WithHttp11ClientStillWorks,
    testGarbageAfterAlpnH2DoesNotCrashServer,
    testAlpnHttp11StillUsesHttp1Connect,
    testNoAlpnStillReachesSocks5,
    testMixedSocks5AndH2OnSameTlsPort,
  ];
  let failed = 0;
  for (const test of tests) {
    try {
      await withTimeout(test(), 15000, test.name);
      console.log(`ok   ${test.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL ${test.name}`);
      console.error(err && err.stack ? err.stack : err);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed}/${tests.length} failed`);
    process.exit(1);
  }
  console.log(`\n${tests.length}/${tests.length} passed`);
  process.exit(0);
}

run();
