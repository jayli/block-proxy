// 访问日志与真实代理钩子的集成测试：node test/access-logger-integration-tests.js
// 直接调用 proxy.js 中真实的 beforeSendRequest / beforeDealHttpsRequest，
// 走「被拦截」分支返回合成响应，全程无网络 IO、无证书依赖。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LocalProxy = require('../proxy/proxy');
const accessLogger = require('../proxy/access-logger');

const rule = LocalProxy._test.getAnyProxyOptions().rule;

const MONITORED_MAC = 'D6:A0:61:69:67:F6';
const MONITORED_IP = '192.168.124.34';
const OTHER_IP = '192.168.124.99';
const OTHER_MAC = '6E:FB:18:4D:9C:3E';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bp-access-int-'));
}

function setup(dir) {
  accessLogger.stop();
  accessLogger.configure({ enabled: true, dir: dir, maxTotalBytes: 50 * 1024 * 1024, flushIntervalMs: 1000 });

  const blockHosts = [
    { filter_host: 'bilibili.com', filter_mac: MONITORED_MAC, filter_weekday: [1, 2, 3, 4, 5, 6, 7] },
    { filter_host: 'iqiyi.com', filter_mac: OTHER_MAC, filter_weekday: [1, 2, 3, 4, 5, 6, 7] }
  ];
  const devices = [
    { ip: MONITORED_IP, mac: MONITORED_MAC },
    { ip: OTHER_IP, mac: OTHER_MAC }
  ];

  // 同步到 proxy.js 内部状态（拦截判定用）与 accessLogger（打点用）
  LocalProxy._test.setBlockHostsForTest(blockHosts);
  LocalProxy._test.setDevicesForTest(devices);
  accessLogger.setRules(blockHosts);
  accessLogger.setDevices(devices);
}

function httpsRequestDetail(host, pathStr, sourceIp) {
  const hostname = host.split(':')[0];
  return {
    url: `https://${host}${pathStr}`,
    protocol: 'https',
    host: `${host}:443`,
    requestOptions: { hostname: hostname, host: host, path: pathStr, method: 'GET', port: 443, headers: {} },
    requestData: Buffer.alloc(0),
    _req: { sourceIp: sourceIp, client: { remoteAddress: sourceIp } }
  };
}

function readShard(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('access-'));
  if (files.length === 0) return '';
  return files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
}

async function testBlockedHttpsRequestIsRecordedWithPath() {
  const dir = tempDir();
  setup(dir);

  // 被监控 MAC 的 IP 访问其配置的拦截域名：beforeSendRequest 会拦截并返回合成响应，同时打点
  const result = await rule.beforeSendRequest.call(
    { checkProxyAuth: () => true, send407bySocket: () => {} },
    httpsRequestDetail('www.bilibili.com', '/x/web-interface/view?bvid=BV1', MONITORED_IP)
  );

  // 确认确实走了拦截分支（返回合成响应而非转发）
  assert.ok(result && result.response, '应返回拦截响应');

  await accessLogger.flush();
  const text = readShard(dir);
  assert.ok(text.includes(MONITORED_IP), '应记录来源 IP');
  assert.ok(text.includes('d6:a0:61:69:67:f6'), '应记录归一化 MAC');
  assert.ok(text.includes('www.bilibili.com'), '应记录域名');
  assert.ok(text.includes('/x/web-interface/view?bvid=BV1'), '应记录完整 path');
  assert.match(text, /https GET www\.bilibili\.com/, '应含协议与方法');
}

async function testOtherDeviceIsNotRecordedUnderThisFeature() {
  const dir = tempDir();
  setup(dir);

  // OTHER_IP 访问的是 MONITORED_MAC 的拦截域名 → 不属于它的规则，不打点
  // （它自己的 iqiyi 规则才会打点；这里验证不会张冠李戴）
  await rule.beforeSendRequest.call(
    { checkProxyAuth: () => true, send407bySocket: () => {} },
    httpsRequestDetail('www.bilibili.com', '/x', OTHER_IP)
  );
  await accessLogger.flush();
  const text = readShard(dir);
  assert.ok(!text.includes(MONITORED_IP), '不应把别的设备记成被监控 IP');
  assert.ok(!text.includes('d6:a0:61:69:67:f6'), '不应记成被监控 MAC');
}

async function testUnconfiguredDomainIsNotRecorded() {
  const dir = tempDir();
  setup(dir);

  await rule.beforeSendRequest.call(
    { checkProxyAuth: () => true, send407bySocket: () => {} },
    httpsRequestDetail('www.example.com', '/foo', MONITORED_IP)
  );
  await accessLogger.flush();
  assert.strictEqual(readShard(dir), '', '未配置的域名不应记录');
}

async function testConnectRecordedWhenMitmDisabled() {
  const dir = tempDir();
  setup(dir);

  // enable_mitm=0：beforeDealHttpsRequest 走纯隧道，只能记到域名级别（action=connect）
  LocalProxy._test.setEnableMitmForTest('0');
  const intercepted = await rule.beforeDealHttpsRequest.call(
    { checkProxyAuth: () => true, send407bySocket: () => {} },
    httpsRequestDetail('www.bilibili.com', '/', MONITORED_IP)
  );
  LocalProxy._test.setEnableMitmForTest('1');

  assert.strictEqual(intercepted, false, 'mitm 关闭时应放行（不解密）');

  await accessLogger.flush();
  const text = readShard(dir);
  assert.ok(text.includes(MONITORED_IP), 'connect 也应记录来源 IP');
  assert.match(text, /connect CONNECT/, 'mitm 关闭时记为 connect 级');
}

async function testConnectNotDuplicatedWhenMitmEnabled() {
  const dir = tempDir();
  setup(dir);

  // enable_mitm=1 且命中拦截：beforeDealHttpsRequest 返回 true（去解密），
  // 此时不应产生 connect 级记录，避免与后续 beforeSendRequest 的 path 级记录重复
  const intercepted = await rule.beforeDealHttpsRequest.call(
    { checkProxyAuth: () => true, send407bySocket: () => {} },
    httpsRequestDetail('www.bilibili.com', '/', MONITORED_IP)
  );
  assert.strictEqual(intercepted, true, '命中拦截域名应解密');

  await accessLogger.flush();
  assert.strictEqual(readShard(dir), '', '解密路径不应在 CONNECT 阶段打点');
}

const tests = [
  testBlockedHttpsRequestIsRecordedWithPath,
  testOtherDeviceIsNotRecordedUnderThisFeature,
  testUnconfiguredDomainIsNotRecorded,
  testConnectRecordedWhenMitmDisabled,
  testConnectNotDuplicatedWhenMitmEnabled
];

(async () => {
  for (const testFn of tests) {
    await testFn();
    accessLogger.stop();
    console.log(`PASS ${testFn.name}`);
  }
  console.log('access logger integration tests passed');
  process.exit(0);
})().catch((error) => {
  console.error('FAIL', error);
  process.exit(1);
});
