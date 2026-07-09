# AnyProxy Core Extraction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 @bachi/anyproxy 的核心逻辑搬运到 proxy/proxy-core/，去除对私有 npm 包的依赖，保持现有架构不变

**Architecture:** 按依赖顺序逐模块搬运（cert-mgr → util → https-server-mgr → request-handler → proxy-server），每个模块独立验证，最后统一集成测试。裁剪无用功能（recorder、webInterface、WebSocket、throttle），保留核心 HTTP/HTTPS 代理 + MITM 逻辑。

**Tech Stack:** Node.js, http/https/net 模块, node-easy-cert (证书管理)

---

### Task 1: 创建目录结构 + 搬运 cert-mgr.js

**Files:**
- Create: `proxy/proxy-core/cert-mgr.js`
- Create: `proxy/proxy-core/.gitkeep` (占位)

**Step 1: 创建目录**

```bash
mkdir -p proxy/proxy-core
touch proxy/proxy-core/.gitkeep
```

**Step 2: 搬运 cert-mgr.js（裁剪版）**

从 `node_modules/@bachi/anyproxy/lib/certMgr.js` 搬运，删除以下函数：
- `trustRootCA` (交互式 inquirer)
- `getCAStatus` (generator)
- `defaultCertAttrs` 自定义属性

创建 `proxy/proxy-core/cert-mgr.js`：

```js
'use strict'

const EasyCert = require('node-easy-cert');
const os = require('os');
const util = require('./util');

const options = {
  rootDirPath: util.getAnyProxyPath('certificates'),
  inMemory: false
};

const easyCert = new EasyCert(options);
const crtMgr = util.merge({}, easyCert);

// rename function
crtMgr.ifRootCAFileExists = easyCert.isRootCAFileExists;

crtMgr.generateRootCA = function (cb) {
  doGenerate(false);

  function doGenerate(overwrite) {
    const rootOptions = {
      commonName: 'AnyProxy',
      overwrite: !!overwrite
    };

    easyCert.generateRootCA(rootOptions, (error, keyPath, crtPath) => {
      cb(error, keyPath, crtPath);
    });
  }
};

module.exports = crtMgr;
```

**Step 3: 验证模块可加载**

```bash
node -e "const certMgr = require('./proxy/proxy-core/cert-mgr'); console.log('cert-mgr loaded:', typeof certMgr.ifRootCAFileExists);"
```

Expected output: `cert-mgr loaded: function`

**Step 4: Commit**

```bash
git add proxy/proxy-core/
git commit -m "feat(proxy-core): add cert-mgr module"
```

---

### Task 2: 搬运 util.js（精简版）

**Files:**
- Create: `proxy/proxy-core/util.js`

**Step 1: 搬运 util.js（裁剪版）**

从 `node_modules/@bachi/anyproxy/lib/util.js` 搬运，删除以下函数：
- `filewalker`, `simpleRender`, `contentType`, `contentLength`
- `formatDate`
- `execScriptSync`, `guideToHomePage`
- `deleteFolderContentsRecursive`

创建 `proxy/proxy-core/util.js`：

