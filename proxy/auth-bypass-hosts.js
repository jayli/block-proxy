// 文件名: proxy/auth-bypass-hosts.js
// 代理认证豁免白名单：命中名单的 host 在 8001 内网 HTTP 代理上免代理认证（不要求
// Proxy-Authorization，不回 407）。用于那些收到 407 后不会带凭据重试、直接失败的 app
// （E听说中学、小红书、知乎等）。
//
// 生效范围：仅 8001 内网 HTTP 代理（proxy/proxy.js 的 authPass）。8002 公网代理有独立
// 认证逻辑，不读本名单。
//
// 两份名单：
//   - 内置 auth_bypass_hosts.json：随仓库提交、随 npm 包分发，8004 后台只展示不可改，
//     调整需改代码发版。结构 { "hosts": [...] }
//   - 临时 temp_auth_bypass_hosts.json：已 gitignore，8004 后台可自由增删，用于现场
//     快速放行某个 app。结构同上
//   两者合并去重后生效（内置优先）。
//
// 生效时机：proxy.js 在 loadConfig()（启动 / 重启代理）时读取一次，改完需重启代理生效。
//
// 失败语义（fail-closed）：文件缺失或 JSON 损坏时按「空白名单」处理并打印日志，
// 即宁可要求认证，也不误放行。

const fsSync = require('fs');
const path = require('path');

const DEFAULT_BUILTIN_FILE_PATH = path.join(__dirname, '../auth_bypass_hosts.json');
const DEFAULT_TEMP_FILE_PATH = path.join(__dirname, '../temp_auth_bypass_hosts.json');

var builtinFilePath = DEFAULT_BUILTIN_FILE_PATH;
var tempFilePath = DEFAULT_TEMP_FILE_PATH;
// 按文件路径记录「已打印过读取告警」，避免热路径上刷屏
var readErrorLogged = new Set();

// 归一化单个 host：trim + 转小写；非法项返回 null
// 允许 "example.com" 与 "example.com:443" 两种形态（authPass 按 endsWith 匹配）
function normalizeHost(raw) {
  if (typeof raw !== 'string') return null;
  const host = raw.trim().toLowerCase();
  if (host === '') return null;
  // 拒绝协议前缀、空白字符、通配符等非法形态
  if (/\s/.test(host)) return null;
  if (host.includes('://')) return null;
  if (host.includes('*')) return null;
  return host;
}

// 从任意输入提取合法 host 列表：去重、保序
function normalizeList(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.hosts) ? raw.hosts : []);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const host = normalizeHost(item);
    if (host === null) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

// 读单个名单文件。缺失 / 损坏均返回 []（fail-closed）
function readList(file, label) {
  let content;
  try {
    content = fsSync.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      // 临时名单从未创建过是正常状态，不打印告警
      if (label !== '临时') {
        if (!readErrorLogged.has(file)) {
          readErrorLogged.add(file);
          console.warn(`[AuthBypassHosts] ${label}白名单文件不存在，按空名单处理:`, file);
        }
      }
    } else if (!readErrorLogged.has(file)) {
      readErrorLogged.add(file);
      console.error(`[AuthBypassHosts] 读取${label}白名单文件失败，按空名单处理:`, e.message);
    }
    return [];
  }

  try {
    const parsed = JSON.parse(content);
    readErrorLogged.delete(file);
    return normalizeList(parsed);
  } catch (e) {
    if (!readErrorLogged.has(file)) {
      readErrorLogged.add(file);
      console.error(`[AuthBypassHosts] ${label}白名单文件 JSON 解析失败，按空名单处理:`, e.message);
    }
    return [];
  }
}

// 内置名单（只读）
function readBuiltin() {
  return readList(builtinFilePath, '内置');
}

// 临时名单（可写）
function readTemp() {
  return readList(tempFilePath, '临时');
}

// 合并两份名单：内置优先，临时项去重后追加
function readAll() {
  const builtin = readBuiltin();
  const temp = readTemp();
  const seen = new Set(builtin);
  const merged = builtin.slice();
  for (const host of temp) {
    if (seen.has(host)) continue;
    seen.add(host);
    merged.push(host);
  }
  return { builtin, temp, hosts: merged };
}

// 兼容旧调用：返回合并后的名单
function read() {
  return { hosts: readAll().hosts };
}

// 整表写入临时名单。非法项抛错（由调用方转成 400），合法项去重后落盘。
// 内置名单不提供写入接口。
function writeTemp(hosts) {
  if (!Array.isArray(hosts)) {
    throw new Error('hosts 必须是数组');
  }
  const invalid = hosts.filter((h) => normalizeHost(h) === null);
  if (invalid.length > 0) {
    throw new Error('包含非法域名项: ' + invalid.map((h) => JSON.stringify(h)).join(', '));
  }
  const normalized = normalizeList(hosts);
  fsSync.writeFileSync(tempFilePath, JSON.stringify({ hosts: normalized }, null, 2) + '\n', 'utf8');
  readErrorLogged.delete(tempFilePath);
  return normalized;
}

// 测试用：切换存储文件并重置告警去重标记
function configure(options = {}) {
  if (options.builtinFilePath !== undefined) builtinFilePath = options.builtinFilePath;
  if (options.tempFilePath !== undefined) tempFilePath = options.tempFilePath;
  // 兼容旧签名
  if (options.filePath !== undefined) tempFilePath = options.filePath;
  readErrorLogged = new Set();
}

function getFilePaths() {
  return { builtin: builtinFilePath, temp: tempFilePath };
}

module.exports = {
  read,
  readAll,
  readBuiltin,
  readTemp,
  writeTemp,
  normalizeHost,
  normalizeList,
  configure,
  getFilePaths
};
