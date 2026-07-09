'use strict';

/**
 * Request handler extracted from @bachi/anyproxy/lib/requestHandler.js.
 *
 * This is the core proxy forwarding module handling:
 *  - HTTP proxy requests (getUserReqHandler)
 *  - HTTPS CONNECT tunnels (getConnectReqHandler)
 *  - WebSocket proxy (getWsHandler)
 *
 * Changes from fork source:
 *  - Removed recorder parameters and all recorder mutation
 *  - Added this.customConnect = config.customConnect (fork gap fix)
 *  - Preserved CONNECT head bytes in requestStream
 *  - Replaced colorful/logUtil with local log module
 *  - Removed global._throttle branches
 *  - Removed brotli package import (unused; proxy/proxy.js uses zlib.brotliDecompress)
 */

const http = require('http');
const https = require('https');
const net = require('net');
const url = require('url');
const Buffer = require('buffer').Buffer;
const util = require('./util');
const logUtil = require('./log');
const co = require('co');
const WebSocket = require('ws');
const HttpsServerMgr = require('./https-server-mgr');
const Readable = require('stream').Readable;

const requestErrorHandler = require('./request-error-handler');

// Fix TLS cache issue: https://github.com/nodejs/node/issues/8368
https.globalAgent.maxCachedSessions = 0;

// Custom keep-alive agents with bounded connection reuse.
// gRPC streams can be RST_STREAM'd independently while the TCP socket looks alive.
// Reusing a dead stream socket → ECONNRESET. Keep-alive with maxRequestsPerSocket=50
// recycles connections before streams go stale.
const _httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  maxRequestsPerSocket: 50,
});
const _httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  maxRequestsPerSocket: 50,
});

const DEFAULT_CHUNK_COLLECT_THRESHOLD = 20 * 1024 * 1024; // ~20 MB

// Check if responseRules match the current request
function matchResponseRule(responseRules, userConfig) {
  try {
    var hostname = userConfig.requestOptions.hostname.split(':')[0].toLowerCase();
    var pathname = userConfig.requestOptions.path;
    var fullUrl = `${userConfig.protocol}://${hostname}${pathname}`;
    var matched = false;
    for (const item of responseRules) {
      if (hostname.endsWith(item['host']) && new RegExp(item['regexp']).test(fullUrl)) {
        matched = true;
        break;
      }
    }
    return matched;
  } catch (e) {
    console.log(e);
    return false;
  }
}

class CommonReadableStream extends Readable {
  constructor(config) {
    super({
      highWaterMark: DEFAULT_CHUNK_COLLECT_THRESHOLD * 5
    });
  }
  _read(size) {
    // no-op: data is pushed externally
  }
}

/**
 * Get error response for exception scenarios.
 */
const getErrorResponse = (error, fullUrl) => {
  const errorResponse = {
    statusCode: 500,
    header: {
      'Content-Type': 'text/html; charset=utf-8',
      'Proxy-Error': true,
      'Proxy-Error-Message': error ? JSON.stringify(error) : 'null'
    },
    body: requestErrorHandler.getErrorContent(error, fullUrl)
  };
  return errorResponse;
};

/**
 * Only GET/HEAD/OPTIONS are safe to retry on a fresh connection.
 */
