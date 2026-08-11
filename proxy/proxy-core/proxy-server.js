'use strict';

/**
 * Proxy server facade extracted from @bachi/anyproxy/proxy.js.
 *
 * This is the ProxyCore/ProxyServer class that block-proxy uses.
 *
 * Kept:
 *  - EventEmitter behavior
 *  - httpProxyServer property
 *  - start(), close(), socket pool cleanup
 *  - HTTP/HTTPS server creation
 *  - CONNECT listener registration
 *  - WebSocket server registration
 *
 * Removed:
 *  - Recorder
 *  - WebInterface
 *  - ProxyRecorder, ProxyWebServer, systemProxyMgr exports
 *  - colorful logging
 *  - stream-throttle
 *
 * Fixed:
 *  - Pass customConnect into RequestHandler (fork gap)
 */

const http = require('http');
const https = require('https');
const events = require('events');
const co = require('co');
const certMgr = require('./cert-mgr');
const logUtil = require('./log');
const util = require('./util');
const wsServerMgr = require('./ws-server-mgr');

const T_TYPE_HTTP = 'http';
const T_TYPE_HTTPS = 'https';
const DEFAULT_TYPE = T_TYPE_HTTP;

const PROXY_STATUS_INIT = 'INIT';
const PROXY_STATUS_READY = 'READY';
const PROXY_STATUS_CLOSED = 'CLOSED';

/**
 * @class ProxyCore
 * @extends {events.EventEmitter}
 */
class ProxyCore extends events.EventEmitter {
  /**
   * @param {object} config
   * @param {number} config.port
   * @param {object} [config.rule]
   * @param {string} [config.type=http]
   * @param {string} [config.hostname=localhost]
   * @param {boolean} [config.forceProxyHttps=false]
   * @param {boolean} [config.silent=false]
   * @param {boolean} [config.dangerouslyIgnoreUnauthorized=false]
   * @param {boolean} [config.wsIntercept]
   * @param {function} [config.customConnect]
   * @param {number} [config.timeout]
   */
  constructor(config) {
    super();
    config = config || {};

    this.status = PROXY_STATUS_INIT;
    this.proxyPort = config.port;
    this.proxyType = /https/i.test(config.type || DEFAULT_TYPE) ? T_TYPE_HTTPS : T_TYPE_HTTP;
    this.proxyHostName = config.hostname || 'localhost';

    if (parseInt(process.versions.node.split('.')[0], 10) < 4) {
      throw new Error('node.js >= v4.x is required');
    } else if (config.forceProxyHttps && !certMgr.ifRootCAFileExists()) {
      throw new Error('root CA not found. Please generate one first.');
    } else if (this.proxyType === T_TYPE_HTTPS && !config.hostname) {
      throw new Error('hostname is required in https proxy');
    } else if (!this.proxyPort) {
      throw new Error('proxy port is required');
    } else if (config.forceProxyHttps && config.rule && config.rule.beforeDealHttpsRequest) {
      logUtil.printLog('both "-i(--intercept)" and rule.beforeDealHttpsRequest are specified, the "-i" option will be ignored.', logUtil.T_WARN);
      config.forceProxyHttps = false;
    }

    this.httpProxyServer = null;
    this.requestHandler = null;

    this.proxyRule = config.rule || {};

    if (config.silent) {
      logUtil.setPrintStatus(false);
    }

    // init request handler
    const RequestHandler = util.freshRequire('./request-handler');
    this.requestHandler = new RequestHandler({
      wsIntercept: config.wsIntercept,
      httpServerPort: config.port,
      forceProxyHttps: !!config.forceProxyHttps,
      dangerouslyIgnoreUnauthorized: !!config.dangerouslyIgnoreUnauthorized,
      customConnect: config.customConnect || null,
      isTunnelDomain: config.isTunnelDomain || null,
      timeout: config.timeout,
      mitmDebugLog: !!config.mitmDebugLog,
    }, this.proxyRule);
  }

  handleExistConnections(socket) {
    const self = this;
    self.socketIndex++;
    const key = `socketIndex_${self.socketIndex}`;
    self.socketPool[key] = socket;

    socket.on('close', () => {
      delete self.socketPool[key];
    });
  }