```js
'use strict';

const fs = require('fs'),
  path = require('path'),
  child_process = require('child_process'),
  os = require('os'),
  Buffer = require('buffer').Buffer;

const networkInterfaces = os.networkInterfaces();

module.exports.lower_keys = (obj) => {
  for (const key in obj) {
    const val = obj[key];
    delete obj[key];
    obj[key.toLowerCase()] = val;
  }
  return obj;
};

module.exports.merge = function (baseObj, extendObj) {
  for (const key in extendObj) {
    baseObj[key] = extendObj[key];
  }
  return baseObj;
};

function getUserHome() {
  return process.env.HOME || process.env.USERPROFILE;
}
module.exports.getUserHome = getUserHome;

function getAnyProxyHome() {
  const home = path.join(getUserHome(), '/.anyproxy/');
  if (!fs.existsSync(home)) {
    fs.mkdirSync(home);
  }
  return home;
}
module.exports.getAnyProxyHome = getAnyProxyHome;

module.exports.getAnyProxyPath = function (pathName) {
  const home = getAnyProxyHome();
  const targetPath = path.join(home, pathName);
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath);
  }
  return targetPath;
}

module.exports.getAnyProxyTmpPath = function () {
  const targetPath = path.join(os.tmpdir(), 'anyproxy', 'cache');
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true });
  }
  return targetPath;
}

module.exports.freshRequire = function (modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
};

module.exports.getHeaderFromRawHeaders = function (rawHeaders) {
  const headerObj = {};
  const _handleSetCookieHeader = function (key, value) {
    if (headerObj[key].constructor === Array) {
      headerObj[key].push(value);
    } else {
      headerObj[key] = [headerObj[key], value];
    }
  };

  if (!!rawHeaders) {
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const key = rawHeaders[i];
      let value = rawHeaders[i + 1];

      if (typeof value === 'string') {
        value = value.replace(/\0+$/g, '');
      }

      if (!headerObj[key]) {
        headerObj[key] = value;
      } else {
        if (key.toLowerCase() === 'set-cookie') {
          _handleSetCookieHeader(key, value);
        } else {
          headerObj[key] = headerObj[key] + ',' + value;
        }
      }
    }
  }
  return headerObj;
};

module.exports.getAllIpAddress = function getAllIpAddress() {
  const allIp = [];
  Object.keys(networkInterfaces).map((nic) => {
    networkInterfaces[nic].filter((detail) => {
      if (detail.family.toLowerCase() === 'ipv4') {
        allIp.push(detail.address);
      }
    });
  });
  return allIp.length ? allIp : ['127.0.0.1'];
};

module.exports.getFreePort = function () {
  return new Promise((resolve, reject) => {
    const server = require('net').createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

module.exports.collectErrorLog = function (error) {
  if (error && error.code && error.toString()) {
    return error.toString();
  } else {
    let result = [error, error.stack].join('\n');
    try {
      const errorString = error.toString();
      if (errorString.indexOf('You may only yield a function') >= 0) {
        result = 'Function is not yieldable. Did you forget to provide a generator or promise in rule file?';
      }
    } catch (e) {}
    return result
  }
}

module.exports.isFunc = function (source) {
  return source && Object.tostring.call(source) === '[object Function]';
};

module.exports.getByteSize = function (content) {
  return Buffer.byteLength(content);
};

module.exports.isIp = function (domain) {
  if (!domain) {
    return false;
  }
  const ipReg = /^\d+?\.\d+?\.\d+?\.\d+?$/;
  return ipReg.test(domain);
};
```

**Step 2: 验证模块可加载**

```bash
node -e "const util = require('./proxy/proxy-core/util'); console.log('util loaded:', typeof util.getFreePort, typeof util.isIp);"
```

Expected output: `util loaded: function function`

**Step 3: Commit**

```bash
git add proxy/proxy-core/util.js
git commit -m "feat(proxy-core): add util module"
```

---

### Task 3: 搬运 https-server-mgr.js

**Files:**
- Create: `proxy/proxy-core/https-server-mgr.js`

**Step 1: 搬运 https-server-mgr.js（裁剪版）**

从 `node_modules/@bachi/anyproxy/lib/httpsServerMgr.js` 搬运，删除：
- `wsServerMgr.getWsServer` 调用
- `async-task-mgr` 依赖（替换为简单 Promise 锁）
- `createHttpsIPServer` 函数（裸 IP 不走 MITM）

创建 `proxy/proxy-core/https-server-mgr.js`：

