// 认证豁免白名单单元测试：node test/auth-bypass-hosts-tests.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const authBypassHosts = require('../proxy/auth-bypass-hosts');

function useTempFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bp-auth-bypass-${label}-`));
  const file = path.join(dir, 'auth_bypass_hosts.json');
  authBypassHosts.configure({ filePath: file });
  return file;
}

function writeRaw(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  authBypassHosts.configure({ filePath: file });
}

function testReadReturnsHostsFromFile() {
  const file = useTempFile('read');
  writeRaw(file, { hosts: ['ets100.com', 'eduaiplat.com'] });

  const result = authBypassHosts.read();
  assert.deepStrictEqual(result.hosts, ['ets100.com', 'eduaiplat.com']);
}

function testReadMissingFileReturnsEmptyList() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-auth-bypass-none-'));
  authBypassHosts.configure({ filePath: path.join(dir, 'missing.json') });

  const result = authBypassHosts.read();
  assert.deepStrictEqual(result.hosts, []);
}

function testReadCorruptFileReturnsEmptyList() {
  const file = useTempFile('corrupt');
  fs.writeFileSync(file, '{ not valid json', 'utf8');
  authBypassHosts.configure({ filePath: file });

  const result = authBypassHosts.read();
  assert.deepStrictEqual(result.hosts, []);
}

function testReadNormalizesAndDeduplicates() {
  const file = useTempFile('normalize');
  writeRaw(file, { hosts: ['  ETS100.com ', 'ets100.com', '', 'aliyuncs.com'] });

  const result = authBypassHosts.read();
  assert.deepStrictEqual(result.hosts, ['ets100.com', 'aliyuncs.com']);
}

function testReadIgnoresNonStringItems() {
  const file = useTempFile('nonstring');
  writeRaw(file, { hosts: ['a.com', 42, null, { x: 1 }, 'b.com'] });

  const result = authBypassHosts.read();
  assert.deepStrictEqual(result.hosts, ['a.com', 'b.com']);
}

function testReadAcceptsLegacyArrayShape() {
  const file = useTempFile('legacy');
  writeRaw(file, ['a.com', 'b.com']);

  const result = authBypassHosts.read();
  assert.deepStrictEqual(result.hosts, ['a.com', 'b.com']);
}

function testWriteRoundTrip() {
  const file = useTempFile('write');
  const written = authBypassHosts.write(['ets100.com', 'eduaiplat.com']);

  assert.deepStrictEqual(written, ['ets100.com', 'eduaiplat.com']);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(onDisk.hosts, ['ets100.com', 'eduaiplat.com']);

  // 写后读一致
  assert.deepStrictEqual(authBypassHosts.read().hosts, written);
}

function testWriteTrimsLowercasesAndDeduplicates() {
  useTempFile('write-norm');
  const written = authBypassHosts.write(['  ETS100.com ', 'ets100.com', 'aliyuncs.com']);

  assert.deepStrictEqual(written, ['ets100.com', 'aliyuncs.com']);
}

function testWriteRejectsNonArray() {
  useTempFile('write-nonarray');
  assert.throws(() => authBypassHosts.write('ets100.com'), /必须是数组/);
  assert.throws(() => authBypassHosts.write(null), /必须是数组/);
}

function testWriteRejectsInvalidItems() {
  useTempFile('write-invalid');
  assert.throws(() => authBypassHosts.write(['a.com', '']), /非法域名/);
  assert.throws(() => authBypassHosts.write(['a.com', 'has space.com']), /非法域名/);
  assert.throws(() => authBypassHosts.write(['a.com', 'https://a.com']), /非法域名/);
  assert.throws(() => authBypassHosts.write(['a.com', '*.a.com']), /非法域名/);
  assert.throws(() => authBypassHosts.write(['a.com', 42]), /非法域名/);
}

function testWriteAllowsPortSuffix() {
  useTempFile('write-port');
  const written = authBypassHosts.write(['xiaohongshu.com:443']);
  assert.deepStrictEqual(written, ['xiaohongshu.com:443']);
}

function testLoadConfigRefreshesAuthPassHosts() {
  // 端到端：proxy.js 的 loadConfig 应把白名单文件读进 authPass
  const file = useTempFile('loadconfig');
  writeRaw(file, { hosts: ['bypass-test.example.com'] });

  const LocalProxy = require('../proxy/proxy');
  return LocalProxy._test.loadConfig().then(() => {
    const authPass = LocalProxy._test.authPass;
    assert.strictEqual(authPass('https', 'api.bypass-test.example.com:443', null), true);
    assert.strictEqual(authPass('https', 'unrelated.example.org:443', null), false);
  });
}

const tests = [
  testReadReturnsHostsFromFile,
  testReadMissingFileReturnsEmptyList,
  testReadCorruptFileReturnsEmptyList,
  testReadNormalizesAndDeduplicates,
  testReadIgnoresNonStringItems,
  testReadAcceptsLegacyArrayShape,
  testWriteRoundTrip,
  testWriteTrimsLowercasesAndDeduplicates,
  testWriteRejectsNonArray,
  testWriteRejectsInvalidItems,
  testWriteAllowsPortSuffix,
  testLoadConfigRefreshesAuthPassHosts
];

(async () => {
  for (const testFn of tests) {
    await testFn();
    console.log(`PASS ${testFn.name}`);
  }
  console.log('auth bypass hosts tests passed');
})().catch((error) => {
  console.error('FAIL', error);
  process.exit(1);
});
