// socks5-proxy.js
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const tls = require('tls');
const http2 = require('http2');
const crypto = require('crypto');
const fs = require('fs');
const _fs = require('../proxy/fs.js');
const domain = require('../proxy/domain.js');
const attacker = require('../proxy/attacker.js');
const tempCredentials = require('../proxy/temp-credentials.js');
const { pipeline, Duplex } = require('stream');
const fdDiagnostics = require('../proxy/fd-diagnostics');

const { ensureTempCert } = require('../cert/generator');
// 固定下游 HTTP 代理地址（可改为配置项）
const DOWNSTREAM_HTTP_PROXY_HOST = '127.0.0.1';
const keyFile = path.join(__dirname, '../cert/socks5_tls.key');
const crtFile = path.join(__dirname, '../cert/socks5_tls.crt');
const ticketKeyPath = path.join(__dirname, './ticket-keys.bin');
const DEFAULT_MAX_TCP_CONNECTS = 200;
const SOCKS5_HANDSHAKE_TIMEOUT_MS = 15_000;
const HTTP_MAX_HEAD_BYTES = 64 * 1024;
const TCP_CONNECT_STATS_LOG_INTERVAL_MS = 5 * 60_000;
const PROC_SELF_FD_PATH = '/proc/self/fd';

function getOpenFdCount() {
  try {
    return fs.readdirSync(PROC_SELF_FD_PATH).length;
  } catch (e) {
    return null;
  }
}