```js
'use strict'

const https = require('https'),
  tls = require('tls'),
  assert = require('assert'),
  crypto = require('crypto'),
  certMgr = require('./cert-mgr'),
  util = require('./util'),
  constants = require('constants');

const DEFAULT_SNI_CONTEXT_CACHE_LIMIT = 1000;

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

function createHttpsSNIServer(port, handler) {
  assert(port && handler, 'invalid param for https SNI server');

  const createSecureContext = tls.createSecureContext || crypto.createSecureContext;
  const secureContextCache = createLRUCache(DEFAULT_SNI_CONTEXT_CACHE_LIMIT);

  function SNIPrepareCert(serverName, SNICallback) {
    let keyContent, crtContent, ctx;

    const cacheKey = normalizeSNIName(serverName);
    const cachedCtx = secureContextCache.get(cacheKey);
    if (cachedCtx) {
      SNICallback(null, cachedCtx);
      return;
    }

    certMgr.getCertificate(serverName, (err, key, crt) => {
      if (err) {
        console.error('err occurred when preparing certs for SNI:', err);
        SNICallback(err);
        return;
      }

      keyContent = key;
      crtContent = crt;

      try {
        ctx = createSecureContext({
          key: keyContent,
          cert: crtContent
        });
        secureContextCache.set(cacheKey, ctx);
        console.log(`[internal https] proxy server for ${serverName} established`);
        SNICallback(null, ctx);
      } catch (e) {
        console.error('err occurred when creating secure context:', e);
        SNICallback(e);
      }
    });
  }

  return new Promise((resolve) => {
    const server = https.createServer({
      secureOptions: constants.SSL_OP_NO_SSLv3 || constants.SSL_OP_NO_TLSv1,
      SNICallback: SNIPrepareCert,
      ALPNProtocols: ['http/1.1'],
    }, handler).listen(port);
    resolve(server);
  });
}

class HttpsServerMgr {
  constructor(config) {
    if (!config || !config.handler) {
      throw new Error('handler is required');
    }
    this.handler = config.handler;
    this.activeServers = [];
    this.pendingServers = new Map(); // 简单 Promise 锁
  }

  getSharedHttpsServer(hostname) {
    const self = this;
    const serverHost = '127.0.0.1';

    // 简单 Promise 锁：同一 host 不重复创建
    if (this.pendingServers.has(serverHost)) {
      return this.pendingServers.get(serverHost);
    }

    const promise = new Promise((resolve, reject) => {
      util.getFreePort()
        .then(freePort => {
          return createHttpsSNIServer(freePort, self.handler);
        })
        .then(httpsServer => {
          self.activeServers.push(httpsServer);
          httpsServer.on('upgrade', (req, cltSocket, head) => {
            // WebSocket upgrade，不做处理
          });

          const result = {
            host: serverHost,
            port: httpsServer.address().port,
          };
          resolve(result);
        })
        .catch(e => {
          reject(e);
        });
    });

    this.pendingServers.set(serverHost, promise);
    return promise;
  }

  close() {
    this.activeServers.forEach(server => {
      server.close();
    });
  }
}

HttpsServerMgr._test = {
  createLRUCache,
  normalizeSNIName,
};

module.exports = HttpsServerMgr;
```

**Step 2: 验证模块可加载**

```bash
node -e "const HttpsServerMgr = require('./proxy/proxy-core/https-server-mgr'); console.log('https-server-mgr loaded:', typeof HttpsServerMgr);"
```

Expected output: `https-server-mgr loaded: function`

**Step 3: Commit**

```bash
git add proxy/proxy-core/https-server-mgr.js
git commit -m "feat(proxy-core): add https-server-mgr module"
```

---

### Task 4: 搬运 request-handler.js（核心，最复杂）

**Files:**
- Create: `proxy/proxy-core/request-handler.js`

**Step 1: 搬运 request-handler.js（裁剪版）**

从 `node_modules/@bachi/anyproxy/lib/requestHandler.js` 搬运，删除：
- `recorder` 相关全部代码
- `getWsHandler` 函数（~150 行）
- `global._throttle` 限速分支
- `CommonReadableStream` 类
- `logUtil` 调用（替换为 console）

由于文件较大（预计 ~850 行），分段创建：

