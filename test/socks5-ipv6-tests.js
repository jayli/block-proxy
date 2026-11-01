'use strict';

// 8002「公网代理」端口的 IPv6 目标转发测试。
// 覆盖：SOCKS5 ATYP=0x04 解析、IPv6 authority 格式化、sendResponse 22 字节，
// 以及端到端：IPv6 目标经 SOCKS5 / HTTP CONNECT 两条入口转发给下游 8001 时
// 必须带方括号（否则冒号会被当成端口分隔符）。
// 下游用一个假的 8001 HTTP 代理（回 200 后进入 echo 模式），不依赖真实网络。

const assert = require('assert');
const net = require('net');
const { once } = require('events');
const Socks5 = require('../socks5/server');

const silentLogger = { log: () => {}, warn: () => {} };

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
      // 隧道建立后进入 echo
      socket.pipe(socket);
    };
    socket.on('data', onData);
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port, received };
}

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

function connect(port) {
  return net.createConnection({ host: '127.0.0.1', port });
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

// ── 单元测试：parseAddress / formatConnectAuthority / sendResponse ──

function testParseAddressIpv6ReturnsBareAddress() {
  const { parseAddress } = Socks5._test;
  // 2001:db8::1 → 16 字节
  const ipv6 = Buffer.from('20010db8000000000000000000000001', 'hex');
  const buf = Buffer.concat([Buffer.from([0x04]), ipv6, Buffer.from([0x01, 0xbb])]);
  const { host, port, nextOffset } = parseAddress(buf, 0);
  // 关键断言：返回裸地址（不带方括号），且 2001 没有被 /00/g 损坏成 201
  assert.strictEqual(host, '2001:db8:0:0:0:0:0:1');
  assert.ok(net.isIPv6(host), 'parseAddress 返回的必须是合法 IPv6');
  assert.strictEqual(port, 443);
  assert.strictEqual(nextOffset, 19);
}

function testParseAddressIpv6DoesNotCorruptGroups() {
  const { parseAddress } = Socks5._test;
  // 全零 + 末尾 1：回归 /00/g 会把组内十六进制位损坏的 bug
  const cases = [
    ['20010db8000000000000000000000001', '2001:db8:0:0:0:0:0:1'],
    ['00000000000000000000000000000001', '0:0:0:0:0:0:0:1'],
    ['fe800000000000000000000000000001', 'fe80:0:0:0:0:0:0:1'],
    ['240c409f1000000000000004000000a5', '240c:409f:1000:0:0:4:0:a5'],
  ];
  for (const [hex, expected] of cases) {
    const buf = Buffer.concat([Buffer.from([0x04]), Buffer.from(hex, 'hex'), Buffer.from([0x00, 0x50])]);
    const { host } = parseAddress(buf, 0);
    assert.strictEqual(host, expected, `hex=${hex}`);
    assert.ok(net.isIPv6(host), `hex=${hex} 结果必须是合法 IPv6`);
  }
}

function testFormatConnectAuthorityBracketsIpv6Only() {
  const { formatConnectAuthority } = Socks5._test;
  assert.strictEqual(formatConnectAuthority('2001:db8::1', 443), '[2001:db8::1]:443');
  assert.strictEqual(formatConnectAuthority('::1', 8443), '[::1]:8443');
  // IPv4 与域名保持原样
  assert.strictEqual(formatConnectAuthority('1.2.3.4', 443), '1.2.3.4:443');
  assert.strictEqual(formatConnectAuthority('example.com', 443), 'example.com:443');
}

function testSendResponseIpv6DoesNotThrowAndIs22Bytes() {
  const { sendResponse } = Socks5._test;
  const writes = [];
  const fakeSocket = { write: (data) => writes.push(Buffer.from(data)) };
  // 旧实现用 10 字节 buffer 上 fill(0,4,20) 会抛 RangeError；这里必须不抛
  assert.doesNotThrow(() => sendResponse(fakeSocket, 0x00, 0x04));
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].length, 22, 'IPv6 响应体必须是 22 字节');
  assert.strictEqual(writes[0][0], 0x05);
  assert.strictEqual(writes[0][1], 0x00);
  assert.strictEqual(writes[0][3], 0x04);
}

