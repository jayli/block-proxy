// 文件名: proxy/auth-bypass-hosts.js
// 代理认证豁免白名单：命中名单的 host 在 8001 内网 HTTP 代理上免代理认证（不要求
// Proxy-Authorization，不回 407）。用于那些收到 407 后不会带凭据重试、直接失败的 app
// （E听说中学、小红书、知乎等）。
//
// 生效范围：仅 8001 内网 HTTP 代理（proxy/proxy.js 的 authPass）。8002 公网代理有独立
// 认证逻辑，不读本名单。
//
// 落盘约定：
//   - 文件 auth_bypass_hosts.json 位于仓库根目录，随仓库提交（区别于 temp_credentials.json）
//   - 结构 { "hosts": ["a.com", "b.com:443", ...] }
//
// 生效时机：proxy.js 在 loadConfig()（启动 / 重启代理）时读取一次，改完需重启代理生效。
//
// 失败语义（fail-closed）：文件缺失或 JSON 损坏时按「空白名单」处理并打印日志，
// 即宁可要求认证，也不误放行。

const fsSync = require('fs');
const path = require('path');

const DEFAULT_FILE_PATH = path.join(__dirname, '../auth_bypass_hosts.json');

var filePath = DEFAULT_FILE_PATH;
var readErrorLogged = false;

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

// 读取白名单。文件缺失 / 损坏均返回 { hosts: [] }（fail-closed）
function read() {
  let content;
  try {
    content = fsSync.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      if (!readErrorLogged) {
        readErrorLogged = true;
        console.warn('[AuthBypassHosts] 白名单文件不存在，按空名单处理:', filePath);
      }
    } else if (!readErrorLogged) {
      readErrorLogged = true;
      console.error('[AuthBypassHosts] 读取白名单文件失败，按空名单处理:', e.message);
    }
    return { hosts: [] };
  }

  try {
    const parsed = JSON.parse(content);
    readErrorLogged = false;
    return { hosts: normalizeList(parsed) };
  } catch (e) {
    if (!readErrorLogged) {
      readErrorLogged = true;
      console.error('[AuthBypassHosts] 白名单文件 JSON 解析失败，按空名单处理:', e.message);
    }
    return { hosts: [] };
  }
}

// 整表写入白名单。非法项抛错（由调用方转成 400），合法项去重后落盘
function write(hosts) {
  if (!Array.isArray(hosts)) {
    throw new Error('hosts 必须是数组');
  }
  const invalid = hosts.filter((h) => normalizeHost(h) === null);
  if (invalid.length > 0) {
    throw new Error('包含非法域名项: ' + invalid.map((h) => JSON.stringify(h)).join(', '));
  }
  const normalized = normalizeList(hosts);
  fsSync.writeFileSync(filePath, JSON.stringify({ hosts: normalized }, null, 2) + '\n', 'utf8');
  readErrorLogged = false;
  return normalized;
}

// 测试用：切换存储文件并重置日志去重标记
function configure(options = {}) {
  if (options.filePath !== undefined) filePath = options.filePath;
  readErrorLogged = false;
}

function getFilePath() {
  return filePath;
}

module.exports = {
  read,
  write,
  normalizeHost,
  normalizeList,
  configure,
  getFilePath
};