```bash
# 先创建文件框架
cat > proxy/proxy-core/request-handler.js << 'EOF'
'use strict';

const http = require('http'),
  https = require('https'),
  net = require('net'),
  url = require('url'),
  zlib = require('zlib'),
  Buffer = require('buffer').Buffer,
  util = require('./util'),
  Stream = require('stream'),
  co = require('co'),
  HttpsServerMgr = require('./https-server-mgr');

// Custom keep-alive agents
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

const DEFAULT_CHUNK_COLLECT_THRESHOLD = 20 * 1024 * 1024; // 20 mb

function normalizeIP(rawIP) {
  if (typeof rawIP !== 'string') return rawIP;
  let ip = rawIP;
  if (ip.startsWith('[')) {
    const match = ip.match(/^\[([^\]]+)\]/);
    if (match) ip = match[1];
  }
  return ip.replace(/^::ffff:/i, '');
}

function normalizeSocketKey(ip, port) {
  return ip + ":" + port
}

function matchResponseRule(responseRules, userConfig) {
  try {
    var hostname = userConfig.requestOptions.hostname.split(":")[0].toLowerCase();
    var pathname = userConfig.requestOptions.path;
    var url = `${userConfig.protocol}://${hostname}${pathname}`
    var matched = false;
    for (const item of responseRules) {
      if (hostname.endsWith(item["host"]) && new RegExp(item['regexp']).test(url)) {
        matched = true;
        break;
      } else {
        continue;
      }
    }
    return matched;
  } catch (e) {
    console.log(e);
    return false;
  }
}

const getErrorResponse = (error, fullUrl) => {
  const errorResponse = {
    statusCode: 500,
    header: {
      'Content-Type': 'text/html; charset=utf-8',
      'Proxy-Error': true,
      'Proxy-Error-Message': error ? JSON.stringify(error) : 'null'
    },
    body: `<html><body><h1>500 Error</h1><p>${error ? error.message : 'Unknown error'}</p></body></html>`
  };
  return errorResponse;
}