function testSendResponseIpv4StillWorks() {
  const { sendResponse } = Socks5._test;
  const writes = [];
  const fakeSocket = { write: (data) => writes.push(Buffer.from(data)) };
  sendResponse(fakeSocket, 0x00, 0x01);
  assert.strictEqual(writes[0].length, 10, 'IPv4 响应体仍是 10 字节');
  assert.strictEqual(writes[0][3], 0x01);
}

// ── 端到端：SOCKS5 入口 IPv6 目标 ────────────────────────────

async function testSocks5Ipv6TargetForwardsBracketedToDownstream() {
  const downstream = await createDownstreamProxy();
  const server = await createPublicProxyServer({ downstreamProxyPort: downstream.port });
  const socket = connect(server.address().port);
  await once(socket, 'connect');

  // 方法协商：免认证
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  assert.deepEqual(await readOnce(socket), Buffer.from([0x05, 0x00]));

  // CONNECT 到 IPv6 目标 2001:db8::1:443
  const ipv6 = Buffer.from('20010db8000000000000000000000001', 'hex');
  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x04]),
    ipv6,
    Buffer.from([0x01, 0xbb]),
  ]));
  const reply = await readOnce(socket);
  assert.strictEqual(reply[0], 0x05);
  assert.strictEqual(reply[1], 0x00, `SOCKS5 CONNECT 失败: 0x${reply[1].toString(16)}`);

  // 关键断言：下游 8001 收到的 CONNECT 目标必须带方括号
  assert.strictEqual(downstream.received.length, 1);
  assert.ok(
    downstream.received[0].head.startsWith('CONNECT [2001:db8:0:0:0:0:0:1]:443 HTTP/1.1'),
    `下游收到的请求行不正确: ${downstream.received[0].head}`
  );
  assert.ok(
    downstream.received[0].head.includes('Host: [2001:db8:0:0:0:0:0:1]:443'),
    `Host 头必须带方括号: ${downstream.received[0].head}`
  );

  socket.destroy();
  await waitForClose(socket);
  await closeServer(server);
  await closeServer(downstream.server);
}

async function testSocks5Ipv4AndDomainTargetsUnchanged() {
  // 回归：IPv4 与域名目标的 CONNECT 行不受 IPv6 改动影响
  const downstream = await createDownstreamProxy();
  const server = await createPublicProxyServer({ downstreamProxyPort: downstream.port });

  // IPv4 目标
  const sock4 = connect(server.address().port);
  await once(sock4, 'connect');
  sock4.write(Buffer.from([0x05, 0x01, 0x00]));
  await readOnce(sock4);
  sock4.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x01]),
    Buffer.from([1, 2, 3, 4]),
    Buffer.from([0x01, 0xbb]),
  ]));
  const reply4 = await readOnce(sock4);
  assert.strictEqual(reply4[1], 0x00);
  assert.ok(downstream.received[0].head.startsWith('CONNECT 1.2.3.4:443 HTTP/1.1'));
  sock4.destroy();
  await waitForClose(sock4);

  // 域名目标
  const sockD = connect(server.address().port);
  await once(sockD, 'connect');
  sockD.write(Buffer.from([0x05, 0x01, 0x00]));
  await readOnce(sockD);
  const host = Buffer.from('example.com');
  sockD.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
    host,
    Buffer.from([0x01, 0xbb]),
  ]));
  const replyD = await readOnce(sockD);
  assert.strictEqual(replyD[1], 0x00);
  assert.ok(downstream.received[1].head.startsWith('CONNECT example.com:443 HTTP/1.1'));
  sockD.destroy();
  await waitForClose(sockD);

  await closeServer(server);
  await closeServer(downstream.server);
}

// ── 端到端：HTTP CONNECT 入口 IPv6 目标 ──────────────────────

