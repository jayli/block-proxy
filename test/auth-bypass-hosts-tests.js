// 认证豁免白名单单元测试：node test/auth-bypass-hosts-tests.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const authBypassHosts = require('../proxy/auth-bypass-hosts');

// 每个用例用独立的临时目录，内置 + 临时两份文件都指过去
function useTempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bp-auth-bypass-${label}-`));
  const builtin = path.join(dir, 'auth_bypass_hosts.json');
  const temp = path.join(dir, 'temp_auth_bypass_hosts.json');
  authBypassHosts.configure({ builtinFilePath: builtin, tempFilePath: temp });
  return { dir, builtin, temp };
}

function writeRaw(file, obj) {
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2), 'utf8');
}

// ---------- 内置名单 ----------

function testReadBuiltinReturnsHostsFromFile() {
  const { builtin } = useTempDir('builtin-read');
  writeRaw(builtin, { hosts: ['ets100.com', 'eduaiplat.com'] });

  assert.deepStrictEqual(authBypassHosts.readBuiltin(), ['ets100.com', 'eduaiplat.com']);
}

function testReadBuiltinMissingFileReturnsEmptyList() {
  useTempDir('builtin-none');
  assert.deepStrictEqual(authBypassHosts.readBuiltin(), []);
}

function testReadBuiltinCorruptFileReturnsEmptyList() {
  const { builtin } = useTempDir('builtin-corrupt');
  writeRaw(builtin, '{ not valid json');

  assert.deepStrictEqual(authBypassHosts.readBuiltin(), []);
}

function testReadBuiltinNormalizesAndDeduplicates() {
  const { builtin } = useTempDir('builtin-norm');
  writeRaw(builtin, { hosts: ['  ETS100.com ', 'ets100.com', '', 'aliyuncs.com'] });

  assert.deepStrictEqual(authBypassHosts.readBuiltin(), ['ets100.com', 'aliyuncs.com']);
}

function testReadBuiltinIgnoresNonStringItems() {
  const { builtin } = useTempDir('builtin-nonstring');
  writeRaw(builtin, { hosts: ['a.com', 42, null, { x: 1 }, 'b.com'] });

  assert.deepStrictEqual(authBypassHosts.readBuiltin(), ['a.com', 'b.com']);
}

function testReadBuiltinAcceptsLegacyArrayShape() {
  const { builtin } = useTempDir('builtin-legacy');
  writeRaw(builtin, ['a.com', 'b.com']);

  assert.deepStrictEqual(authBypassHosts.readBuiltin(), ['a.com', 'b.com']);
}

function testBuiltinHasNoWriteApi() {
  // 内置名单必须只读：模块不得暴露任何写内置的函数
  assert.strictEqual(typeof authBypassHosts.write, 'undefined', 'write 应已移除');
  assert.strictEqual(typeof authBypassHosts.writeBuiltin, 'undefined', '不应有 writeBuiltin');
  assert.strictEqual(typeof authBypassHosts.writeTemp, 'function');
}

// ---------- 临时名单 ----------

function testReadTempMissingFileReturnsEmptyList() {
  useTempDir('temp-none');
  assert.deepStrictEqual(authBypassHosts.readTemp(), []);
}

function testWriteTempRoundTrip() {
  const { temp } = useTempDir('temp-write');
  const written = authBypassHosts.writeTemp(['ets100.com', 'eduaiplat.com']);

  assert.deepStrictEqual(written, ['ets100.com', 'eduaiplat.com']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(temp, 'utf8')).hosts, written);
  assert.deepStrictEqual(authBypassHosts.readTemp(), written);
}

function testWriteTempTrimsLowercasesAndDeduplicates() {
  useTempDir('temp-norm');
  assert.deepStrictEqual(
    authBypassHosts.writeTemp(['  ETS100.com ', 'ets100.com', 'aliyuncs.com']),
    ['ets100.com', 'aliyuncs.com']
  );
}

function testWriteTempRejectsNonArray() {
  useTempDir('temp-nonarray');
  assert.throws(() => authBypassHosts.writeTemp('ets100.com'), /必须是数组/);
  assert.throws(() => authBypassHosts.writeTemp(null), /必须是数组/);
}

function testWriteTempRejectsInvalidItems() {
  useTempDir('temp-invalid');
  assert.throws(() => authBypassHosts.writeTemp(['a.com', '']), /非法域名/);
  assert.throws(() => authBypassHosts.writeTemp(['a.com', 'has space.com']), /非法域名/);
  assert.throws(() => authBypassHosts.writeTemp(['a.com', 'https://a.com']), /非法域名/);
  assert.throws(() => authBypassHosts.writeTemp(['a.com', '*.a.com']), /非法域名/);
  assert.throws(() => authBypassHosts.writeTemp(['a.com', 42]), /非法域名/);
}

function testWriteTempAllowsPortSuffix() {
  useTempDir('temp-port');
  assert.deepStrictEqual(authBypassHosts.writeTemp(['xiaohongshu.com:443']), ['xiaohongshu.com:443']);
}

function testWriteTempDoesNotTouchBuiltinFile() {
  const { builtin, temp } = useTempDir('temp-isolation');
  writeRaw(builtin, { hosts: ['builtin-only.com'] });

  authBypassHosts.writeTemp(['temp-only.com']);

  assert.deepStrictEqual(JSON.parse(fs.readFileSync(builtin, 'utf8')).hosts, ['builtin-only.com']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(temp, 'utf8')).hosts, ['temp-only.com']);
}

function testWriteTempEmptyListClearsFile() {
  useTempDir('temp-clear');
  authBypassHosts.writeTemp(['a.com']);
  assert.deepStrictEqual(authBypassHosts.writeTemp([]), []);
  assert.deepStrictEqual(authBypassHosts.readTemp(), []);
}

// ---------- 合并 ----------

function testReadAllMergesBuiltinAndTemp() {
  const { builtin, temp } = useTempDir('merge');
  writeRaw(builtin, { hosts: ['builtin-a.com', 'shared.com'] });
  writeRaw(temp, { hosts: ['shared.com', 'temp-b.com'] });

  const all = authBypassHosts.readAll();
  assert.deepStrictEqual(all.builtin, ['builtin-a.com', 'shared.com']);
  assert.deepStrictEqual(all.temp, ['shared.com', 'temp-b.com']);
  // 内置优先，重复项只出现一次
  assert.deepStrictEqual(all.hosts, ['builtin-a.com', 'shared.com', 'temp-b.com']);
}

function testReadAllWithOnlyBuiltin() {
  const { builtin } = useTempDir('merge-builtin-only');
  writeRaw(builtin, { hosts: ['builtin-a.com'] });

  const all = authBypassHosts.readAll();
  assert.deepStrictEqual(all.hosts, ['builtin-a.com']);
  assert.deepStrictEqual(all.temp, []);
}

function testReadAllWithOnlyTemp() {
  const { temp } = useTempDir('merge-temp-only');
  writeRaw(temp, { hosts: ['temp-a.com'] });

  const all = authBypassHosts.readAll();
  assert.deepStrictEqual(all.hosts, ['temp-a.com']);
  assert.deepStrictEqual(all.builtin, []);
}

function testReadAllBothMissingReturnsEmpty() {
  useTempDir('merge-empty');
  assert.deepStrictEqual(authBypassHosts.readAll(), { builtin: [], temp: [], hosts: [] });
}

function testReadAllBothCorruptReturnsEmpty() {
  const { builtin, temp } = useTempDir('merge-corrupt');
  writeRaw(builtin, 'broken{');
  writeRaw(temp, 'broken{');

  assert.deepStrictEqual(authBypassHosts.readAll().hosts, []);
}

function testReadIsBackwardCompatible() {
  const { builtin, temp } = useTempDir('compat');
  writeRaw(builtin, { hosts: ['builtin-a.com'] });
  writeRaw(temp, { hosts: ['temp-a.com'] });

  assert.deepStrictEqual(authBypassHosts.read(), { hosts: ['builtin-a.com', 'temp-a.com'] });
}

// ---------- 端到端：proxy.js loadConfig ----------

function testLoadConfigMergesBothListsIntoAuthPass() {
  const { builtin, temp } = useTempDir('loadconfig');
  writeRaw(builtin, { hosts: ['builtin-pass.example.com'] });
  writeRaw(temp, { hosts: ['temp-pass.example.com'] });

  const LocalProxy = require('../proxy/proxy');
  return LocalProxy._test.loadConfig().then(() => {
    const authPass = LocalProxy._test.authPass;
    assert.strictEqual(authPass('https', 'api.builtin-pass.example.com:443', null), true);
    assert.strictEqual(authPass('https', 'api.temp-pass.example.com:443', null), true);
    assert.strictEqual(authPass('https', 'unrelated.example.org:443', null), false);
  });
}

function testLoadConfigPicksUpTempFileChanges() {
  const { builtin, temp } = useTempDir('loadconfig-reload');
  writeRaw(builtin, { hosts: ['builtin-pass.example.com'] });

  const LocalProxy = require('../proxy/proxy');
  const authPass = LocalProxy._test.authPass;

  return LocalProxy._test.loadConfig()
    .then(() => {
      assert.strictEqual(authPass('https', 'api.later.example.com:443', null), false);
      // 模拟后台写入临时名单后重启
      authBypassHosts.writeTemp(['later.example.com']);
      return LocalProxy._test.loadConfig();
    })
    .then(() => {
      assert.strictEqual(authPass('https', 'api.later.example.com:443', null), true);
      // 内置那份不受影响
      assert.strictEqual(authPass('https', 'api.builtin-pass.example.com:443', null), true);
    });
}

const tests = [
  testReadBuiltinReturnsHostsFromFile,
  testReadBuiltinMissingFileReturnsEmptyList,
  testReadBuiltinCorruptFileReturnsEmptyList,
  testReadBuiltinNormalizesAndDeduplicates,
  testReadBuiltinIgnoresNonStringItems,
  testReadBuiltinAcceptsLegacyArrayShape,
  testBuiltinHasNoWriteApi,
  testReadTempMissingFileReturnsEmptyList,
  testWriteTempRoundTrip,
  testWriteTempTrimsLowercasesAndDeduplicates,
  testWriteTempRejectsNonArray,
  testWriteTempRejectsInvalidItems,
  testWriteTempAllowsPortSuffix,
  testWriteTempDoesNotTouchBuiltinFile,
  testWriteTempEmptyListClearsFile,
  testReadAllMergesBuiltinAndTemp,
  testReadAllWithOnlyBuiltin,
  testReadAllWithOnlyTemp,
  testReadAllBothMissingReturnsEmpty,
  testReadAllBothCorruptReturnsEmpty,
  testReadIsBackwardCompatible,
  testLoadConfigMergesBothListsIntoAuthPass,
  testLoadConfigPicksUpTempFileChanges
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
