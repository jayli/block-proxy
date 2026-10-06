'use strict';

// 8002「公网代理」端口的协议分发测试：
// 同一个（TLS）监听端口上，首字节 0x05 走 SOCKS5，ASCII 方法名走 HTTP CONNECT。
// 下游用一个假的 8001 HTTP 代理（回 200 后进入 echo 模式），不依赖真实网络。

const assert = require('assert');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const Socks5 = require('../socks5/server');

const CERT_FILE = path.join(__dirname, '../cert/socks5_tls.crt');
const KEY_FILE = path.join(__dirname, '../cert/socks5_tls.key');

const silentLogger = { log: () => {}, warn: () => {} };

function basicAuth(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
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
      // 隧道建立后进入 echo：客户端写什么就回什么
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

// ── 被测服务：8002 公网代理端口 ───────────────────────────────
async function createPublicProxyServer(options = {}) {
  const handler = Socks5._test.createPublicProxyHandler({
    authCredentials: { username: '', password: '' },
    handshakeTimeoutMs: 500,
    maxTcpConnects: 200,
    logger: silentLogger,
    ...options,
  });
  const server = net.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function createHttpConnectServer(options = {}) {
  const handler = Socks5._test.createHttpConnectHandler({
    authCredentials: { username: '', password: '' },
    handshakeTimeoutMs: 500,
    maxTcpConnects: 200,
    logger: silentLogger,
    ...options,
  });
  const server = net.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

function createFakeAttacker(banAfter) {
  const counts = new Map();
  const banned = new Set();
  return {
    counts,
    banned,
    countIPAccess(ip) {
      const n = (counts.get(ip) || 0) + 1;
      counts.set(ip, n);
      if (n >= banAfter) banned.add(ip);
      return n;
    },
    isBadGuy(ip) {
      return banned.has(ip);
    },
    setGoodGuy() {},
    cleanupInactiveIPs() {},
  };
}

// 不触碰真实 attacker 全局状态的占位实现：用于不关心限频、但会认证成功
// （从而触发 setGoodGuy）的用例，避免污染后续真实限频测试。
const noopAttacker = {
  countIPAccess() {},
  isBadGuy() { return false; },
  setGoodGuy() {},
  cleanupInactiveIPs() {},
};

async function sendConnectExpect407(port, authHeaderLine) {
  const socket = connect(port);
  await once(socket, 'connect');
  socket.write(
    'CONNECT example.com:443 HTTP/1.1\r\n' +
    'Host: example.com:443\r\n' +
    (authHeaderLine ? `${authHeaderLine}\r\n` : '') +
    '\r\n'
  );
  const { head } = await readUntil(socket, '\r\n\r\n');
  await waitForClose(socket);
  return head.toString('latin1');
}

function socks5AuthPacket(username, password) {
  const user = Buffer.from(username);
  const pass = Buffer.from(password);
  return Buffer.concat([
    Buffer.from([0x01, user.length]),
    user,
    Buffer.from([pass.length]),
    pass,
  ]);
}

// 走完整 SOCKS5 握手（方法协商 + 用户名密码），返回认证应答字节
async function socks5AuthAttempt(port, username, password) {
  const socket = connect(port);
  await once(socket, 'connect');
  socket.write(Buffer.from([0x05, 0x01, 0x02]));
  const methodReply = await readOnce(socket);
  assert.deepEqual(methodReply, Buffer.from([0x05, 0x02]), 'SOCKS5 方法协商应答异常');
  socket.write(socks5AuthPacket(username, password));
  const authReply = await readOnce(socket);
  await waitForClose(socket);
  return authReply;
}

// 被拉黑 IP 的 SOCKS5 连接：握手前即被关闭，收不到任何字节
async function socks5ExpectClosedBeforeHandshake(port) {
  const socket = connect(port);
  await once(socket, 'connect');
  const received = [];
  socket.on('data', (chunk) => received.push(chunk));
  socket.write(Buffer.from([0x05, 0x01, 0x02]));
  await waitForClose(socket);
  return Buffer.concat(received);
}

async function createPublicTlsProxyServer(options = {}) {
  const handler = Socks5._test.createPublicProxyHandler({
    authCredentials: { username: '', password: '' },
    handshakeTimeoutMs: 500,
    maxTcpConnects: 200,
    logger: silentLogger,
    ...options,
  });
  const server = tls.createServer({
    cert: fs.readFileSync(CERT_FILE),
    key: fs.readFileSync(KEY_FILE),
    minVersion: 'TLSv1.2',
  }, handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

function connect(port) {
  return net.createConnection({ host: '127.0.0.1', port });
}

function connectTls(port) {
  return tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false });
}

async function readOnce(socket) {
  const [chunk] = await once(socket, 'data');
  return chunk;
}

async function readUntil(socket, needle, timeoutMs = 1500) {
  let buffer = Buffer.alloc(0);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const idx = buffer.indexOf(needle);
    if (idx !== -1) return { head: buffer.slice(0, idx), rest: buffer.slice(idx + needle.length) };
    const remaining = deadline - Date.now();
    const chunk = await Promise.race([
      readOnce(socket),
      new Promise((_, reject) => setTimeout(() => reject(new Error('read timeout')), remaining)),
    ]);
    buffer = Buffer.concat([buffer, chunk]);
  }
  throw new Error(`read timeout waiting for ${JSON.stringify(needle.toString())}`);
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function waitForClose(socket) {
  if (socket.destroyed) return;
  await once(socket, 'close');
}

// ── 测试用例 ─────────────────────────────────────────────────

async function testSocks5GreetingIsStillRoutedToSocks5Handler() {
  const downstream = await createDownstreamProxy();
  const server = await createPublicProxyServer({ downstreamProxyPort: downstream.port });
  const socket = connect(server.address().port);
  await once(socket, 'connect');

  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  const reply = await readOnce(socket);
  assert.deepEqual(reply, Buffer.from([0x05, 0x00]), 'SOCKS5 方法协商应答被破坏');

  socket.destroy();
  await waitForClose(socket);
  await closeServer(server);
  await closeServer(downstream.server);
}

async function testHttpConnectTunnelsThroughDownstreamProxy() {
  const downstream = await createDownstreamProxy();
  const server = await createPublicProxyServer({ downstreamProxyPort: downstream.port });
  const socket = connect(server.address().port);
  await once(socket, 'connect');

  socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
  const { rest } = await readUntil(socket, '\r\n\r\n');
  assert.strictEqual(rest.length, 0);

  socket.write('hello-tunnel');
  const echoed = await readOnce(socket);
  assert.strictEqual(echoed.toString(), 'hello-tunnel');

  assert.strictEqual(downstream.received.length, 1);
  assert.ok(
    downstream.received[0].head.startsWith('CONNECT example.com:443 HTTP/1.1'),
    `下游收到的请求行不正确: ${downstream.received[0].head}`
  );

  socket.destroy();
  await waitForClose(socket);
  await closeServer(server);
  await closeServer(downstream.server);
}

async function testHttpConnectStripsProxyAuthorizationBeforeDownstream() {
  const downstream = await createDownstreamProxy();
  const server = await createPublicProxyServer({
    downstreamProxyPort: downstream.port,
    authCredentials: { username: 'user', password: 'pass' },
    attacker: noopAttacker,
  });
  const socket = connect(server.address().port);
  await once(socket, 'connect');

  socket.write(
    'CONNECT example.com:443 HTTP/1.1\r\n' +
    `Host: example.com:443\r\n` +
    `Proxy-Authorization: ${basicAuth('user', 'pass')}\r\n` +
    'Proxy-Connection: keep-alive\r\n\r\n'
  );
  await readUntil(socket, '\r\n\r\n');

  assert.strictEqual(downstream.received.length, 1);
  const forwarded = downstream.received[0].head.toLowerCase();
  assert.ok(!forwarded.includes('proxy-authorization'), '凭据被透传到下游 8001');
  assert.ok(!forwarded.includes('proxy-connection'), 'hop-by-hop 头被透传到下游 8001');

  socket.destroy();
  await waitForClose(socket);
  await closeServer(server);
  await closeServer(downstream.server);
}

async function testHttpConnectRejectsWrongCredentialsWith407() {
  const downstream = await createDownstreamProxy();
  const server = await createPublicProxyServer({
    downstreamProxyPort: downstream.port,
    authCredentials: { username: 'user', password: 'pass' },
  });
  const socket = connect(server.address().port);
  await once(socket, 'connect');

  socket.write(
    'CONNECT example.com:443 HTTP/1.1\r\n' +
    `Host: example.com:443\r\n` +
    `Proxy-Authorization: ${basicAuth('user', 'wrong')}\r\n\r\n`
  );
  const { head } = await readUntil(socket, '\r\n\r\n');
  const text = head.toString('latin1');
  assert.ok(text.startsWith('HTTP/1.1 407'), `期望 407，实际: ${text.split('\r\n')[0]}`);
  assert.ok(/proxy-authenticate:\s*basic/i.test(text), '缺少 Proxy-Authenticate 挑战头');
  assert.strictEqual(downstream.received.length, 0, '认证失败不应连接下游');

  await waitForClose(socket);
  await closeServer(server);
  await closeServer(downstream.server);
}

async function testHttpConnectRejectsMissingCredentialsWith407() {
  const downstream = await createDownstreamProxy();
  const server = await createPublicProxyServer({
    downstreamProxyPort: downstream.port,
    authCredentials: { username: 'user', password: 'pass' },
  });
  const socket = connect(server.address().port);
  await once(socket, 'connect');

  socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
  const { head } = await readUntil(socket, '\r\n\r\n');
  assert.ok(head.toString('latin1').startsWith('HTTP/1.1 407'), '缺少凭据应返回 407');

  await waitForClose(socket);
  await closeServer(server);
  await closeServer(downstream.server);
}

async function testHttpConnectAllowsAnyClientWhenNoCredentialsConfigured() {
  const downstream = await createDownstreamProxy();
  const server = await createPublicProxyServer({ downstreamProxyPort: downstream.port });
  const socket = connect(server.address().port);
  await once(socket, 'connect');

  socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
  await readUntil(socket, '\r\n\r\n');
  socket.write('ping');
  assert.strictEqual((await readOnce(socket)).toString(), 'ping');

  socket.destroy();
  await waitForClose(socket);
  await closeServer(server);
  await closeServer(downstream.server);
}

async function testNonConnectMethodIsRejectedWith501() {
  const downstream = await createDownstreamProxy();
  const server = await createPublicProxyServer({ downstreamProxyPort: downstream.port });
  const socket = connect(server.address().port);
  await once(socket, 'connect');

  socket.write('GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n');
  const { head } = await readUntil(socket, '\r\n\r\n');
  assert.ok(head.toString('latin1').startsWith('HTTP/1.1 501'), '非 CONNECT 方法应返回 501');
  assert.strictEqual(downstream.received.length, 0);

  await waitForClose(socket);
  await closeServer(server);
  await closeServer(downstream.server);
}

async function testMalformedConnectTargetIsRejectedWith400() {
  const downstream = await createDownstreamProxy();
  const server = await createPublicProxyServer({ downstreamProxyPort: downstream.port });
  const socket = connect(server.address().port);
  await once(socket, 'connect');

  socket.write('CONNECT example.com:notaport HTTP/1.1\r\nHost: example.com\r\n\r\n');
  const { head } = await readUntil(socket, '\r\n\r\n');
  assert.ok(head.toString('latin1').startsWith('HTTP/1.1 400'), '非法端口应返回 400');
  assert.strictEqual(downstream.received.length, 0);

  socket.destroy();
  await waitForClose(socket);
  await closeServer(server);
  await closeServer(downstream.server);
}

async function testDispatchSurvivesFirstByteArrivingAlone() {
  const downstream = await createDownstreamProxy();
  const server = await createPublicProxyServer({ downstreamProxyPort: downstream.port });
  const socket = connect(server.address().port);
  await once(socket, 'connect');

  // 首字节单独一个 TCP 包，剩余字节随后到达
  socket.write('C');
  await new Promise((resolve) => setTimeout(resolve, 30));
  socket.write('ONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');

  await readUntil(socket, '\r\n\r\n');
  socket.write('split-ok');
  assert.strictEqual((await readOnce(socket)).toString(), 'split-ok');

  socket.destroy();
  await waitForClose(socket);
  await closeServer(server);
  await closeServer(downstream.server);
}

async function testPipelinedTunnelBytesAfterConnectHeadAreForwarded() {
  const downstream = await createDownstreamProxy();
  const server = await createPublicProxyServer({ downstreamProxyPort: downstream.port });
  const socket = connect(server.address().port);
  await once(socket, 'connect');

  // CONNECT 头与首段隧道数据写在同一个包里：数据不能丢，必须进隧道
  socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\nearly-bytes');
  await readUntil(socket, '\r\n\r\n');

  // 下游是 echo 代理：early-bytes 被转发后会原样回来
  const echoed = await readOnce(socket);
  assert.strictEqual(echoed.toString(), 'early-bytes');

  socket.destroy();
  await waitForClose(socket);
  await closeServer(server);
  await closeServer(downstream.server);
}

async function testDownstreamFailureIsRelayedToClient() {
  const downstream = await createFailingDownstreamProxy('HTTP/1.1 502 Bad Gateway');
  const server = await createPublicProxyServer({ downstreamProxyPort: downstream.port });
  const socket = connect(server.address().port);
  await once(socket, 'connect');

  socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
  const { head } = await readUntil(socket, '\r\n\r\n');
  assert.ok(head.toString('latin1').startsWith('HTTP/1.1 502'), '下游失败应原样回传状态行');

  await waitForClose(socket);
  await closeServer(server);
  await closeServer(downstream.server);
}

async function testHttpConnectWorksOverTls() {
  const downstream = await createDownstreamProxy();
  const server = await createPublicTlsProxyServer({ downstreamProxyPort: downstream.port });
  const socket = connectTls(server.address().port);
  await once(socket, 'secureConnect');

  socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
  await readUntil(socket, '\r\n\r\n');
  socket.write('tls-tunnel');
  assert.strictEqual((await readOnce(socket)).toString(), 'tls-tunnel');

  socket.destroy();
  await waitForClose(socket);
  await closeServer(server);
  await closeServer(downstream.server);
}

async function testSocks5StillWorksOverTlsOnSamePort() {
  const downstream = await createDownstreamProxy();
  const server = await createPublicTlsProxyServer({ downstreamProxyPort: downstream.port });
  const socket = connectTls(server.address().port);
  await once(socket, 'secureConnect');

  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  assert.deepEqual(await readOnce(socket), Buffer.from([0x05, 0x00]));

  const host = Buffer.from('example.com');
  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
    host,
    Buffer.from([0x01, 0xbb]),
  ]));
  const reply = await readOnce(socket);
  assert.strictEqual(reply[0], 0x05);
  assert.strictEqual(reply[1], 0x00, `SOCKS5 CONNECT 失败: 0x${reply[1].toString(16)}`);

  socket.destroy();
  await waitForClose(socket);
  await closeServer(server);
  await closeServer(downstream.server);
}