function _isRetryableMethod(method) {
  const m = (method || 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
}

function fetchRemoteResponse(protocol, options, reqData, config) {
  reqData = reqData || '';

  function _doRequest(useAgent) {
    return new Promise((resolve, reject) => {
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

      const proxyReq = (isHttps ? https : http).request(opts, (res) => {
        res.headers = util.getHeaderFromRawHeaders(res.rawHeaders);
        const statusCode = res.statusCode;
        const resHeader = res.headers;
        let resDataChunks = [];
        let resSize = 0;

        const finishCollecting = () => {
          new Promise((fulfill) => {
            const serverResData = Buffer.concat(resDataChunks);
            fulfill(serverResData);
          }).then((serverResData) => {
            resolve({
              statusCode,
              header: resHeader,
              body: serverResData,
              _res: res,
            });
          });
        };

        res.on('data', (chunk) => {
          resDataChunks.push(chunk);
          resSize += chunk.length;
        });

        res.on('end', () => {
          finishCollecting();
        });

        res.on('error', (error) => {
          console.error('error happened in response:', error);
          reject(error);
        });
      });

      proxyReq.on('error', reject);
      proxyReq.end(reqData);
    });
  }

  return _doRequest(true).catch((err) => {
    if ((err.code === 'ECONNRESET' || err.code === 'EPIPE') && _isRetryableMethod(options.method)) {
      console.warn('requestHandler: retrying with fresh connection after', err.code);
      return _doRequest(false);
    }
    throw err;
  });
}

function getSourceIp(req, socketMap) {
  var localIp;
  try {
    if (req.client.remoteAddress === undefined) {
      localIp = "255.255.255.254";
    } else {
      localIp = req.client.remoteAddress.split(":").pop();
    }
  } catch (e) {
    console.log(e);
    localIp = "255.255.255.254";
    return localIp;
  }
  var connectionPort = getConnectionPort(req.socket.server._connectionKey);
  if (localIp != '127.0.0.1' && localIp != '0.0.0.0') {
    return localIp;
  } else {
    var mapKey = '127.0.0.1:' + connectionPort;
    if (socketMap.has(mapKey)) {
      if (socketMap.get(mapKey).remoteAddress === undefined) {
        localIp = "0.0.0.0";
      } else {
        localIp = socketMap.get(mapKey).remoteAddress.split(":").pop();
      }
    }
    return localIp;
  }
}

function getConnectionPort(connectionKey) {
  return connectionKey.split(":").pop();
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

function getUserReqHandler(userRule) {
  const reqHandlerCtx = this

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

    req.headers = util.getHeaderFromRawHeaders(req.rawHeaders);

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

    const sendFinalResponse = (finalResponseData) => {
      const responseInfo = finalResponseData.response;
      const resHeader = responseInfo.header;
      const responseBody = responseInfo.body || '';

      const transferEncoding = resHeader['transfer-encoding'] || resHeader['Transfer-Encoding'] || '';
      const connection = resHeader.Connection || resHeader.connection;

      if (connection) {
        resHeader['x-anyproxy-origin-connection'] = connection;
        if (responseInfo.statusCode === 407 || responseInfo.statusCode === 200) {
          // do nothing
        }
      }

      if (!responseInfo) {
        throw new Error('failed to get response info');
      } else if (!responseInfo.statusCode) {
        throw new Error('failed to get response status code')
      } else if (!responseInfo.header) {
        throw new Error('failed to get response header');
      }

      if (transferEncoding !== 'chunked') {
        resHeader['Content-Length'] = util.getByteSize(responseBody);
      }

      userRes.writeHead(responseInfo.statusCode, resHeader);

      if (responseBody instanceof Stream) {
        responseBody.pipe(userRes);
      } else {
        userRes.end(responseBody);
      }

      return responseInfo;
    }

    co(fetchReqData)
      .then(prepareRequestDetail)

      .then(co.wrap(function *() {
        const userModifiedInfo = (yield userRule.beforeSendRequest(Object.assign({}, requestDetail))) || {};
        const finalReqDetail = {};
        ['protocol', 'requestOptions', 'requestData', 'response'].map((key) => {
          finalReqDetail[key] = userModifiedInfo[key] || requestDetail[key]
        });
        return finalReqDetail;
      }))

      .then(co.wrap(function *(userConfig) {
        if (userRule.responseRules && matchResponseRule(userRule.responseRules, userConfig)) {
          var _chunkSizeThreshold = chunkSizeThreshold;
        } else {
          var _chunkSizeThreshold = 64 * 1024;
        }
        if (userConfig.response) {
          userConfig._directlyPassToRespond = true;
          return userConfig;
        } else if (userConfig.requestOptions) {
          const remoteResponse = yield fetchRemoteResponse(userConfig.protocol, userConfig.requestOptions, userConfig.requestData, {
            dangerouslyIgnoreUnauthorized: reqHandlerCtx.dangerouslyIgnoreUnauthorized,
            chunkSizeThreshold: _chunkSizeThreshold,
          });
          return {
            response: {
              statusCode: remoteResponse.statusCode,
              header: remoteResponse.header,
              body: remoteResponse.body,
            },
            _res: remoteResponse._res,
          };
        } else {
          throw new Error('lost response or requestOptions, failed to continue');
        }
      }))

      .then(co.wrap(function *(responseData) {
        if (responseData._directlyPassToRespond) {
          return responseData;
        } else if (responseData.response.body && responseData.response.body instanceof Stream) {
          return responseData;
        } else {
          return (yield userRule.beforeSendResponse(Object.assign({}, requestDetail), Object.assign({}, responseData))) || responseData;
        }
      }))

      .catch(co.wrap(function *(error) {
        console.error('requestHandler error:', util.collectErrorLog(error));

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
        console.error('Send final response failed:', e.message);
      });
  }
}

function getConnectReqHandler(userRule, httpsServerMgr) {
  const reqHandlerCtx = this; reqHandlerCtx.conns = new Map(); reqHandlerCtx.cltSockets = new Map()

  return function (req, cltSocket, head) {
    const host = req.url.split(':')[0],
      targetPort = req.url.split(':')[1];
    let shouldIntercept;
    let requestDetail;
    const requestStream = new Stream.Readable({
      read() {}
    });

    co(function *() {
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
            if (error.code === 'EPIPE' || error.code === 'ECONNRESET') {
              resolve();
            } else {
              reject(error);
            }
          });

          try {
            cltSocket.write('HTTP/' + req.httpVersion + ' 200 OK\r\n\r\n', 'UTF-8', (writeErr) => {
              if (writeErr) {
                if (writeErr.code === 'EPIPE' || writeErr.code === 'ECONNRESET') {
                  resolve();
                } else {
                  reject(writeErr);
                }
              } else {
                resolve();
              }
            });
          } catch (syncErr) {
            reject(syncErr);
          }
        });
      })
      .then(() => {
        return new Promise((resolve, reject) => {
          let resolved = false;
          cltSocket.on('data', (chunk) => {
            requestStream.push(chunk);
            if (!resolved) {
              resolved = true;
              resolve();
            }
          });
          cltSocket.on('error', (error) => {
            if (error.code === 'EPIPE' || error.code === 'ECONNRESET') {
              // ignore
            }
          });
          cltSocket.on('end', () => {
            requestStream.push(null);
          });
        });
      })
      .then((result) => {
        if (shouldIntercept) {
          console.log('will forward to local https server');
        } else {
          console.log('will bypass the man-in-the-middle proxy');
        }
      })
      .then(() => {
        if (!shouldIntercept) {
          const originServer = {
            host,
            port: (targetPort === 80) ? 443 : targetPort
          }
          return originServer;
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
        console.error('connectHandler error:', util.collectErrorLog(error));

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
  }
}

class RequestHandler {
  constructor(config, rule) {
    const reqHandlerCtx = this;
    this.forceProxyHttps = false;
    this.dangerouslyIgnoreUnauthorized = false;
    this.httpServerPort = '';
    this.customConnect = config.customConnect;

    if (config.forceProxyHttps) {
      this.forceProxyHttps = true;
    }

    if (config.dangerouslyIgnoreUnauthorized) {
      this.dangerouslyIgnoreUnauthorized = true;
    }

    this.httpServerPort = config.httpServerPort;
    const default_rule = util.freshRequire('./rule_default');
    const userRule = util.merge(default_rule, rule);

    reqHandlerCtx.userRequestHandler = getUserReqHandler.apply(reqHandlerCtx, [userRule]);
    reqHandlerCtx.httpServerPort = config.httpServerPort;

    reqHandlerCtx.httpsServerMgr = new HttpsServerMgr({
      handler: reqHandlerCtx.userRequestHandler,
      hostname: '127.0.0.1',
    });

    this.connectReqHandler = getConnectReqHandler.apply(reqHandlerCtx, [userRule, reqHandlerCtx.httpsServerMgr]);
  }
}

RequestHandler._test = {
  registerSocketMapCleanup,
};

module.exports = RequestHandler;
EOF
```

**Step 2: 创建 rule_default.js**

```bash
cat > proxy/proxy-core/rule_default.js << 'EOF'
'use strict';

module.exports = {
  summary: 'the default rule',

  *beforeSendRequest(requestDetail) {
    return null;
  },

  *beforeSendResponse(requestDetail, responseDetail) {
    return null;
  },

  *beforeDealHttpsRequest(requestDetail) {
    return null;
  },

  *onError(requestDetail, error) {
    return null;
  },

  *onConnectError(requestDetail, error) {
    return null;
  },

  *onClientSocketError(requestDetail, error) {
    return null;
  },
};
EOF
```

**Step 3: 验证模块可加载**

```bash
node -e "const RequestHandler = require('./proxy/proxy-core/request-handler'); console.log('request-handler loaded:', typeof RequestHandler);"
```

Expected output: `request-handler loaded: function`

**Step 4: Commit**

```bash
git add proxy/proxy-core/request-handler.js proxy/proxy-core/rule_default.js
git commit -m "feat(proxy-core): add request-handler module (core)"
```

---

### Task 5: 搬运 proxy-server.js + 创建 index.js

**Files:**
- Create: `proxy/proxy-core/proxy-server.js`
- Create: `proxy/proxy-core/index.js`

**Step 1: 搬运 proxy-server.js（裁剪版）**

从 `node_modules/@bachi/anyproxy/proxy.js` 搬运，删除：
- `Recorder` 实例化
- `WebInterface` 实例化
- `ThrottleGroup` 初始化
- `wsServerMgr` WebSocket 服务器
- ProxyCore / ProxyServer 两层继承（合并为单个 ProxyServer 类）

```bash
cat > proxy/proxy-core/proxy-server.js << 'EOF'
'use strict';

const http = require('http'),
  https = require('https'),
  certMgr = require('./cert-mgr'),
  util = require('./util'),
  events = require('events'),
  RequestHandler = require('./request-handler');

const T_TYPE_HTTP = 'http',
  T_TYPE_HTTPS = 'https',
  DEFAULT_TYPE = T_TYPE_HTTP;

const PROXY_STATUS_INIT = 'INIT';
const PROXY_STATUS_READY = 'READY';
const PROXY_STATUS_CLOSED = 'CLOSED';

class ProxyServer extends events.EventEmitter {
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
      config.forceProxyHttps = false;
    }

    this.httpProxyServer = null;
    this.requestHandler = null;

    this.proxyRule = config.rule || {};

    // init request handler
    this.requestHandler = new RequestHandler({
      httpServerPort: config.port,
      forceProxyHttps: !!config.forceProxyHttps,
      dangerouslyIgnoreUnauthorized: !!config.dangerouslyIgnoreUnauthorized,
      customConnect: config.customConnect
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

    const createServer = () => {
      return new Promise((resolve, reject) => {
        if (self.proxyType === T_TYPE_HTTPS) {
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
        } else {
          self.httpProxyServer = http.createServer(self.requestHandler.userRequestHandler);
          resolve();
        }
      });
    };

    createServer()
      .then(() => {
        self.httpProxyServer.on('connect', self.requestHandler.connectReqHandler);
      })
      .then(() => {
        self.httpProxyServer.on('connection', (socket) => {
          self.handleExistConnections.call(self, socket);
        });
      })
      .then(() => {
        self.httpProxyServer.listen(self.proxyPort);
      })
      .then(() => {
        console.log(`${self.proxyType === T_TYPE_HTTP ? 'Http' : 'Https'} proxy started on port ${self.proxyPort}`);
        self.status = PROXY_STATUS_READY;
        self.emit('ready');
      })
      .catch((err) => {
        console.error('err when start proxy server :(');
        console.error(err);
        self.emit('error', {
          error: err
        });
      });

    return self;
  }

  close() {
    return new Promise((resolve) => {
      if (this.httpProxyServer) {
        for (const connItem of this.requestHandler.conns) {
          const key = connItem[0];
          const conn = connItem[1];
          console.log(`destroying https connection : ${key}`);
          conn.end();
        }

        for (const cltSocketItem of this.requestHandler.cltSockets) {
          const key = cltSocketItem[0];
          const cltSocket = cltSocketItem[1];
          console.log(`closing https cltSocket : ${key}`);
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
            console.error(`proxy server close FAILED : ${error.message}`);
          } else {
            this.httpProxyServer = null;
            this.status = PROXY_STATUS_CLOSED;
            console.log(`proxy server closed at ${this.proxyHostName}:${this.proxyPort}`);
          }
          resolve(error);
        });
      } else {
        resolve();
      }
    })
  }
}

