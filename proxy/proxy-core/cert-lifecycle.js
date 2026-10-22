'use strict';

/**
 * Certificate lifecycle helpers for the MITM proxy.
 *
 * Leaf certificates are generated with `selfsigned`, which delegates key generation
 * and signing to WebCrypto (`crypto.subtle`). That matters on low-power routers:
 * the previous node-easy-cert/node-forge path generated RSA keys synchronously in
 * pure JS (measured 4.5–8.7s per host on an RK3588, blocking the whole event loop).
 * WebCrypto does the same work on the libuv threadpool (~1.1–1.8s) and only leaves
 * ~100ms of event loop lag.
 *
 * The lifecycle layer adds prewarming, validation, invalidation, and a shared
 * pending map around the generator.
 */

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const tls = require('tls');
const { domainToASCII } = require('url');
const selfsigned = require('selfsigned');
const util = require('./util');

// 与 easy-cert 保持一致，避免新旧证书签发参数漂移
const LEAF_KEY_SIZE = 2048;
const ROOT_CA_KEY_SIZE = 2048;
const LEAF_NOT_BEFORE_SKEW_MS = 24 * 60 * 60 * 1000; // 1 天前
const LEAF_VALID_DAYS = 824; // 对齐 Apple 的 824 天证书政策
const ROOT_CA_VALID_YEARS = 30;

let state = createState({});
const pendingCerts = new Map();

function createState(options) {
  const certDir = options.certDir || util.getAnyProxyHome();
  fs.mkdirSync(certDir, { recursive: true });

  return {
    certDir,
    mitmRegistry: options.mitmRegistry || null,
  };
}

function init(options = {}) {
  state = createState(options);
  pendingCerts.clear();
}

function normalizeHostname(hostname) {
  if (!hostname || typeof hostname !== 'string') {
    throw new Error('hostname is required');
  }

  let host = hostname.trim();
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close < 0) throw new Error('invalid bracketed hostname');
    host = host.slice(1, close);
  } else {
    const colon = host.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) {
      host = host.slice(0, colon);
    }
  }

  host = host.toLowerCase().replace(/\.$/, '');
  if (!host || /[\/\\\0]/.test(host)) {
    throw new Error('invalid hostname');
  }

  return domainToASCII(host) || host;
}

function getCachePaths(hostname) {
  const normalized = normalizeHostname(hostname);
  return {
    hostname: normalized,
    keyPath: path.join(state.certDir, `${normalized}.key`),
    crtPath: path.join(state.certDir, `${normalized}.crt`),
  };
}

function readRootCert() {
  const rootPath = path.join(state.certDir, 'rootCA.crt');
  if (!fs.existsSync(rootPath)) return null;
  return new crypto.X509Certificate(fs.readFileSync(rootPath));
}

function readRootCaPem() {
  const keyPath = path.join(state.certDir, 'rootCA.key');
  const crtPath = path.join(state.certDir, 'rootCA.crt');
  if (!fs.existsSync(keyPath) || !fs.existsSync(crtPath)) {
    throw new Error('rootCA.key / rootCA.crt not found, generate the root CA first');
  }
  return {
    key: fs.readFileSync(keyPath, 'utf8'),
    cert: fs.readFileSync(crtPath, 'utf8'),
  };
}

function hasHostnameInSan(cert, hostname) {
  const san = cert.subjectAltName || '';
  if (net.isIP(hostname)) {
    return san.includes(`IP Address:${hostname}`);
  }
  return san.includes(`DNS:${hostname}`);
}

function validateCache(paths) {
  try {
    if (!fs.existsSync(paths.keyPath) || !fs.existsSync(paths.crtPath)) {
      return false;
    }

    const key = fs.readFileSync(paths.keyPath);
    const certPem = fs.readFileSync(paths.crtPath);
    const leaf = new crypto.X509Certificate(certPem);
    const root = readRootCert();

    if (!root) return false;
    if (leaf.publicKey.asymmetricKeyType !== 'rsa') return false;
    if (leaf.publicKey.asymmetricKeyDetails.modulusLength !== 2048) return false;
    if (!leaf.verify(root.publicKey)) return false;
    if (!hasHostnameInSan(leaf, paths.hostname)) return false;

    const now = Date.now();
    if (now < Date.parse(leaf.validFrom) || now > Date.parse(leaf.validTo)) {
      return false;
    }

    tls.createSecureContext({ key, cert: certPem });
    return true;
  } catch (e) {
    return false;
  }
}

function deleteCache(paths) {
  try { fs.unlinkSync(paths.keyPath); } catch (e) {}
  try { fs.unlinkSync(paths.crtPath); } catch (e) {}
}

function getCertificateFromGenerator(hostname) {
  const rootCa = readRootCaPem();
  const notBefore = new Date(Date.now() - LEAF_NOT_BEFORE_SKEW_MS);
  const notAfter = new Date(Date.now() + LEAF_VALID_DAYS * 24 * 60 * 60 * 1000);
  const altNames = net.isIP(hostname)
    ? [{ type: 7, ip: hostname }]
    : [{ type: 2, value: hostname }];

  return selfsigned.generate([{ name: 'commonName', value: hostname }], {
    keyType: 'rsa',
    keySize: LEAF_KEY_SIZE,
    algorithm: 'sha256',
    ca: { cert: rootCa.cert, key: rootCa.key },
    notBeforeDate: notBefore,
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'subjectAltName', altNames },
    ],
  });
}

