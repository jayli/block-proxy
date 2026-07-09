'use strict';

/**
 * HTTPS server manager extracted from @bachi/anyproxy/lib/httpsServerMgr.js.
 *
 * Manages SNI-based and IP-based HTTPS servers for MITM proxying.
 *
 * Replaced:
 *  - async-task-mgr → local Promise lock map
 *  - async.series → Promise flow
 *  - colorful → local log module
 */

const https = require('https');
const tls = require('tls');
const assert = require('assert');
const crypto = require('crypto');
const constants = require('constants');
const certMgr = require('./cert-mgr');
const logUtil = require('./log');
const util = require('./util');
const wsServerMgr = require('./ws-server-mgr');

const DEFAULT_SNI_CONTEXT_CACHE_LIMIT = 1000;

function getSecureOptions() {
  return constants.SSL_OP_NO_SSLv3 | constants.SSL_OP_NO_TLSv1;
}

function createLRUCache(limit) {
  const maxEntries = Math.max(1, limit || DEFAULT_SNI_CONTEXT_CACHE_LIMIT);
  const store = new Map();

  return {
    get(key) {
      if (!store.has(key)) return undefined;
      const value = store.get(key);
      store.delete(key);
      store.set(key, value);
      return value;
    },

    set(key, value) {
      if (store.has(key)) store.delete(key);
      store.set(key, value);

      while (store.size > maxEntries) {
        const oldestKey = store.keys().next().value;
        store.delete(oldestKey);
      }
    },

    size() {
      return store.size;
    }
  };
}

function normalizeSNIName(serverName) {
  return String(serverName || '').toLowerCase();
}

/**
 * Create an HTTPS server with SNI-based dynamic certificate generation.
 *
 * @param {number} port
 * @param {function} handler
 * @returns {Promise<https.Server>}
 */
function createHttpsSNIServer(port, handler) {
  assert(port && handler, 'invalid param for https SNI server');

  const createSecureContext = tls.createSecureContext || crypto.createSecureContext;
  const secureContextCache = createLRUCache(DEFAULT_SNI_CONTEXT_CACHE_LIMIT);

  function SNIPrepareCert(serverName, SNICallback) {
    const cacheKey = normalizeSNIName(serverName);
    const cachedCtx = secureContextCache.get(cacheKey);
    if (cachedCtx) {
      SNICallback(null, cachedCtx);
      return;
    }

    certMgr.getCertificate(serverName, (err, keyContent, crtContent) => {
      if (err) {
        logUtil.printLog('err occurred when prepare certs for SNI - ' + err, logUtil.T_ERR);
        logUtil.printLog('err occurred when prepare certs for SNI - ' + err.stack, logUtil.T_ERR);
        SNICallback(err);
        return;
      }

      try {
        const ctx = createSecureContext({
          key: keyContent,
          cert: crtContent
        });
        secureContextCache.set(cacheKey, ctx);
        logUtil.printLog(`[internal https] proxy server for ${serverName} established`);
        SNICallback(null, ctx);
      } catch (e) {
        logUtil.printLog('err occurred when prepare certs for SNI - ' + e, logUtil.T_ERR);
        SNICallback(e);
      }
    });
  }

  return new Promise((resolve) => {
    const server = https.createServer({
      secureOptions: getSecureOptions(),
      SNICallback: SNIPrepareCert,
      ALPNProtocols: ['http/1.1'],
    }, handler).listen(port);
    resolve(server);
  });
}

/**
 * Create an HTTPS server for an IP-based host (no SNI).
 *
 * @param {string} ip
 * @param {number} port
 * @param {function} handler
 * @returns {Promise<https.Server>}
 */
function createHttpsIPServer(ip, port, handler) {
  assert(ip && port && handler, 'invalid param for https IP server');

  return new Promise((resolve, reject) => {
    certMgr.getCertificate(ip, (err, keyContent, crtContent) => {
      if (err) return reject(err);
      const server = https.createServer({
        secureOptions: getSecureOptions(),
        key: keyContent,
        cert: crtContent,
      }, handler).listen(port);

      resolve(server);
    });
  });
}

/**
 * HTTPS Server Manager
 *
 * Creates and caches HTTPS servers for MITM proxying.
 * Uses a Promise lock map to deduplicate concurrent server creation for the same host.
 */
class HttpsServerMgr {
  constructor(config) {
    if (!config || !config.handler) {
      throw new Error('handler is required');
    }
    this.handler = config.handler;
    this.wsHandler = config.wsHandler;
    this.activeServers = [];

    // Promise lock map: key → Promise<{host, port}>
    this._pendingServers = new Map();
  }

  /**
   * Get or create a shared HTTPS server for the given hostname.
   *
   * For IP hosts, creates a dedicated IP-based server.
   * For domain hosts, creates/reuses a shared SNI server on 127.0.0.1.
   *
   * @param {string} hostname
   * @returns {Promise<{host: string, port: number}>}
   */
  getSharedHttpsServer(hostname) {
    const ifIPHost = hostname && util.isIp(hostname);
    const serverHost = '127.0.0.1';
    const lockKey = ifIPHost ? hostname : serverHost;

    // Check if already pending or created
    if (this._pendingServers.has(lockKey)) {
      return this._pendingServers.get(lockKey);
    }

    const serverPromise = this._createServer(ifIPHost, hostname, serverHost)
      .catch((err) => {
        // Remove failed entry so retry can recreate
        this._pendingServers.delete(lockKey);
        throw err;
      });

    this._pendingServers.set(lockKey, serverPromise);
    return serverPromise;
  }

  _createServer(ifIPHost, hostname, serverHost) {
    return util.getFreePort()
      .then((freePort) => {
        if (ifIPHost) {
          return createHttpsIPServer(hostname, freePort, this.handler)
            .then(server => ({ server, port: freePort }));
        } else {
          return createHttpsSNIServer(freePort, this.handler)
            .then(server => ({ server, port: freePort }));
        }
      })
      .then(({ server, port }) => {
        this.activeServers.push(server);

        wsServerMgr.getWsServer({
          server: server,
          connHandler: this.wsHandler
        });

        server.on('upgrade', (req, cltSocket, head) => {
          logUtil.debug('will let WebSocket server to handle the upgrade event');
        });

        return {
          host: serverHost,
          port: port,
        };
      });
  }

  close() {
    this.activeServers.forEach(server => {
      server.close();
    });
    this._pendingServers.clear();
  }
}

HttpsServerMgr._test = {
  createLRUCache,
  getSecureOptions,
  normalizeSNIName,
};

module.exports = HttpsServerMgr;