function getRemoteIp(socket) {
  const address = socket.remoteAddress || 'unknown';
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

function getRemotePeer(socket) {
  return `${getRemoteIp(socket)}:${socket.remotePort || 0}`;
}

function initTicketKeyFile() {
  if (!fs.existsSync(ticketKeyPath)) {
    fs.writeFileSync(ticketKeyPath, crypto.randomBytes(48));
  }
}

function getTicketKeys() {
  initTicketKeyFile();
  return fs.readFileSync(ticketKeyPath) || crypto.randomBytes(48);
}

function parseAddress(buf, offset) {
  const atyp = buf[offset];
  let host, port, nextOffset;

  if (atyp === 0x01) {
    host = buf.slice(offset + 1, offset + 5).join('.');
    port = buf.readUInt16BE(offset + 5);
    nextOffset = offset + 7;
  } else if (atyp === 0x03) {
    const len = buf[offset + 1];
    host = buf.slice(offset + 2, offset + 2 + len).toString();
    port = buf.readUInt16BE(offset + 2 + len);
    nextOffset = offset + 2 + len + 2;
  } else if (atyp === 0x04) {
    const ipv6Bytes = buf.slice(offset + 1, offset + 17);
    host = '[' + ipv6Bytes.reduce((acc, byte, i) => {
      if (i % 2 === 0 && i > 0) acc += ':';
      return acc + byte.toString(16).padStart(2, '0');
    }, '').replace(/00/g, '0').replace(/(^|:)0+([0-9a-f]+)/g, '$1$2') + ']';
    port = buf.readUInt16BE(offset + 17);
    nextOffset = offset + 19;
  } else {
    throw new Error('Unsupported address type: ' + atyp);
  }

  return { host, port, nextOffset };
}

function sendResponse(socket, status, atyp = 0x01, bindAddr = '0.0.0.0', bindPort = 0) {
  const resp = Buffer.alloc(10);
  resp[0] = 0x05;
  resp[1] = status;
  resp[2] = 0x00;
  resp[3] = atyp;

  if (atyp === 0x01) {
    resp[4] = 0;
    resp[5] = 0;
    resp[6] = 0;
    resp[7] = 0;
  } else if (atyp === 0x03) {
    resp[4] = 0;
  } else if (atyp === 0x04) {
    resp.fill(0, 4, 20);
  }

  resp.writeUInt16BE(bindPort, atyp === 0x01 ? 8 : (atyp === 0x03 ? 5 : 20));
  const len = atyp === 0x01 ? 10 : (atyp === 0x03 ? 5 + resp[4] + 2 : 22);
  socket.write(resp.slice(0, len));
}

// 读够 minBytes（或遇到 0x05）为止，全程用 readable 模式，中间字节不会丢。
function readPrefixWithTimeout(socket, minBytes, timeoutMs, stage) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.removeListener('readable', onReadable);
      socket.removeListener('end', onEnd);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
    };
    const finish = () => {
      cleanup();
      resolve(buffer);
    };
    const onReadable = () => {
      let chunk = socket.read();
      while (chunk !== null) {
        buffer = Buffer.concat([buffer, chunk]);
        chunk = socket.read();
      }
      if (buffer.length >= minBytes || (buffer.length > 0 && buffer[0] === 0x05)) finish();
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`${stage} ended`));
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`${stage} closed`));
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${stage} timeout`));
    }, timeoutMs);
    timer.unref?.();

    socket.on('readable', onReadable);
    socket.once('end', onEnd);
    socket.once('close', onClose);
    socket.once('error', onError);
    onReadable();
  });
}

function readOnceWithTimeout(socket, timeoutMs, stage) {
  return new Promise((resolve, reject) => {
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
    };
    const onData = (chunk) => {
      cleanup();
      resolve(chunk);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`${stage} ended`));
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`${stage} closed`));
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${stage} timeout`));
    }, timeoutMs);
    timer.unref?.();

    socket.once('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

function createConnectionHandler(options) {
  const downstreamProxyPort = options.downstreamProxyPort;
  const downstreamProxyHost = options.downstreamProxyHost || DOWNSTREAM_HTTP_PROXY_HOST;
  const authCredentials = options.authCredentials || {};
  const handshakeTimeoutMs = options.handshakeTimeoutMs || SOCKS5_HANDSHAKE_TIMEOUT_MS;
  const maxTcpConnects = Number.isFinite(options.maxTcpConnects)
    ? options.maxTcpConnects
    : DEFAULT_MAX_TCP_CONNECTS;
  const statsLogIntervalMs = Number.isFinite(options.statsLogIntervalMs)
    ? options.statsLogIntervalMs
    : TCP_CONNECT_STATS_LOG_INTERVAL_MS;
  const fdCountProvider = options.fdCountProvider || getOpenFdCount;
  const fdDiagnosticsProvider = options.fdDiagnosticsProvider || null;
  const logger = options.logger || console;
  // 默认复用 proxy/attacker.js 的全局 IP 限频状态（与 8001、HTTP CONNECT 路径共享）；测试可注入
  const attackerModule = options.attacker || attacker;
  // 未配置用户名时不做认证，也不参与限频（与 8001/HTTP 路径语义一致）
  const authRequired = authCredentials.username !== undefined && authCredentials.username !== '';
  let handshakingSockets = 0;
  let activeUdpAssociations = 0;
  let activeTcpConnects = 0;
  let acceptedTcpConnects = 0;
  let closedTcpConnects = 0;
  let rejectedTcpConnects = 0;
  let peakTcpConnects = 0;

  const statsTimer = statsLogIntervalMs > 0
    ? setInterval(() => {
      const fdCount = fdCountProvider();
      const fdText = fdCount === null || fdCount === undefined ? 'unknown' : fdCount;
      let diagnostics = '';
      try {
        diagnostics = ` ${fdDiagnosticsProvider
          ? fdDiagnosticsProvider()
          : fdDiagnostics.formatSnapshot(fdDiagnostics.getFdSnapshot())}`;
      } catch (_) {}
      logger.log(`[SOCKS5] TCP CONNECT stats active=${activeTcpConnects} handshaking=${handshakingSockets} udp=${activeUdpAssociations} peak=${peakTcpConnects} accepted=${acceptedTcpConnects} closed=${closedTcpConnects} rejected=${rejectedTcpConnects} max=${maxTcpConnects} fds=${fdText}${diagnostics}`);
    }, statsLogIntervalMs)
    : null;
  statsTimer?.unref?.();

  function handleTcpRequest(clientSocket, targetHost, targetPort) {
    if (activeTcpConnects >= maxTcpConnects) {
      rejectedTcpConnects++;
      logger.warn(`SOCKS5 TCP CONNECT rejected: too many concurrent connections (${activeTcpConnects}/${maxTcpConnects})`);
      sendResponse(clientSocket, 0x05);
      clientSocket.destroy();
      return;
    }

    clientSocket.setTimeout(120_000);
    clientSocket.on('timeout', () => clientSocket.destroy());

    activeTcpConnects++;
    acceptedTcpConnects++;
    peakTcpConnects = Math.max(peakTcpConnects, activeTcpConnects);
    let cleaned = false;
    let proxySocket = null;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      activeTcpConnects--;
      closedTcpConnects++;
      if (proxySocket && !proxySocket.destroyed) proxySocket.destroy();
      // 对端（下游 HTTP 代理）先关闭时，client socket 可能仍处于
      // 半关闭状态（FIN_WAIT2/CLOSE_WAIT）。不强制销毁会滞留 fd，
      // 长时间运行后触发 EMFILE。这里双向兜底销毁。
      if (clientSocket && !clientSocket.destroyed) clientSocket.destroy();
    };

    proxySocket = net.connect(downstreamProxyPort, downstreamProxyHost, () => {
      const connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`;
      proxySocket.write(connectReq);

      const chunks = [];
      let totalLen = 0;
      const onProxyData = (chunk) => {
        if (clientSocket.destroyed || proxySocket.destroyed) return;

        chunks.push(chunk);
        totalLen += chunk.length;
        const buf = Buffer.concat(chunks, totalLen);
        if (buf.indexOf('\r\n\r\n') !== -1) {
          proxySocket.removeListener('data', onProxyData);
          const str = buf.toString();
          if (!str.match(/^HTTP\/1\.[01] 200/)) {
            sendResponse(clientSocket, 0x05);
            clientSocket.destroy();
            proxySocket.destroy();
            return;
          }
          sendResponse(clientSocket, 0x00);
          clientSocket.pipe(proxySocket);
          proxySocket.pipe(clientSocket);
        }
      };
      proxySocket.on('data', onProxyData);
    });

    proxySocket.setTimeout(120_000);
    proxySocket.on('timeout', () => proxySocket.destroy());
    proxySocket.on('error', (err) => {
      logger.warn(`Proxy error: ${err.message}`);
      if (!clientSocket.destroyed) {
        sendResponse(clientSocket, 0x05);
        clientSocket.destroy();
      }
    });
    proxySocket.on('close', cleanup);
    clientSocket.on('error', () => proxySocket.destroy());
    clientSocket.on('close', cleanup);
  }

  function handleUdpAssociate(clientSocket) {
    activeUdpAssociations++;
    sendResponse(clientSocket, 0x00);

    const udpSocket = dgram.createSocket('udp4');
    let buffer = Buffer.alloc(0);
    let idleTimer = null;
    const UDP_IDLE_TIMEOUT = 120_000;

    function resetIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        clientSocket.destroy();
      }, UDP_IDLE_TIMEOUT);
    }

    resetIdleTimer();

    udpSocket.on('message', (msg, rinfo) => {
      if (clientSocket.destroyed) return;
      resetIdleTimer();

      const addrParts = rinfo.address.split('.');
      const header = Buffer.alloc(10);
      header[0] = 0x00;
      header[1] = 0x00;
      header[2] = 0x00;
      header[3] = 0x01;
      header[4] = parseInt(addrParts[0]);
      header[5] = parseInt(addrParts[1]);
      header[6] = parseInt(addrParts[2]);
      header[7] = parseInt(addrParts[3]);
      header.writeUInt16BE(rinfo.port, 8);

      const payload = Buffer.concat([header, msg]);
      const frame = Buffer.alloc(2 + payload.length);
      frame.writeUInt16BE(payload.length, 0);
      payload.copy(frame, 2);
      clientSocket.write(frame);
    });

    clientSocket.on('data', (chunk) => {
      resetIdleTimer();
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 2) {
        const frameLen = buffer.readUInt16BE(0);
        if (frameLen === 0 || frameLen > 65535) {
          clientSocket.destroy();
          return;
        }
        if (buffer.length < 2 + frameLen) break;

        const payload = buffer.slice(2, 2 + frameLen);
        buffer = buffer.slice(2 + frameLen);

        if (payload.length < 10) continue;
        if (payload[0] !== 0x00 || payload[1] !== 0x00) continue;
        if (payload[2] !== 0x00) continue;

        const atyp = payload[3];
        let targetHost, targetPort, headerLen;

        try {
          if (atyp === 0x01) {
            targetHost = payload.slice(4, 8).join('.');
            targetPort = payload.readUInt16BE(8);
            headerLen = 10;
          } else if (atyp === 0x03) {
            const len = payload[4];
            if (payload.length < 5 + len + 2) continue;
            targetHost = payload.slice(5, 5 + len).toString();
            targetPort = payload.readUInt16BE(5 + len);
            headerLen = 5 + len + 2;
          } else if (atyp === 0x04) {
            if (payload.length < 22) continue;
            const ipv6Bytes = payload.slice(4, 20);
            targetHost = '[' + ipv6Bytes.reduce((acc, byte, i) => {
              if (i % 2 === 0 && i > 0) acc += ':';
              return acc + byte.toString(16).padStart(2, '0');
            }, '').replace(/(^|:)0+([0-9a-f]+)/g, '$1$2') + ']';
            targetPort = payload.readUInt16BE(20);
            headerLen = 22;
          } else {
            continue;
          }

          const data = payload.slice(headerLen);
          if (data.length === 0) continue;

          udpSocket.send(data, targetPort, targetHost, (err) => {
            if (err) {
              logger.warn(`UDP forward error to ${targetHost}:${targetPort}:`, err.message);
            }
          });
        } catch (e) {
          logger.warn('UDP frame parse error:', e.message);
        }
      }
    });

    udpSocket.on('error', (err) => {
      logger.warn('UDP socket error:', err.message);
      clientSocket.destroy();
    });

    let udpCleaned = false;
    const cleanup = () => {
      if (udpCleaned) return;
      udpCleaned = true;
      if (idleTimer) clearTimeout(idleTimer);
      try { udpSocket.close(); } catch (e) {}
      activeUdpAssociations--;
    };
    clientSocket.once('close', cleanup);
    clientSocket.once('error', cleanup);
  }

  return async (socket) => {
    const clientIp = getRemoteIp(socket);

    // 错误监听必须先于任何 destroy() 挂载：公网端口上对端随时可能 RST，
    // 无监听器的 'error' 事件会直接抛成未捕获异常并终止进程。
    socket.on('error', (err) => {
      logger.warn('Client socket error (ignored):', err.message);
    });

    // 被拉黑的 IP 在握手前直接断开，不消耗握手与认证开销
    if (authRequired && attackerModule.isBadGuy(clientIp)) {
      logger.warn(`[🚫]>> 拦截 badguy ${clientIp} (SOCKS5)`);
      socket.destroy();
      return;
    }

    let handshaking = true;
    handshakingSockets++;
    const finishHandshake = () => {
      if (!handshaking) return;
      handshaking = false;
      handshakingSockets--;
    };
    socket.once('close', finishHandshake);
    socket.setKeepAlive(true, 60000);

    try {
      const authMethodsBuf = await readOnceWithTimeout(socket, handshakeTimeoutMs, 'SOCKS5 method negotiation');

      if (authMethodsBuf.length < 2) {
        socket.destroy();
        return;
      }

      const nmethods = authMethodsBuf[1];
      if (authMethodsBuf.length !== 2 + nmethods) {
        socket.destroy();
        return;
      }

      // 配置了主凭据时只接受用户名/密码认证（0x02）；客户端不提 0x02 一律回 0xff
      // 并断开，绝不能回 0x00/0xff 之后继续读 CONNECT/UDP 请求（否则认证被绕过）。
      // 未配置主凭据时保持原有语义：0x02 优先（后台生成的临时凭据以此连接），
      // 其次才是 0x00 免认证。
      let method = 0xff;
      if (authRequired) {
        for (let i = 0; i < nmethods; i++) {
          if (authMethodsBuf[2 + i] === 0x02) { method = 0x02; break; }
        }
      } else {
        for (let i = 0; i < nmethods; i++) {
          const m = authMethodsBuf[2 + i];
          if (m === 0x02) method = 0x02;
          if (m === 0x00 && method === 0xff) method = 0x00;
        }
      }

      socket.write(Buffer.from([0x05, method]));

      if (method === 0xff) {
        socket.destroy();
        return;
      }

      if (method === 0x02) {
        const authData = await readOnceWithTimeout(socket, handshakeTimeoutMs, 'SOCKS5 authentication');

        if (authData.length < 2) {
          socket.write(Buffer.from([0x01, 0xff]));
          socket.destroy();
          return;
        }

        const ulen = authData[1];
        if (authData.length < 2 + ulen + 1) {
          socket.write(Buffer.from([0x01, 0xff]));
          socket.destroy();
          return;
        }

        const username = authData.slice(2, 2 + ulen).toString();
        const plen = authData[2 + ulen];
        if (authData.length < 2 + ulen + 1 + plen) {
          socket.write(Buffer.from([0x01, 0xff]));
          socket.destroy();
          return;
        }

        const password = authData.slice(2 + ulen + 1, 2 + ulen + 1 + plen).toString();

        if (username !== authCredentials.username || password !== authCredentials.password) {
          // 主凭据不匹配时，再查后台生成的临时凭据（仅 8001/8002，隧道不接入）
          if (!tempCredentials.isValid(username, password)) {
            logger.warn(`SOCKS5 auth failed remote=${getRemotePeer(socket)}`);
            attackerModule.countIPAccess(clientIp);
            socket.write(Buffer.from([0x01, 0xff]));
            socket.destroy();
            return;
          }
        }
        socket.write(Buffer.from([0x01, 0x00]));
        attackerModule.setGoodGuy(clientIp);
      }

      const requestBuf = await readOnceWithTimeout(socket, handshakeTimeoutMs, 'SOCKS5 request');

      if (requestBuf.length < 4) {
        socket.destroy();
        return;
      }

      const cmd = requestBuf[1];
      let target;
      try {
        target = parseAddress(requestBuf, 3);
      } catch (e) {
        sendResponse(socket, 0x08);
        socket.destroy();
        return;
      }

      if (cmd === 0x01) {
        finishHandshake();
        handleTcpRequest(socket, target.host, target.port);
      } else if (cmd === 0x03) {
        finishHandshake();
        handleUdpAssociate(socket);
      } else {
        sendResponse(socket, 0x07);
        socket.destroy();
      }
    } catch (err) {
      logger.warn(`SOCKS5 session closed during setup: ${err.message} remote=${getRemotePeer(socket)}`);
      socket.destroy();
    }
  };
}

// 把（可能已读掉首包的）TLS socket 包装成 http2 可用的 Duplex：
// Node 的 http2 session 直接消费 socket._handle，JS 层 unshift 的首包会被
// 绕过，所以这里把已读出的分片在新流的 _read 里重放。
class PrefixedDuplex extends Duplex {
  constructor(socket, prefix) {
    super();
    this._socket = socket;
    this._prefix = prefix;
    this._pushPrefix = prefix.length > 0;
    this._pumping = false;
    // 先暂停：前缀必须在任何后续字节之前进可读缓冲
    socket.pause();
    socket.on('error', (err) => this.destroy(err));
    socket.on('close', () => {
      if (!this.destroyed) this.destroy();
    });
    this.on('drain', () => socket.resume());
  }

  _startPumping() {
    if (this._pumping) return;
    this._pumping = true;
    this._socket.on('data', (chunk) => {
      if (!this.push(chunk)) this._socket.pause();
    });
    this._socket.on('end', () => this.push(null));
  }

  get remoteAddress() {
    return this._socket.remoteAddress;
  }

  get remotePort() {
    return this._socket.remotePort;
  }

  get encrypted() {
    return this._socket.encrypted;
  }

  address() {
    return this._socket.address();
  }

  setNoDelay(value) {
    try { this._socket.setNoDelay(value); } catch (e) {}
  }

  setTimeout(ms, callback) {
    try { this._socket.setTimeout(ms, callback); } catch (e) {}
  }

  _read() {
    if (this._pushPrefix) {
      this._pushPrefix = false;
      this.push(this._prefix);
    }
    this._startPumping();
    this._socket.resume();
  }

  _write(chunk, encoding, callback) {
    this._socket.write(chunk, callback);
  }

  _final(callback) {
    this._socket.end();
    callback();
  }

  _destroy(err, callback) {
    this._socket.destroy();
    callback(err);
  }
}

// 包装 Duplex 后 http2 session 的 socket 是 Node 的 JSStreamSocket（拿不到
// remoteAddress），所以用 session → 真实 socket 的映射取客户端 IP。
// 'session' 事件在 emit('connection') 内同步触发，h2PendingSocket 可靠对应。
const h2SessionSockets = new WeakMap();
let h2PendingSocket = null;

function h2RealSocket(session) {
  if (!session) return null;
  return h2SessionSockets.get(session) || session.socket || null;
}

// 解析 CONNECT 目标：host:port / [ipv6]:port / host（缺省 443）
function parseConnectTarget(target) {
  let host;
  let portText;
  if (target.startsWith('[')) {
    const close = target.indexOf(']');
    if (close === -1) return null;
    host = target.slice(1, close);
    const after = target.slice(close + 1);
    if (after === '') portText = '443';
    else if (after.startsWith(':')) portText = after.slice(1);
    else return null;
  } else {
    const idx = target.lastIndexOf(':');
    if (idx === -1) {
      host = target;
      portText = '443';
    } else {
      host = target.slice(0, idx);
      portText = target.slice(idx + 1);
    }
  }
  if (!host) return null;
  const port = Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

// 公网代理认证校验：未配置用户名则放行；命中主凭据或后台生成的临时凭据均可。
// 8002 的 HTTP/1.1、HTTP/2 两条路径共用该语义。
function checkProxyAuthCredentials(authCredentials, headers) {
  const expectedUser = authCredentials.username;
  const expectedPass = authCredentials.password;
  if (expectedUser === undefined || expectedUser === '') return true;
  const authHeader = headers['proxy-authorization'];
  if (!authHeader || !authHeader.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  } catch (e) {
    return false;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  if (user === expectedUser && pass === expectedPass) return true;
  // 主凭据不匹配时，再查后台生成的临时凭据（仅 8001/8002，隧道不接入）
  return tempCredentials.isValid(user, pass);
}

// 公网 HTTP 代理（over TLS）处理器：仅支持 CONNECT 隧道。
// 认证语义与 SOCKS5/8001 一致：auth_username 为空则放行，否则要求
// Proxy-Authorization: Basic 与配置完全匹配。认证在 8002 侧完成，
// 转发给下游 8001 时剥离凭据（8001 对 127.0.0.1 来源免认证，与 SOCKS5 路径一致）。
function createHttpConnectHandler(options) {
  const downstreamProxyPort = options.downstreamProxyPort;
  const downstreamProxyHost = options.downstreamProxyHost || DOWNSTREAM_HTTP_PROXY_HOST;
  const authCredentials = options.authCredentials || {};
  const handshakeTimeoutMs = options.handshakeTimeoutMs || SOCKS5_HANDSHAKE_TIMEOUT_MS;
  const maxTcpConnects = Number.isFinite(options.maxTcpConnects)
    ? options.maxTcpConnects
    : DEFAULT_MAX_TCP_CONNECTS;
  const logger = options.logger || console;
  // 默认复用 proxy/attacker.js 的全局 IP 限频状态（与 8001 共享）；测试可注入
  const attackerModule = options.attacker || attacker;

  let activeTunnels = 0;

  // 与 8001 checkProxyAuth 一致：未配置用户名则不做认证，也不参与限频
  const authRequired = authCredentials.username !== undefined && authCredentials.username !== '';

  function checkProxyAuth(headers) {
    return checkProxyAuthCredentials(authCredentials, headers);
  }

  function sendError(socket, statusLine) {
    if (socket.destroyed) return;
    const challenge = statusLine.startsWith('407')
      ? 'Proxy-Authenticate: Basic realm="BlockProxy"\r\n'
      : '';
    socket.write(
      `HTTP/1.1 ${statusLine}\r\n${challenge}Content-Length: 0\r\nConnection: close\r\n\r\n`,
      () => socket.destroy()
    );
  }

  return async (socket, firstChunk) => {
    socket.setKeepAlive(true, 60000);
    socket.on('error', (err) => {
      logger.warn('Public HTTP proxy client socket error (ignored):', err.message);
    });

    // 1. 读取完整请求头（限制大小与超时，防公网扫描器灌数据）
    let buffer = firstChunk || Buffer.alloc(0);
    let headEnd = buffer.indexOf('\r\n\r\n');
    while (headEnd === -1) {
      if (buffer.length > HTTP_MAX_HEAD_BYTES) {
        sendError(socket, '431 Request Header Fields Too Large');
        return;
      }
      let chunk;
      try {
        chunk = await readOnceWithTimeout(socket, handshakeTimeoutMs, 'HTTP proxy request head');
      } catch (err) {
        logger.warn(`HTTP proxy session closed during setup: ${err.message} remote=${getRemotePeer(socket)}`);
        socket.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      headEnd = buffer.indexOf('\r\n\r\n');
    }
    if (headEnd > HTTP_MAX_HEAD_BYTES) {
      sendError(socket, '431 Request Header Fields Too Large');
      return;
    }
    const headText = buffer.slice(0, headEnd).toString('latin1');
    const rest = buffer.slice(headEnd + 4);

    // 2. 解析请求行
    const lines = headText.split('\r\n');
    const parts = lines[0].split(' ');
    if (parts.length !== 3 || !/^HTTP\/1\.[01]$/.test(parts[2]) || !/^[A-Z]+$/.test(parts[0])) {
      sendError(socket, '400 Bad Request');
      return;
    }
    const method = parts[0];
    if (method !== 'CONNECT') {
      sendError(socket, '501 Not Implemented');
      return;
    }
    const parsedTarget = parseConnectTarget(parts[1]);
    if (!parsedTarget) {
      sendError(socket, '400 Bad Request');
      return;
    }
    const { host: targetHost, port: targetPort } = parsedTarget;

    // 3. 认证（与 SOCKS5 相同的凭据与语义）+ attacker 限频（与 8001 同源）
    const headers = {};
    for (let i = 1; i < lines.length; i++) {
      const idx = lines[i].indexOf(':');
      if (idx === -1) continue;
      headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
    }
    const clientIp = getRemoteIp(socket);
    if (authRequired) {
      if (attackerModule.isBadGuy(clientIp)) {
        logger.warn(`[🚫]>> 拦截 badguy ${clientIp} (HTTP proxy)`);
        sendError(socket, '407 Proxy Authentication Required');
        return;
      }
      if (!checkProxyAuth(headers)) {
        logger.warn(`HTTP proxy auth failed remote=${getRemotePeer(socket)} target=${targetHost}:${targetPort}`);
        attackerModule.countIPAccess(clientIp);
        sendError(socket, '407 Proxy Authentication Required');
        return;
      }
      attackerModule.setGoodGuy(clientIp);
    }
    // 4. 并发上限
    if (activeTunnels >= maxTcpConnects) {
      logger.warn(`HTTP CONNECT rejected: too many concurrent connections (${activeTunnels}/${maxTcpConnects})`);
      sendError(socket, '503 Service Unavailable');
      return;
    }

    // 5. 经下游 HTTP 代理建立隧道（与 SOCKS5 TCP CONNECT 同路径，保留拦截/MITM 能力）
    activeTunnels++;
    let cleaned = false;
    let proxySocket = null;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      activeTunnels--;
      if (proxySocket && !proxySocket.destroyed) proxySocket.destroy();
      // 下游先关闭时客户端 socket 可能半关闭滞留 fd，双向兜底销毁（同 SOCKS5 路径）
      if (socket && !socket.destroyed) socket.destroy();
    };

    socket.setTimeout(120_000);
    socket.on('timeout', () => socket.destroy());

    proxySocket = net.connect(downstreamProxyPort, downstreamProxyHost, () => {
      proxySocket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);

      const chunks = [];
      let totalLen = 0;
      const onProxyData = (chunk) => {
        if (socket.destroyed || proxySocket.destroyed) return;
        chunks.push(chunk);
        totalLen += chunk.length;
        if (totalLen > HTTP_MAX_HEAD_BYTES) {
          cleanup();
          return;
        }
        const buf = Buffer.concat(chunks, totalLen);
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        proxySocket.removeListener('data', onProxyData);

        const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString('latin1');
        if (!/^HTTP\/1\.[01] 2\d\d/.test(statusLine)) {
          // 下游拒绝（如 502/407）：原样回传状态行后关闭
          socket.write(buf.slice(0, end + 4), () => socket.destroy());
          proxySocket.destroy();
          return;
        }

        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const downstreamLeftover = buf.slice(end + 4);
        if (downstreamLeftover.length > 0) socket.write(downstreamLeftover);
        if (rest.length > 0) proxySocket.write(rest);
        socket.pipe(proxySocket);
        proxySocket.pipe(socket);
      };
      proxySocket.on('data', onProxyData);
    });

    proxySocket.setTimeout(120_000);
    proxySocket.on('timeout', () => proxySocket.destroy());
    proxySocket.on('error', (err) => {
      logger.warn(`Public HTTP proxy upstream error: ${err.message}`);
      if (!socket.destroyed) {
        sendError(socket, '502 Bad Gateway');
      }
    });
    proxySocket.on('close', cleanup);
    socket.on('error', () => proxySocket.destroy());
    socket.on('close', cleanup);
  };
}

// 8002 公网代理端口分发器：TLS 解密后按首字节区分协议。
// 0x05 → SOCKS5；ASCII 大写字母（HTTP 方法名）→ HTTP CONNECT。
function createPublicProxyHandler(options) {
  const socks5Handler = createConnectionHandler(options);
  const httpHandler = createHttpConnectHandler(options);
  const handshakeTimeoutMs = options.handshakeTimeoutMs || SOCKS5_HANDSHAKE_TIMEOUT_MS;
  const logger = options.logger || console;

  return (socket) => {
    let detected = false;
    const onEarlyError = (err) => {
      if (!detected) {
        logger.warn(`Public proxy connection error during detection: ${err.message} remote=${getRemotePeer(socket)}`);
      }
    };
    socket.on('error', onEarlyError);

    readOnceWithTimeout(socket, handshakeTimeoutMs, 'public proxy protocol detection')
      .then((chunk) => {
        detected = true;
        socket.removeListener('error', onEarlyError);
        if (chunk[0] === 0x05) {
          // 把已读出的首包塞回流内，交给原 SOCKS5 处理器（行为不变）
          socket.pause();
          socket.unshift(chunk);
          socks5Handler(socket);
          socket.resume();
        } else {
          httpHandler(socket, chunk);
        }
      })
      .catch((err) => {
        detected = true;
        socket.removeListener('error', onEarlyError);
        logger.warn(`Public proxy protocol detection failed: ${err.message} remote=${getRemotePeer(socket)}`);
        socket.destroy();
      });
  };
}

// 8002 HTTP/2 处理器：ALPN 协商出 h2 后，同一条 TLS 连接上的每条 CONNECT 流
// 对应一条独立隧道（下游仍是 8001 的 HTTP CONNECT，拦截/MITM 能力不变）。
function createHttp2ConnectHandler(options) {
  const downstreamProxyPort = options.downstreamProxyPort;
  const downstreamProxyHost = options.downstreamProxyHost || DOWNSTREAM_HTTP_PROXY_HOST;
  const authCredentials = options.authCredentials || {};
  const maxTcpConnects = Number.isFinite(options.maxTcpConnects)
    ? options.maxTcpConnects
    : DEFAULT_MAX_TCP_CONNECTS;
  const logger = options.logger || console;
  // 默认复用 proxy/attacker.js 的全局 IP 限频状态（与 8001 共享）；测试可注入
  const attackerModule = options.attacker || attacker;

  const authRequired = authCredentials.username !== undefined && authCredentials.username !== '';

  let activeTunnels = 0;
  let activeSessions = 0;

  function respond(stream, status, extraHeaders) {
    if (!stream || stream.destroyed || stream.closed) return;
    const headers = { ':status': status };
    if (status === 407) headers['proxy-authenticate'] = 'Basic realm="BlockProxy"';
    if (extraHeaders) Object.assign(headers, extraHeaders);
    try {
      stream.respond(headers);
      stream.end();
    } catch (e) {
      // 对端已 RST_STREAM：respond 会抛，忽略
    }
  }

  const h2Server = http2.createServer({
    settings: { maxConcurrentStreams: maxTcpConnects },
  });

  h2Server.on('session', (session) => {
    activeSessions++;
    if (h2PendingSocket) h2SessionSockets.set(session, h2PendingSocket);
    const clientSocket = h2RealSocket(session);
    const remote = clientSocket ? getRemotePeer(clientSocket) : 'unknown';
    logger.log(`[H2] session open remote=${remote} sessions=${activeSessions}`);
    session.on('error', (err) => {
      logger.warn(`[H2] session error remote=${remote}: ${err.message}`);
    });
    session.on('close', () => {
      activeSessions--;
      logger.log(`[H2] session closed remote=${remote} sessions=${activeSessions}`);
    });
  });

  h2Server.on('sessionError', (err) => {
    logger.warn(`[H2] session error: ${err.message}`);
  });

  h2Server.on('stream', (stream, headers) => {
    // 每条流的错误都要有监听器：公网端口上对端随时可能 RST
    stream.on('error', () => {});

    if (headers[':method'] !== 'CONNECT') {
      respond(stream, 501);
      return;
    }
    const target = parseConnectTarget(headers[':authority'] || '');
    if (!target) {
      respond(stream, 400);
      return;
    }

    const clientSocket = h2RealSocket(stream.session);
    const clientIp = clientSocket ? getRemoteIp(clientSocket) : 'unknown';

    if (authRequired) {
      if (attackerModule.isBadGuy(clientIp)) {
        logger.warn(`[🚫]>> 拦截 badguy ${clientIp} (HTTP/2 proxy)`);
        respond(stream, 407);
        try { stream.session.close(); } catch (e) {}
        return;
      }
      if (!checkProxyAuthCredentials(authCredentials, headers)) {
        logger.warn(`HTTP/2 proxy auth failed remote=${clientIp} target=${target.host}:${target.port}`);
        attackerModule.countIPAccess(clientIp);
        respond(stream, 407);
        return;
      }
      attackerModule.setGoodGuy(clientIp);
    }

    if (activeTunnels >= maxTcpConnects) {
      logger.warn(`HTTP/2 CONNECT rejected: too many concurrent connections (${activeTunnels}/${maxTcpConnects})`);
      respond(stream, 503);
      return;
    }

    activeTunnels++;
    let cleaned = false;
    let proxySocket = null;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      activeTunnels--;
      if (proxySocket && !proxySocket.destroyed) proxySocket.destroy();
    };
    // 下游 RST 不会触发 pipe 的 end：不主动重置的话客户端既收不到数据也收不到
    // EOF，只能等 relay 的空闲超时（5 分钟）。正常 FIN 时 writableEnded 已为
    // true，此时不能补 RST，否则会截断客户端仍在发送的方向。
    const tearDownStreamIfOpen = () => {
      if (!stream || stream.destroyed || stream.closed || stream.writableEnded) return;
      try {
        stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      } catch (e) {}
    };

    proxySocket = net.connect(downstreamProxyPort, downstreamProxyHost, () => {
      proxySocket.write(`CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n\r\n`);

      const chunks = [];
      let totalLen = 0;
      const onProxyData = (chunk) => {
        if (stream.destroyed || proxySocket.destroyed) return;
        chunks.push(chunk);
        totalLen += chunk.length;
        if (totalLen > HTTP_MAX_HEAD_BYTES) {
          respond(stream, 502);
          cleanup();
          return;
        }
        const buf = Buffer.concat(chunks, totalLen);
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        proxySocket.removeListener('data', onProxyData);

        const headText = buf.slice(0, end).toString('latin1');
        const statusLine = headText.split('\r\n')[0];
        const match = statusLine.match(/^HTTP\/1\.[01] (\d{3})/);
        const status = match ? Number(match[1]) : 502;
        if (status < 200 || status > 299) {
          const challenge = /^proxy-authenticate:\s*(.+)$/im.exec(headText);
          respond(stream, status, challenge ? { 'proxy-authenticate': challenge[1].trim() } : null);
          cleanup();
          return;
        }

        try {
          stream.respond({ ':status': 200 });
        } catch (e) {
          // 流已被对端重置：不必再建隧道
          cleanup();
          return;
        }
        const leftover = buf.slice(end + 4);
        if (leftover.length > 0) stream.write(leftover);
        stream.pipe(proxySocket);
        proxySocket.pipe(stream);
      };
      proxySocket.on('data', onProxyData);
    });

    proxySocket.on('error', (err) => {
      logger.warn(`HTTP/2 proxy upstream error: ${err.message}`);
      respond(stream, 502);
      cleanup();
      tearDownStreamIfOpen();
    });
    proxySocket.on('close', () => {
      cleanup();
      if (!proxySocket.readableEnded) tearDownStreamIfOpen();
    });
    stream.on('close', cleanup);
  });

  return h2Server;
}

// 8002 端口分发器：TLS ALPN 协商出 h2 时交给 HTTP/2 处理器，
// 否则（含老客户端完全不发 ALPN）走原有首字节分发，行为不变。
function createPublicProxyDispatcher(options) {
  const fallback = createPublicProxyHandler(options);
  const h2Server = options.enableH2 === false ? null : createHttp2ConnectHandler(options);
  const handshakeTimeoutMs = options.handshakeTimeoutMs || SOCKS5_HANDSHAKE_TIMEOUT_MS;
  const logger = options.logger || console;

  // 只有真的发出 HTTP/2 连接前言的才交给 http2 解析。ALPN=h2 只证明客户端
  // 支持 h2：xray/v2rayU 常把 h2 放进 ALPN 列表却仍说 SOCKS5/HTTP1.1，
  // 直接按 ALPN 分发会把它们的握手字节灌进 h2 解析器（老版本能正常用）。
  function dispatchH2ByFirstBytes(socket) {
    const detect = async () => {
      const buffer = await readPrefixWithTimeout(
        socket, 4, handshakeTimeoutMs, 'ALPN h2 preface'
      );
      if (buffer[0] !== 0x05 && buffer.slice(0, 4).toString('latin1') === 'PRI ') {
        const wrapped = new PrefixedDuplex(socket, buffer);
        h2PendingSocket = socket;
        try {
          h2Server.emit('connection', wrapped);
        } finally {
          h2PendingSocket = null;
        }
      } else {
        socket.unshift(buffer);
        fallback(socket);
        socket.resume();
      }
    };
    detect().catch((err) => {
      logger.warn(`Public HTTP/2 preface detection failed: ${err.message}`);
      socket.destroy();
    });
  }

  function handleConnection(socket) {
    if (h2Server && socket.alpnProtocol === 'h2') {
      socket.on('error', (err) => {
        logger.warn(`Public HTTP/2 proxy socket error (ignored): ${err.message}`);
      });
      dispatchH2ByFirstBytes(socket);
      return;
    }
    fallback(socket);
  }

  return {
    h2Server,
    handleConnection,
    close() {
      if (!h2Server) return;
      try { h2Server.close(); } catch (e) {}
    },
  };
}

async function init() {
  try {
    // 确保 ECC P-256 临时 TLS 证书存在（首次启动自动生成，之后跳过）
    await ensureTempCert('socks5_tls', keyFile, crtFile);

    const loadedConfig = await _fs.readConfig();

    const DOWNSTREAM_HTTP_PROXY_PORT = loadedConfig.proxy_port;
    const LISTEN_PORT = loadedConfig.socks5_port;
    const enableTls = (loadedConfig.socks5_tls || "1") === "1";

    let TLS_CERT, TLS_KEY, ticketKeys;
    if (enableTls) {
      ticketKeys = getTicketKeys();

      const certPath = crtFile;
      const keyPath = keyFile;

      if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
        console.error(`❌ TLS 证书或私钥文件不存在: cert=${certPath}, key=${keyPath}`);
        process.exit(1);
      }

      TLS_CERT = fs.readFileSync(certPath);
      TLS_KEY = fs.readFileSync(keyPath);
    }

    const AUTH_CREDENTIALS = {
      username: loadedConfig.auth_username,
      password: loadedConfig.auth_password,
    };

    const dispatcher = createPublicProxyDispatcher({
      downstreamProxyPort: DOWNSTREAM_HTTP_PROXY_PORT,
      downstreamProxyHost: DOWNSTREAM_HTTP_PROXY_HOST,
      authCredentials: AUTH_CREDENTIALS,
      handshakeTimeoutMs: SOCKS5_HANDSHAKE_TIMEOUT_MS,
      maxTcpConnects: DEFAULT_MAX_TCP_CONNECTS,
    });

    // 根据配置创建 TLS 或纯 TCP 服务器
    let server;
    if (enableTls) {
      const tlsOptions = {
        key: TLS_KEY,
        cert: TLS_CERT,
        minVersion: 'TLSv1.2',
        sessionTimeout: 300,
        // 客户端提 h2 时同一条连接上复用多条 CONNECT 隧道；
        // 不提 ALPN 的老客户端（SOCKS5 / HTTP1.1）仍走首字节分发。
        ALPNProtocols: ['h2', 'http/1.1'],
        ticketKeys: ticketKeys
      };
      server = tls.createServer(tlsOptions, dispatcher.handleConnection);

      server.on('clientError', (err, socket) => {
        console.warn('TLS client error during handshake:', err);
        socket?.end();
      });

      server.on('tlsClientError', (err, tlsSocket) => {
        console.warn('TLS handshake failed:', err.message);
        tlsSocket?.destroy();
      });
    } else {
      server = net.createServer(dispatcher.handleConnection);
    }

    server.on('error', (err) => {
      console.error('SOCKS5 server error:', err);
    });

    // 独立运行（npm run socks5）时 proxy.js 的清理定时器不在，这里兜底：
    // 每 2 分钟清理 attacker 中超过 10 分钟无活动的 IP，防止公网端口上 Map 无界增长。
    // 全栈模式下与 proxy.js 的定时器重复调用是幂等的。
    const attackerCleanupTimer = setInterval(() => {
      attacker.cleanupInactiveIPs();
    }, 2 * 60 * 1000);
    attackerCleanupTimer.unref?.();

    // 启动监听
    const tlsLabel = enableTls ? ' (over TLS)' : ' (纯 TCP)';
    server.listen(LISTEN_PORT, () => {
      var localIp = domain.getLocalIp();
      console.log(`✅ \x1b[32mSOCKS5/HTTP${tlsLabel} 公网代理服务启动，IP ${localIp}, 端口 ${LISTEN_PORT}\x1b[0m`);
      if (enableTls) {
        console.log(`🔒 传输加密和认证基于 TLS`);
        console.log(`🔄 ALPN h2 复用已启用（同一条连接承载多条 CONNECT 隧道，未协商则回退 HTTP/1.1）`);
      }
      console.log(`➡️  SOCKS5 TCP / HTTP CONNECT → 流量转发至 HTTP 代理 → ${DOWNSTREAM_HTTP_PROXY_HOST}:${DOWNSTREAM_HTTP_PROXY_PORT}`);
      console.log(`➡️  UDP → 直接发起请求`);
    });
  } catch (err) {
    console.error('Failed to initialize SOCKS5 proxy:', err);
    process.exit(1);
  }
}

module.exports.init = init;
module.exports._test = {
  createConnectionHandler,
  createHttpConnectHandler,
  createHttp2ConnectHandler,
  createPublicProxyHandler,
  createPublicProxyDispatcher,
  checkProxyAuthCredentials,
  parseConnectTarget,
  DEFAULT_MAX_TCP_CONNECTS,
  SOCKS5_HANDSHAKE_TIMEOUT_MS,
  getOpenFdCount,
  getRemotePeer,
};