function _isRetryableMethod(method) {
  const m = (method || 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
}

/**
 * Fetch remote response with keep-alive agents and retry-once on ECONNRESET/EPIPE.
 *
 * @param {string} protocol
 * @param {object} options - http.request options
 * @param {buffer} reqData - request body
 * @param {object} config
 * @param {boolean} config.dangerouslyIgnoreUnauthorized
 * @param {number} config.chunkSizeThreshold
 * @param {number} config.timeout
 * @returns {Promise}
 */
function fetchRemoteResponse(protocol, options, reqData, config) {
  reqData = reqData || '';

  function _doRequest(useAgent) {
    return new Promise((resolve, reject) => {
      // Clone headers so retry gets a clean copy (delete ops are destructive)
      const headers = Object.assign({}, options.headers || {});
      delete headers['content-length'];
      delete headers['Content-Length'];
      delete headers['Transfer-Encoding'];
      delete headers['transfer-encoding'];

      const opts = Object.assign({}, options, { headers });

      if (config.dangerouslyIgnoreUnauthorized) {
        opts.rejectUnauthorized = false;
      }

      if (!config.chunkSizeThreshold) {
        throw new Error('chunkSizeThreshold is required');
      }

      const isHttps = /https/i.test(protocol);
      opts.agent = useAgent
        ? (isHttps ? _httpsAgent : _httpAgent)
        : false;

      let settled = false;
      const settleResolve = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const settleReject = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const proxyReq = (isHttps ? https : http).request(opts, (res) => {
        res.headers = util.getHeaderFromRawHeaders(res.rawHeaders);
        const statusCode = res.statusCode;
        const resHeader = res.headers;
        let resDataChunks = [];
        let rawResChunks = [];
        let resDataStream = null;
        let resSize = 0;

        const finishCollecting = () => {
          new Promise((fulfill, rejectParsing) => {
            if (resDataStream) {
              fulfill(resDataStream);
            } else {
              const serverResData = Buffer.concat(resDataChunks);
              fulfill(serverResData);
              return;
            }
          }).then((serverResData) => {
            settleResolve({
              statusCode,
              header: resHeader,
              body: serverResData,
              rawBody: rawResChunks,
              _res: res,
            });
          }).catch((e) => {
            settleReject(e);
          });
        };

        res.on('data', (chunk) => {
          if (resDataStream) {
            // stream mode — push directly
            resDataStream.push(chunk);
          } else {
            rawResChunks.push(chunk);
            resSize += chunk.length;
            resDataChunks.push(chunk);

            // Switch to stream mode when threshold exceeded
            if (resSize >= config.chunkSizeThreshold) {
              resDataStream = new CommonReadableStream();
              while (resDataChunks.length) {
                resDataStream.push(resDataChunks.shift());
              }
              resDataChunks = null;
              rawResChunks = null;
              finishCollecting();
            }
          }
        });

        res.on('end', () => {
          if (resDataStream) {
            resDataStream.push(null);
          } else {
            finishCollecting();
          }
        });
        res.on('error', (error) => {
          logUtil.printLog('error happened in response:' + error, logUtil.T_ERR);
          settleReject(error);
        });
      });

      if (config.timeout) {
        proxyReq.setTimeout(config.timeout, () => {
          const error = new Error('request timeout');
          error.code = 'ETIMEDOUT';
          proxyReq.destroy(error);
        });
      }

      proxyReq.on('error', settleReject);
      proxyReq.end(reqData);
    });
  }

  return _doRequest(true).catch((err) => {
    if ((err.code === 'ECONNRESET' || err.code === 'EPIPE') && _isRetryableMethod(options.method)) {
      logUtil.printLog(
        'requestHandler: retrying with fresh connection after ' + err.code,
        logUtil.T_WARN
      );
      return _doRequest(false);
    }
    throw err;
  });
}

/**
 * Get WebSocket request info from the ws upgrade request.
 */
function getWsReqInfo(wsReq) {
  const headers = wsReq.headers || {};
  const host = headers.host;
  if (!host) {
    throw new Error('missing Host header in WebSocket request');
  }
  const hostName = host.split(':')[0];
  const port = host.split(':')[1];
  const path = wsReq.url || '/';
  const isEncript = wsReq.connection && wsReq.connection.encrypted;

  const getNoWsHeaders = () => {
    const originHeaders = Object.assign({}, headers);
    const originHeaderKeys = Object.keys(originHeaders);
    originHeaderKeys.forEach((key) => {
      if (/sec-websocket/ig.test(key)) {
        delete originHeaders[key];
      }
    });
    delete originHeaders.connection;
    delete originHeaders.upgrade;
    return originHeaders;
  };

  return {
    headers: headers,
    noWsHeaders: getNoWsHeaders(),
    hostName: hostName,
    port: port,
    path: path,
    protocol: isEncript ? 'wss' : 'ws'
  };
}

// Recover source IP for MITM requests via socket maps
function getSourceIp(req, socketMap) {
  var localIp;
  try {
    if (req.client.remoteAddress === undefined) {
      localIp = '255.255.255.254';
    } else {
      localIp = req.client.remoteAddress.split(':').pop();
    }
  } catch (e) {
    console.log(e);
    localIp = '255.255.255.254';
    return localIp;
  }
  var connectionPort = getConnectionPort(req.socket.server._connectionKey);
  if (localIp != '127.0.0.1' && localIp != '0.0.0.0') {
    return localIp;
  } else {
    var mapKey = '127.0.0.1:' + connectionPort;
    if (socketMap.has(mapKey)) {
      if (socketMap.get(mapKey).remoteAddress === undefined) {
        localIp = '0.0.0.0';
      } else {
        localIp = socketMap.get(mapKey).remoteAddress.split(':').pop();
      }
    }
    return localIp;
  }
}

function getConnectionPort(connectionKey) {
  return connectionKey.split(':').pop();
}

function registerSocketMapCleanup(socketMap, key, socket) {
  if (!socketMap || !key || !socket || typeof socket.once !== 'function') return;

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (socketMap.get(key) === socket) {
      socketMap.delete(key);
    }
  }

  socket.once('close', cleanup);
}

