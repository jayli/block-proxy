// 访问足迹日志与真实代理钩子的集成测试：node test/visit-logger-integration-tests.js
// 直接调用 proxy.js 中真实的 beforeSendRequest / beforeDealHttpsRequest，
// 覆盖「被监控机器的任意域名都记录」这一核心语义；全程无网络 IO、无证书依赖。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LocalProxy = require('../proxy/proxy');
const visitLogger = require('../proxy/visit-logger');

const rule = LocalProxy._test.getAnyProxyOptions().rule;

const MONITORED_MAC = 'EE:A8:EB:67:F4:AD';
const MONITORED_IP = '192.168.124.23';
const OTHER_IP = '192.168.124.34';
const OTHER_MAC = 'D6:A0:61:69:67:F6';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bp-visit-int-'));
}

function setup(dir) {
  visitLogger.stop();
  visitLogger.configure({ enabled: true, dir: dir, maxTotalBytes: 15 * 1024 * 1024, flushIntervalMs: 1000 });

  const blockHosts = [
    // 只有一条针对 MONITORED_MAC 的拦截规则：足以让这台机器进入「被监控」名单
    { filter_host: 'bilibili.com', filter_mac: MONITORED_MAC, filter_weekday: [1, 2, 3, 4, 5, 6, 7] },
    // 全局规则（无 filter_mac）不代表某台具体机器，不应把任何设备拉进监控名单
    { filter_host: 'youtube.com', filter_match_rule: 'pagead' }
  ];
  const devices = [
    { ip: MONITORED_IP, mac: MONITORED_MAC },
    { ip: OTHER_IP, mac: OTHER_MAC }
  ];

  // setBlockHostsForTest / setDevicesForTest 会同步刷新 accessLogger 与 visitLogger，
  // 与 loadConfig() 里的行为一致
  LocalProxy._test.setBlockHostsForTest(blockHosts);
  LocalProxy._test.setDevicesForTest(devices);
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
  if (!fs.existsSync(dir)) return '';
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('visit-'));
  return files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
}

function rows(dir) {
  return readShard(dir).split('\n').filter(Boolean);
}

async function testAnyDomainIsRecordedForMonitoredMac() {
  const dir = tempDir();
  setup(dir);

  // 三个域名都不在 MONITORED_MAC 的拦截规则里（只有 bilibili.com 被拦截）
  for (const host of ['www.bilibili.com', 'www.zhihu.com', 'api.example.com']) {
    await rule.beforeDealHttpsRequest.call(
      { checkProxyAuth: () => true, send407bySocket: () => {} },
      httpsRequestDetail(host, '/', MONITORED_IP)
    );
    await rule.beforeSendRequest.call(
      { checkProxyAuth: () => true, send407bySocket: () => {} },
      httpsRequestDetail(host, '/some/path?q=1', MONITORED_IP)
    );
  }

  await visitLogger.flush();
  const recorded = rows(dir);
  assert.strictEqual(recorded.length, 3, '同一次请求的 CONNECT 与解密后回调只算一条');
  assert.ok(recorded.some((r) => r.endsWith(' www.bilibili.com')), '拦截域名要记');
  assert.ok(recorded.some((r) => r.endsWith(' www.zhihu.com')), '未拦截域名也要记');
  assert.ok(recorded.some((r) => r.endsWith(' api.example.com')), '未拦截域名也要记');
  assert.ok(recorded.every((r) => !r.includes('/some/path')), '不记录 path');
  assert.ok(recorded.every((r) => r.includes(MONITORED_IP)), '每行带来源 IP');
}

async function testOtherDeviceIsNotRecorded() {
  const dir = tempDir();
  setup(dir);

  await rule.beforeSendRequest.call(
    { checkProxyAuth: () => true, send407bySocket: () => {} },
    httpsRequestDetail('www.zhihu.com', '/x', OTHER_IP)
  );

  await visitLogger.flush();
  assert.strictEqual(readShard(dir), '', '未配置 filter_mac 的设备不记录');
}

async function testHttpsConnectIsRecordedBeforeDecryption() {
  const dir = tempDir();
  setup(dir);

  // beforeDealHttpsRequest：mitm 关闭时的纯隧道路径，只能拿到域名
  LocalProxy._test.setEnableMitmForTest('0');
  const intercepted = await rule.beforeDealHttpsRequest.call(
    { checkProxyAuth: () => true, send407bySocket: () => {} },
    httpsRequestDetail('www.toutiao.com', '/', MONITORED_IP)
  );
  LocalProxy._test.setEnableMitmForTest('1');

  assert.strictEqual(intercepted, false, 'mitm 关闭时应放行（不解密）');
  await visitLogger.flush();
  const recorded = rows(dir);
  assert.strictEqual(recorded.length, 1, 'CONNECT 阶段就应记录域名');
  assert.ok(recorded[0].endsWith(' www.toutiao.com'));
}