async function testOversizedRequestHeadIsRejected() {
  const downstream = await createDownstreamProxy();
  const server = await createPublicProxyServer({ downstreamProxyPort: downstream.port });
  const socket = connect(server.address().port);
  await once(socket, 'connect');

  socket.write('CONNECT example.com:443 HTTP/1.1\r\n' + 'X-Pad: ' + 'a'.repeat(64 * 1024) + '\r\n\r\n');
  const { head } = await readUntil(socket, '\r\n\r\n');
  assert.ok(
    head.toString('latin1').startsWith('HTTP/1.1 431'),
    '超大请求头应返回 431'
  );
  assert.strictEqual(downstream.received.length, 0);

  await waitForClose(socket);
  await closeServer(server);
  await closeServer(downstream.server);
}

async function testHandshakeTimeoutClosesIdleHttpSocket() {
  const downstream = await createDownstreamProxy();
  const warnings = [];
  const server = await createPublicProxyServer({
    downstreamProxyPort: downstream.port,
    handshakeTimeoutMs: 30,
    logger: { log: () => {}, warn: (message) => warnings.push(message) },
  });
  const socket = connect(server.address().port);
  await once(socket, 'connect');

  socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n');
  await waitForClose(socket);
  assert.ok(
    warnings.some((line) => line.includes('HTTP')),
    `缺少 HTTP 握手超时日志: ${JSON.stringify(warnings)}`
  );

  await closeServer(server);
  await closeServer(downstream.server);
}

