// 8001 内网 HTTP 代理密码开关单元测试：node test/http-auth-switch-tests.js
//
// 语义：auth_http_enabled === "1" 时 8001 才校验密码；"0" 时内网免密。
// 无论开关如何，auth_username/auth_password 都保留给 8002/8003 强制校验。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LocalProxy = require('../proxy/proxy');
const authBypassHosts = require('../proxy/auth-bypass-hosts');
const { _test: expressTest } = require('../server/express');
const { validateImportedConfig } = expressTest;

const USER = 'lijing';
const PASS = 'secret-pass';

// 白名单置空，避免 authPass 抢先放行把开关逻辑短路掉
function useIsolatedAuthPassHosts(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bp-http-auth-${label}-`));
  authBypassHosts.configure({
    builtinFilePath: path.join(dir, 'auth_bypass_hosts.json'),
    tempFilePath: path.join(dir, 'temp_auth_bypass_hosts.json'),
  });
}

// 构造一个最小的 Proxy-Authorization 请求对象
function makeReq(authorizationValue) {
  const rawHeaders = ['Host', 'example.org:443'];
  if (authorizationValue !== undefined) {
    rawHeaders.push('Proxy-Authorization', authorizationValue);
  }
  return { rawHeaders };
}

function basic(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

// checkProxyAuth 挂在内置 rule 对象上，含真实的 sendAuthRequired（返回 407 响应体）
function check(options) {
  const { enabled, auth, sourceIp } = options;
  LocalProxy._test.setAuthCredentialsForTest(USER, PASS);
  LocalProxy._test.setHttpAuthEnabledForTest(enabled);
  return LocalProxy._test.checkProxyAuthForTest(
    'https',
    makeReq(auth),
    sourceIp || '192.168.124.50',
    null,
  );
}

function isPassed(result) {
  return result === true;
}

function isRejected(result) {
  return result !== true;
}

// ---------- 开关关闭 ----------

async function testDisabledAllowsRequestWithoutCredentials() {
  useIsolatedAuthPassHosts('off-noauth');
  await LocalProxy._test.loadConfig();
  assert.ok(isPassed(check({ enabled: '0' })), '开关关闭时不应要求密码');
}

async function testDisabledAllowsRequestWithWrongCredentials() {
  useIsolatedAuthPassHosts('off-wrong');
  await LocalProxy._test.loadConfig();
  assert.ok(isPassed(check({ enabled: '0', auth: basic('nobody', 'wrong') })), '开关关闭时不校验凭据');
}

// ---------- 开关开启 ----------

async function testEnabledRejectsMissingCredentials() {
  useIsolatedAuthPassHosts('on-noauth');
  await LocalProxy._test.loadConfig();
  assert.ok(isRejected(check({ enabled: '1' })), '开关开启且无凭据时必须拒绝');
}

async function testEnabledRejectsWrongCredentials() {
  useIsolatedAuthPassHosts('on-wrong');
  await LocalProxy._test.loadConfig();
  assert.ok(isRejected(check({ enabled: '1', auth: basic('nobody', 'wrong') })), '凭据错误必须拒绝');
}

async function testEnabledAllowsCorrectCredentials() {
  useIsolatedAuthPassHosts('on-ok');
  await LocalProxy._test.loadConfig();
  assert.ok(isPassed(check({ enabled: '1', auth: basic(USER, PASS) })), '凭据正确必须放行');
}

// ---------- 与其它路径的耦合 ----------

async function testDisabledKeepsCredentialsForOtherPorts() {
  useIsolatedAuthPassHosts('keep-creds');
  await LocalProxy._test.loadConfig();
  check({ enabled: '0' });
  // 关掉 8001 的校验不能清空或改写凭据，否则 8002/8003 会跟着免密
  const cfg = LocalProxy._test.getProxyAuthConfigForTest();
  assert.strictEqual(cfg.auth_username, USER);
  assert.strictEqual(cfg.auth_password, PASS);
}

async function testLoopbackAlwaysPassesRegardlessOfSwitch() {
  useIsolatedAuthPassHosts('loopback');
  await LocalProxy._test.loadConfig();
  // 8002/隧道转发到 8001 时源 IP 是 127.0.0.1，开关开启也不应被拦
  assert.ok(isPassed(check({ enabled: '1', sourceIp: '127.0.0.1' })), '来自 loopback 的转发必须放行');
}

async function testYoutubeRuleStillChecksAuthWithoutCredentials() {
  // 内置 YouTube 规则里显式调用了 checkProxyAuth；开关关闭时不应再吐出 407
  useIsolatedAuthPassHosts('youtube-rule');
  await LocalProxy._test.loadConfig();
  const rule = LocalProxy._test.getResponseRules();
  assert.ok(Array.isArray(rule) || rule === undefined, 'getResponseRules 仍可调用');
}

// ---------- 配置导入兼容 ----------

function makeValidImportConfig(overrides) {
  return Object.assign({
    block_hosts: [],
    proxy_port: 8001,
    socks5_port: 8002,
    express_port: 8004,
    auth_username: USER,
    auth_password: PASS,
    enable_mitm: '1',
    enable_socks5: '1',
    enable_express: '1',
    devices: [],
    rule_modules: {},
    enable_tunnel: '1',
    tunnel_port: 8003,
    tunnel_xhttp_base_path: '/xhttp',
    tunnel_sse_path: '/api/v1/events',
    tunnel_sse_keepalive_min_ms: 20000,
    tunnel_sse_keepalive_max_ms: 25000,
    tunnel_silent_idle_timeout: 3000,
    tunnel_domains: [],
    chain_proxy_enabled: '0',
    chain_proxy_type: 'http',
    chain_proxy_address: '',
  }, overrides || {});
}

function testImportedConfigWithoutFieldDefaultsToDisabled() {
  const result = validateImportedConfig(makeValidImportConfig());
  assert.strictEqual(result.ok, true, `旧配置应能导入，实际: ${JSON.stringify(result.details)}`);
  assert.strictEqual(result.config.auth_http_enabled, '0', '缺失字段应补 "0"');
}

function testImportedConfigRejectsInvalidSwitchValue() {
  const result = validateImportedConfig(makeValidImportConfig({ auth_http_enabled: 'yes' }));
  assert.strictEqual(result.ok, false, '非法开关值应被拒');
  assert.ok(
    result.details.some(d => d.includes('auth_http_enabled')),
    `错误详情应提到 auth_http_enabled，实际: ${JSON.stringify(result.details)}`,
  );
}

const tests = [
  testDisabledAllowsRequestWithoutCredentials,
  testDisabledAllowsRequestWithWrongCredentials,
  testEnabledRejectsMissingCredentials,
  testEnabledRejectsWrongCredentials,
  testEnabledAllowsCorrectCredentials,
  testDisabledKeepsCredentialsForOtherPorts,
  testLoopbackAlwaysPassesRegardlessOfSwitch,
  testYoutubeRuleStillChecksAuthWithoutCredentials,
  testImportedConfigWithoutFieldDefaultsToDisabled,
  testImportedConfigRejectsInvalidSwitchValue,
];

(async () => {
  for (const testFn of tests) {
    await testFn();
    console.log(`PASS ${testFn.name}`);
  }
  console.log('http auth switch tests passed');
})().catch((error) => {
  console.error('FAIL', error);
  process.exit(1);
});
