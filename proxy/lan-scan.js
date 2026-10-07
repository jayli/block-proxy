// 局域网设备表扫描（IP -> MAC），不依赖 arp / ping 外部命令
// /proxy/lan-scan.js
//
// 原理：
//   1. 枚举本机所在的可扫网段（私有网段，排除 172.* 与公网/回环/链路本地/组播）
//   2. 用原生 UDP 报文逐个 IP 触发内核的邻居解析（ARP），代替 254 次 ping
//   3. 等内核完成可达性重验证后读邻居表，只保留带有效单播 MAC 的条目
//
// 相比旧的 `ping` + `arp -a` 方案：
//   - 不依赖外部二进制（OpenWrt 上常常没有 arp 命令，busybox 也未必编译进来）
//   - 邻居表带可达性状态（REACHABLE/STALE/FAILED/INCOMPLETE），失联主机会被排除，
//     而不是像 arp -a 那样把过期条目一直读回来
//   - 一次读表拿到全部条目，不需要给每个 IP 起一个进程
//   - 修掉旧解析器对单个十六进制位（如 48:f3:f3:ca:1d:e）分段的漏读

const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const PROBE_PORT = 9; // discard 端口，只是为了让内核去解析目标 MAC，不需要对方回应
const PROBE_ROUNDS = 2; // 一轮 UDP 有丢包概率，发两轮覆盖
const PROBE_ROUND_GAP_MS = 600;
// 发完探测包后等内核把"发不出去"的条目标记为 FAILED/INCOMPLETE 再读表，否则会读到旧 MAC。
// OpenWrt（Linux 6.6）实测：主机已不在时，旧条目约 7s 后才从 DELAY/PROBE 变 FAILED
const SETTLE_MS = parsePositiveInt(process.env.BLOCK_PROXY_SCAN_SETTLE_MS, 8000);
const COMMAND_TIMEOUT_MS = 5000;
const MIN_PREFIX_LENGTH = 22; // 只扫 /22 及更小的网段，避免 /16 /8 展开成上万个探测包
const MAX_HOSTS_PER_NETWORK = 1022;
const MAX_TOTAL_HOSTS = 4096;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- IPv4 / MAC 基础工具 ----------

function ipv4ToInt(ip) {
  if (typeof ip !== 'string') return null;
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number.parseInt(part, 10);
    if (value > 255) return null;
    result = result * 256 + value;
  }
  return result;
}

function intToIpv4(value) {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  ].join('.');
}

// 只认私有网段，并排除 172.*（用户要求整段排除，含 docker0/vap 这类 172.16/12、/16 网段）
function isScannableIpv4(ip) {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  if (value < ipv4ToInt('1.0.0.0')) return false; // 0.0.0.0/8
  if (value >= ipv4ToInt('127.0.0.0') && value <= ipv4ToInt('127.255.255.255')) return false; // 回环
  if (value >= ipv4ToInt('169.254.0.0') && value <= ipv4ToInt('169.254.255.255')) return false; // 链路本地
  if (value >= ipv4ToInt('172.0.0.0') && value <= ipv4ToInt('172.255.255.255')) return false; // 172 开头整段排除
  if (value >= ipv4ToInt('224.0.0.0')) return false; // 组播/保留段，含广播
  if (value >= ipv4ToInt('10.0.0.0') && value <= ipv4ToInt('10.255.255.255')) return true; // 10/8
  if (value >= ipv4ToInt('192.168.0.0') && value <= ipv4ToInt('192.168.255.255')) return true; // 192.168/16
  return false; // 其余一律当公网排除（含 100.64/10 CGNAT 等）
}

// 归一化 MAC：统一大写冒号分隔并补前导零，跳过组播/全零/广播地址
// 返回 null 表示不是可用的单播 MAC
function normalizeMac(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/-/g, ':');
  const parts = cleaned.split(':');
  if (parts.length !== 6) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^[0-9a-fA-F]{1,2}$/.test(part)) return null;
    octets.push(Number.parseInt(part, 16));
  }
  if (octets.every((octet) => octet === 0)) return null; // 00:00:00:00:00:00
  if (octets.every((octet) => octet === 0xff)) return null; // 广播
  if ((octets[0] & 1) === 1) return null; // 组播位（01:00:5e:... / 33:33:...）
  return octets.map((octet) => octet.toString(16).padStart(2, '0')).join(':').toUpperCase();
}