async function testAuthFailuresAreCountedByAttacker() {
  const downstream = await createDownstreamProxy();
  const fakeAttacker = createFakeAttacker(3);
  const server = await createHttpConnectServer({
    downstreamProxyPort: downstream.port,
    authCredentials: { username: 'user', password: 'pass' },
    attacker: fakeAttacker,
  });

  for (let i = 0; i < 3; i++) {
    const text = await sendConnectExpect407(server.address().port, `Proxy-Authorization: ${basicAuth('user', 'wrong')}`);
    assert.ok(text.startsWith('HTTP/1.1 407'), `第 ${i + 1} 次失败应返回 407`);
  }
  assert.strictEqual(fakeAttacker.counts.get('127.0.0.1'), 3, '每次认证失败都应计入 attacker');
  assert.strictEqual(downstream.received.length, 0);

  await closeServer(server);
  await closeServer(downstream.server);
}

async function testBannedIpIsRejectedBeforeAuthCheck() {
  const downstream = await createDownstreamProxy();
  const fakeAttacker = createFakeAttacker(1);
  const server = await createHttpConnectServer({
    downstreamProxyPort: downstream.port,
    authCredentials: { username: 'user', password: 'pass' },
    attacker: fakeAttacker,
  });

  // 第 1 次失败即被标记（banAfter=1）
  await sendConnectExpect407(server.address().port, `Proxy-Authorization: ${basicAuth('user', 'wrong')}`);
  assert.ok(fakeAttacker.banned.has('127.0.0.1'));

  // 被拉黑后即使凭据正确也必须拒绝，且不连接下游
  const text = await sendConnectExpect407(server.address().port, `Proxy-Authorization: ${basicAuth('user', 'pass')}`);
  assert.ok(text.startsWith('HTTP/1.1 407'), '被拉黑 IP 应返回 407');
  assert.strictEqual(downstream.received.length, 0, '被拉黑 IP 不应到达下游');

  await closeServer(server);
  await closeServer(downstream.server);
}

