const assert = require('assert');
const net = require('net');
const { once } = require('events');
const Socks5 = require('../socks5/server');

async function createPlainServer(options = {}) {
  const server = net.createServer(Socks5._test.createConnectionHandler({
    downstreamProxyPort: 9,
    downstreamProxyHost: '127.0.0.1',
    authCredentials: { username: 'u', password: 'p' },
    handshakeTimeoutMs: 50,
    maxTcpConnects: 200,
    ...options,
  }));

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function createDownstreamProxy() {
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function connect(port, options = {}) {
  return net.createConnection({ host: '127.0.0.1', port, ...options });
}

async function readOnce(socket) {
  const [chunk] = await once(socket, 'data');
  return chunk;
}

async function waitForClose(socket) {
  if (socket.destroyed) return;
  await once(socket, 'close');
}

async function waitFor(predicate, timeoutMs = 1500) {
  const start = Date.now();
  for (;;) {
    const result = predicate();
    if (result && typeof result.then === 'function') {
      if (await result) return;
    } else if (result) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function testHandshakeTimeoutClosesIdleSocket() {
  const warnings = [];
  const server = await createPlainServer({
    handshakeTimeoutMs: 30,
    logger: { log: () => {}, warn: (message) => warnings.push(message) },
  });
  const socket = connect(server.address().port);
  await once(socket, 'connect');

  await waitForClose(socket);
  assert.equal(socket.destroyed, true);
  assert.ok(warnings.some((line) =>
    line.includes('SOCKS5 session closed during setup: SOCKS5 method negotiation timeout') &&
    line.includes('remote=127.0.0.1:')
  ));

  await closeServer(server);
}

async function testTcpConnectLimitRejectsNewConnect() {
  const server = await createPlainServer({ maxTcpConnects: 0, handshakeTimeoutMs: 500 });
  const socket = connect(server.address().port);
  await once(socket, 'connect');

  socket.write(Buffer.from([0x05, 0x01, 0x02]));
  assert.deepEqual(await readOnce(socket), Buffer.from([0x05, 0x02]));
  socket.write(Buffer.from([0x01, 0x01, 0x75, 0x01, 0x70]));
  assert.deepEqual(await readOnce(socket), Buffer.from([0x01, 0x00]));

  const host = Buffer.from('example.com');
  const req = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
    host,
    Buffer.from([0x01, 0xbb]),
  ]);
  socket.write(req);

  const response = await readOnce(socket);
  assert.equal(response[0], 0x05);
  assert.equal(response[1], 0x05);

  await waitForClose(socket);
  await closeServer(server);
}

async function openSocksConnect(port, hostName = 'example.com', connectOptions = {}) {
  const socket = connect(port, connectOptions);
  await once(socket, 'connect');
  socket.write(Buffer.from([0x05, 0x01, 0x02]));
  assert.deepEqual(await readOnce(socket), Buffer.from([0x05, 0x02]));
  socket.write(Buffer.from([0x01, 0x01, 0x75, 0x01, 0x70]));
  assert.deepEqual(await readOnce(socket), Buffer.from([0x01, 0x00]));

  const host = Buffer.from(hostName);
  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
    host,
    Buffer.from([0x01, 0xbb]),
  ]));

  const response = await readOnce(socket);
  assert.equal(response[0], 0x05);
  assert.equal(response[1], 0x00);
  return socket;
}

async function testTcpConnectCleanupReleasesCapacity() {
  const downstream = await createDownstreamProxy();
  const server = await createPlainServer({
    downstreamProxyPort: downstream.address().port,
    maxTcpConnects: 1,
    handshakeTimeoutMs: 500,
  });

  const first = await openSocksConnect(server.address().port, 'first.example');
  first.destroy();
  await waitForClose(first);

  const second = await openSocksConnect(server.address().port, 'second.example');
  second.destroy();
  await waitForClose(second);

  await closeServer(server);
  await closeServer(downstream);
}

