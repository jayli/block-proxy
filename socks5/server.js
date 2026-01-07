// socks5-proxy.js
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const tls = require('tls');
const crypto = require('crypto');
const fs = require('fs');
const _fs = require('../proxy/fs.js');
const { pipeline } = require('stream');

// 固定下游 HTTP 代理地址（可改为配置项）
const DOWNSTREAM_HTTP_PROXY_HOST = '127.0.0.1';
const keyFile = path.join(__dirname, '../cert/rootCA.key');
const crtFile = path.join(__dirname, '../cert/rootCA.crt');
const ticketKeyPath = path.join(__dirname, './ticket-keys.bin');

function initTicketKeyFile() {
  if (!fs.existsSync(ticketKeyPath)) {
    fs.writeFileSync(ticketKeyPath, crypto.randomBytes(48));
  }
}

function getTicketKeys() {
  initTicketKeyFile();
  return fs.readFileSync(ticketKeyPath) || crypto.randomBytes(48);
}

async function init() {
  initTicketKeyFile();
  const ticketKeys = getTicketKeys();

  try {
    const loadedConfig = await _fs.readConfig();

    const DOWNSTREAM_HTTP_PROXY_PORT = loadedConfig.proxy_port;
    const LISTEN_PORT = loadedConfig.socks5_port;

    // 从配置加载 TLS 证书和密钥路径
    const certPath = crtFile;
    const keyPath = keyFile;

    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
      console.error(`❌ TLS 证书或私钥文件不存在: cert=${certPath}, key=${keyPath}`);
      process.exit(1);
    }

    const TLS_CERT = fs.readFileSync(certPath);
    const TLS_KEY = fs.readFileSync(keyPath);

    const AUTH_CREDENTIALS = {
      username: loadedConfig.auth_username,
      password: loadedConfig.auth_password,
    };

    // 工具函数：解析目标地址（IPv4 / 域名 / IPv6）
    function parseAddress(buf, offset) {
      const atyp = buf[offset];
      let host, port, nextOffset;

      if (atyp === 0x01) {
        // IPv4
        host = buf.slice(offset + 1, offset + 5).join('.');
        port = buf.readUInt16BE(offset + 5);
        nextOffset = offset + 7;
      } else if (atyp === 0x03) {
        // Domain name
        const len = buf[offset + 1];
        host = buf.slice(offset + 2, offset + 2 + len).toString();
        port = buf.readUInt16BE(offset + 2 + len);
        nextOffset = offset + 2 + len + 2;
      } else if (atyp === 0x04) {
        // IPv6 (简化表示)
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

    // 发送 SOCKS5 响应包
    function sendResponse(socket, status, atyp = 0x01, bindAddr = '0.0.0.0', bindPort = 0) {
      const resp = Buffer.alloc(10);
      resp[0] = 0x05; // VER
      resp[1] = status; // REP
      resp[2] = 0x00; // RSV
      resp[3] = atyp; // ATYP

      if (atyp === 0x01) {
        // IPv4: 0.0.0.0
        resp[4] = 0;
        resp[5] = 0;
        resp[6] = 0;
        resp[7] = 0;
      } else if (atyp === 0x03) {
        // 域名（此处不使用）
        resp[4] = 0;
      } else if (atyp === 0x04) {
        // IPv6: :: (16 bytes of 0)
        resp.fill(0, 4, 20);
      }

      resp.writeUInt16BE(bindPort, atyp === 0x01 ? 8 : (atyp === 0x03 ? 5 : 20));
      const len = atyp === 0x01 ? 10 : (atyp === 0x03 ? 5 + resp[4] + 2 : 22);
      socket.write(resp.slice(0, len));
    }

    function handleTcpRequest(clientSocket, targetHost, targetPort) {
      clientSocket.setTimeout(30_000);
      clientSocket.on('timeout', () => clientSocket.destroy());

      const proxySocket = net.connect(DOWNSTREAM_HTTP_PROXY_PORT, DOWNSTREAM_HTTP_PROXY_HOST, () => {
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

            // 👇 高效双向转发
            clientSocket.pipe(proxySocket);
            proxySocket.pipe(clientSocket);
          }
        };
        proxySocket.on('data', onProxyData);
      });

      proxySocket.setTimeout(30_000);
      proxySocket.on('timeout', () => proxySocket.destroy());
      proxySocket.on('error', (err) => {
        console.warn(`Proxy error: ${err.message}`);
        if (!clientSocket.destroyed) {
          sendResponse(clientSocket, 0x05);
          clientSocket.destroy();
        }
      });
      clientSocket.on('error', () => proxySocket.destroy());
      clientSocket.on('close', () => proxySocket.destroy());
    }

    // 处理 UDP ASSOCIATE（本地 UDP 中继）
    function handleUdpAssociate(clientSocket) {
      const udpRelay = dgram.createSocket('udp4');
      udpRelay.on('message', (msg, rinfo) => {
        // 注意：标准 SOCKS5 UDP 包含 header，但此处简化直接回传（适用于 DNS 等）
        // 生产环境建议按 RFC 1928 封装/解封装
        clientSocket.write(msg);
      });

      udpRelay.on('error', (err) => {
        console.error('UDP relay error:', err);
        clientSocket.destroy();
      });

      const localAddr = udpRelay.address();
      // 告诉客户端 UDP 中继地址（返回 127.0.0.1 + 端口）
      sendResponse(clientSocket, 0x00, 0x01, '127.0.0.1', localAddr.port);

      // 清理
      clientSocket.on('close', () => udpRelay.close());
      clientSocket.on('error', () => udpRelay.close());
    }

    console.log('ticketKeys length:', ticketKeys.length); // 必须是 48！

    // TLS 服务器选项
    const tlsOptions = {
      key: TLS_KEY,
      cert: TLS_CERT,
      minVersion: 'TLSv1.2',
      // 👇 启用会话缓存（Session ID + Session Tickets）
      sessionTimeout: 300, // 会话有效期（秒），默认 300
      ticketKeys: ticketKeys
    };

    // 创建 TLS 封装的 SOCKS5 服务器
    const server = tls.createServer(tlsOptions, async (socket) => {
      try {
        // Step 1: 协商认证方法
        const authMethodsBuf = await new Promise((resolve) => {
          socket.once('data', resolve);
        });

        if (authMethodsBuf.length < 2) {
          socket.destroy();
          return;
        }

        const nmethods = authMethodsBuf[1];
        if (authMethodsBuf.length !== 2 + nmethods) {
          socket.destroy();
          return;
        }

        let method = 0xff; // 不支持任何方法
        for (let i = 0; i < nmethods; i++) {
          const m = authMethodsBuf[2 + i];
          if (m === 0x02) method = 0x02; // 用户名/密码
          if (m === 0x00 && method === 0xff) method = 0x00; // 匿名
        }

        socket.write(Buffer.from([0x05, method]));

        // Step 2: 执行认证
        if (method === 0x02) {
          const authData = await new Promise((resolve) => {
            socket.once('data', resolve);
          });

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

          if (username !== AUTH_CREDENTIALS.username || password !== AUTH_CREDENTIALS.password) {
            socket.write(Buffer.from([0x01, 0xff])); // 认证失败
            socket.destroy();
            return;
          }
          socket.write(Buffer.from([0x01, 0x00])); // 成功
        }

        // Step 3: 处理请求
        const requestBuf = await new Promise((resolve) => {
          socket.once('data', resolve);
        });

        if (requestBuf.length < 4) {
          socket.destroy();
          return;
        }

        const cmd = requestBuf[1];
        let target;
        try {
          target = parseAddress(requestBuf, 3);
        } catch (e) {
          sendResponse(socket, 0x08); // Address type not supported
          socket.destroy();
          return;
        }

        if (cmd === 0x01) {
          // CONNECT
          handleTcpRequest(socket, target.host, target.port);
        } else if (cmd === 0x03) {
          // UDP ASSOCIATE
          handleUdpAssociate(socket);
        } else {
          sendResponse(socket, 0x07); // Command not supported
          socket.destroy();
        }
      } catch (err) {
        console.error('SOCKS5 over TLS session error:', err.message);
        socket.destroy();
      }
    });

    // 错误处理
    server.on('tlsClientError', (err, tlsSocket) => {
      console.warn('TLS handshake failed:', err.message);
      tlsSocket?.destroy();
    });

    server.on('error', (err) => {
      console.error('SOCKS5 TLS server error:', err);
    });

    // 启动监听
    server.listen(LISTEN_PORT, () => {
      console.log(`✅ SOCKS5 over TLS server started on port ${LISTEN_PORT}`);
      console.log(`🔒 Credentials and traffic are encrypted via TLS`);
      console.log(`➡️  TCP → downstream HTTP proxy at ${DOWNSTREAM_HTTP_PROXY_HOST}:${DOWNSTREAM_HTTP_PROXY_PORT}`);
      console.log(`➡️  UDP → direct local relay`);
    });
  } catch (err) {
    console.error('Failed to initialize SOCKS5-TLS proxy:', err);
    process.exit(1);
  }
}

module.exports.init = init;