async function testHttpConnectIpv6TargetForwardsBracketedToDownstream() {
  const downstream = await createDownstreamProxy();
  const server = await createHttpConnectServer({ downstreamProxyPort: downstream.port });
  const socket = connect(server.address().port);
  await once(socket, 'connect');

  socket.write('CONNECT [2001:db8::1]:443 HTTP/1.1\r\nHost: [2001:db8::1]:443\r\n\r\n');
  const { head } = await readUntil(socket, '\r\n\r\n');
  assert.ok(head.toString('latin1').startsWith('HTTP/1.1 200'), `应返回 200: ${head}`);

  // 关键断言：下游收到的 CONNECT 目标带方括号
  assert.strictEqual(downstream.received.length, 1);
  assert.ok(
    downstream.received[0].head.startsWith('CONNECT [2001:db8::1]:443 HTTP/1.1'),
    `下游收到的请求行不正确: ${downstream.received[0].head}`
  );

  socket.destroy();
  await waitForClose(socket);
  await closeServer(server);
  await closeServer(downstream.server);
}

async function testHttpConnectIpv6WithoutPortDefaultsTo443() {
  const downstream = await createDownstreamProxy();
  const server = await createHttpConnectServer({ downstreamProxyPort: downstream.port });
  const socket = connect(server.address().port);
  await once(socket, 'connect');

  socket.write('CONNECT [2001:db8::1] HTTP/1.1\r\nHost: [2001:db8::1]\r\n\r\n');
  const { head } = await readUntil(socket, '\r\n\r\n');
  assert.ok(head.toString('latin1').startsWith('HTTP/1.1 200'), `应返回 200: ${head}`);

  assert.strictEqual(downstream.received.length, 1);
  assert.ok(
    downstream.received[0].head.startsWith('CONNECT [2001:db8::1]:443 HTTP/1.1'),
    `无端口应默认 443: ${downstream.received[0].head}`
  );

  socket.destroy();
  await waitForClose(socket);
  await closeServer(server);
  await closeServer(downstream.server);
}

async function testHttpConnectMalformedIpv6Rejected() {
  const downstream = await createDownstreamProxy();
  const server = await createHttpConnectServer({ downstreamProxyPort: downstream.port });
  const socket = connect(server.address().port);
  await once(socket, 'connect');

  socket.write('CONNECT [::1 HTTP/1.1\r\nHost: [::1\r\n\r\n');
  const { head } = await readUntil(socket, '\r\n\r\n');
  assert.ok(head.toString('latin1').startsWith('HTTP/1.1 400'), `缺右括号应返回 400: ${head}`);
  assert.strictEqual(downstream.received.length, 0, '非法目标不应转发到下游');

  await waitForClose(socket);
  await closeServer(server);
  await closeServer(downstream.server);
}

// ── 运行 ─────────────────────────────────────────────────────

async function run() {
  testParseAddressIpv6ReturnsBareAddress();
  console.log('PASS testParseAddressIpv6ReturnsBareAddress');
  testParseAddressIpv6DoesNotCorruptGroups();
  console.log('PASS testParseAddressIpv6DoesNotCorruptGroups');
  testFormatConnectAuthorityBracketsIpv6Only();
  console.log('PASS testFormatConnectAuthorityBracketsIpv6Only');
  testSendResponseIpv6DoesNotThrowAndIs22Bytes();
  console.log('PASS testSendResponseIpv6DoesNotThrowAndIs22Bytes');
  testSendResponseIpv4StillWorks();
  console.log('PASS testSendResponseIpv4StillWorks');
  await testSocks5Ipv6TargetForwardsBracketedToDownstream();
  console.log('PASS testSocks5Ipv6TargetForwardsBracketedToDownstream');
  await testSocks5Ipv4AndDomainTargetsUnchanged();
  console.log('PASS testSocks5Ipv4AndDomainTargetsUnchanged');
  await testHttpConnectIpv6TargetForwardsBracketedToDownstream();
  console.log('PASS testHttpConnectIpv6TargetForwardsBracketedToDownstream');
  await testHttpConnectIpv6WithoutPortDefaultsTo443();
  console.log('PASS testHttpConnectIpv6WithoutPortDefaultsTo443');
  await testHttpConnectMalformedIpv6Rejected();
  console.log('PASS testHttpConnectMalformedIpv6Rejected');
  console.log('\nAll socks5-ipv6 tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