function getWebSocketConnectRequestText(chunk) {
  try {
    const text = chunk.toString();
    return text.indexOf('GET ') === 0 ? text : '';
  } catch (e) {
    console.error(e);
    return '';
  }
}

/**
 * HTTP/HTTPS request handler (no recorder).
 *
 * @param {object} userRule
 */
function getUserReqHandler(userRule) {
  const reqHandlerCtx = this;

  return function (req, userRes) {
    req.sourceIp = getSourceIp(req, reqHandlerCtx.cltSockets);

    const host = req.headers.host;
    const protocol = (!!req.connection.encrypted && !(/^http:/).test(req.url)) ? 'https' : 'http';

    let fullUrl = protocol + '://' + host + req.url;
    if (protocol === 'http') {
      const reqUrlPattern = url.parse(req.url);
      if (reqUrlPattern.host && reqUrlPattern.protocol) {
        fullUrl = req.url;
      }
    }

    const urlPattern = url.parse(fullUrl);
    const path = urlPattern.path;
    const chunkSizeThreshold = DEFAULT_CHUNK_COLLECT_THRESHOLD;

    let reqData;
    let requestDetail;

    // Reconstruct headers from rawHeaders
    req.headers = util.getHeaderFromRawHeaders(req.rawHeaders);

    logUtil.printLog(`received request to: ${req.method} ${host}${path}`);

    const fetchReqData = () => new Promise((resolve) => {
      const postData = [];
      req.on('data', (chunk) => {
        postData.push(chunk);
      });
      req.on('end', () => {
        reqData = Buffer.concat(postData);
        resolve();
      });
    });

    const prepareRequestDetail = () => {
      const options = {
        hostname: urlPattern.hostname || req.headers.host,
        port: urlPattern.port || req.port || (/https/.test(protocol) ? 443 : 80),
        path,
        method: req.method,
        headers: req.headers
      };

      requestDetail = {
        requestOptions: options,
        protocol,
        url: fullUrl,
        requestData: reqData,
        _req: req
      };

      return Promise.resolve();
    };

    /**
     * Send response to client.
     */
    const sendFinalResponse = (finalResponseData) => {
      const responseInfo = finalResponseData.response;
      const resHeader = responseInfo.header;
      const responseBody = responseInfo.body || '';

      const transferEncoding = resHeader['transfer-encoding'] || resHeader['Transfer-Encoding'] || '';
      const contentLength = resHeader['content-length'] || resHeader['Content-Length'];
      const connection = resHeader.Connection || resHeader.connection;

      if (connection) {
        resHeader['x-anyproxy-origin-connection'] = connection;
        if (responseInfo.statusCode === 407 || responseInfo.statusCode === 200) {
          // pass through as-is
        }
      }

      if (!responseInfo) {
        throw new Error('failed to get response info');
      } else if (!responseInfo.statusCode) {
        throw new Error('failed to get response status code');
      } else if (!responseInfo.header) {
        throw new Error('failed to get response header');
      }

      // Set Content-Length if no transfer-encoding and not streaming
      if (transferEncoding !== 'chunked'
        && !(responseBody instanceof CommonReadableStream)
      ) {
        resHeader['Content-Length'] = util.getByteSize(responseBody);
      }

      userRes.writeHead(responseInfo.statusCode, resHeader);

      if (responseBody instanceof CommonReadableStream) {
        responseBody.pipe(userRes);
      } else {
        userRes.end(responseBody);
      }

      return responseInfo;
    };

    co(fetchReqData)
      .then(prepareRequestDetail)

      // invoke rule before sending request
      .then(co.wrap(function *() {
        const userModifiedInfo = (yield userRule.beforeSendRequest(Object.assign({}, requestDetail))) || {};
        const finalReqDetail = {};
        ['protocol', 'requestOptions', 'requestData', 'response'].map((key) => {
          finalReqDetail[key] = userModifiedInfo[key] || requestDetail[key];
        });
        return finalReqDetail;
      }))

      // route user config
      .then(co.wrap(function *(userConfig) {
        // If responseRules match, use high threshold to buffer full response for beforeSendResponse.
        // Otherwise use 64K threshold for early streaming.
        if (userRule.responseRules && matchResponseRule(userRule.responseRules, userConfig)) {
          var _chunkSizeThreshold = chunkSizeThreshold;
        } else {
          var _chunkSizeThreshold = 64 * 1024; // 64K
        }
        if (userConfig.response) {
          userConfig._directlyPassToRespond = true;
          return userConfig;
        } else if (userConfig.requestOptions) {
          const remoteResponse = yield fetchRemoteResponse(userConfig.protocol, userConfig.requestOptions, userConfig.requestData, {
            dangerouslyIgnoreUnauthorized: reqHandlerCtx.dangerouslyIgnoreUnauthorized,
            chunkSizeThreshold: _chunkSizeThreshold,
            timeout: reqHandlerCtx.timeout,
          });
          return {
            response: {
              statusCode: remoteResponse.statusCode,
              header: remoteResponse.header,
              body: remoteResponse.body,
              rawBody: remoteResponse.rawBody
            },
            _res: remoteResponse._res,
          };
        } else {
          throw new Error('lost response or requestOptions, failed to continue');
        }
      }))

      // invoke rule before responding to client
      .then(co.wrap(function *(responseData) {
        if (responseData._directlyPassToRespond) {
          return responseData;
        } else if (responseData.response.body && responseData.response.body instanceof CommonReadableStream) {
          // stream mode — skip beforeSendResponse
          return responseData;
        } else {
          return (yield userRule.beforeSendResponse(Object.assign({}, requestDetail), Object.assign({}, responseData))) || responseData;
        }
      }))

      .catch(co.wrap(function *(error) {
        logUtil.printLog(util.collectErrorLog(error), logUtil.T_ERR);

        let errorResponse = getErrorResponse(error, fullUrl);

        try {
          const userResponse = yield userRule.onError(Object.assign({}, requestDetail), error);
          if (userResponse && userResponse.response && userResponse.response.header) {
            errorResponse = userResponse.response;
          }
        } catch (e) {}

        return {
          response: errorResponse
        };
      }))
      .then(sendFinalResponse)

      .catch((e) => {
        logUtil.printLog('Send final response failed:' + e.message, logUtil.T_ERR);
      });
  };
}

