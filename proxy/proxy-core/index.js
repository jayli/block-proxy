'use strict';

/**
 * Proxy-core facade — AnyProxy-compatible API surface.
 *
 * Replaces: const AnyProxy = require('@bachi/anyproxy');
 *
 * Usage in proxy/proxy.js:
 *   const { ProxyServer, utils: { certMgr, certLifecycle } } = require('./proxy-core');
 */

const ProxyServer = require('./proxy-server');
const certMgr = require('./cert-mgr');
const certLifecycle = require('./cert-lifecycle');

module.exports = {
  ProxyServer,
  utils: { certMgr, certLifecycle }
};