async function ensureCert(hostname) {
  const normalized = normalizeHostname(hostname);
  if (pendingCerts.has(normalized)) {
    return pendingCerts.get(normalized);
  }

  const promise = (async () => {
    const paths = getCachePaths(normalized);
    if (validateCache(paths)) {
      return {
        key: fs.readFileSync(paths.keyPath),
        cert: fs.readFileSync(paths.crtPath),
        source: 'cache',
      };
    }

    deleteCache(paths);
    const result = await getCertificateFromGenerator(normalized);
    // 生成器只返回值，落盘由本模块负责（写入目标受 getCachePaths 约束）
    fs.writeFileSync(paths.keyPath, result.private);
    fs.writeFileSync(paths.crtPath, result.cert);
    if (!validateCache(paths)) {
      deleteCache(paths);
      throw new Error(`generated certificate failed validation for ${normalized}`);
    }

    return {
      key: result.private,
      cert: result.cert,
      source: 'generated',
    };
  })().finally(() => {
    pendingCerts.delete(normalized);
  });

  pendingCerts.set(normalized, promise);
  return promise;
}

function getCertificate(hostname, cb) {
  ensureCert(hostname)
    .then(result => cb(null, result.key, result.cert))
    .catch(err => cb(err));
}

function ifRootCAFileExists() {
  const keyPath = path.join(state.certDir, 'rootCA.key');
  const crtPath = path.join(state.certDir, 'rootCA.crt');
  return fs.existsSync(crtPath) && fs.existsSync(keyPath);
}

function getRootCAFilePath() {
  return ifRootCAFileExists() ? path.join(state.certDir, 'rootCA.crt') : '';
}

function getCertDir() {
  return state.certDir;
}

function generateRootCA(cb) {
  const crtPath = path.join(state.certDir, 'rootCA.crt');
  const keyPath = path.join(state.certDir, 'rootCA.key');

  if (fs.existsSync(crtPath) && fs.existsSync(keyPath)) {
    // 与 easy-cert 的默认行为一致：已存在且未要求覆盖时直接返回
    if (typeof cb === 'function') cb(null, crtPath);
    return Promise.resolve({ keyPath, certPath: crtPath });
  }

  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + ROOT_CA_VALID_YEARS);

  // 与 cert/generator.js 保持同一套 CA 参数，避免两条路径签出的根证书不一致
  const promise = selfsigned.generate(
    [
      { name: 'commonName', value: 'BlockProxy' },
      { name: 'organizationName', value: 'BlockProxy' },
      { shortName: 'ST', value: 'SH' },
      { shortName: 'OU', value: 'BlockProxy SSL Proxy' },
    ],
    {
      keyType: 'rsa',
      keySize: ROOT_CA_KEY_SIZE,
      algorithm: 'sha256',
      notAfterDate,
      extensions: [
        { name: 'basicConstraints', cA: true, critical: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      ],
    }
  ).then((pems) => {
    // 私钥收 0600：泄露即可伪造任意站点
    fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
    fs.writeFileSync(crtPath, pems.cert, { mode: 0o644 });
    if (typeof cb === 'function') cb(null, crtPath);
    return { keyPath, certPath: crtPath };
  }).catch((error) => {
    if (typeof cb === 'function') {
      cb(error);
      return { keyPath, certPath: crtPath, error: error.message };
    }
    throw error;
  });

  return promise;
}

function invalidateCert(hostname, lru) {
  const paths = getCachePaths(hostname);
  deleteCache(paths);
  pendingCerts.delete(paths.hostname);

  if (lru && typeof lru.delete === 'function') {
    lru.delete(paths.hostname);
  }
}

function getDomainsToPrewarm(config = {}) {
  const domains = new Set();

  if (state.mitmRegistry && typeof state.mitmRegistry.getEnabledRules === 'function') {
    for (const rule of state.mitmRegistry.getEnabledRules()) {
      if (!rule || !rule.host) continue;
      try {
        domains.add(normalizeHostname(rule.host));
      } catch (e) {}
    }
  }

  if (Array.isArray(config.block_hosts)) {
    for (const item of config.block_hosts) {
      const host = typeof item === 'string' ? item : item && item.filter_host;
      if (!host) continue;
      try {
        domains.add(normalizeHostname(host));
      } catch (e) {}
    }
  }

  return Array.from(domains);
}

async function prewarmCerts(domains, options = {}) {
  const concurrency = Math.max(1, options.concurrency || 4);
  const queue = Array.from(new Set((domains || []).map(normalizeHostname)));
  let success = 0;
  let fail = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < queue.length) {
      const index = cursor++;
      try {
        await ensureCert(queue[index]);
        success++;
      } catch (e) {
        fail++;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { success, fail, total: queue.length };
}

async function healthCheck() {
  let kept = 0;
  let removed = 0;

  for (const fileName of fs.readdirSync(state.certDir)) {
    if (!fileName.endsWith('.crt') || fileName === 'rootCA.crt') {
      continue;
    }

    const hostname = fileName.slice(0, -4);
    const paths = getCachePaths(hostname);
    if (validateCache(paths)) {
      kept++;
    } else {
      deleteCache(paths);
      removed++;
    }
  }

  return { kept, removed };
}

module.exports = {
  init,
  normalizeHostname,
  getCachePaths,
  ensureCert,
  getCertificate,
  invalidateCert,
  rootCAExists: ifRootCAFileExists,
  ifRootCAFileExists,
  getRootCAPath: getRootCAFilePath,
  getRootCAFilePath,
  getCertDir,
  generateRootCA,
  getDomainsToPrewarm,
  prewarmCerts,
  healthCheck,
  _test: {
    validateCache,
  },
};