/**
 * CONNECT request handler (no recorder).
 *
 * @param {object} userRule
 * @param {HttpsServerMgr} httpsServerMgr
 */
function getConnectReqHandler(userRule, httpsServerMgr) {
  const reqHandlerCtx = this;
  reqHandlerCtx.conns = new Map();
  reqHandlerCtx.cltSockets = new Map();

  return function (req, cltSocket, head) {
    const host = req.url.split(':')[0];
    const targetPort = req.url.split(':')[1];
    let shouldIntercept;
    let interceptWsRequest = false;
    let requestDetail;
    const requestStream = new CommonReadableStream();

    co(function *() {
      logUtil.printLog('received https CONNECT request ' + host);
      requestDetail = {
        host: req.url,
        _req: req
      };
      shouldIntercept = yield userRule.beforeDealHttpsRequest(requestDetail);

      if (shouldIntercept === null) {
        shouldIntercept = reqHandlerCtx.forceProxyHttps;
      }
    })
      .then(() => {
        return new Promise((resolve, reject) => {
          cltSocket.on('error', (error) => {
            if (error.code === 'EPIPE') {
              logUtil.printLog(`Client prematurely closed connection (EPIPE) during CONNECT response for ${req.url}`, logUtil.T_DEBUG);
              resolve();
            } else if (error.code === 'ECONNRESET') {
              logUtil.printLog(`Client reset connection (ECONNRESET) during CONNECT response for ${req.url}`, logUtil.T_DEBUG);
              resolve();
            } else {
              logUtil.printLog(`Socket error writing CONNECT response to client for ${req.url}: ${util.collectErrorLog(error)}`, logUtil.T_ERR);
              reject(error);
            }
          });

          try {
            cltSocket.write('HTTP/' + req.httpVersion + ' 200 OK\r\n\r\n', 'UTF-8', (writeErr) => {
              if (writeErr) {
                if (writeErr.code === 'EPIPE' || writeErr.code === 'ECONNRESET') {
                  logUtil.printLog(`Write failed due to client disconnect (EPIPE/ECONNRESET) for ${req.url}`, logUtil.T_DEBUG);
                  resolve();
                } else {
                  reject(writeErr);
                }
              } else {
                resolve();
              }
            });
          } catch (syncErr) {
            logUtil.printLog(`Sync error during write for ${req.url}: ${util.collectErrorLog(syncErr)}`, logUtil.T_ERR);
            reject(syncErr);
          }
        });
      })
      .then(() => {
        return new Promise((resolve, reject) => {
          let resolved = false;

          // Push CONNECT head bytes first, before any socket data
          if (head && head.length > 0) {
            requestStream.push(head);
            const headText = getWebSocketConnectRequestText(head);
            if (headText) {
              shouldIntercept = false;
              if (reqHandlerCtx.wsIntercept && headText.indexOf('GET /do-not-proxy') !== 0) {
                interceptWsRequest = true;
              }
            }
            resolved = true;
            resolve();
          }

          cltSocket.on('data', (chunk) => {
            requestStream.push(chunk);
            if (!resolved) {
              resolved = true;
              const chunkText = getWebSocketConnectRequestText(chunk);
              if (chunkText) {
                shouldIntercept = false; // websocket, do not intercept

                if (reqHandlerCtx.wsIntercept && chunkText.indexOf('GET /do-not-proxy') !== 0) {
                  interceptWsRequest = true;
                }
              }
              resolve();
            }
          });
          cltSocket.on('error', (error) => {
            if (error.code === 'EPIPE') {
              logUtil.printLog(`Client prematurely closed connection (EPIPE) for ${req.method} ${req.url}`, logUtil.T_DEBUG);
            } else if (error.code === 'ECONNRESET') {
              logUtil.printLog(`ECONNRESET---`, logUtil.T_ERR);
            } else {
              logUtil.printLog(`Socket error for ${req.method} ${req.url}: ${util.collectErrorLog(error)}`, logUtil.T_ERR);
              co.wrap(function *() {
                try {
                  yield userRule.onClientSocketError(requestDetail, error);
                } catch (e) {
                  logUtil.printLog(`Error notifying user rule about socket error: ${e.message}`, logUtil.T_WARN);
                }
              })();
            }
          });
          cltSocket.on('end', () => {
            requestStream.push(null);
          });
        });
      })
      .then(() => {
        if (shouldIntercept) {
          logUtil.printLog('will forward to local https server');
        } else {
          logUtil.printLog('will bypass the man-in-the-middle proxy');
        }
      })
      .then(() => {
        if (!shouldIntercept) {
          const originServer = {
            host,
            port: (targetPort === 80) ? 443 : targetPort
          };

          const localHttpServer = {
            host: 'localhost',
            port: reqHandlerCtx.httpServerPort
          };

          return interceptWsRequest ? localHttpServer : originServer;
        } else {
          return httpsServerMgr.getSharedHttpsServer(host).then(serverInfo => ({ host: serverInfo.host, port: serverInfo.port }));
        }
      })
      .then((serverInfo) => {
        if (!serverInfo.port || !serverInfo.host) {
          throw new Error('failed to get https server info');
        }

        return new Promise((resolve, reject) => {
          const setupPipe = (conn) => {
            if (conn.setTimeout) {
              conn.setTimeout(0);
            }
            requestStream.pipe(conn);
            conn.pipe(cltSocket);
            resolve();
          };

          let conn;
          if (reqHandlerCtx.customConnect) {
            conn = reqHandlerCtx.customConnect(serverInfo.host, serverInfo.port, () => {
              setupPipe(conn);
            });
          }

          if (!conn) {
            conn = net.connect(serverInfo.port, serverInfo.host, () => {
              setupPipe(conn);
            });
          }

          if (reqHandlerCtx.timeout && conn.setTimeout) {
            conn.setTimeout(reqHandlerCtx.timeout, () => {
              const error = new Error('connect timeout');
              error.code = 'ETIMEDOUT';
              conn.destroy(error);
              reject(error);
            });
          }

          conn.on('error', (e) => {
            reject(e);
          });

          const socketMapKey = serverInfo.host + ':' + serverInfo.port;
          reqHandlerCtx.conns.set(socketMapKey, conn);
          reqHandlerCtx.cltSockets.set(socketMapKey, cltSocket);
          registerSocketMapCleanup(reqHandlerCtx.conns, socketMapKey, conn);
          registerSocketMapCleanup(reqHandlerCtx.cltSockets, socketMapKey, cltSocket);
        });
      })
      .catch(co.wrap(function *(error) {
        logUtil.printLog(util.collectErrorLog(error), logUtil.T_ERR);

        try {
          yield userRule.onConnectError(requestDetail, error);
        } catch (e) { }

        try {
          let errorHeader = 'Proxy-Error: true\r\n';
          errorHeader += 'Proxy-Error-Message: ' + (error || 'null') + '\r\n';
          errorHeader += 'Content-Type: text/html\r\n';
          cltSocket.write('HTTP/1.1 502\r\n' + errorHeader + '\r\n\r\n');
        } catch (e) { }
      }));
  };
}