module.exports = ProxyServer;
EOF
```

**Step 2: 创建 index.js**

```bash
cat > proxy/proxy-core/index.js << 'EOF'
const ProxyServer = require('./proxy-server');
const certMgr = require('./cert-mgr');

module.exports = {
  ProxyServer,
  utils: { certMgr }
};
EOF
```

**Step 3: 验证模块可加载**

```bash
node -e "const { ProxyServer, utils } = require('./proxy/proxy-core'); console.log('index loaded:', typeof ProxyServer, typeof utils.certMgr);"
```

Expected output: `index loaded: function function`

**Step 4: Commit**

```bash
git add proxy/proxy-core/proxy-server.js proxy/proxy-core/index.js
git commit -m "feat(proxy-core): add proxy-server and index modules"
```

---

### Task 6: 修改 proxy.js 的 require 路径

**Files:**
- Modify: `proxy/proxy.js:2` (require 路径)
- Modify: `proxy/proxy.js:542-543` (certMgr 调用)
- Modify: `proxy/proxy.js:555` (ProxyServer 创建)
- Modify: `proxy/proxy.js:1468-1469` (删除 throttle/wsIntercept 选项)

**Step 1: 修改 require 路径**

```bash
# 在 proxy/proxy.js 第 2 行
sed -i.bak "s/const AnyProxy = require('@bachi\/anyproxy');/const { ProxyServer, utils: { certMgr } } = require('.\/proxy-core');/" proxy/proxy.js
rm proxy/proxy.js.bak
```

**Step 2: 修改 certMgr 调用**

```bash
# 在 proxy/proxy.js 第 542-543 行附近
sed -i.bak "s/AnyProxy\.utils\.certMgr\.ifRootCAFileExists()/certMgr.ifRootCAFileExists()/g" proxy/proxy.js
sed -i.bak "s/AnyProxy\.utils\.certMgr\.generateRootCA/certMgr.generateRootCA/g" proxy/proxy.js
rm proxy/proxy.js.bak
```

**Step 3: 修改 ProxyServer 创建**

```bash
# 在 proxy/proxy.js 第 555 行附近
sed -i.bak "s/new AnyProxy\.ProxyServer(options)/new ProxyServer(options)/g" proxy/proxy.js
rm proxy/proxy.js.bak
```

**Step 4: 删除无用选项**

手动编辑 `proxy/proxy.js` 的 `getAnyProxyOptions()` 函数（约第 1468-1469 行），删除：

```diff
  function getAnyProxyOptions() {
    return {
      port: proxyPort,
      customConnect: ...,
      rule: { ... },
-     throttle: 800 * 1024 * 1024,
-     wsIntercept: false,
      silent: true,
      timeout: 120 * 1000
    };
  }
