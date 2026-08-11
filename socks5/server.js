// socks5-proxy.js
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const tls = require('tls');
const crypto = require('crypto');
const fs = require('fs');
const _fs = require('../proxy/fs.js');
const domain = require('../proxy/domain.js');
const { pipeline } = require('stream');
const fdDiagnostics = require('../proxy/fd-diagnostics');

const { ensureTempCert } = require('../cert/generator');
// 固定下游 HTTP 代理地址（可改为配置项）
const DOWNSTREAM_HTTP_PROXY_HOST = '127.0.0.1';
const keyFile = path.join(__dirname, '../cert/socks5_tls.key');
const crtFile = path.join(__dirname, '../cert/socks5_tls.crt');
const ticketKeyPath = path.join(__dirname, './ticket-keys.bin');
const DEFAULT_MAX_TCP_CONNECTS = 200;
const SOCKS5_HANDSHAKE_TIMEOUT_MS = 15_000;
const TCP_CONNECT_STATS_LOG_INTERVAL_MS = 5 * 60_000;
const PROC_SELF_FD_PATH = '/proc/self/fd';

function getOpenFdCount() {
  try {
    return fs.readdirSync(PROC_SELF_FD_PATH).length;
  } catch (e) {
    return null;
  }
}

function getRemotePeer(socket) {
  const address = socket.remoteAddress || 'unknown';
  const port = socket.remotePort || 0;
  const normalizedAddress = address.startsWith('::ffff:')
    ? address.slice('::ffff:'.length)
    : address;
  return `${normalizedAddress}:${port}`;
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
    let handshaking = true;
    handshakingSockets++;
    const finishHandshake = () => {
      if (!handshaking) return;
      handshaking = false;
      handshakingSockets--;
    };
    socket.once('close', finishHandshake);
    socket.setKeepAlive(true, 60000);

    socket.on('error', (err) => {
      logger.warn('Client socket error (ignored):', err.message);
    });

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

      let method = 0xff;
      for (let i = 0; i < nmethods; i++) {
        const m = authMethodsBuf[2 + i];
        if (m === 0x02) method = 0x02;
        if (m === 0x00 && method === 0xff) method = 0x00;
      }

      socket.write(Buffer.from([0x05, method]));

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
          socket.write(Buffer.from([0x01, 0xff]));
          socket.destroy();
          return;
        }
        socket.write(Buffer.from([0x01, 0x00]));
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

    const protectedConnectionHandler = createConnectionHandler({
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
        ticketKeys: ticketKeys
      };
      server = tls.createServer(tlsOptions, protectedConnectionHandler);

      server.on('clientError', (err, socket) => {
        console.warn('TLS client error during handshake:', err);
        socket?.end();
      });

      server.on('tlsClientError', (err, tlsSocket) => {
        console.warn('TLS handshake failed:', err.message);
        tlsSocket?.destroy();
      });
    } else {
      server = net.createServer(protectedConnectionHandler);
    }

    server.on('error', (err) => {
      console.error('SOCKS5 server error:', err);
    });

    // 启动监听
    const tlsLabel = enableTls ? ' (over TLS)' : ' (纯 TCP)';
    server.listen(LISTEN_PORT, () => {
      var localIp = domain.getLocalIp();
      console.log(`✅ \x1b[32mSOCKS5${tlsLabel} 服务启动，IP ${localIp}, 端口 ${LISTEN_PORT}\x1b[0m`);
      if (enableTls) {
        console.log(`🔒 传输加密和认证基于 TLS`);
      }
      console.log(`➡️  TCP → 流量转发至 HTTP 代理 → ${DOWNSTREAM_HTTP_PROXY_HOST}:${DOWNSTREAM_HTTP_PROXY_PORT}`);
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
  DEFAULT_MAX_TCP_CONNECTS,
  SOCKS5_HANDSHAKE_TIMEOUT_MS,
  getOpenFdCount,
  getRemotePeer,
};
