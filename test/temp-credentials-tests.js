// 临时代理凭据单元测试：node test/temp-credentials-tests.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tempCredentials = require('../proxy/temp-credentials');

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

function useTempFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bp-temp-cred-${label}-`));
  const file = path.join(dir, 'temp_credentials.json');
  tempCredentials.configure({ filePath: file });
  return file;
}

function writeRaw(file, credentials) {
  fs.writeFileSync(file, JSON.stringify({ credentials }, null, 2), 'utf8');
  tempCredentials.configure({ filePath: file });
}

function testGenerateReturnsActiveCredentialWithSevenDayTtl() {
  useTempFile('generate');
  const cred = tempCredentials.generate();

  assert.match(cred.username, /^tmp_[0-9a-f]{8}$/);
  assert.strictEqual(cred.password.length, 12);
  assert.strictEqual(cred.revoked, false);
  assert.strictEqual(cred.status, 'active');

  const ttl = Date.parse(cred.expires_at) - Date.parse(cred.created_at);
  assert.strictEqual(ttl, SEVEN_DAYS);
  // 剩余时间应接近 7 天
  assert(cred.remaining_ms > SEVEN_DAYS - 5000, `remaining_ms=${cred.remaining_ms}`);
}

function testGeneratedCredentialPassesValidation() {
  useTempFile('valid');
  const cred = tempCredentials.generate();

  assert.strictEqual(tempCredentials.isValid(cred.username, cred.password), true);
}

function testValidationRejectsWrongOrEmptyCredentials() {
  useTempFile('reject');
  const cred = tempCredentials.generate();

  assert.strictEqual(tempCredentials.isValid(cred.username, 'wrong-password'), false);
  assert.strictEqual(tempCredentials.isValid('tmp_deadbeef', cred.password), false);
  assert.strictEqual(tempCredentials.isValid('', ''), false);
  assert.strictEqual(tempCredentials.isValid(undefined, undefined), false);
  assert.strictEqual(tempCredentials.isValid(cred.username, ''), false);
}

function testLatestReturnsNoneWithoutFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-temp-cred-none-'));
  tempCredentials.configure({ filePath: path.join(dir, 'missing.json') });

  assert.strictEqual(tempCredentials.getLatest().status, 'none');
  assert.strictEqual(tempCredentials.isValid('tmp_aaaaaaaa', 'bbbbbbbbbbbb'), false);
}

function testExpiredCredentialIsRejected() {
  const file = useTempFile('expired');
  const past = new Date(Date.now() - 60_000).toISOString();
  writeRaw(file, [{
    username: 'tmp_expired0',
    password: 'abcdefghijkl',
    created_at: new Date(Date.now() - SEVEN_DAYS - 60_000).toISOString(),
    expires_at: past,
    revoked: false
  }]);

  assert.strictEqual(tempCredentials.isValid('tmp_expired0', 'abcdefghijkl'), false);
  const latest = tempCredentials.getLatest();
  assert.strictEqual(latest.status, 'expired');
  assert.strictEqual(latest.remaining_ms, 0);
}

function testRevokeMarksLatestAndRejectsValidation() {
  useTempFile('revoke');
  const cred = tempCredentials.generate();
  assert.strictEqual(tempCredentials.isValid(cred.username, cred.password), true);

  const revoked = tempCredentials.revokeLatest();
  assert.strictEqual(revoked.revoked, true);
  assert.strictEqual(revoked.status, 'revoked');
  assert.strictEqual(tempCredentials.isValid(cred.username, cred.password), false);
  assert.strictEqual(tempCredentials.getLatest().status, 'revoked');
}

function testRevokeWithoutAnyCredentialReturnsNone() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-temp-cred-revoke-none-'));
  tempCredentials.configure({ filePath: path.join(dir, 'missing.json') });

  assert.strictEqual(tempCredentials.revokeLatest().status, 'none');
}

function testMultipleCredentialsAllValidAndLatestIsNewest() {
  useTempFile('multi');
  const first = tempCredentials.generate();
  const second = tempCredentials.generate();

  assert.notStrictEqual(first.username, second.username);
  assert.notStrictEqual(first.password, second.password);
  // 生成新的一条不会让旧的失效
  assert.strictEqual(tempCredentials.isValid(first.username, first.password), true);
  assert.strictEqual(tempCredentials.isValid(second.username, second.password), true);
  assert.strictEqual(tempCredentials.getLatest().username, second.username);
}

function testFileKeepsOnlyLatestTwentyCredentials() {
  const file = useTempFile('cap');
  let last = null;
  for (let i = 0; i < 25; i++) {
    last = tempCredentials.generate();
  }

  const stored = JSON.parse(fs.readFileSync(file, 'utf8')).credentials;
  assert.strictEqual(stored.length, tempCredentials.MAX_CREDENTIALS);
  assert.strictEqual(stored[stored.length - 1].username, last.username);
  assert.strictEqual(tempCredentials.getLatest().username, last.username);
  // 保留下来的最旧一条仍可用
  assert.strictEqual(tempCredentials.isValid(stored[0].username, stored[0].password), true);
  // 被裁掉的 5 条已不可用
  assert.strictEqual(tempCredentials.getAll().length, tempCredentials.MAX_CREDENTIALS);
}

function testCorruptFileIsTreatedAsEmpty() {
  const file = useTempFile('corrupt');
  fs.writeFileSync(file, '{ not valid json', 'utf8');
  tempCredentials.configure({ filePath: file });

  assert.strictEqual(tempCredentials.getLatest().status, 'none');
  assert.strictEqual(tempCredentials.isValid('tmp_aaaaaaaa', 'bbbbbbbbbbbb'), false);
  // 损坏后仍可正常生成（覆盖写入）
  const cred = tempCredentials.generate();
  assert.strictEqual(tempCredentials.isValid(cred.username, cred.password), true);
}

function testExternalWriteIsPickedUpByMtimeInvalidation() {
  const file = useTempFile('mtime');
  const cred = tempCredentials.generate();
  assert.strictEqual(tempCredentials.isValid(cred.username, cred.password), true);

  // 模拟另一个进程撤销：直接改文件并推后 mtime，不调 configure，
  // 验证缓存能按 mtime 失效而不是靠重启
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.credentials[raw.credentials.length - 1].revoked = true;
  fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(file, future, future);

  assert.strictEqual(tempCredentials.isValid(cred.username, cred.password), false);
  assert.strictEqual(tempCredentials.getLatest().status, 'revoked');
}

function testLegacyArrayShapeIsAccepted() {
  const file = useTempFile('legacy');
  // 顶层直接是数组的旧格式
  fs.writeFileSync(file, JSON.stringify([{
    username: 'tmp_legacy01',
    password: 'legacyPass13',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + SEVEN_DAYS).toISOString(),
    revoked: false
  }]), 'utf8');
  tempCredentials.configure({ filePath: file });

  assert.strictEqual(tempCredentials.isValid('tmp_legacy01', 'legacyPass13'), true);
  assert.strictEqual(tempCredentials.getLatest().username, 'tmp_legacy01');
}

function testReloadFromDiskAfterCacheReset() {
  const file = useTempFile('reload');
  const cred = tempCredentials.generate();

  // 模拟进程重启：清空缓存后仍能从磁盘读到同一条凭据
  tempCredentials.configure({ filePath: file });
  assert.strictEqual(tempCredentials.getLatest().username, cred.username);
  assert.strictEqual(tempCredentials.isValid(cred.username, cred.password), true);
}

const tests = [
  testGenerateReturnsActiveCredentialWithSevenDayTtl,
  testGeneratedCredentialPassesValidation,
  testValidationRejectsWrongOrEmptyCredentials,
  testLatestReturnsNoneWithoutFile,
  testExpiredCredentialIsRejected,
  testRevokeMarksLatestAndRejectsValidation,
  testRevokeWithoutAnyCredentialReturnsNone,
  testMultipleCredentialsAllValidAndLatestIsNewest,
  testFileKeepsOnlyLatestTwentyCredentials,
  testCorruptFileIsTreatedAsEmpty,
  testLegacyArrayShapeIsAccepted,
  testExternalWriteIsPickedUpByMtimeInvalidation,
  testReloadFromDiskAfterCacheReset
];

(async () => {
  for (const testFn of tests) {
    await testFn();
    console.log(`PASS ${testFn.name}`);
  }
  console.log('temp credentials tests passed');
})().catch((error) => {
  console.error('FAIL', error);
  process.exit(1);
});