async function testRealAttackerBansIpAfterRepeatedFailures() {
  // 使用真实 attacker 模块（默认注入）：BAD_THRESHOLD=20，第 21 次应走拉黑分支。
  // 注意：本测试会污染进程内 attacker 全局状态（127.0.0.1 被拉黑），必须放在最后执行。
  const downstream = await createDownstreamProxy();
  const warnings = [];
  const server = await createHttpConnectServer({
    downstreamProxyPort: downstream.port,
    authCredentials: { username: 'user', password: 'pass' },
    logger: { log: () => {}, warn: (message) => warnings.push(String(message)) },
  });

  for (let i = 0; i < 21; i++) {
    const text = await sendConnectExpect407(server.address().port, `Proxy-Authorization: ${basicAuth('user', 'wrong')}`);
    assert.ok(text.startsWith('HTTP/1.1 407'), `第 ${i + 1} 次应返回 407`);
  }
  assert.ok(
    warnings.some((line) => line.includes('badguy')),
    `第 21 次请求应命中拉黑分支: ${JSON.stringify(warnings.slice(-3))}`
  );
  assert.strictEqual(downstream.received.length, 0);

  await closeServer(server);
  await closeServer(downstream.server);
}

async function testSocks5AuthFailuresAreCountedByAttacker() {
  const downstream = await createDownstreamProxy();
  const fakeAttacker = createFakeAttacker(99);
  const goodGuys = [];
  fakeAttacker.setGoodGuy = (ip) => goodGuys.push(ip);
  const server = await createPublicProxyServer({
    downstreamProxyPort: downstream.port,
    authCredentials: { username: 'user', password: 'pass' },
    attacker: fakeAttacker,
  });

  for (let i = 0; i < 3; i++) {
    const reply = await socks5AuthAttempt(server.address().port, 'user', 'wrong');
    assert.deepEqual(reply, Buffer.from([0x01, 0xff]), `第 ${i + 1} 次错误密码应被拒`);
  }
  assert.strictEqual(fakeAttacker.counts.get('127.0.0.1'), 3, 'SOCKS5 认证失败未计入 attacker');
  assert.strictEqual(goodGuys.length, 0, '认证失败不应标记为好人');
  assert.strictEqual(downstream.received.length, 0);

  await closeServer(server);
  await closeServer(downstream.server);
}