function prefixLengthFromNetmask(netmask) {
  const value = ipv4ToInt(netmask);
  if (value === null) return null;
  let prefix = 0;
  let seenZero = false;
  for (let bit = 31; bit >= 0; bit -= 1) {
    const set = ((value >>> bit) & 1) === 1;
    if (set) {
      if (seenZero) return null; // 掩码不连续
      prefix += 1;
    } else {
      seenZero = true;
    }
  }
  return prefix;
}

function networkAddress(ip, netmask) {
  const ipValue = ipv4ToInt(ip);
  const maskValue = ipv4ToInt(netmask);
  if (ipValue === null || maskValue === null) return null;
  return intToIpv4((ipValue & maskValue) >>> 0);
}

// ---------- 网段枚举 ----------

// 从 os.networkInterfaces() 的结果里挑出可扫网段（纯函数，便于单测）
function collectScanNetworks(interfaces) {
  const networks = [];
  const seen = new Set();
  let totalHosts = 0;

  for (const [name, addresses] of Object.entries(interfaces || {})) {
    for (const address of addresses || []) {
      if (!address) continue;
      if (address.family !== 'IPv4' && address.family !== 4) continue;
      if (address.internal) continue;
      if (!isScannableIpv4(address.address)) continue;
      if (!address.netmask) continue;

      const prefix = prefixLengthFromNetmask(address.netmask);
      if (prefix === null) continue;
      if (prefix < MIN_PREFIX_LENGTH) continue;

      const base = networkAddress(address.address, address.netmask);
      if (!base) continue;

      const key = `${base}/${prefix}`;
      if (seen.has(key)) continue;

      const hostCount = Math.pow(2, 32 - prefix) - 2;
      if (hostCount > MAX_HOSTS_PER_NETWORK) continue;
      if (totalHosts + hostCount > MAX_TOTAL_HOSTS) {
        console.warn(`[lan-scan] 跳过网段 ${key}：本轮探测主机数已达上限 ${MAX_TOTAL_HOSTS}`);
        continue;
      }

      seen.add(key);
      totalHosts += hostCount;
      networks.push({
        name,
        address: address.address,
        netmask: address.netmask,
        base,
        prefix,
        mac: normalizeMac(address.mac),
        hostCount
      });
    }
  }

  return networks;
}

// 网段内所有可分配主机地址（不含网络号与广播地址）
function hostsForNetwork(network) {
  const baseValue = ipv4ToInt(network.base);
  if (baseValue === null) return [];
  const total = Math.pow(2, 32 - network.prefix);
  const hosts = [];
  for (let offset = 1; offset < total - 1; offset += 1) {
    hosts.push(intToIpv4(baseValue + offset));
  }
  return hosts;
}

// ---------- 邻居表解析（纯函数，输入为命令原始输出） ----------

// Linux: ip -4 neigh show
// 192.168.124.187 dev br-lan lladdr 86:8e:78:a6:d9:3d STALE
// 192.168.124.125 dev br-lan FAILED
function parseIpNeigh(text) {
  const entries = [];
  for (const line of String(text || '').split('\n')) {
    const ipMatch = line.match(/(\d+\.\d+\.\d+\.\d+)/);
    if (!ipMatch) continue;
    if (/\b(FAILED|INCOMPLETE)\b/.test(line)) continue;
    const macMatch = line.match(/lladdr\s+([0-9a-fA-F]{1,2}(?:[:-][0-9a-fA-F]{1,2}){5})/);
    if (!macMatch) continue;
    entries.push({ ip: ipMatch[1], mac: macMatch[1] });
  }
  return entries;
}

// Linux: /proc/net/arp（iproute2 缺失时的回退）
// IP address       HW type  Flags  HW address          Mask  Device
// 192.168.124.125  0x1      0x0    14:c0:50:14:6e:a5   *     br-lan   <- flags 无 ATF_COM(0x2)，不可信
function parseProcNetArp(text) {
  const entries = [];
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6) continue;
    const [ip, , flags, mac] = fields;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
    const flagsValue = Number.parseInt(flags, 16);
    if (!Number.isFinite(flagsValue)) continue;
    if ((flagsValue & 0x2) === 0) continue; // ATF_COM：条目完整（已解析出 MAC）才可信
    entries.push({ ip, mac });
  }
  return entries;
}

