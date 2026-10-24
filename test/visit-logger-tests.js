// 访问足迹日志单元测试：node test/visit-logger-tests.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const visitLogger = require('../proxy/visit-logger');

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bp-visit-log-${label}-`));
}

function readShard(dir, day) {
  const file = path.join(dir, `visit-${day}.log`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

function shardFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith('visit-'));
}

function lines(text) {
  return (text || '').split('\n').filter(Boolean);
}

const MONITORED_MAC = 'EE:A8:EB:67:F4:AD';
const MONITORED_IP = '192.168.124.23';
const OTHER_MAC = 'D6:A0:61:69:67:F6';
const OTHER_IP = '192.168.124.34';

function configureFixture(dir, extra) {
  visitLogger.stop();
  visitLogger.configure({
    enabled: true,
    dir: dir,
    maxTotalBytes: 15 * 1024 * 1024,
    flushIntervalMs: 1000,
    ...extra
  });
  // 只有 EE:A8:... 这台机器配了针对性规则 → 它是唯一的被监控对象
  visitLogger.setMonitoredMacs([
    { filter_host: 'bilibili.com', filter_mac: MONITORED_MAC },
    // 全局规则（无 filter_mac）不代表某台机器，不产生被监控 MAC
    { filter_host: 'youtube.com', filter_match_rule: 'pagead' }
  ]);
  visitLogger.setDevices([
    { ip: MONITORED_IP, mac: MONITORED_MAC },
    { ip: OTHER_IP, mac: OTHER_MAC }
  ]);
}

function testNormalizeMacAcceptsConfigFormats() {
  assert.strictEqual(visitLogger.normalizeMac('EE:A8:EB:67:F4:AD'), 'ee:a8:eb:67:f4:ad');
  assert.strictEqual(visitLogger.normalizeMac('ee-a8-eb-67-f4-ad'), 'ee:a8:eb:67:f4:ad');
  assert.strictEqual(visitLogger.normalizeMac('EE:A8:EB:67:F4:AD '), 'ee:a8:eb:67:f4:ad');
  assert.strictEqual(visitLogger.normalizeMac('e:a8:eb:67:f4:ad'), '0e:a8:eb:67:f4:ad');
  assert.strictEqual(visitLogger.normalizeMac(''), null);
  assert.strictEqual(visitLogger.normalizeMac(undefined), null);
  assert.strictEqual(visitLogger.normalizeMac('not-a-mac'), null);
}

function testMatchVisitCoversAnyDomain() {
  configureFixture(tempDir('match'));

  // 被监控机器的任意域名都命中，与该域名是否被配置拦截无关（每台不重复的域名）
  assert.strictEqual(visitLogger.matchVisit(MONITORED_IP, 'www.bilibili.com'), 'ee:a8:eb:67:f4:ad');
  assert.strictEqual(visitLogger.matchVisit(MONITORED_IP, 'www.zhihu.com'), 'ee:a8:eb:67:f4:ad');
  assert.strictEqual(visitLogger.matchVisit(MONITORED_IP, 'example.com:443'), 'ee:a8:eb:67:f4:ad');

  // 未在 block_hosts 里配置 filter_mac 的设备不记录
  assert.strictEqual(visitLogger.matchVisit(OTHER_IP, 'www.zhihu.com'), null);
  // 未知 IP
  assert.strictEqual(visitLogger.matchVisit('10.0.0.5', 'www.zhihu.com'), null);
  // 空参数
  assert.strictEqual(visitLogger.matchVisit('', 'www.zhihu.com'), null);
  assert.strictEqual(visitLogger.matchVisit(MONITORED_IP, ''), null);
  assert.strictEqual(visitLogger.matchVisit(MONITORED_IP, undefined), null);
}

function testDuplicateCallbackWithinWindowIsSuppressed() {
  configureFixture(tempDir('dedupe'));

  // 同一次 HTTPS 请求：CONNECT 阶段记一次，解密后 beforeSendRequest 又经过一次
  assert.ok(visitLogger.matchVisit(MONITORED_IP, 'www.zhihu.com'), 'CONNECT 阶段应记录');
  assert.strictEqual(visitLogger.matchVisit(MONITORED_IP, 'www.zhihu.com'), null, '2 秒内的第二次回调应被挡住');

  // 不同域名不受影响：一个页面访问多个站点照常都记
  assert.ok(visitLogger.matchVisit(MONITORED_IP, 'i0.hdslb.com'), '别的域名不能被误挡');
  // 端口不同的同一域名视为同一站点
  assert.strictEqual(visitLogger.matchVisit(MONITORED_IP, 'www.zhihu.com:443'), null, '端口归一化后仍视为重复');

  // 窗口过期后同一域名重新记录（时间前进 3 秒）
  const realNow = Date.now;
  Date.now = () => realNow() + 3000;
  try {
    assert.ok(visitLogger.matchVisit(MONITORED_IP, 'www.zhihu.com'), '窗口过期后应重新记录');
  } finally {
    Date.now = realNow;
  }
}

function testGlobalOnlyRulesDoNotMonitorAnyMac() {
  const dir = tempDir('global-only');
  visitLogger.stop();
  visitLogger.configure({ enabled: true, dir: dir, flushIntervalMs: 1000 });
  // 只有全局规则：没有 filter_mac → 没有需要监控的机器
  visitLogger.setMonitoredMacs([{ filter_host: 'youtube.com' }, { filter_host: 'baidu.com', filter_mac: '' }]);
  visitLogger.setDevices([{ ip: MONITORED_IP, mac: MONITORED_MAC }]);

  assert.strictEqual(visitLogger.matchVisit(MONITORED_IP, 'youtube.com'), null);
  assert.strictEqual(visitLogger.getStats().monitoredMacs, 0);
}

async function testRecordWritesDomainOnlyLine() {
  const dir = tempDir('record');
  configureFixture(dir);

  const ok = visitLogger.record({
    ts: new Date(2026, 9, 19, 14, 3, 12, 123),
    ip: MONITORED_IP,
    mac: 'ee:a8:eb:67:f4:ad',
    host: 'WWW.Bilibili.com:443'
  });
  assert.strictEqual(ok, true);

  await visitLogger.flush();

  const text = readShard(dir, '2026-10-19');
  assert.ok(text, '应当生成 visit-2026-10-19.log');
  assert.strictEqual(lines(text).length, 1);
  // 每行：时间 + MAC + IP + 域名（小写、去端口、无 path）
  assert.strictEqual(
    lines(text)[0],
    '[2026-10-19 14:03:12.123] ee:a8:eb:67:f4:ad 192.168.124.23 www.bilibili.com'
  );
  assert.strictEqual(visitLogger.getStats().written, 1);
}

async function testEveryRequestWritesOneLine() {
  const dir = tempDir('every');
  configureFixture(dir);

  // 同一次页面加载产生的几十条同域名请求：按用户要求逐条记录，不做去重
  for (let i = 0; i < 20; i++) {
    visitLogger.record({
      ts: new Date(2026, 9, 19, 14, 3, i),
      ip: MONITORED_IP,
      mac: 'ee:a8:eb:67:f4:ad',
      host: 'i0.hdslb.com'
    });
  }
  await visitLogger.flush();

  const rows = lines(readShard(dir, '2026-10-19'));
  assert.strictEqual(rows.length, 20, '每次请求都应有一行');
  assert.ok(rows.every((r) => r.endsWith(' i0.hdslb.com')), '每行都以域名结尾');
}

async function testHostIsNormalizedAndInjectionSanitized() {
  const dir = tempDir('sanitize');
  configureFixture(dir);

  // 域名里的换行必须被清理，否则可以伪造日志行；末尾点和端口一并归一化
  visitLogger.record({
    ts: new Date(2026, 9, 19, 10, 0, 0),
    ip: MONITORED_IP,
    mac: 'ee:a8:eb:67:f4:ad',
    host: 'evil.com\n[2026-01-01 00:00:00] aa:bb:cc:dd:ee:ff 1.2.3.4 fake.com'
  });
  visitLogger.record({
    ts: new Date(2026, 9, 19, 10, 0, 1),
    ip: MONITORED_IP,
    mac: 'ee:a8:eb:67:f4:ad',
    host: 'Example.COM.'
  });
  await visitLogger.flush();

  const rows = lines(readShard(dir, '2026-10-19'));
  assert.strictEqual(rows.length, 2, '注入的换行不得产生额外行');
  assert.ok(rows[0].includes('[2026-01-01'), '注入内容留在同一行内，造不出第二行');
  assert.ok(rows[0].includes('evil.com_'), '换行转义为下划线');
  assert.ok(rows[1].endsWith(' example.com'), '大小写与末尾点归一化');
}

async function testDaySharding() {
  const dir = tempDir('shard');
  configureFixture(dir);

  visitLogger.record({ ts: new Date(2026, 9, 18, 23, 59, 0), ip: MONITORED_IP, mac: 'ee:a8:eb:67:f4:ad', host: 'a.com' });
  visitLogger.record({ ts: new Date(2026, 9, 19, 0, 1, 0), ip: MONITORED_IP, mac: 'ee:a8:eb:67:f4:ad', host: 'b.com' });
  await visitLogger.flush();

  const day1 = readShard(dir, '2026-10-18');
  const day2 = readShard(dir, '2026-10-19');
  assert.ok(day1 && day1.includes('a.com'), '10-18 分片');
  assert.ok(day2 && day2.includes('b.com'), '10-19 分片');
  assert.ok(!day1.includes('b.com') && !day2.includes('a.com'), '不能串片');
  assert.deepStrictEqual(shardFiles(dir).sort(), ['visit-2026-10-18.log', 'visit-2026-10-19.log']);
}

async function testAppendAcrossFlushes() {
  const dir = tempDir('append');
  configureFixture(dir);

  for (let round = 0; round < 3; round++) {
    visitLogger.record({ ts: new Date(2026, 9, 19, 12, 0, round), ip: MONITORED_IP, mac: 'ee:a8:eb:67:f4:ad', host: `site${round}.com` });
    await visitLogger.flush();
  }

  const rows = lines(readShard(dir, '2026-10-19'));
  assert.strictEqual(rows.length, 3);
  assert.ok(rows[0].endsWith('site0.com') && rows[2].endsWith('site2.com'), '多次 flush 应为追加而非覆盖');
}

async function testTotalSizeCapDeletesOldestShard() {
  const dir = tempDir('cap');
  configureFixture(dir, { maxTotalBytes: 15 * 1024 * 1024 });

  const makeEntries = (day, count) => {
    for (let i = 0; i < count; i++) {
      visitLogger.record({
        ts: new Date(`${day}T12:00:${String(i % 60).padStart(2, '0')}`),
        ip: MONITORED_IP,
        mac: 'ee:a8:eb:67:f4:ad',
        host: `host-${'p'.repeat(60)}-${i}.example.com`
      });
    }
  };

  for (const day of ['2026-10-16', '2026-10-17', '2026-10-18']) {
    makeEntries(day, 30);
  }
  await visitLogger.flush();

  assert.strictEqual(shardFiles(dir).length, 3);
  const threeDaysBytes = visitLogger.getStats().totalBytes;
  const oneDayBytes = Math.ceil(threeDaysBytes / 3);

  // 收紧到「装不下第四天」的上限（configure 会重置账目，下次 flush 从磁盘重扫）
  visitLogger.configure({
    enabled: true,
    dir: dir,
    maxTotalBytes: threeDaysBytes + Math.floor(oneDayBytes / 2),
    flushIntervalMs: 1000
  });

  makeEntries('2026-10-19', 30);
  await visitLogger.flush();

  const files = shardFiles(dir);
  assert.ok(!files.includes('visit-2026-10-16.log'), '最旧分片应被删除');
  assert.ok(files.includes('visit-2026-10-19.log'), '当日分片应保留');
  assert.ok(
    visitLogger.getStats().totalBytes <= threeDaysBytes + Math.floor(oneDayBytes / 2),
    '删除后总量应在上限内'
  );
}

async function testDefaultCapIs15MB() {
  const dir = tempDir('default-cap');
  visitLogger.stop();
  visitLogger.configure({ enabled: true, dir: dir });
  assert.strictEqual(visitLogger.getStats().maxTotalBytes, 15 * 1024 * 1024);
  assert.strictEqual(visitLogger.getStats().flushIntervalMs, 1000);
}

function testDefaultDirIsLogsVisits() {
  visitLogger.stop();
  visitLogger.configure({ enabled: true });
  // 默认落在仓库内的 logs/visits（.gitignore 已忽略 /logs/），无需配置即可用
  assert.strictEqual(visitLogger.getStats().dir, path.join(__dirname, '../logs/visits'));
}

async function testCapSurvivesRestartWithExistingShards() {
  const dir = tempDir('restart');
  configureFixture(dir, { maxTotalBytes: 2000 });

  // 预置已存在的旧分片，模拟进程重启前的遗留
  fs.writeFileSync(path.join(dir, 'visit-2026-09-01.log'), 'y'.repeat(1800));

  visitLogger.record({
    ts: new Date(2026, 9, 19, 12, 0, 0),
    ip: MONITORED_IP,
    mac: 'ee:a8:eb:67:f4:ad',
    host: 'q'.repeat(200) + '.com'
  });
  await visitLogger.flush();

  const files = shardFiles(dir);
  assert.ok(!files.includes('visit-2026-09-01.log'), '重启后应扫描到遗留分片并纳入总量控制');
  assert.ok(visitLogger.getStats().totalBytes <= 2000, '遗留分片也要计入上限');
}

async function testCapDoesNotDeleteUnrelatedFiles() {
  const dir = tempDir('safe');
  configureFixture(dir, { maxTotalBytes: 500 });

  fs.writeFileSync(path.join(dir, 'keep-me.txt'), 'w'.repeat(5000));
  fs.writeFileSync(path.join(dir, 'visit-2026-01-01.log.bak'), 'v'.repeat(5000));
  // 访问日志的分片也放在 logs/ 下，绝不能因为上限清理被误删
  fs.writeFileSync(path.join(dir, 'access-2026-01-01.log'), 'u'.repeat(5000));

  visitLogger.record({
    ts: new Date(2026, 9, 19, 12, 0, 0),
    ip: MONITORED_IP,
    mac: 'ee:a8:eb:67:f4:ad',
    host: 'z'.repeat(120) + '.com'
  });
  await visitLogger.flush();

  assert.ok(fs.existsSync(path.join(dir, 'keep-me.txt')), '不得删除非分片文件');
  assert.ok(fs.existsSync(path.join(dir, 'visit-2026-01-01.log.bak')), '文件名不严格匹配不得删除');
  assert.ok(fs.existsSync(path.join(dir, 'access-2026-01-01.log')), '不得删除访问日志分片');
}

async function testBackpressureDropsInsteadOfGrowing() {
  const dir = tempDir('backpressure');
  configureFixture(dir);

  const limit = visitLogger.MAX_QUEUE_LENGTH;
  for (let i = 0; i < limit + 500; i++) {
    visitLogger.record({ ts: new Date(2026, 9, 19, 12, 0, 0), ip: MONITORED_IP, mac: 'ee:a8:eb:67:f4:ad', host: `flood${i}.com` });
  }

  const stats = visitLogger.getStats();
  assert.strictEqual(stats.queued, limit, '队列不得无界增长');
  assert.strictEqual(stats.dropped, 500);

  await visitLogger.flush();
  assert.match(readShard(dir, '2026-10-19'), /\[dropped\] 500 条/, '丢弃必须留痕');
}

async function testDisabledRecordsNothing() {
  const dir = tempDir('disabled');
  configureFixture(dir, { enabled: false });

  assert.strictEqual(visitLogger.matchVisit(MONITORED_IP, 'www.zhihu.com'), null);
  assert.strictEqual(
    visitLogger.record({ ts: new Date(), ip: MONITORED_IP, mac: 'ee:a8:eb:67:f4:ad', host: 'www.zhihu.com' }),
    false
  );
  await visitLogger.flush();
  assert.strictEqual(shardFiles(dir).length, 0, '关闭时不应产生日志文件');
}

async function testStringEnabledFlagFromConfig() {
  const dir = tempDir('flag');
  configureFixture(dir, { enabled: '0' });
  assert.strictEqual(visitLogger.getStats().enabled, false, '"0" 应解析为关闭');
  assert.strictEqual(visitLogger.matchVisit(MONITORED_IP, 'www.zhihu.com'), null);

  configureFixture(dir, { enabled: '1' });
  assert.strictEqual(visitLogger.getStats().enabled, true, '"1" 应解析为开启');
  assert.ok(visitLogger.matchVisit(MONITORED_IP, 'www.zhihu.com'));
}

function testMonitoredMacAndDeviceChangesTakeEffect() {
  configureFixture(tempDir('hotreload'));

  // 每步用不同域名，避开 2 秒去重窗口（那里是 mac|host 维度的键）
  assert.strictEqual(visitLogger.matchVisit(MONITORED_IP, 'weibo.com'), 'ee:a8:eb:67:f4:ad');

  // 面板保存 config.json 后 loadConfig 会重设规则与设备
  visitLogger.setMonitoredMacs([{ filter_host: 'bilibili.com', filter_mac: OTHER_MAC }]);
  assert.strictEqual(visitLogger.matchVisit(MONITORED_IP, 'toutiao.com'), null, '被监控 MAC 集合更新后旧机器不再命中');
  assert.strictEqual(visitLogger.matchVisit(OTHER_IP, 'douyin.com'), 'd6:a0:61:69:67:f6', '新配置的机器应命中');

  visitLogger.setDevices([{ ip: '192.168.124.50', mac: OTHER_MAC }]);
  assert.strictEqual(visitLogger.matchVisit(OTHER_IP, 'kuaishou.com'), null, '设备表更新后旧 IP 不再命中');
  assert.strictEqual(visitLogger.matchVisit('192.168.124.50', 'bilibili.com'), 'd6:a0:61:69:67:f6', '新 IP 应命中');
}

function testRecordIsSynchronousAndNonBlocking() {
  const dir = tempDir('sync');
  configureFixture(dir);

  // 请求路径上不得产生 Promise / 不得做 IO：record 必须同步返回布尔值且不落盘
  const result = visitLogger.record({ ts: new Date(), ip: MONITORED_IP, mac: 'ee:a8:eb:67:f4:ad', host: 'www.zhihu.com' });
  assert.strictEqual(typeof result, 'boolean');
  assert.strictEqual(visitLogger.getStats().queued, 1, '入队后应仍在内存中，尚未落盘');
  assert.strictEqual(shardFiles(dir).length, 0, 'record 不应同步写盘');
}

const tests = [
  testNormalizeMacAcceptsConfigFormats,
  testMatchVisitCoversAnyDomain,
  testDuplicateCallbackWithinWindowIsSuppressed,
  testGlobalOnlyRulesDoNotMonitorAnyMac,
  testRecordWritesDomainOnlyLine,
  testEveryRequestWritesOneLine,
  testHostIsNormalizedAndInjectionSanitized,
  testDaySharding,
  testAppendAcrossFlushes,
  testTotalSizeCapDeletesOldestShard,
  testDefaultCapIs15MB,
  testDefaultDirIsLogsVisits,
  testCapSurvivesRestartWithExistingShards,
  testCapDoesNotDeleteUnrelatedFiles,
  testBackpressureDropsInsteadOfGrowing,
  testDisabledRecordsNothing,
  testStringEnabledFlagFromConfig,
  testMonitoredMacAndDeviceChangesTakeEffect,
  testRecordIsSynchronousAndNonBlocking
];

(async () => {
  for (const testFn of tests) {
    await testFn();
    visitLogger.stop();
    console.log(`PASS ${testFn.name}`);
  }
  console.log('visit logger tests passed');
})().catch((error) => {
  console.error('FAIL', error);
  process.exit(1);
});