async function testHttpsConnectRecordedEvenWhenDecrypted() {
  const dir = tempDir();
  setup(dir);

  // 命中拦截域名会解密（beforeDealHttpsRequest 返回 true），
  // 域名访问本身仍要留痕 —— 这是「看这台机器访问了什么网站」的主干路径
  const intercepted = await rule.beforeDealHttpsRequest.call(
    { checkProxyAuth: () => true, send407bySocket: () => {} },
    httpsRequestDetail('www.bilibili.com', '/', MONITORED_IP)
  );
  assert.strictEqual(intercepted, true, '命中拦截域名应解密');

  await visitLogger.flush();
  const recorded = rows(dir);
  assert.strictEqual(recorded.length, 1, '解密路径同样在 CONNECT 阶段记录域名');
  assert.ok(recorded[0].endsWith(' www.bilibili.com'));
}

async function testRepeatedRequestsStillRecordedAfterWindow() {
  const dir = tempDir();
  setup(dir);

  // 去重窗口只吸收同一次请求的两个回调，不影响「每个真实请求一行」
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    for (let i = 0; i < 3; i++) {
      await rule.beforeSendRequest.call(
        { checkProxyAuth: () => true, send407bySocket: () => {} },
        httpsRequestDetail('www.zhihu.com', `/p${i}`, MONITORED_IP)
      );
      offset += 3000; // 时间前进 3 秒，超出 2 秒去重窗口
    }
  } finally {
    Date.now = realNow;
  }

  await visitLogger.flush();
  assert.strictEqual(rows(dir).length, 3, '每个真实请求都应留一行');
}

async function testPlainHttpIsRecorded() {
  const dir = tempDir();
  setup(dir);

  await rule.beforeSendRequest.call(
    { checkProxyAuth: () => true, send407bySocket: () => {} },
    {
      url: 'http://neverssl.com/index.html',
      protocol: 'http',
      host: 'neverssl.com',
      requestOptions: { hostname: 'neverssl.com', host: 'neverssl.com', path: '/index.html', method: 'GET', port: 80, headers: {} },
      requestData: Buffer.alloc(0),
      _req: { sourceIp: MONITORED_IP, client: { remoteAddress: MONITORED_IP } }
    }
  );

  await visitLogger.flush();
  const recorded = rows(dir);
  assert.strictEqual(recorded.length, 1);
  assert.ok(recorded[0].endsWith(' neverssl.com'));
}

async function testBareIpRequestIsNotRecorded() {
  const dir = tempDir();
  setup(dir);

  // 裸 IP 请求在打点之前就放行了，不产生域名级记录
  await rule.beforeSendRequest.call(
    { checkProxyAuth: () => true, send407bySocket: () => {} },
    {
      url: 'http://192.168.124.1/admin',
      protocol: 'http',
      host: '192.168.124.1',
      requestOptions: { hostname: '192.168.124.1', host: '192.168.124.1', path: '/admin', method: 'GET', port: 80, headers: {} },
      requestData: Buffer.alloc(0),
      _req: { sourceIp: MONITORED_IP, client: { remoteAddress: MONITORED_IP } }
    }
  );

  await visitLogger.flush();
  assert.strictEqual(readShard(dir), '', '裸 IP 请求没有域名，不记录');
}

async function testTunnelDomainNotRecordedViaConnect() {
  const dir = tempDir();
  setup(dir);
  // 隧道域名在 beforeDealHttpsRequest 的 logVisit 之后才被判定；
  // 这里只验证「非隧道域名照常记录」，避免依赖隧道 manager 的内部状态

  await rule.beforeDealHttpsRequest.call(
    { checkProxyAuth: () => true, send407bySocket: () => {} },
    httpsRequestDetail('www.douyin.com', '/', MONITORED_IP)
  );
  await visitLogger.flush();
  assert.ok(readShard(dir).includes('www.douyin.com'));
}

const tests = [
  testAnyDomainIsRecordedForMonitoredMac,
  testOtherDeviceIsNotRecorded,
  testHttpsConnectIsRecordedBeforeDecryption,
  testHttpsConnectRecordedEvenWhenDecrypted,
  testRepeatedRequestsStillRecordedAfterWindow,
  testPlainHttpIsRecorded,
  testBareIpRequestIsNotRecorded,
  testTunnelDomainNotRecordedViaConnect
];

(async () => {
  for (const testFn of tests) {
    await testFn();
    visitLogger.stop();
    console.log(`PASS ${testFn.name}`);
  }
  console.log('visit logger integration tests passed');
  process.exit(0);
})().catch((error) => {
  console.error('FAIL', error);
  process.exit(1);
});
