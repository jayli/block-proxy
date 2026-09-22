// 文件名: proxy/access-logger.js
// 访问日志：记录「被监控 MAC 的设备」访问「config.json 中为该 MAC 配置的拦截域名」的请求。
//
// 性能约定（不能影响代理主链路）：
//   1. matchRequest() / record() 在请求路径上执行，只做 Map 查找与字符串拼接，
//      不触碰文件系统、不产生 Promise、不做任何 await。
//   2. 所有磁盘 IO（mkdir / readdir / appendFile / unlink）都在独立的定时 flush 中
//      通过 fs.promises 完成，跑在 libuv 线程池上，不阻塞事件循环。
//   3. 队列有上限，写入跟不上时丢弃新条目并计数（背压），绝不无界增长占内存。
//
// 落盘约定：
//   - 按天分片：access-YYYY-MM-DD.log
//   - 所有分片总大小受 maxTotalBytes 限制（默认 50MB），超限删除最旧分片

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { formatTimestamp } = require('../server/timestampConsole');

const FILE_PREFIX = 'access-';
const FILE_SUFFIX = '.log';
// 分片文件名白名单：只有严格匹配该格式的文件才可能被删除，避免误删其他文件
const SHARD_NAME_RE = /^access-(\d{4}-\d{2}-\d{2})\.log$/;
const DEFAULT_DIR = path.join(__dirname, '../logs/access');
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const MAX_QUEUE_LENGTH = 20000;
const MAX_PATH_LENGTH = 512;

var enabled = false;
var logDir = DEFAULT_DIR;
var maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES;
var flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS;

var queue = [];
var dropped = 0;
var flushTimer = null;
var flushing = false;
var fatal = false;
var readyPromise = null;
var exitHookInstalled = false;

// filename -> bytes，所有已知分片的大小
var shardSizes = new Map();
var totalBytes = 0;
var writtenCount = 0;

// normalizedMac -> [filter_host, ...]，仅包含显式配置了 filter_mac 的规则
var macHosts = new Map();
// clientIp -> normalizedMac
var ipMac = new Map();

// f4:6b:8c:90:29:5 / F4-6B-8C-90-29-05 -> f4:6b:8c:90:29:05
// 与 proxy.js 的 normalizeMacAddress 语义一致，但非法输入返回 null 而不抛异常
function normalizeMac(mac) {
  if (typeof mac !== 'string') return null;
  const cleaned = mac.trim().toLowerCase().replace(/-/g, ':');
  if (cleaned === '') return null;
  const parts = cleaned.split(':');
  if (parts.length !== 6) return null;
  const normalized = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,2}$/.test(part)) return null;
    normalized.push(part.padStart(2, '0'));
  }
  return normalized.join(':');
}

// host 可能带端口（example.com:443）或为 [IPv6]:443，这里只用于域名子串匹配
function stripPort(host) {
  if (typeof host !== 'string') return '';
  let value = host.trim();
  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']');
    if (closingBracket !== -1) return value.substring(1, closingBracket);
    return value;
  }
  const lastColon = value.lastIndexOf(':');
  if (lastColon !== -1 && /^\d+$/.test(value.substring(lastColon + 1))) {
    return value.substring(0, lastColon);
  }
  return value;
}

function isShardName(name) {
  return typeof name === 'string' && SHARD_NAME_RE.test(name);
}

// 开关解析：兼容项目约定的字符串 "0"/"1" 与布尔值
function parseFlag(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
  if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return true;
  return defaultValue;
}

function fileFor(name) {
  return path.join(logDir, name);
}

function shardNameForDay(day) {
  return `${FILE_PREFIX}${day}${FILE_SUFFIX}`;
}

// 由 config.json 的 block_hosts 重建 MAC -> 域名 索引
// 只收录显式带 filter_mac 的规则：全局规则（filter_mac 为空）不属于「某个 MAC 的域名」
function setRules(blockHosts) {
  const next = new Map();
  if (Array.isArray(blockHosts)) {
    for (const rule of blockHosts) {
      if (!rule || typeof rule !== 'object') continue;
      const mac = normalizeMac(rule.filter_mac);
      if (!mac) continue;
      const host = typeof rule.filter_host === 'string' ? rule.filter_host.trim() : '';
      if (!host) continue;
      const list = next.get(mac);
      if (list) {
        if (!list.includes(host)) list.push(host);
      } else {
        next.set(mac, [host]);
      }
    }
  }
  macHosts = next;
}

