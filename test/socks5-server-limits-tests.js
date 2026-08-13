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

  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  assert.deepEqual(await readOnce(socket), Buffer.from([0x05, 0x00]));

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
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  assert.deepEqual(await readOnce(socket), Buffer.from([0x05, 0x00]));

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
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  assert.deepEqual(await readOnce(socket), Buffer.from([0x05, 0x00]));

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

(async () => {
  await testHandshakeTimeoutClosesIdleSocket();
  await testTcpConnectLimitRejectsNewConnect();
  await testTcpConnectCleanupReleasesCapacity();
  await testDownstreamCloseDestroysClientSocket();
  await testTcpConnectStatsLogReportsCounters();
  await testStatsIncludeSocketsStillInHandshake();
  console.log('socks5 server limit tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