  start() {
    const self = this;
    self.socketIndex = 0;
    self.socketPool = {};

    if (self.status !== PROXY_STATUS_INIT) {
      throw new Error('server status is not PROXY_STATUS_INIT, can not run start()');
    }

    // Use Promise-based flow instead of async.series
    let serverCreation;
    if (self.proxyType === T_TYPE_HTTPS) {
      serverCreation = new Promise((resolve, reject) => {
        certMgr.getCertificate(self.proxyHostName, (err, keyContent, crtContent) => {
          if (err) {
            reject(err);
          } else {
            self.httpProxyServer = https.createServer({
              key: keyContent,
              cert: crtContent
            }, self.requestHandler.userRequestHandler);
            resolve();
          }
        });
      });
    } else {
      serverCreation = Promise.resolve().then(() => {
        self.httpProxyServer = http.createServer(self.requestHandler.userRequestHandler);
      });
    }

    serverCreation
      .then(() => {
        // Register CONNECT handler
        self.httpProxyServer.on('connect', self.requestHandler.connectReqHandler);

        // Register WebSocket server
        wsServerMgr.getWsServer({
          server: self.httpProxyServer,
          connHandler: self.requestHandler.wsHandler
        });

        // Track connections for cleanup
        self.httpProxyServer.on('connection', (socket) => {
          self.handleExistConnections.call(self, socket);
        });

        // Start listening
        return new Promise((resolve, reject) => {
          self.httpProxyServer.listen(self.proxyPort, () => {
            resolve();
          });
          self.httpProxyServer.on('error', reject);
        });
      })
      .then(() => {
        const tipText = (self.proxyType === T_TYPE_HTTP ? 'Http' : 'Https')
          + ' proxy started on port ' + self.proxyPort;
        logUtil.printLog(tipText);

        // Rule summary
        const ruleSummary = self.proxyRule.summary;
        if (ruleSummary) {
          co(function *() {
            let ruleSummaryString = '';
            if (typeof ruleSummary === 'string') {
              ruleSummaryString = ruleSummary;
            } else {
              ruleSummaryString = yield ruleSummary();
            }
            logUtil.printLog(`Active rule is: ${ruleSummaryString}`);
          });
        }

        self.status = PROXY_STATUS_READY;
        self.emit('ready');
      })
      .catch((err) => {
        logUtil.printLog('err when start proxy server :(', logUtil.T_ERR);
        logUtil.printLog(err, logUtil.T_ERR);
        self.emit('error', { error: err });
      });

    return self;
  }

  close() {
    return new Promise((resolve) => {
      if (this.httpProxyServer) {
        // Destroy HTTPS connections
        for (const connItem of this.requestHandler.conns) {
          const key = connItem[0];
          const conn = connItem[1];
          logUtil.printLog(`destroying https connection : ${key}`);
          conn.end();
        }

        // Close client sockets
        for (const cltSocketItem of this.requestHandler.cltSockets) {
          const key = cltSocketItem[0];
          const cltSocket = cltSocketItem[1];
          logUtil.printLog(`closing https cltSocket : ${key}`);
          cltSocket.end();
        }

        if (this.requestHandler.httpsServerMgr) {
          this.requestHandler.httpsServerMgr.close();
        }

        if (this.socketPool) {
          for (const key in this.socketPool) {
            this.socketPool[key].destroy();
          }
        }

        this.httpProxyServer.close((error) => {
          if (error) {
            console.error(error);
            logUtil.printLog(`proxy server close FAILED : ${error.message}`, logUtil.T_ERR);
          } else {
            this.httpProxyServer = null;
            this.status = PROXY_STATUS_CLOSED;
            logUtil.printLog(`proxy server closed at ${this.proxyHostName}:${this.proxyPort}`);
          }
          resolve(error);
        });
      } else {
        resolve();
      }
    });
  }
}

/**
 * ProxyServer — public facade used by block-proxy.
 *
 * In the original AnyProxy, this class added Recorder and WebInterface.
 * Here it's a thin wrapper over ProxyCore.
 */
class ProxyServer extends ProxyCore {
  constructor(config) {
    super(config);
  }
}

module.exports = ProxyServer;
module.exports.ProxyCore = ProxyCore;
module.exports.ProxyServer = ProxyServer;