// macOS: netstat -rn -f inet
// 192.168.124.1      fa:27:3c:e5:31:5f  UHLWIir               en1   1199
// 192.168.124.4      link#5             UHLWI                 en1      !   <- 未解析出来，丢弃
function parseNetstatRoute(text) {
  const entries = [];
  for (const line of String(text || '').split('\n')) {
    const match = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F]{1,2}(?::[0-9a-fA-F]{1,2}){5})\s+(\S+)/);
    if (!match) continue;
    if (match[3].includes('!')) continue; // 未生效/拒绝的条目
    entries.push({ ip: match[1], mac: match[2] });
  }
  return entries;
}

// 通用回退：arp -a（macOS / Linux / Windows 三种格式）
function parseArpA(text) {
  const entries = [];
  for (const line of String(text || '').split('\n')) {
    const ipMatch = line.match(/(\d+\.\d+\.\d+\.\d+)/);
    if (!ipMatch) continue;
    if (/incomplete/i.test(line)) continue;
    const macMatch = line.match(/([0-9a-fA-F]{1,2}(?:[:-][0-9a-fA-F]{1,2}){5})/);
    if (!macMatch) continue;
    entries.push({ ip: ipMatch[1], mac: macMatch[1] });
  }
  return entries;
}

// 按平台给出读邻居表的来源，依次尝试（前者不可用/报错才降级）
function neighborSources(platform) {
  if (platform === 'linux') {
    return [
      { name: 'ip-neigh', kind: 'cmd', command: 'ip', args: ['-4', 'neigh', 'show'], parse: parseIpNeigh },
      { name: 'proc-net-arp', kind: 'file', file: '/proc/net/arp', parse: parseProcNetArp },
      { name: 'arp-a', kind: 'cmd', command: 'arp', args: ['-a'], parse: parseArpA }
    ];
  }
  if (platform === 'darwin') {
    return [
      { name: 'netstat-rn', kind: 'cmd', command: 'netstat', args: ['-rn', '-f', 'inet'], parse: parseNetstatRoute },
      { name: 'arp-a', kind: 'cmd', command: 'arp', args: ['-a'], parse: parseArpA }
    ];
  }
  return [{ name: 'arp-a', kind: 'cmd', command: 'arp', args: ['-a'], parse: parseArpA }];
}

async function readNeighborEntries(options = {}) {
  const platform = options.platform || process.platform;
  const attempts = [];
  for (const source of neighborSources(platform)) {
    try {
      const raw = source.kind === 'file'
        ? await fs.promises.readFile(source.file, 'utf8')
        : (await execFileAsync(source.command, source.args, { timeout: COMMAND_TIMEOUT_MS })).stdout;
      return { entries: source.parse(raw), source: source.name };
    } catch (error) {
      attempts.push(`${source.name}: ${error.message}`);
    }
  }
  throw new Error(`读取邻居表失败（${platform}）: ${attempts.join('; ')}`);
}

// ---------- 探测 ----------

async function probeHosts(ips, options = {}) {
  if (!ips.length) return 0;
  const port = options.probePort || PROBE_PORT;
  const rounds = options.probeRounds || PROBE_ROUNDS;
  const gapMs = options.probeRoundGapMs === undefined ? PROBE_ROUND_GAP_MS : options.probeRoundGapMs;
  const socket = dgram.createSocket('udp4');
  const payload = Buffer.alloc(1);
  let inFlight = 0;
  let settle;
  const idle = new Promise((resolve) => { settle = resolve; });

  try {
    for (let round = 0; round < rounds; round += 1) {
      for (const ip of ips) {
        inFlight += 1;
        try {
          socket.send(payload, port, ip, () => {
            inFlight -= 1;
            if (inFlight === 0) settle();
          });
        } catch (error) {
          inFlight -= 1; // 目标不可达等错误忽略即可，探测失败不影响其他地址
        }
      }
      if (inFlight === 0) settle();
      const flushed = await Promise.race([idle, delay(2000)]);
      void flushed;
      if (round < rounds - 1 && gapMs > 0) await delay(gapMs);
    }
    if (inFlight > 0) await Promise.race([idle, delay(1000)]);
  } finally {
    socket.close();
  }
  return ips.length;
}

// ---------- 组装设备表 ----------

function compareIp(a, b) {
  const left = ipv4ToInt(a && a.ip);
  const right = ipv4ToInt(b && b.ip);
  if (left === null || right === null) return 0;
  return left - right;
}

