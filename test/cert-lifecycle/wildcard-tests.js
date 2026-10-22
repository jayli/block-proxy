'use strict';

// 通配符证书行为测试：
//   - certCoversHostname 用 tls.checkServerIdentity 判定（不能用字符串 includes）
//   - ensureCert 通配符优先命中，剥不到的通配符主机降级现签
//   - 内置条目一次签出多个 SAN（裸域 + 通配符），且不被 healthCheck 误删
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');

const certLifecycle = require('../../proxy/proxy-core/cert-lifecycle');
const { ensureTestRootCA } = require('../helpers/ensure-root-ca');

ensureTestRootCA();

const ROOT_CRT = path.join(__dirname, '../../cert/rootCA.crt');
const ROOT_KEY = path.join(__dirname, '../../cert/rootCA.key');

function makeCertDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-wildcard-'));
  fs.copyFileSync(ROOT_CRT, path.join(dir, 'rootCA.crt'));
  fs.copyFileSync(ROOT_KEY, path.join(dir, 'rootCA.key'));
  certLifecycle.init({ certDir: dir });
  return dir;
}

function covers(pem, hostname) {
  return certLifecycle._test.certCoversHostname(pem, hostname);
}

test('certCoversHostname：单层子域通过，两层子域/裸域/无关域名拒绝', async () => {
  const dir = makeCertDir();
  try {
    const result = await certLifecycle.ensureCert('googlevideo.com');
    const { subjectAltName } = new crypto.X509Certificate(result.cert);

    // 内置条目应同时带裸域与通配符两个 SAN
    assert.ok(subjectAltName.includes('DNS:googlevideo.com'), '应含裸域 SAN');
    assert.ok(subjectAltName.includes('DNS:*.googlevideo.com'), '应含通配符 SAN');

    assert.strictEqual(covers(result.cert, 'googlevideo.com'), true, '裸域应覆盖');
    assert.strictEqual(covers(result.cert, 'rr1---sn-a5meknd6.googlevideo.com'), true, '单层子域应覆盖');
    assert.strictEqual(covers(result.cert, 'redirector.googlevideo.com'), true, '单层子域应覆盖');
    assert.strictEqual(covers(result.cert, 'a.b.googlevideo.com'), false, '两层子域不应覆盖');
    assert.strictEqual(covers(result.cert, 'evil.example.com'), false, '无关域名不应覆盖');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('certCoversHostname：精确主机证书与 IP SAN 语义不变', async () => {
  const dir = makeCertDir();
  try {
    const exact = await certLifecycle.ensureCert('www.baidu.com');
    assert.strictEqual(covers(exact.cert, 'www.baidu.com'), true);
    assert.strictEqual(covers(exact.cert, 'mbd.baidu.com'), false, '精确证书不覆盖兄弟子域');

    const ip = await certLifecycle.ensureCert('192.168.1.1');
    assert.strictEqual(covers(ip.cert, '192.168.1.1'), true);
    assert.strictEqual(covers(ip.cert, '192.168.1.2'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('certCoversHostname：非法输入返回 false 而不抛异常', () => {
  assert.strictEqual(covers('not-a-pem', 'example.com'), false);
  assert.strictEqual(certLifecycle._test.certCoversHostname(null, 'example.com'), false);
});

test('ensureCert：通配符优先命中，不重复签发具体证书', async () => {
  const dir = makeCertDir();
  try {
    // 先让内置通配符落地
    const wildcard = await certLifecycle.ensureCert('googlevideo.com');
    assert.strictEqual(wildcard.source, 'generated');

    // 任意未见过的新 CDN 主机都应命中通配符，且不产生具体证书文件
    const hit = await certLifecycle.ensureCert('rr9---sn-neverseen.googlevideo.com');
    assert.strictEqual(hit.source, 'wildcard');
    assert.strictEqual(String(hit.cert), String(wildcard.cert));
    assert.ok(!fs.existsSync(path.join(dir, 'rr9---sn-neverseen.googlevideo.com.crt')),
      '命中通配符时不应为具体主机落盘证书');

    // 同一主机再次请求仍然命中通配符
    const again = await certLifecycle.ensureCert('rr9---sn-neverseen.googlevideo.com');
    assert.strictEqual(again.source, 'wildcard');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureCert：通配符覆盖不到时降级现签', async () => {
  const dir = makeCertDir();
  try {
    await certLifecycle.ensureCert('googlevideo.com');

    // 两层子域：通配符只匹配一层，必须降级为现签
    const deep = await certLifecycle.ensureCert('a.b.googlevideo.com');
    assert.strictEqual(deep.source, 'generated', '两层子域应降级现签');
    const { subjectAltName } = new crypto.X509Certificate(deep.cert);
    assert.ok(subjectAltName.includes('DNS:a.b.googlevideo.com'), 'SAN 应为精确主机名');
    assert.ok(!subjectAltName.includes('*.'), '降级证书不应含通配符');
    assert.ok(fs.existsSync(path.join(dir, 'a.b.googlevideo.com.crt')), '降级证书应落盘');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureCert：没有通配符证书时行为与改造前一致', async () => {
  const dir = makeCertDir();
  try {
    const r = await certLifecycle.ensureCert('rr1---sn-fresh.googlevideo.com');
    assert.strictEqual(r.source, 'generated', '无通配符时应现签');
    assert.strictEqual(covers(r.cert, 'rr1---sn-fresh.googlevideo.com'), true);

    const cached = await certLifecycle.ensureCert('rr1---sn-fresh.googlevideo.com');
    assert.strictEqual(cached.source, 'cache');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findWildcardCache：未生成时返回 null，生成后返回通配符', async () => {
  const dir = makeCertDir();
  try {
    assert.strictEqual(certLifecycle._test.findWildcardCache('x.googlevideo.com'), null);

    await certLifecycle.ensureCert('googlevideo.com');
    const hit = certLifecycle._test.findWildcardCache('x.googlevideo.com');
    assert.ok(hit, '应命中通配符');
    assert.strictEqual(hit.source, 'wildcard');
    assert.strictEqual(hit.matchedWildcard, 'googlevideo.com');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findWildcardCache：通配符证书损坏后不命中', async () => {
  const dir = makeCertDir();
  try {
    await certLifecycle.ensureCert('googlevideo.com');
    assert.ok(certLifecycle._test.findWildcardCache('x.googlevideo.com'));

    fs.writeFileSync(path.join(dir, 'googlevideo.com.crt'), 'corrupted');
    assert.strictEqual(certLifecycle._test.findWildcardCache('x.googlevideo.com'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('healthCheck 不会删除通配符证书', async () => {
  const dir = makeCertDir();
  try {
    await certLifecycle.ensureCert('googlevideo.com');
    await certLifecycle.ensureCert('c.youtube.com');

    const result = await certLifecycle.healthCheck();
    assert.strictEqual(result.removed, 0, '通配符证书应被保留');
    assert.ok(result.kept >= 2);
    assert.ok(fs.existsSync(path.join(dir, 'googlevideo.com.crt')));
    assert.ok(fs.existsSync(path.join(dir, 'c.youtube.com.crt')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getDomainsToPrewarm 包含内置通配符条目', () => {
  const domains = certLifecycle.getDomainsToPrewarm({ block_hosts: [] });
  for (const entry of certLifecycle._test.BUILTIN_WILDCARDS) {
    assert.ok(domains.includes(entry.hostname), `预热列表应包含 ${entry.hostname}`);
  }
});

test('c.youtube.com 通配符覆盖 rrN 主机', async () => {
  const dir = makeCertDir();
  try {
    await certLifecycle.ensureCert('c.youtube.com');
    const hit = await certLifecycle.ensureCert('rr1---sn-a5meknd6.c.youtube.com');
    assert.strictEqual(hit.source, 'wildcard');
    assert.strictEqual(covers(hit.cert, 'rr1---sn-a5meknd6.c.youtube.com'), true);
    // 但不应越界覆盖 youtube.com 其他主机
    assert.strictEqual(covers(hit.cert, 'www.youtube.com'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('通配符证书能建立 TLS context（可实际用于握手）', async () => {
  const dir = makeCertDir();
  try {
    await certLifecycle.ensureCert('googlevideo.com');
    const hit = await certLifecycle.ensureCert('rr1---sn-tls.googlevideo.com');
    assert.doesNotThrow(() => tls.createSecureContext({ key: hit.key, cert: hit.cert }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('存量仅裸域证书会被升级为带通配符 SAN（回归：通配符曾因缓存命中而永不生效）', async () => {
  const dir = makeCertDir();
  try {
    // 造一张「改造前」形态的证书：只含裸域 SAN，validateCache 会判为有效
    const selfsigned = require('selfsigned');
    const rootCrt = fs.readFileSync(path.join(dir, 'rootCA.crt'), 'utf8');
    const rootKey = fs.readFileSync(path.join(dir, 'rootCA.key'), 'utf8');
    const legacy = await selfsigned.generate([{ name: 'commonName', value: 'googlevideo.com' }], {
      keyType: 'rsa',
      keySize: 2048,
      algorithm: 'sha256',
      ca: { cert: rootCrt, key: rootKey },
      notAfterDate: new Date(Date.now() + 824 * 24 * 60 * 60 * 1000),
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'subjectAltName', altNames: [{ type: 2, value: 'googlevideo.com' }] },
      ],
    });
    fs.writeFileSync(path.join(dir, 'googlevideo.com.key'), legacy.private);
    fs.writeFileSync(path.join(dir, 'googlevideo.com.crt'), legacy.cert);
    assert.strictEqual(covers(legacy.cert, 'a.googlevideo.com'), false, '存量证书确实覆盖不了子域');

    // 预热时应该识别出「SAN 不全」并重新签发
    await certLifecycle.prewarmCerts(certLifecycle.getDomainsToPrewarm({ block_hosts: [] }));

    const upgraded = fs.readFileSync(path.join(dir, 'googlevideo.com.crt'));
    assert.strictEqual(covers(upgraded, 'a.googlevideo.com'), true, '升级后应能覆盖单层子域');
    assert.strictEqual(covers(upgraded, 'googlevideo.com'), true, '升级后仍覆盖裸域');

    const hit = await certLifecycle.ensureCert('a.googlevideo.com');
    assert.strictEqual(hit.source, 'wildcard', '子域应命中通配符而不是现签');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