// 由 config.json 的 devices 重建 IP -> MAC 索引
// 同一 IP 出现多次时保留第一个，与 proxy.js getMacByIp 的 devices.find() 语义一致
function setDevices(devices) {
  const next = new Map();
  if (Array.isArray(devices)) {
    for (const device of devices) {
      if (!device || typeof device !== 'object') continue;
      if (typeof device.ip !== 'string' || device.ip === '') continue;
      const mac = normalizeMac(device.mac);
      if (!mac) continue;
      if (!next.has(device.ip)) next.set(device.ip, mac);
    }
  }
  ipMac = next;
}

// 请求路径上的热点函数：判断这条请求是否需要记录
// 命中返回 { mac, matchedHost }，否则返回 null
function matchRequest(clientIp, host) {
  if (!enabled || fatal) return null;
  if (!clientIp || !host) return null;
  const mac = ipMac.get(clientIp);
  if (!mac) return null;
  const hosts = macHosts.get(mac);
  if (!hosts) return null;
  const bareHost = stripPort(host);
  if (!bareHost) return null;
  for (const configured of hosts) {
    // 与 shouldBlockHost 相同的子串匹配语义：baidu.com 命中 www.baidu.com
    if (bareHost.includes(configured)) {
      return { mac: mac, matchedHost: configured };
    }
  }
  return null;
}

function sanitizePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath === '') return '-';
  // 去掉换行/制表，避免伪造日志行；空格转义为 %20 保证列可切分
  let value = rawPath.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, '%20');
  if (value.length > MAX_PATH_LENGTH) {
    value = value.slice(0, MAX_PATH_LENGTH) + '...';
  }
  return value;
}

function field(value) {
  if (typeof value !== 'string' || value === '') return '-';
  return value.replace(/[\r\n\t ]/g, '_');
}

// 请求路径上的第二个热点函数：只做拼接与入队
function record(entry) {
  if (!enabled || fatal || !entry) return false;
  const ts = entry.ts instanceof Date ? entry.ts : new Date();
  const text = `[${formatTimestamp(ts)}.${String(ts.getMilliseconds()).padStart(3, '0')}] ` +
    `${field(entry.ip)} ${field(entry.mac)} ${field(entry.action)} ${field(entry.method)} ` +
    `${field(entry.host)} ${sanitizePath(entry.path)}\n`;
  const day = text.slice(1, 11); // [YYYY-MM-DD ...

  if (queue.length >= MAX_QUEUE_LENGTH) {
    // 背压：落盘跟不上时丢弃并计数，不阻塞请求，也不无界占用内存
    dropped++;
    return false;
  }
  queue.push({ day: day, text: text });
  ensureTimer();
  return true;
}

function ensureTimer() {
  if (flushTimer !== null || !enabled) return;
  flushTimer = setInterval(() => {
    flush().catch(onFlushError);
  }, flushIntervalMs);
  if (typeof flushTimer.unref === 'function') {
    flushTimer.unref();
  }
}

function clearTimer() {
  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

function onFlushError(error) {
  // 日志失败绝不影响代理，只报告一次然后停用
  fatal = true;
  clearTimer();
  queue = [];
  console.error('[AccessLog] 写入失败，访问日志已停用:', error && error.message ? error.message : error);
}

async function init() {
  await fsp.mkdir(logDir, { recursive: true });
  const entries = await fsp.readdir(logDir);
  const sizes = new Map();
  let total = 0;
  for (const name of entries) {
    if (!isShardName(name)) continue;
    try {
      const stat = await fsp.stat(fileFor(name));
      if (stat.isFile()) {
        sizes.set(name, stat.size);
        total += stat.size;
      }
    } catch (e) {
      // 单个分片读取失败不影响整体启动
    }
  }
  shardSizes = sizes;
  totalBytes = total;
  return true;
}

function ensureReady() {
  if (!readyPromise) {
    readyPromise = init().catch((error) => {
      readyPromise = null;
      throw error;
    });
  }
  return readyPromise;
}

async function removeShard(name) {
  const size = shardSizes.get(name) || 0;
  try {
    await fsp.unlink(fileFor(name));
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      console.error(`[AccessLog] 删除旧分片失败 ${name}:`, e.message);
    }
  }
  // 即使 unlink 失败也把账目去掉，避免 totalBytes 永远卡在超限状态导致每条日志都重试删除
  shardSizes.delete(name);
  totalBytes -= size;
  if (totalBytes < 0) totalBytes = 0;
}