/**
 * WebSocket proxy handler (no recorder).
 *
 * @param {object} userRule
 * @param {WebSocket} wsClient
 * @param {http.IncomingMessage} wsReq
 */
function getWsHandler(userRule, wsClient, wsReq) {
  const self = this;
  try {
    const clientMsgQueue = [];
    const serverInfo = getWsReqInfo(wsReq);
    const serverInfoPort = serverInfo.port ? `:${serverInfo.port}` : '';
    const wsUrl = `${serverInfo.protocol}://${serverInfo.hostName}${serverInfoPort}${serverInfo.path}`;
    const proxyWs = new WebSocket(wsUrl, '', {
      rejectUnauthorized: !self.dangerouslyIgnoreUnauthorized,
      headers: serverInfo.noWsHeaders
    });

    const sendProxyMessage = (event) => {
      const message = event.data;
      if (proxyWs.readyState === 1) {
        if (clientMsgQueue.length > 0) {
          clientMsgQueue.push(message);
        } else {
          proxyWs.send(message);
        }
      } else {
        clientMsgQueue.push(message);
      }
    };

    const consumeMsgQueue = () => {
      while (clientMsgQueue.length > 0) {
        const message = clientMsgQueue.shift();
        proxyWs.send(message);
      }
    };

    const getCloseFromOriginEvent = (event) => {
      const code = event.code || '';
      const reason = event.reason || '';
      let targetCode = '';
      let targetReason = '';
      if (code >= 1004 && code <= 1006) {
        targetCode = 1000;
        targetReason = `Normally closed. The origin ws is closed at code: ${code} and reason: ${reason}`;
      } else {
        targetCode = code;
        targetReason = reason;
      }
      return {
        code: targetCode,
        reason: targetReason
      };
    };

    proxyWs.onopen = () => {
      consumeMsgQueue();
    };

    proxyWs.onerror = (e) => {
      wsClient.close(1001, e.message);
      proxyWs.close(1001);
    };

    proxyWs.onmessage = (event) => {
      wsClient.readyState === 1 && wsClient.send(event.data);
    };

    proxyWs.onclose = (event) => {
      logUtil.debug(`proxy ws closed with code: ${event.code} and reason: ${event.reason}`);
      const targetCloseInfo = getCloseFromOriginEvent(event);
      wsClient.readyState !== 3 && wsClient.close(targetCloseInfo.code, targetCloseInfo.reason);
    };

    wsClient.onmessage = (event) => {
      sendProxyMessage(event);
    };

    wsClient.onclose = (event) => {
      logUtil.debug(`original ws closed with code: ${event.code} and reason: ${event.reason}`);
      const targetCloseInfo = getCloseFromOriginEvent(event);
      proxyWs.readyState !== 3 && proxyWs.close(targetCloseInfo.code, targetCloseInfo.reason);
    };
  } catch (e) {
    logUtil.debug('WebSocket Proxy Error:' + e.message);
    logUtil.debug(e.stack);
    console.error(e);
  }
}

