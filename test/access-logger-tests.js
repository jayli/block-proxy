// 访问日志单元测试：node test/access-logger-tests.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const accessLogger = require('../proxy/access-logger');

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bp-access-log-${label}-`));
}

function readShard(dir, day) {
  const file = path.join(dir, `access-${day}.log`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

function localDay(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const MONITORED_MAC = 'D6:A0:61:69:67:F6';
const MONITORED_IP = '192.168.124.34';

function configureFixture(dir, extra) {
  accessLogger.stop();
  accessLogger.configure({
    enabled: true,
    dir: dir,
    maxTotalBytes: 50 * 1024 * 1024,
    flushIntervalMs: 1000,
    ...extra
  });
  accessLogger.setRules([
    { filter_host: 'bilibili.com', filter_mac: MONITORED_MAC },
    { filter_host: 'baidu.com', filter_mac: 'd6:a0:61:69:67:f6' },
    { filter_host: 'youtube.com', filter_match_rule: 'pagead' }
  ]);
  accessLogger.setDevices([
    { ip: MONITORED_IP, mac: MONITORED_MAC },
    { ip: '192.168.124.99', mac: '6E:FB:18:4D:9C:3E' }
  ]);
}

function testNormalizeMacAcceptsConfigFormats() {
  // config.json 里出现过这三种写法：标准、小写混排(d6:A0:...)、补零前格式
  assert.strictEqual(accessLogger.normalizeMac('D6:A0:61:69:67:F6'), 'd6:a0:61:69:67:f6');
  assert.strictEqual(accessLogger.normalizeMac('d6:A0:61:69:67:F6'), 'd6:a0:61:69:67:f6');
  assert.strictEqual(accessLogger.normalizeMac('f4-6b-8c-90-29-5'), 'f4:6b:8c:90:29:05');
  assert.strictEqual(accessLogger.normalizeMac(''), null);
  assert.strictEqual(accessLogger.normalizeMac(undefined), null);
  assert.strictEqual(accessLogger.normalizeMac('not-a-mac'), null);
}

function testMatchRequestOnlyForMonitoredMacAndConfiguredHost() {
  const dir = tempDir('match');
  configureFixture(dir);

  // 命中：被监控 MAC 的 IP 访问其配置的拦截域名
  const hit = accessLogger.matchRequest(MONITORED_IP, 'www.bilibili.com');
  assert.ok(hit, '应当命中');
  assert.strictEqual(hit.mac, 'd6:a0:61:69:67:f6');
  assert.strictEqual(hit.matchedHost, 'bilibili.com');

  // 大小写混排的 MAC 规则同样命中（baidu.com 配的是 d6:a0:...）
  assert.ok(accessLogger.matchRequest(MONITORED_IP, 'www.baidu.com'), '小写 MAC 规则应命中');

  // host 带端口也要能匹配
  assert.ok(accessLogger.matchRequest(MONITORED_IP, 'bilibili.com:443'), '带端口应命中');

  // 未命中：别的设备的 IP（它的 MAC 也配了规则，但不是这台）
  assert.strictEqual(accessLogger.matchRequest('192.168.124.99', 'www.bilibili.com'), null);
  // 未命中：被监控设备访问未配置的域名
  assert.strictEqual(accessLogger.matchRequest(MONITORED_IP, 'www.example.com'), null);
  // 未命中：全局规则（youtube.com 无 filter_mac）不算某台 MAC 的域名
  assert.strictEqual(accessLogger.matchRequest(MONITORED_IP, 'www.youtube.com'), null);
  // 未命中：未知 IP
  assert.strictEqual(accessLogger.matchRequest('10.0.0.5', 'www.bilibili.com'), null);
  // 未命中：空参数
  assert.strictEqual(accessLogger.matchRequest('', 'www.bilibili.com'), null);
  assert.strictEqual(accessLogger.matchRequest(MONITORED_IP, ''), null);
}

async function testRecordWritesFieldsToDayShard() {
  const dir = tempDir('record');
  configureFixture(dir);

  const ts = new Date(2026, 8, 22, 21, 36, 32, 123);
  const ok = accessLogger.record({
    ts: ts,
    ip: MONITORED_IP,
    mac: 'd6:a0:61:69:67:f6',
    action: 'https',
    method: 'GET',
    host: 'www.bilibili.com',
    path: '/x/web-interface/view?bvid=BV1xx&t=1'
  });
  assert.strictEqual(ok, true);

  await accessLogger.flush();

  const text = readShard(dir, '2026-09-22');
  assert.ok(text, '应当生成 access-2026-09-22.log');
  assert.strictEqual(text.split('\n').filter(Boolean).length, 1);
  // 四个必需字段：时间、来源 IP、域名、path
  assert.match(text, /^\[2026-09-22 21:36:32\.123\] /);
  assert.match(text, /192\.168\.124\.34/);
  assert.match(text, /d6:a0:61:69:67:f6/);
  assert.match(text, /https GET www\.bilibili\.com/);
  assert.match(text, /\/x\/web-interface\/view\?bvid=BV1xx&t=1/);
  assert.strictEqual(accessLogger.getStats().written, 1);
}

async function testPathIsSanitizedAgainstLogInjection() {
  const dir = tempDir('sanitize');
  configureFixture(dir);

  accessLogger.record({
    ts: new Date(2026, 8, 22, 10, 0, 0),
    ip: MONITORED_IP,
    mac: 'd6:a0:61:69:67:f6',
    action: 'https',
    method: 'GET',
    host: 'www.bilibili.com',
    path: '/a\n[2026-01-01 00:00:00] 1.2.3.4 fake fake GET evil.com /fake'
  });
  await accessLogger.flush();

  const text = readShard(dir, '2026-09-22');
  // 换行被去掉，伪造不出第二行日志
  assert.strictEqual(text.split('\n').filter(Boolean).length, 1);
  assert.ok(!text.includes('\n[2026-01-01'), 'path 中的换行必须被清理');
}

async function testConnectActionWithoutPath() {
  const dir = tempDir('connect');
  configureFixture(dir);

  accessLogger.record({
    ts: new Date(2026, 8, 22, 11, 0, 0),
    ip: MONITORED_IP,
    mac: 'd6:a0:61:69:67:f6',
    action: 'connect',
    method: 'CONNECT',
    host: 'bilibili.com:443',
    path: ''
  });
  await accessLogger.flush();

  const text = readShard(dir, '2026-09-22');
  assert.match(text, /connect CONNECT bilibili\.com:443 -/);
}

async function testDaySharding() {
  const dir = tempDir('shard');
  configureFixture(dir);

  accessLogger.record({ ts: new Date(2026, 8, 21, 23, 59, 0), ip: MONITORED_IP, mac: 'd6:a0:61:69:67:f6', action: 'https', method: 'GET', host: 'www.bilibili.com', path: '/day1' });
  accessLogger.record({ ts: new Date(2026, 8, 22, 0, 1, 0), ip: MONITORED_IP, mac: 'd6:a0:61:69:67:f6', action: 'https', method: 'GET', host: 'www.bilibili.com', path: '/day2' });
  await accessLogger.flush();

  const day1 = readShard(dir, '2026-09-21');
  const day2 = readShard(dir, '2026-09-22');
  assert.ok(day1 && day1.includes('/day1'), '9-21 分片');
  assert.ok(day2 && day2.includes('/day2'), '9-22 分片');
  assert.ok(!day1.includes('/day2'), '不能串片');
  assert.ok(!day2.includes('/day1'), '不能串片');

  const files = fs.readdirSync(dir).filter((f) => f.startsWith('access-'));
  assert.deepStrictEqual(files.sort(), ['access-2026-09-21.log', 'access-2026-09-22.log']);
}

async function testAppendAcrossFlushes() {
  const dir = tempDir('append');
  configureFixture(dir);

  for (let round = 0; round < 3; round++) {
    accessLogger.record({ ts: new Date(2026, 8, 22, 12, 0, round), ip: MONITORED_IP, mac: 'd6:a0:61:69:67:f6', action: 'https', method: 'GET', host: 'www.baidu.com', path: `/round${round}` });
    await accessLogger.flush();
  }

  const text = readShard(dir, '2026-09-22');
  assert.strictEqual(text.split('\n').filter(Boolean).length, 3);
  assert.ok(text.includes('/round0') && text.includes('/round2'), '多次 flush 应为追加而非覆盖');
}

async function testTotalSizeCapDeletesOldestShard() {
  const dir = tempDir('cap');
  // 先用大上限铺出三天的旧分片
  configureFixture(dir, { maxTotalBytes: 50 * 1024 * 1024 });

  const payload = 'x'.repeat(600);
  const makeEntry = (day) => ({
    ts: new Date(day + 'T12:00:00'),
    ip: MONITORED_IP,
    mac: 'd6:a0:61:69:67:f6',
    action: 'https',
    method: 'GET',
    host: 'www.bilibili.com',
    path: '/' + payload
  });

  for (const day of ['2026-09-18', '2026-09-19', '2026-09-20']) {
    accessLogger.record(makeEntry(day));
  }
  await accessLogger.flush();

  let files = fs.readdirSync(dir).filter((f) => f.startsWith('access-'));
  assert.strictEqual(files.length, 3);
  const threeDaysBytes = accessLogger.getStats().totalBytes;
  assert.ok(threeDaysBytes > 0);

  // 重新配置成「刚好装不下第四天」的上限（configure 会重置账目，下次 flush 从磁盘重扫）
  const oneDayBytes = Math.ceil(threeDaysBytes / 3);
  accessLogger.configure({
    enabled: true,
    dir: dir,
    maxTotalBytes: threeDaysBytes + Math.floor(oneDayBytes / 2),
    flushIntervalMs: 1000
  });

  accessLogger.record(makeEntry('2026-09-22'));
  await accessLogger.flush();

  files = fs.readdirSync(dir).filter((f) => f.startsWith('access-'));
  assert.ok(!files.includes('access-2026-09-18.log'), '最旧分片应被删除');
  assert.ok(files.includes('access-2026-09-22.log'), '当日分片应保留');
  assert.ok(
    accessLogger.getStats().totalBytes <= threeDaysBytes + Math.floor(oneDayBytes / 2),
    '删除后总量应在上限内'
  );
}

async function testCapSurvivesRestartWithExistingShards() {
  const dir = tempDir('restart');
  configureFixture(dir, { maxTotalBytes: 2000 });

  // 预置一个已存在的旧分片，模拟进程重启前的遗留
  fs.writeFileSync(path.join(dir, 'access-2026-09-01.log'), 'y'.repeat(1800));

  accessLogger.record({ ts: new Date(2026, 8, 22, 12, 0, 0), ip: MONITORED_IP, mac: 'd6:a0:61:69:67:f6', action: 'https', method: 'GET', host: 'www.bilibili.com', path: '/' + 'z'.repeat(600) });
  await accessLogger.flush();

  const files = fs.readdirSync(dir).filter((f) => f.startsWith('access-'));
  assert.ok(!files.includes('access-2026-09-01.log'), '重启后应扫描到遗留分片并纳入总量控制');
  assert.ok(accessLogger.getStats().totalBytes <= 2000, '遗留分片也要计入上限');
}

async function testCapDoesNotDeleteUnrelatedFiles() {
  const dir = tempDir('safe');
  configureFixture(dir, { maxTotalBytes: 500 });

  fs.writeFileSync(path.join(dir, 'keep-me.txt'), 'w'.repeat(5000));
  fs.writeFileSync(path.join(dir, 'access-2026-01-01.log.bak'), 'v'.repeat(5000));

  accessLogger.record({ ts: new Date(2026, 8, 22, 12, 0, 0), ip: MONITORED_IP, mac: 'd6:a0:61:69:67:f6', action: 'https', method: 'GET', host: 'www.bilibili.com', path: '/' + 'q'.repeat(400) });
  await accessLogger.flush();

  assert.ok(fs.existsSync(path.join(dir, 'keep-me.txt')), '不得删除非分片文件');
  assert.ok(fs.existsSync(path.join(dir, 'access-2026-01-01.log.bak')), '文件名不严格匹配不得删除');
}

async function testBackpressureDropsInsteadOfGrowing() {
  const dir = tempDir('backpressure');
  configureFixture(dir);

  const limit = accessLogger.MAX_QUEUE_LENGTH;
  for (let i = 0; i < limit + 500; i++) {
    accessLogger.record({ ts: new Date(2026, 8, 22, 12, 0, 0), ip: MONITORED_IP, mac: 'd6:a0:61:69:67:f6', action: 'https', method: 'GET', host: 'www.bilibili.com', path: `/flood${i}` });
  }

  const stats = accessLogger.getStats();
  assert.strictEqual(stats.queued, limit, '队列不得无界增长');
  assert.strictEqual(stats.dropped, 500);

  await accessLogger.flush();
  const text = readShard(dir, '2026-09-22');
  assert.match(text, /\[dropped\] 500 条/, '丢弃必须留痕');
}

async function testDisabledRecordsNothing() {
  const dir = tempDir('disabled');
  configureFixture(dir, { enabled: false });

  assert.strictEqual(accessLogger.matchRequest(MONITORED_IP, 'www.bilibili.com'), null);
  assert.strictEqual(accessLogger.record({ ts: new Date(), ip: MONITORED_IP, mac: 'd6:a0:61:69:67:f6', action: 'https', method: 'GET', host: 'www.bilibili.com', path: '/x' }), false);
  await accessLogger.flush();

  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('access-')) : [];
  assert.strictEqual(files.length, 0, '关闭时不应产生日志文件');
}

async function testStringEnabledFlagFromConfig() {
  // config.json 里 access_log.enabled 是字符串 "0"/"1"，必须能被正确解析
  const dir = tempDir('flag');
  configureFixture(dir, { enabled: '0' });
  assert.strictEqual(accessLogger.getStats().enabled, false, '"0" 应解析为关闭');
  assert.strictEqual(accessLogger.matchRequest(MONITORED_IP, 'www.bilibili.com'), null);

  configureFixture(dir, { enabled: '1' });
  assert.strictEqual(accessLogger.getStats().enabled, true, '"1" 应解析为开启');
  assert.ok(accessLogger.matchRequest(MONITORED_IP, 'www.bilibili.com'));

  configureFixture(dir, { enabled: true });
  assert.strictEqual(accessLogger.getStats().enabled, true, '布尔 true 应开启');
}

async function testNoRuleOrDeviceChangeTakesEffect() {
  const dir = tempDir('hotreload');
  configureFixture(dir);

  assert.strictEqual(accessLogger.matchRequest(MONITORED_IP, 'weibo.com'), null, '初始未配 weibo 应不命中');

  // 面板保存 config.json 后 loadConfig 会重设规则与设备
  accessLogger.setRules([{ filter_host: 'weibo.com', filter_mac: MONITORED_MAC }]);
  assert.ok(accessLogger.matchRequest(MONITORED_IP, 'weibo.com'), '新增规则应立即生效');

  accessLogger.setDevices([{ ip: '192.168.124.50', mac: MONITORED_MAC }]);
  assert.strictEqual(accessLogger.matchRequest(MONITORED_IP, 'weibo.com'), null, '设备表更新后旧 IP 不再命中');
  assert.ok(accessLogger.matchRequest('192.168.124.50', 'weibo.com'), '新 IP 应命中');
}

async function testRecordIsSynchronousAndNonBlocking() {
  const dir = tempDir('sync');
  configureFixture(dir);

  // 请求路径上不得产生 Promise / 不得做 IO：record 必须同步返回布尔值
  const result = accessLogger.record({ ts: new Date(), ip: MONITORED_IP, mac: 'd6:a0:61:69:67:f6', action: 'https', method: 'GET', host: 'www.bilibili.com', path: '/sync' });
  assert.strictEqual(typeof result, 'boolean');
  assert.strictEqual(accessLogger.getStats().queued, 1, '入队后应仍在内存中，尚未落盘');
  assert.ok(!fs.existsSync(path.join(dir, `access-${localDay()}.log`)), 'record 不应同步写盘');

  await accessLogger.flush();
  assert.ok(fs.existsSync(path.join(dir, `access-${localDay()}.log`)), 'flush 后才落盘');
}

const tests = [
  testNormalizeMacAcceptsConfigFormats,
  testMatchRequestOnlyForMonitoredMacAndConfiguredHost,
  testRecordWritesFieldsToDayShard,
  testPathIsSanitizedAgainstLogInjection,
  testConnectActionWithoutPath,
  testDaySharding,
  testAppendAcrossFlushes,
  testTotalSizeCapDeletesOldestShard,
  testCapSurvivesRestartWithExistingShards,
  testCapDoesNotDeleteUnrelatedFiles,
  testBackpressureDropsInsteadOfGrowing,
  testDisabledRecordsNothing,
  testStringEnabledFlagFromConfig,
  testNoRuleOrDeviceChangeTakesEffect,
  testRecordIsSynchronousAndNonBlocking
];

(async () => {
  for (const testFn of tests) {
    await testFn();
    accessLogger.stop();
    console.log(`PASS ${testFn.name}`);
  }
  console.log('access logger tests passed');
})().catch((error) => {
  console.error('FAIL', error);
  process.exit(1);
});