// 总量超限则从最旧分片开始删除；正在写入的当日分片尽量保留
async function enforceCap(activeName) {
  if (totalBytes <= maxTotalBytes) return;
  const names = [...shardSizes.keys()].sort(); // 文件名含日期，字典序即时间序
  for (const name of names) {
    if (totalBytes <= maxTotalBytes) break;
    if (name === activeName && names.length > 1) continue;
    await removeShard(name);
  }
  // 极端情况：只剩当日分片且它自己就超过总上限，只能强制丢弃以满足硬上限
  if (totalBytes > maxTotalBytes && shardSizes.has(activeName)) {
    console.warn(`[AccessLog] 当日分片 ${activeName} 单独超过总上限 ${maxTotalBytes} 字节，强制滚动删除`);
    await removeShard(activeName);
  }
}

async function flush() {
  if (flushing || fatal) return;
  if (queue.length === 0 && dropped === 0) return;
  flushing = true;
  const batch = queue;
  const batchDropped = dropped;
  queue = [];
  dropped = 0;
  try {
    await ensureReady();

    // 一批日志可能跨越零点，按天分组后分别写入各自分片
    const groups = new Map();
    for (const item of batch) {
      const list = groups.get(item.day);
      if (list) list.push(item.text);
      else groups.set(item.day, [item.text]);
    }

    const days = [...groups.keys()].sort();
    for (const day of days) {
      const lines = groups.get(day);
      if (batchDropped > 0 && day === days[days.length - 1]) {
        lines.push(`[dropped] ${batchDropped} 条访问日志因写入队列溢出被丢弃\n`);
      }
      const text = lines.join('');
      if (text === '') continue;
      const name = shardNameForDay(day);
      const bytes = Buffer.byteLength(text, 'utf8');
      await fsp.appendFile(fileFor(name), text, 'utf8');
      shardSizes.set(name, (shardSizes.get(name) || 0) + bytes);
      totalBytes += bytes;
      writtenCount += lines.length;
      await enforceCap(name);
    }
  } finally {
    flushing = false;
  }
}

// 退出时尽力同步落盘，最多丢掉一批未写入的日志而不是全部
function flushSyncOnExit() {
  if (!enabled || fatal || queue.length === 0) return;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const groups = new Map();
    for (const item of queue) {
      const list = groups.get(item.day);
      if (list) list.push(item.text);
      else groups.set(item.day, [item.text]);
    }
    for (const day of [...groups.keys()].sort()) {
      fs.appendFileSync(fileFor(shardNameForDay(day)), groups.get(day).join(''), 'utf8');
    }
    queue = [];
  } catch (e) {
    // 退出路径上的失败无处上报，忽略
  }
}

// options: { enabled, dir, maxTotalBytes, flushIntervalMs }
// 重新配置会丢弃已缓存的大小账目并在下次 flush 时从磁盘重新扫描（进程内重启安全）
function configure(options) {
  const opts = options || {};
  const nextDir = (typeof opts.dir === 'string' && opts.dir.trim() !== '')
    ? path.resolve(opts.dir.trim())
    : DEFAULT_DIR;
  const nextMax = Number(opts.maxTotalBytes);
  const nextInterval = Number(opts.flushIntervalMs);

  enabled = parseFlag(opts.enabled, true);
  fatal = false;
  logDir = nextDir;
  maxTotalBytes = Number.isFinite(nextMax) && nextMax > 0 ? Math.floor(nextMax) : DEFAULT_MAX_TOTAL_BYTES;
  flushIntervalMs = Number.isFinite(nextInterval) && nextInterval > 0
    ? Math.floor(nextInterval)
    : DEFAULT_FLUSH_INTERVAL_MS;

  // 退出时尽力同步落盘，只注册一次（process.exit 只能做同步 IO）
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', flushSyncOnExit);
  }

  shardSizes = new Map();
  totalBytes = 0;
  readyPromise = null;

  // 间隔可能已变更，重建定时器（下次 record 时按新间隔创建）
  clearTimer();

  if (!enabled) {
    queue = [];
    dropped = 0;
  }
}

function stop() {
  clearTimer();
  queue = [];
  dropped = 0;
  enabled = false;
  fatal = false;
  readyPromise = null;
  shardSizes = new Map();
  totalBytes = 0;
}

function getStats() {
  return {
    enabled: enabled,
    dir: logDir,
    maxTotalBytes: maxTotalBytes,
    flushIntervalMs: flushIntervalMs,
    queued: queue.length,
    dropped: dropped,
    written: writtenCount,
    totalBytes: totalBytes,
    shards: [...shardSizes.keys()].sort(),
    monitoredMacs: macHosts.size,
    knownIps: ipMac.size
  };
}

module.exports = {
  configure,
  setRules,
  setDevices,
  matchRequest,
  record,
  flush,
  stop,
  getStats,
  flushSyncOnExit,
  normalizeMac,
  MAX_QUEUE_LENGTH
};