class RequestHandler {
  /**
   * @param {object} config
   * @param {boolean} config.forceProxyHttps
   * @param {boolean} config.dangerouslyIgnoreUnauthorized
   * @param {number} config.httpServerPort
   * @param {boolean} config.wsIntercept
   * @param {function} config.customConnect - optional custom CONNECT handler (for tunnel domains)
   * @param {number} config.timeout
   * @param {object} rule - user rule callbacks
   */
  constructor(config, rule) {
    const reqHandlerCtx = this;
    this.forceProxyHttps = false;
    this.dangerouslyIgnoreUnauthorized = false;
    this.httpServerPort = '';
    this.wsIntercept = false;
    this.customConnect = null;
    this.timeout = 0;

    if (config.forceProxyHttps) {
      this.forceProxyHttps = true;
    }

    if (config.dangerouslyIgnoreUnauthorized) {
      this.dangerouslyIgnoreUnauthorized = true;
    }

    if (config.wsIntercept) {
      this.wsIntercept = config.wsIntercept;
    }

    // Fix: pass customConnect into RequestHandler (fork gap)
    if (config.customConnect) {
      this.customConnect = config.customConnect;
    }

    if (config.timeout) {
      this.timeout = config.timeout;
    }

    this.httpServerPort = config.httpServerPort;
    const default_rule = util.freshRequire('./rule-default');
    const userRule = util.merge(default_rule, rule);

    reqHandlerCtx.userRequestHandler = getUserReqHandler.apply(reqHandlerCtx, [userRule]);
    reqHandlerCtx.wsHandler = getWsHandler.bind(this, userRule);
    reqHandlerCtx.httpServerPort = config.httpServerPort;

    reqHandlerCtx.httpsServerMgr = new HttpsServerMgr({
      handler: reqHandlerCtx.userRequestHandler,
      wsHandler: reqHandlerCtx.wsHandler,
      hostname: '127.0.0.1',
    });

    this.connectReqHandler = getConnectReqHandler.apply(reqHandlerCtx, [userRule, reqHandlerCtx.httpsServerMgr]);
  }
}

RequestHandler._test = {
  registerSocketMapCleanup,
  getWebSocketConnectRequestText,
  CommonReadableStream,
  matchResponseRule,
  fetchRemoteResponse,
  getWsReqInfo,
};

module.exports = RequestHandler;