async function createClosingDownstreamProxy() {
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      // 优雅关闭（FIN）：模拟下游 HTTP 代理先结束连接。
      // RST 场景已被 pipe 的错误传播覆盖，泄漏发生在优雅半关闭时。
      setTimeout(() => socket.end(), 30);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

function getServerConnections(server) {
  return new Promise((resolve, reject) => {
    server.getConnections((err, count) => (err ? reject(err) : resolve(count)));
  });
}

async function testDownstreamCloseDestroysClientSocket() {
  const downstream = await createClosingDownstreamProxy();
  const server = await createPlainServer({
    downstreamProxyPort: downstream.address().port,
    maxTcpConnects: 200,
    handshakeTimeoutMs: 500,
  });

  // allowHalfOpen: 模拟真实客户端收到 FIN 后不主动关闭（Mac 客户端行为）。
  const socket = await openSocksConnect(server.address().port, 'close-first.example', { allowHalfOpen: true });
  // 客户端先收到服务端转发的 FIN（隧道半关闭）
  await waitFor(() => socket.readableEnded);
  // 下游 HTTP 代理先关闭连接时，服务端必须强制销毁 client socket，
  // 否则半关闭 socket 会滞留 FIN_WAIT2 并泄漏 fd（服务端连接数仍为 1）。
  await waitFor(async () => (await getServerConnections(server)) === 0);
  assert.strictEqual(await getServerConnections(server), 0);

  socket.destroy();
  await waitForClose(socket);
  await closeServer(server);
  await closeServer(downstream);
}

async function testTcpConnectStatsLogReportsCounters() {
  const logs = [];
  const server = await createPlainServer({
    maxTcpConnects: 0,
    handshakeTimeoutMs: 500,
    statsLogIntervalMs: 20,
    fdCountProvider: () => 123,
    logger: { log: (message) => logs.push(message), warn: () => {} },
  });

  const socket = connect(server.address().port);
  await once(socket, 'connect');
  socket.write(Buffer.from([0x05, 0x01, 0x02]));
  assert.deepEqual(await readOnce(socket), Buffer.from([0x05, 0x02]));
  socket.write(Buffer.from([0x01, 0x01, 0x75, 0x01, 0x70]));
  assert.deepEqual(await readOnce(socket), Buffer.from([0x01, 0x00]));

  const host = Buffer.from('example.com');
  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
    host,
    Buffer.from([0x01, 0xbb]),
  ]));
  await waitForClose(socket);

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(logs.some((line) => line.includes('active=0') && line.includes('accepted=0') && line.includes('rejected=1') && line.includes('max=0') && line.includes('fds=123')));

  await closeServer(server);
}

async function testStatsIncludeSocketsStillInHandshake() {
  const logs = [];
  const server = await createPlainServer({
    handshakeTimeoutMs: 500,
    statsLogIntervalMs: 20,
    fdCountProvider: () => 123,
    fdDiagnosticsProvider: () => 'fds_total=123 fd_socket=100',
    logger: { log: (message) => logs.push(message), warn: () => {} },
  });
  const socket = connect(server.address().port);
  await once(socket, 'connect');

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(logs.some((line) =>
    line.includes('handshaking=1') &&
    line.includes('udp=0') &&
    line.includes('fds_total=123 fd_socket=100')
  ));

  socket.destroy();
  await waitForClose(socket);
  await closeServer(server);
}

// ── 认证协商：配置了凭据时，任何「未通过 0x02 认证」的路径都必须被拒绝 ──
// 回归保护：修复前 [0x05,0x01,0x00] / NMETHODS=0 / 仅 0xff 都会被应答为免认证，
// 且服务端会继续处理后续的 CONNECT / UDP ASSOCIATE 请求（认证被完全绕过）。
async function expectNegotiationRejected(port, greeting, label) {
  const socket = connect(port);
  await once(socket, 'connect');

  const received = [];
  socket.on('data', (chunk) => received.push(chunk));
  socket.write(greeting);

  // 服务端应在协商阶段回 0xff 后断开，不得再接受任何请求
  await waitForClose(socket);

  const reply = Buffer.concat(received);
  assert.ok(reply.length >= 2, `${label}: 应收到 0xff 应答，实际无应答`);
  assert.equal(reply[0], 0x05, `${label}: 版本字节应为 0x05`);
  assert.equal(reply[1], 0xff, `${label}: 应回「无可接受的方法」0xff，实际 0x${reply[1].toString(16)}`);
}

async function testSocks5RejectsUnsupportedAuthMethods() {
  const server = await createPlainServer({ handshakeTimeoutMs: 500 });
  const port = server.address().port;

  // 每条都是真实客户端/扫描器可发出的协商包；修复前均能拿到免认证应答并继续建隧道
  await expectNegotiationRejected(port, Buffer.from([0x05, 0x01, 0x00]), '仅声明无认证 0x00');
  await expectNegotiationRejected(port, Buffer.from([0x05, 0x00]), 'NMETHODS=0');
  await expectNegotiationRejected(port, Buffer.from([0x05, 0x01, 0xff]), '仅声明 unavailable 0xff');
  await expectNegotiationRejected(port, Buffer.from([0x05, 0x01, 0x01]), '仅声明 GSSAPI 0x01');

  await closeServer(server);
}