// 只保留"本轮探测过 + 有有效单播 MAC"的条目，附上本机自己的地址，按 IP 排序
function buildDevices({ hosts, entries, selfEntries }) {
  const byIp = new Map();

  for (const entry of entries || []) {
    const ip = entry && entry.ip;
    if (!hosts.has(ip)) continue;
    const mac = normalizeMac(entry.mac);
    if (!mac) continue;
    if (!byIp.has(ip)) byIp.set(ip, mac);
  }

  for (const self of selfEntries || []) {
    const ip = self && self.ip;
    const mac = normalizeMac(self.mac);
    if (!ip || !mac) continue;
    if (!byIp.has(ip)) byIp.set(ip, mac);
  }

  return Array.from(byIp, ([ip, mac]) => ({ ip, mac })).sort(compareIp);
}

// 本机各网卡自己的地址（保证本机条目在表里，与旧实现一致）
function collectSelfEntries(networks) {
  return (networks || [])
    .filter((network) => network && network.address && network.mac)
    .map((network) => ({ ip: network.address, mac: network.mac }));
}

// 两张设备表是否等价（用于跳过无意义的 config.json 写入）
function deviceTablesEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!a[i] || !b[i]) return false;
    if (a[i].ip !== b[i].ip || a[i].mac !== b[i].mac) return false;
  }
  return true;
}

// 用本轮扫描结果整体替换旧表（不是追加）：
// 扫到的就是全部，离线/换 IP 的旧记录不再保留，同时给出变更明细供日志输出
function diffDeviceTables(previous, scanned) {
  const previousList = Array.isArray(previous) ? previous.filter((item) => item && item.ip) : [];
  const nextList = Array.isArray(scanned) ? scanned.filter((item) => item && item.ip) : [];

  const previousByIp = new Map();
  for (const device of previousList) {
    if (!previousByIp.has(device.ip)) previousByIp.set(device.ip, device);
  }
  const nextIps = new Set(nextList.map((device) => device.ip));

  const added = [];
  const updated = [];
  for (const device of nextList) {
    const existing = previousByIp.get(device.ip);
    if (!existing) {
      added.push(device);
    } else if (existing.mac !== device.mac) {
      updated.push({ ip: device.ip, from: existing.mac, to: device.mac });
    }
  }

  const removed = previousList.filter((device) => !nextIps.has(device.ip));

  return {
    devices: nextList,
    added,
    updated,
    removed,
    changed: added.length > 0 || updated.length > 0 || removed.length > 0
  };
}

// ---------- 主流程 ----------

// 扫描本机所在的所有局域网网段，返回 [{ ip, mac }]（MAC 统一大写）
// options 里的注入点仅用于单测
async function scanLan(options = {}) {
  const interfaces = options.interfaces || os.networkInterfaces();
  const networks = options.networks || collectScanNetworks(interfaces);
  if (!networks.length) {
    throw new Error('没有找到可扫描的局域网网段（无 192.168/10 私有地址）');
  }

  const hosts = [];
  for (const network of networks) hosts.push(...hostsForNetwork(network));
  const hostSet = new Set(hosts);

  const subnetList = networks.map((network) => `${network.base}/${network.prefix}(${network.name})`).join(', ');
  console.log(`[lan-scan] 开始扫描网段: ${subnetList}，共 ${hosts.length} 个地址`);

  const probe = options.probeHosts || probeHosts;
  await probe(hosts, options);

  const wait = options.delay || delay;
  const settleMs = options.settleMs === undefined ? SETTLE_MS : options.settleMs;
  if (settleMs > 0) await wait(settleMs);

  const readNeighbor = options.readNeighborEntries || readNeighborEntries;
  const { entries, source } = await readNeighbor(options);
  const devices = buildDevices({
    hosts: hostSet,
    entries,
    selfEntries: collectSelfEntries(networks)
  });

  console.log(`[lan-scan] 邻居表(${source}) ${entries.length} 条，命中本网段 ${devices.length} 台设备`);
  return devices;
}

module.exports = {
  scanLan,
  collectScanNetworks,
  collectSelfEntries,
  hostsForNetwork,
  buildDevices,
  deviceTablesEqual,
  diffDeviceTables,
  isScannableIpv4,
  normalizeMac,
  parseIpNeigh,
  parseProcNetArp,
  parseNetstatRoute,
  parseArpA,
  neighborSources,
  readNeighborEntries,
  probeHosts,
  prefixLengthFromNetmask,
  networkAddress
};
