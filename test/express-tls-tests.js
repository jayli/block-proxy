// 8004 管理面板 HTTPS 单元测试：node test/express-tls-tests.js
//
// 覆盖两件事：
//   1. ensurePanelCert 的生成/幂等/SAN（localhost + 127.0.0.1 + 本机内网 IPv4）
//   2. 真实面板只在 TLS 上提供服务（纯 HTTPS 单栈，同端口不再接受明文）
//
// 证书一律生成到临时目录，不碰仓库里的 cert/express_tls.*。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { once } = require('events');

const { ensurePanelCert, inspectPanelCert } = require('../cert/generator');

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bp-panel-tls-${label}-`));
}

function localIpv4() {
  const ips = [];
  for (const name of Object.keys(os.networkInterfaces())) {
    for (const iface of os.networkInterfaces()[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

async function testPanelCertGeneration() {
  const dir = makeTempDir('gen');
  const keyPath = path.join(dir, 'express_tls.key');
  const certPath = path.join(dir, 'express_tls.crt');

  const first = await ensurePanelCert(keyPath, certPath);
  assert.strictEqual(first.generated, true, '首次调用应生成证书');
  assert.ok(fs.existsSync(keyPath), '私钥应已写入');
  assert.ok(fs.existsSync(certPath), '证书应已写入');

  const keyMode = fs.statSync(keyPath).mode & 0o777;
  assert.strictEqual(keyMode, 0o600, `私钥权限应为 0600，实际 ${keyMode.toString(8)}`);

  // SAN：localhost + 127.0.0.1 + 本机全部内网 IPv4
  const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
  assert.ok(cert.checkHost('localhost'), 'SAN 应覆盖 localhost');
  assert.ok(cert.checkIP('127.0.0.1'), 'SAN 应覆盖 127.0.0.1');

  const ips = localIpv4();
  for (const ip of ips) {
    assert.ok(cert.checkIP(ip), `SAN 应覆盖本机内网 IP ${ip}`);
  }
  // 未纳入的地址必须不命中，确认匹配不是恒真
  assert.strictEqual(cert.checkIP('10.255.255.254'), undefined);

  // 有效期 30 年（留一天余量）
  const notAfter = new Date(cert.validTo);
  const minYears = 29;
  assert.ok(
    notAfter.getFullYear() - new Date().getFullYear() >= minYears,
    `证书有效期应约 30 年，实际到期 ${cert.validTo}`
  );

  // 幂等：再次调用不重写
  const beforeMtime = fs.statSync(certPath).mtimeMs;
  const second = await ensurePanelCert(keyPath, certPath);
  assert.strictEqual(second.generated, false, '已存在且可用时不应重新生成');
  assert.strictEqual(fs.statSync(certPath).mtimeMs, beforeMtime, '已存在时不应改动文件');

  // 残缺（只删证书）时重新生成一对
  fs.unlinkSync(certPath);
  const third = await ensurePanelCert(keyPath, certPath);
  assert.strictEqual(third.generated, true, '残缺时应重新生成');
  assert.ok(fs.existsSync(certPath), '残缺恢复后证书应存在');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('  ✓ ensurePanelCert 生成/权限/SAN/幂等/残缺恢复');
}

// 「没有可用证书」的几种情形都应当重签，而不是靠用户手动删文件
async function testPanelCertUnusableCases() {
  const dir = makeTempDir('unusable');
  const keyPath = path.join(dir, 'express_tls.key');
  const certPath = path.join(dir, 'express_tls.crt');

  // 基线：一份可用证书
  await ensurePanelCert(keyPath, certPath);
  assert.strictEqual(inspectPanelCert(keyPath, certPath).usable, true, '基线证书应可用');
  const goodKey = fs.readFileSync(keyPath);
  const goodCert = fs.readFileSync(certPath);

  // 1) 证书文件是垃圾内容
  fs.writeFileSync(certPath, 'not a certificate');
  let verdict = inspectPanelCert(keyPath, certPath);
  assert.strictEqual(verdict.usable, false, '垃圾证书应判定不可用');
  assert.ok(/无法解析/.test(verdict.reason), `理由应提到无法解析，实际: ${verdict.reason}`);
  let result = await ensurePanelCert(keyPath, certPath);
  assert.strictEqual(result.generated, true, '垃圾证书应触发重签');

  // 2) 私钥与证书不配对（拿另一对证书的公钥配这份私钥）
  const otherDir = makeTempDir('other');
  await ensurePanelCert(path.join(otherDir, 'k.pem'), path.join(otherDir, 'c.pem'));
  fs.writeFileSync(keyPath, goodKey);
  fs.writeFileSync(certPath, fs.readFileSync(path.join(otherDir, 'c.pem')));
  verdict = inspectPanelCert(keyPath, certPath);
  assert.strictEqual(verdict.usable, false, '公私钥不配对应判定不可用');
  assert.ok(/不配对/.test(verdict.reason), `理由应提到不配对，实际: ${verdict.reason}`);
  result = await ensurePanelCert(keyPath, certPath);
  assert.strictEqual(result.generated, true, '不配对应触发重签');

  // 3) SAN 不覆盖本机内网 IP（模拟旧版只签 localhost + 127.0.0.1 的证书）
  const selfsigned = require('selfsigned');
  const narrow = await selfsigned.generate([{ name: 'commonName', value: 'BlockProxy-panel' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'subjectAltName', altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' }
      ] }
    ]
  });
  fs.writeFileSync(keyPath, narrow.private);
  fs.writeFileSync(certPath, narrow.cert);
  verdict = inspectPanelCert(keyPath, certPath);
  const ips = localIpv4();
  if (ips.length > 0) {
    assert.strictEqual(verdict.usable, false, 'SAN 未覆盖内网 IP 应判定不可用');
    assert.ok(/SAN 未覆盖本机内网 IP/.test(verdict.reason), `理由应提到 SAN，实际: ${verdict.reason}`);
    result = await ensurePanelCert(keyPath, certPath);
    assert.strictEqual(result.generated, true, 'SAN 不覆盖内网 IP 应触发重签');
    const renewed = new crypto.X509Certificate(fs.readFileSync(certPath));
    for (const ip of ips) {
      assert.ok(renewed.checkIP(ip), `重签后 SAN 应覆盖 ${ip}`);
    }
  }

  // 4) 只缺一个文件
  fs.writeFileSync(keyPath, goodKey);
  fs.writeFileSync(certPath, goodCert);
  fs.unlinkSync(certPath);
  result = await ensurePanelCert(keyPath, certPath);
  assert.strictEqual(result.generated, true, '残缺时应重新生成');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(otherDir, { recursive: true, force: true });
  console.log('  ✓ 垃圾证书/公私钥不配对/SAN 缺内网 IP/缺文件 都触发重签');
}

function httpsGet(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method: 'GET',
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(3000, () => req.destroy(new Error('HTTPS 请求超时')));
    req.on('error', reject);
    req.end();
  });
}

// 明文 HTTP 打到 HTTPS 端口：TLS 握手失败，读不到任何合法 HTTP 响应
function plainHttpToTlsPort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write('GET /api/server-ip HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    });
    const chunks = [];
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', () => resolve({ body: Buffer.concat(chunks).toString('utf8') }));
    socket.on('close', () => resolve({ body: Buffer.concat(chunks).toString('utf8') }));
  });
}

async function testPanelServesHttpsOnly() {
  // express.js 在 require 时就会读 config.json 等模块，这里只起 server 不发 init，
  // 用同一份 app + 同一份证书路径手工验证「单栈 HTTPS」这一点。
  const dir = makeTempDir('serve');
  const keyPath = path.join(dir, 'express_tls.key');
  const certPath = path.join(dir, 'express_tls.crt');
  await ensurePanelCert(keyPath, certPath);

  const { _test } = require('../server/express');
  const tlsOptions = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
    minVersion: 'TLSv1.2',
  };
  assert.ok(_test.readPanelTlsOptions, 'express 应导出 readPanelTlsOptions');

  const server = https.createServer(tlsOptions, _test.app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const res = await httpsGet(port, '/api/server-ip');
    assert.strictEqual(res.statusCode, 200, `HTTPS 应返回 200，实际 ${res.statusCode}`);
    const payload = JSON.parse(res.body);
    assert.ok(Array.isArray(payload.ips), '响应应是 server-ip 的 JSON');

    const plain = await plainHttpToTlsPort(port);
    assert.ok(
      !plain.body.includes('HTTP/1.1'),
      `明文 HTTP 打到 TLS 端口不应拿到 HTTP 响应，实际收到: ${JSON.stringify(plain.body)}`
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('  ✓ 面板在 TLS 上提供 /api/server-ip，且同端口不接受明文 HTTP');
}

(async function main() {
  console.log('express tls tests');
  await testPanelCertGeneration();
  await testPanelCertUnusableCases();
  await testPanelServesHttpsOnly();
  console.log('全部通过');
})().catch(err => {
  console.error('测试失败:', err && err.stack ? err.stack : err);
  process.exit(1);
});