// 同时提供 0x00 和 0x02 时必须选 0x02（强认证优先），
// 不能因为 0x00 排在列表最后就降级为免认证。
async function testSocks5PrefersUserPassAuthWhenBothOffered() {
  const server = await createPlainServer({ handshakeTimeoutMs: 500 });
  const port = server.address().port;

  for (const greeting of [
    Buffer.from([0x05, 0x02, 0x00, 0x02]),
    Buffer.from([0x05, 0x02, 0x02, 0x00]),
  ]) {
    const socket = connect(port);
    await once(socket, 'connect');
    socket.write(greeting);
    assert.deepEqual(
      await readOnce(socket),
      Buffer.from([0x05, 0x02]),
      '0x00 与 0x02 同时提供时应选 0x02'
    );

    // 随后用错误凭据必须被拒，且不能进入请求阶段
    socket.write(Buffer.from([0x01, 0x03, 0x62, 0x61, 0x64, 0x03, 0x62, 0x61, 0x64]));
    assert.deepEqual(await readOnce(socket), Buffer.from([0x01, 0xff]));
    await waitForClose(socket);
  }

  await closeServer(server);
}

// UDP ASSOCIATE 也必须受认证保护；修复前无凭据即可获得开放 UDP 中继。
async function testSocks5UdpAssociateRequiresAuth() {
  const server = await createPlainServer({ handshakeTimeoutMs: 500 });
  const port = server.address().port;

  const socket = connect(port);
  await once(socket, 'connect');
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  assert.deepEqual(await readOnce(socket), Buffer.from([0x05, 0xff]));

  // 即便继续发送 UDP ASSOCIATE，连接也应已被关闭，不会得到 rep=0x00 的批准
  socket.write(Buffer.from([0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
  await waitForClose(socket);
  assert.equal(socket.destroyed, true);

  await closeServer(server);
}

// 未配置主凭据时保持原语义：0x02 仍优先（后台生成的临时凭据靠它连接），
// 只有客户端明确提供 0x00 时才免认证。
async function testSocks5KeepsUserPassPreferredWithoutMainCredentials() {
  const server = await createPlainServer({
    authCredentials: { username: '', password: '' },
  });
  const port = server.address().port;

  for (const greeting of [
    Buffer.from([0x05, 0x02, 0x00, 0x02]),
    Buffer.from([0x05, 0x02, 0x02, 0x00]),
  ]) {
    const socket = connect(port);
    await once(socket, 'connect');
    socket.write(greeting);
    assert.deepEqual(
      await readOnce(socket),
      Buffer.from([0x05, 0x02]),
      '未配置主凭据时仍应优先选 0x02（兼容后台临时凭据）'
    );
    socket.destroy();
    await waitForClose(socket);
  }

  // 仅声明 0x00（如不配凭据的客户端）→ 免认证
  const socket = connect(port);
  await once(socket, 'connect');
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  assert.deepEqual(await readOnce(socket), Buffer.from([0x05, 0x00]));
  socket.destroy();
  await waitForClose(socket);

  // 声明了 0x02 但服务端无主凭据也无临时凭据时，应回认证失败
  const bad = connect(port);
  await once(bad, 'connect');
  bad.write(Buffer.from([0x05, 0x01, 0x02]));
  assert.deepEqual(await readOnce(bad), Buffer.from([0x05, 0x02]));
  bad.write(Buffer.from([0x01, 0x03, 0x62, 0x61, 0x64, 0x03, 0x62, 0x61, 0x64]));
  assert.deepEqual(await readOnce(bad), Buffer.from([0x01, 0xff]));
  await waitForClose(bad);

  await closeServer(server);
}

// 未配置凭据时保持原行为：0x00 免认证照常可用（内网/开发场景不受本次修复影响）
async function testSocks5AllowsNoAuthWhenNoCredentialsConfigured() {
  const downstream = await createDownstreamProxy();
  const server = await createPlainServer({
    downstreamProxyPort: downstream.address().port,
    authCredentials: { username: '', password: '' },
  });

  // 无凭据模式下客户端声明 0x00，服务端应回 0x00 并允许建立隧道
  const socket = connect(server.address().port);
  await once(socket, 'connect');
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  assert.deepEqual(await readOnce(socket), Buffer.from([0x05, 0x00]));

  const host = Buffer.from('noauth.example');
  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
    host,
    Buffer.from([0x01, 0xbb]),
  ]));
  const response = await readOnce(socket);
  assert.equal(response[0], 0x05);
  assert.equal(response[1], 0x00, '无凭据模式应照常允许 CONNECT');

  socket.destroy();
  await waitForClose(socket);

  await closeServer(server);
  await closeServer(downstream);
}

(async () => {
  await testHandshakeTimeoutClosesIdleSocket();
  await testTcpConnectLimitRejectsNewConnect();
  await testTcpConnectCleanupReleasesCapacity();
  await testDownstreamCloseDestroysClientSocket();
  await testSocks5RejectsUnsupportedAuthMethods();
  await testSocks5PrefersUserPassAuthWhenBothOffered();
  await testSocks5UdpAssociateRequiresAuth();
  await testSocks5AllowsNoAuthWhenNoCredentialsConfigured();
  await testSocks5KeepsUserPassPreferredWithoutMainCredentials();
  await testTcpConnectStatsLogReportsCounters();
  await testStatsIncludeSocketsStillInHandshake();
  console.log('socks5 server limit tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
