// 文件名: proxy/temp-credentials.js
// 临时代理凭据：由 8004 管理后台按钮生成，固定有效期 7 天，作为 config.json 中
// auth_username/auth_password 的一组平替。
//
// 生效范围（严格限定，隧道 8003 不接入）：
//   - 8001 内网 HTTP 代理（proxy/proxy.js checkProxyAuth）
//   - 8002 公网 HTTP CONNECT over TLS（socks5/server.js createHttpConnectHandler）
//   - 8002 公网 SOCKS5（socks5/server.js createConnectionHandler）
//
// 落盘约定：
//   - 文件 temp_credentials.json 位于仓库根目录，已加入 .gitignore，不随仓库提交
//   - 追加式保存，最多保留最新 MAX_CREDENTIALS 条，超出裁掉最旧的
//
// 性能约定：
//   - isValid() 在认证路径上同步执行，只读内存缓存；缓存按 TTL + 文件 mtime 失效，
//     避免每个请求都 stat/read 磁盘

const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_FILE_PATH = path.join(__dirname, '../temp_credentials.json');
const MAX_CREDENTIALS = 20;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 缓存最长存活时间：到期后重新 stat 文件，mtime 变化才重读内容
const CACHE_TTL_MS = 5000;

// 密码字符表去掉易混淆字符（0/O、1/l/I），方便手输
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

var filePath = DEFAULT_FILE_PATH;
var cache = null;          // { credentials, mtimeMs, loadedAt }
var parseErrorLogged = false;

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function randomPassword(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  }
  return out;
}

function normalizeList(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const list = Array.isArray(raw) ? raw : raw.credentials;
  if (!Array.isArray(list)) return [];
  return list.filter((item) => item && typeof item.username === 'string' && typeof item.password === 'string');
}

function readFromDisk() {
  let stat = null;
  try {
    stat = fsSync.statSync(filePath);
  } catch (e) {
    // 文件不存在是正常状态（从未生成过）
    cache = { credentials: [], mtimeMs: 0, loadedAt: Date.now() };
    return cache.credentials;
  }

  if (cache && cache.mtimeMs === stat.mtimeMs && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.credentials;
  }

  try {
    const content = fsSync.readFileSync(filePath, 'utf8');
    const credentials = normalizeList(JSON.parse(content));
    cache = { credentials, mtimeMs: stat.mtimeMs, loadedAt: Date.now() };
    parseErrorLogged = false;
  } catch (e) {
    if (!parseErrorLogged) {
      parseErrorLogged = true;
      console.error('[TempCredentials] 读取临时凭据文件失败，按无临时凭据处理:', e.message);
    }
    cache = { credentials: [], mtimeMs: stat.mtimeMs, loadedAt: Date.now() };
  }
  return cache.credentials;
}

function getAll() {
  return readFromDisk();
}

function write(credentials) {
  const trimmed = credentials.slice(-MAX_CREDENTIALS);
  fsSync.writeFileSync(filePath, JSON.stringify({ credentials: trimmed }, null, 2), 'utf8');
  let mtimeMs = 0;
  try {
    mtimeMs = fsSync.statSync(filePath).mtimeMs;
  } catch (e) {}
  cache = { credentials: trimmed, mtimeMs, loadedAt: Date.now() };
  return trimmed;
}

function statusOf(credential, now) {
  if (!credential) return { status: 'none', remaining_ms: 0 };
  if (credential.revoked) return { status: 'revoked', remaining_ms: 0 };
  const expiresAt = Date.parse(credential.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return { status: 'expired', remaining_ms: 0 };
  }
  return { status: 'active', remaining_ms: expiresAt - now };
}

// 生成一条新的临时凭据（固定 7 天有效期），追加写入文件
function generate() {
  const now = Date.now();
  const createdAt = new Date(now);
  const expiresAt = new Date(now + TTL_MS);
  const credential = {
    username: `tmp_${randomHex(4)}`,
    password: randomPassword(12),
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    revoked: false
  };
  write(getAll().concat([credential]));
  return { ...credential, ...statusOf(credential, Date.now()) };
}

// 最新一条凭据（含状态与剩余时间），没有则 status 为 'none'
function getLatest() {
  const list = getAll();
  const credential = list.length > 0 ? list[list.length - 1] : null;
  if (!credential) return { status: 'none', remaining_ms: 0 };
  return { ...credential, ...statusOf(credential, Date.now()) };
}

// 撤销最新一条凭据（保留记录以便 UI 展示「已撤销」）
function revokeLatest() {
  const list = getAll().slice();
  if (list.length === 0) return { status: 'none', remaining_ms: 0 };
  const latest = { ...list[list.length - 1], revoked: true };
  list[list.length - 1] = latest;
  write(list);
  return { ...latest, ...statusOf(latest, Date.now()) };
}

// 等长比较：长度不等直接 false，等长时用 timingSafeEqual
function safeEqual(expected, actual) {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// 认证路径调用：username/password 命中一条未撤销且未过期的临时凭据则返回 true
function isValid(username, password) {
  if (typeof username !== 'string' || username === '') return false;
  if (typeof password !== 'string' || password === '') return false;
  const now = Date.now();
  const list = getAll();
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (item.revoked) continue;
    if (Date.parse(item.expires_at) <= now) continue;
    if (safeEqual(item.username, username) && safeEqual(item.password, password)) return true;
  }
  return false;
}

// 测试用：切换存储文件并清空缓存
function configure(options = {}) {
  if (options.filePath !== undefined) filePath = options.filePath;
  cache = null;
  parseErrorLogged = false;
}

function getFilePath() {
  return filePath;
}

module.exports = {
  generate,
  getLatest,
  revokeLatest,
  isValid,
  getAll,
  configure,
  getFilePath,
  MAX_CREDENTIALS,
  TTL_MS
};