async function testSocks5AuthSuccessMarksIpAsGoodGuy() {
  const downstream = await createDownstreamProxy();
  const fakeAttacker = createFakeAttacker(99);
  const goodGuys = [];
  fakeAttacker.setGoodGuy = (ip) => goodGuys.push(ip);
  const server = await createPublicProxyServer({
    downstreamProxyPort: downstream.port,
    authCredentials: { username: 'user', password: 'pass' },
    attacker: fakeAttacker,
  });

  const reply = await socks5AuthAttempt(server.address().port, 'user', 'pass');
  assert.deepEqual(reply, Buffer.from([0x01, 0x00]), '正确凭据应通过');
  assert.deepStrictEqual(goodGuys, ['127.0.0.1'], 'SOCKS5 认证成功应标记好人豁免');

  await closeServer(server);
  await closeServer(downstream.server);
}

async function testSocks5BannedIpIsClosedBeforeHandshake() {
  const downstream = await createDownstreamProxy();
  const fakeAttacker = createFakeAttacker(1);
  const server = await createPublicProxyServer({
    downstreamProxyPort: downstream.port,
    authCredentials: { username: 'user', password: 'pass' },
    attacker: fakeAttacker,
  });

  // 第 1 次失败即被标记（banAfter=1）
  await socks5AuthAttempt(server.address().port, 'user', 'wrong');
  assert.ok(fakeAttacker.banned.has('127.0.0.1'));

  // 被拉黑后即使凭据正确也在握手前被断开
  const received = await socks5ExpectClosedBeforeHandshake(server.address().port);
  assert.strictEqual(received.length, 0, '被拉黑 IP 不应收到任何 SOCKS5 应答');
  assert.strictEqual(downstream.received.length, 0);

  await closeServer(server);
  await closeServer(downstream.server);
}