```

**Step 5: 验证改动**

```bash
node -e "const LocalProxy = require('./proxy/proxy'); console.log('proxy.js loaded:', typeof LocalProxy.init);"
```

Expected output: `proxy.js loaded: function`

**Step 6: Commit**

```bash
git add proxy/proxy.js
git commit -m "refactor(proxy): switch to local proxy-core module"
```

---

### Task 7: 集成测试

**Step 1: 运行冒烟测试**

```bash
npm run test:proxy
```

Expected: 所有测试通过（HTTP/SOCKS5 连通性、延迟、并发）

**Step 2: 手动测试 HTTPS MITM**

```bash
# 启动代理
npm run proxy

# 在另一个终端测试
curl -x http://127.0.0.1:8001 https://example.com -v
```

Expected: 返回 example.com 页面内容，证书为 AnyProxy 生成的伪造证书

**Step 3: 手动测试隧道域名**

```bash
# 在 config.json 中配置 tunnel_domains
# 启动代理和隧道
npm run dev

# 验证隧道域名的 CONNECT 请求走 tunnelManager.forward()
```

Expected: 日志中出现 `[Tunnel] CONNECT xxx → 走隧道转发`

**Step 4: Commit（如有修复）**

```bash
git add -A
git commit -m "fix(proxy-core): integration test fixes"
```

---

### Task 8: 从 package.json 移除 @bachi/anyproxy

**Files:**
- Modify: `package.json` (dependencies)

**Step 1: 移除依赖**

手动编辑 `package.json`，删除：

```diff
  "dependencies": {
-   "@bachi/anyproxy": "^0.1.9",
    "axios": "^1.13.2",
    ...
+   "node-easy-cert": "^1.0.0"
  }
```

**Step 2: 重新安装依赖**

```bash
pnpm i
```

Expected: 安装成功，node_modules 中不再有 @bachi/anyproxy

**Step 3: 验证项目仍可运行**

```bash
npm run test:proxy
```

Expected: 所有测试通过

**Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): remove @bachi/anyproxy, add node-easy-cert"
```

---

## Plan complete and saved to `docs/plans/2026-07-09-anyproxy-core-extraction-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

**Which approach?**
