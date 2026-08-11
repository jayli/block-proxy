'use strict';

/**
 * Certificate lifecycle helpers for the MITM proxy.
 *
 * This intentionally keeps node-easy-cert as the certificate generator so the
 * leaf certificate format stays compatible with the YouTube MITM fix. The
 * lifecycle layer adds prewarming, validation, invalidation, and a shared
 * pending map around the existing generator.
 */

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const tls = require('tls');
const { domainToASCII } = require('url');
const EasyCert = require('node-easy-cert');
const util = require('./util');

const DEFAULT_CERT_ATTRS = [
  { name: 'countryName', value: 'CN' },
  { name: 'organizationName', value: 'AnyProxy' },
  { shortName: 'ST', value: 'SH' },
  { shortName: 'OU', value: 'AnyProxy SSL Proxy' }
];

let state = createState({});
const pendingCerts = new Map();

function createEasyCert(certDir) {
  return new EasyCert({
    rootDirPath: certDir,
    inMemory: false,
    defaultCertAttrs: DEFAULT_CERT_ATTRS,
  });
}

function createState(options) {
  const certDir = options.certDir || util.getAnyProxyHome();
  fs.mkdirSync(certDir, { recursive: true });

  return {
    certDir,
    easyCert: createEasyCert(certDir),
    mitmRegistry: options.mitmRegistry || null,
  };
}

function resetGenerator() {
  state.easyCert = createEasyCert(state.certDir);
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

function getCertificateFromEasyCert(hostname) {
  return new Promise((resolve, reject) => {
    state.easyCert.getCertificate(hostname, (err, key, cert) => {
      if (err) {
        reject(err);
      } else {
        resolve({ key, cert });
      }
    });
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
    resetGenerator();
    const result = await getCertificateFromEasyCert(normalized);
    if (!validateCache(paths)) {
      deleteCache(paths);
      throw new Error(`generated certificate failed validation for ${normalized}`);
    }

    return {
      key: result.key,
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
  return state.easyCert.isRootCAFileExists();
}

function getRootCAFilePath() {
  return state.easyCert.getRootCAFilePath();
}

function getCertDir() {
  return state.certDir;
}

function generateRootCA(cb) {
  state.easyCert.generateRootCA({
    commonName: 'AnyProxy',
    overwrite: false,
  }, cb);
}

function invalidateCert(hostname, lru) {
  const paths = getCachePaths(hostname);
  deleteCache(paths);
  resetGenerator();
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