async function testBanIsSharedAcrossSocks5AndHttpProtocols() {
  const downstream = await createDownstreamProxy();
  const fakeAttacker = createFakeAttacker(2);
  const server = await createPublicProxyServer({
    downstreamProxyPort: downstream.port,
    authCredentials: { username: 'user', password: 'pass' },
    attacker: fakeAttacker,
  });

  // HTTP 路径失败 2 次 → 拉黑
  for (let i = 0; i < 2; i++) {
    await sendConnectExpect407(server.address().port, `Proxy-Authorization: ${basicAuth('user', 'wrong')}`);
  }
  assert.ok(fakeAttacker.banned.has('127.0.0.1'));

  // 同一 IP 转去试 SOCKS5（凭据正确）也应被拒
  const received = await socks5ExpectClosedBeforeHandshake(server.address().port);
  assert.strictEqual(received.length, 0, 'HTTP 路径拉黑的 IP 应同时封掉 SOCKS5');
  assert.strictEqual(downstream.received.length, 0);

  await closeServer(server);
  await closeServer(downstream.server);
}

async function testSocks5WithoutCredentialsDoesNotTouchAttacker() {
  const downstream = await createDownstreamProxy();
  const fakeAttacker = createFakeAttacker(1);
  let goodGuyCalls = 0;
  fakeAttacker.setGoodGuy = () => { goodGuyCalls++; };
  const server = await createPublicProxyServer({
    downstreamProxyPort: downstream.port,
    authCredentials: { username: '', password: '' },
    attacker: fakeAttacker,
  });

  // 未配置凭据：客户端只提 0x00 无认证，不应产生任何 attacker 记录
  const socket = connect(server.address().port);
  await once(socket, 'connect');
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  assert.deepEqual(await readOnce(socket), Buffer.from([0x05, 0x00]));

  assert.strictEqual(fakeAttacker.counts.size, 0, '无认证模式不应计入限频');
  assert.strictEqual(goodGuyCalls, 0, '无认证模式不应标记好人');

  socket.destroy();
  await waitForClose(socket);
  await closeServer(server);
  await closeServer(downstream.server);
}

(async () => {
  await testSocks5GreetingIsStillRoutedToSocks5Handler();
  await testHttpConnectTunnelsThroughDownstreamProxy();
  await testHttpConnectStripsProxyAuthorizationBeforeDownstream();
  await testHttpConnectRejectsWrongCredentialsWith407();
  await testHttpConnectRejectsMissingCredentialsWith407();
  await testHttpConnectAllowsAnyClientWhenNoCredentialsConfigured();
  await testNonConnectMethodIsRejectedWith501();
  await testMalformedConnectTargetIsRejectedWith400();
  await testDispatchSurvivesFirstByteArrivingAlone();
  await testPipelinedTunnelBytesAfterConnectHeadAreForwarded();
  await testDownstreamFailureIsRelayedToClient();
  await testHttpConnectWorksOverTls();
  await testSocks5StillWorksOverTlsOnSamePort();
  await testOversizedRequestHeadIsRejected();
  await testHandshakeTimeoutClosesIdleHttpSocket();
  await testAuthFailuresAreCountedByAttacker();
  await testBannedIpIsRejectedBeforeAuthCheck();
  await testSocks5AuthFailuresAreCountedByAttacker();
  await testSocks5AuthSuccessMarksIpAsGoodGuy();
  await testSocks5BannedIpIsClosedBeforeHandshake();
  await testBanIsSharedAcrossSocks5AndHttpProtocols();
  await testSocks5WithoutCredentialsDoesNotTouchAttacker();
  await testRealAttackerBansIpAfterRepeatedFailures();
  console.log('public proxy protocol tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
