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
      // jayli
      // console.log(targetHost);
      clientSocket.setTimeout(120_000);
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

      proxySocket.setTimeout(120_000);
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

    // 处理 UDP ASSOCIATE（RFC 1928 合规实现）
    function handleUdpAssociate(clientSocket) {
      const udpRelay = dgram.createSocket('udp4');
      let clientUdpAddr = null; // 客户端的 UDP 地址（用于回包）

      // 存储 { 'host:port': { rinfo } } 用于回包时知道发给谁
      const targetToClientMap = new Map();

      // 绑定到任意端口
      udpRelay.bind(0, '127.0.0.1', () => {
        const localAddr = udpRelay.address();
        // 告诉客户端 UDP 中继地址（必须是 127.0.0.1 或公网 IP，不能是 0.0.0.0）
        sendResponse(clientSocket, 0x00, 0x01, '127.0.0.1', localAddr.port);
      });

      // 接收来自客户端的 UDP 包（带 SOCKS5 header）
      udpRelay.on('message', (msg, rinfo) => {
        if (!clientUdpAddr) {
          // 第一个包来自客户端，记录其地址（后续回包用）
          clientUdpAddr = rinfo;
        }

        if (msg.length < 10) {
          // 最小 UDP 请求：VER=0 + RSV=0 + FRAG=0 + ATYP=1 (IPv4) + ADDR(4) + PORT(2) = 10
          return;
        }

        const ver = msg[0];
        const frag = msg[2]; // 分片不支持
        if (ver !== 0x00 || frag !== 0x00) {
          return; // 不支持分片或错误版本
        }

        try {
          const atyp = msg[3];
          let headerLen = 0;
          let targetHost, targetPort;

          if (atyp === 0x01) {
            // IPv4
            targetHost = msg.slice(4, 8).join('.');
            targetPort = msg.readUInt16BE(8);
            headerLen = 10;
          } else if (atyp === 0x03) {
            // Domain
            const len = msg[4];
            if (msg.length < 5 + len + 2) return;
            targetHost = msg.slice(5, 5 + len).toString();
            targetPort = msg.readUInt16BE(5 + len);
            headerLen = 5 + len + 2;
          } else if (atyp === 0x04) {
            // IPv6 —— 简化：只取原始字节，Node.js dgram 支持字符串格式
            if (msg.length < 22) return;
            const ipv6Bytes = msg.slice(4, 20);
            targetHost = '[' + ipv6Bytes.reduce((acc, byte, i) => {
              if (i % 2 === 0 && i > 0) acc += ':';
              return acc + byte.toString(16).padStart(2, '0');
            }, '').replace(/(^|:)0+([0-9a-f]+)/g, '$1$2') + ']';
            targetPort = msg.readUInt16BE(20);
            headerLen = 22;
          } else {
            return; // 不支持的地址类型
          }

          const payload = msg.slice(headerLen);
          if (payload.length === 0) return;

          // 构建目标唯一键（用于回包映射）
          const targetKey = `${targetHost}:${targetPort}`;

          // 创建临时 socket 发送数据（避免端口复用问题）
          const outSocket = dgram.createSocket('udp4');
          outSocket.send(payload, targetPort, targetHost, (err) => {
            if (err) {
              console.warn(`UDP forward error to ${targetHost}:${targetPort}:`, err.message);
            }
            outSocket.close();
          });

          // 记录该目标对应的客户端地址（用于响应包回传）
          targetToClientMap.set(targetKey, rinfo);

          // 可选：加个超时自动清理（简化起见这里省略，靠 close 清理）
        } catch (e) {
          console.warn('UDP parse error:', e.message);
        }
      });

      // 接收从目标服务器返回的 UDP 响应，并转发回客户端
      udpRelay.on('listening', () => {
        // Node.js 不会自动监听入站响应，但我们已经在 bind 后处于 listening 状态
        // 所有 inbound UDP 都会触发 'message'，包括响应
      });

      // 注意：响应包也会触发 'message'，但来源是外部服务器（不是 clientUdpAddr）
      // 所以我们需要在上面的逻辑中区分：如果是来自已知 target 的响应，则回包

      // 重写 message handler 以同时处理“客户端请求”和“服务器响应”
      // 我们已经做了：所有包都进同一个 handler，通过 targetToClientMap 判断是否是响应

      // 但我们还需要：当收到外部服务器的响应时，把它封装后发回 clientUdpAddr
      // 所以上面的 handler 已经能处理请求，现在补充响应回包逻辑：

      // 实际上，上面的 handler 只处理了“客户端 → 代理”的包。
      // “目标服务器 → 代理”的包也会进同一个 handler，但此时 rinfo ≠ clientUdpAddr，
      // 且不在 targetToClientMap 的 key 中（因为 key 是 host:port，而 rinfo 是源地址）。

      // 所以我们需要换一种方式：**为每个目标创建独立的 socket？**
      // 但那样太重。更高效的做法是：**用单个 relay socket，靠 targetToClientMap 映射**

      // ✅ 正确做法：在收到外部响应时，根据 (rinfo.address:rinfo.port) 查找是否是我们发出的请求的目标
      // 但注意：我们发的是 targetHost:targetPort，而响应来自 same address:port

      // 所以我们在发送时，应该用 **rinfo.address:rinfo.port 作为 key 存 clientAddr**
      // 但这样不行，因为多个客户端可能访问同一目标。

      // 🚨 更健壮的方式：**每个客户端有自己的 udpRelay**（当前就是这么做的！）
      // 所以在这个函数内，所有流量都属于同一个 SOCKS5 TCP 会话的客户端。
      // 因此，我们可以安全地假设：**任何非 clientUdpAddr 的 UDP 包都是目标服务器的响应**

      // 修改 message handler 如下（替换上面的 handler）：
      udpRelay.removeAllListeners('message');
      udpRelay.on('message', (msg, rinfo) => {
        // 判断是客户端发来的请求，还是目标服务器的响应
        if (clientUdpAddr && rinfo.address === clientUdpAddr.address && rinfo.port === clientUdpAddr.port) {
          // ← 来自客户端的请求（带 header）
          if (msg.length < 10) return;
          const ver = msg[0];
          const frag = msg[2];
          if (ver !== 0x00 || frag !== 0x00) return;

          const atyp = msg[3];
          let headerLen = 0, targetHost, targetPort;

          try {
            if (atyp === 0x01) {
              targetHost = msg.slice(4, 8).join('.');
              targetPort = msg.readUInt16BE(8);
              headerLen = 10;
            } else if (atyp === 0x03) {
              const len = msg[4];
              if (msg.length < 5 + len + 2) return;
              targetHost = msg.slice(5, 5 + len).toString();
              targetPort = msg.readUInt16BE(5 + len);
              headerLen = 5 + len + 2;
            } else if (atyp === 0x04) {
              if (msg.length < 22) return;
              const ipv6Bytes = msg.slice(4, 20);
              targetHost = '[' + ipv6Bytes.reduce((acc, byte, i) => {
                if (i % 2 === 0 && i > 0) acc += ':';
                return acc + byte.toString(16).padStart(2, '0');
              }, '').replace(/(^|:)0+([0-9a-f]+)/g, '$1$2') + ']';
              targetPort = msg.readUInt16BE(20);
              headerLen = 22;
            } else {
              return;
            }

            const payload = msg.slice(headerLen);
            if (payload.length === 0) return;

            // 发送到目标
            udpRelay.send(payload, targetPort, targetHost, (err) => {
              if (err) {
                console.warn(`UDP send error to ${targetHost}:${targetPort}:`, err.message);
              }
            });
          } catch (e) {
            console.warn('UDP request parse error:', e.message);
          }
        } else {
          // ← 来自目标服务器的响应（裸 payload），需要封装后发回客户端
          if (!clientUdpAddr) return; // 还没收到客户端请求

          // 构建 SOCKS5 UDP response header
          const respHeader = Buffer.alloc(10);
          respHeader[0] = 0x00; // RSV
          respHeader[1] = 0x00; // RSV
          respHeader[2] = 0x00; // FRAG
          respHeader[3] = 0x01; // ATYP = IPv4 (简化：统一返回 IPv4 0.0.0.0)
          respHeader[4] = 0;
          respHeader[5] = 0;
          respHeader[6] = 0;
          respHeader[7] = 0;
          respHeader.writeUInt16BE(rinfo.port, 8); // 源端口作为 DST.PORT（部分客户端依赖）

          const response = Buffer.concat([respHeader, msg]);
          udpRelay.send(response, clientUdpAddr.port, clientUdpAddr.address, (err) => {
            if (err) {
              console.warn('UDP send back to client error:', err.message);
            }
          });
        }
      });

      udpRelay.on('error', (err) => {
        console.error('UDP relay error:', err);
        clientSocket.destroy();
      });

      // 清理
      const cleanup = () => {
        if (!udpRelay._closed) {
          udpRelay.close();
        }
      };
      clientSocket.on('close', cleanup);
      clientSocket.on('error', cleanup);
    }

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
      // 👇 关键：捕获 socket 级别的错误（包括 ECONNRESET）
      socket.on('error', (err) => {
        console.warn('Client socket error (ignored):', err.message);
        // 不需要手动 destroy()，Node.js 会自动关闭
      });

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
        console.error('SOCKS5 over TLS session error:', err);
        socket.destroy();
      }
    });

    server.on('clientError', (err, socket) => {
      console.warn('TLS client error during handshake:', err);
      socket?.end(); // 安全关闭
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
      var localIp = domain.getLocalIp();
      console.log(`✅ \x1b[32mSOCKS5 (over TLS) 服务启动，IP ${localIp}, 端口 ${LISTEN_PORT}\x1b[0m`);
      console.log(`🔒 传输加密和认证基于 TLS`);
      console.log(`➡️  TCP → 流量转发至 HTTP 代理 → ${DOWNSTREAM_HTTP_PROXY_HOST}:${DOWNSTREAM_HTTP_PROXY_PORT}`);
      console.log(`➡️  UDP → 直接发起请求`);
    });
  } catch (err) {
    console.error('Failed to initialize SOCKS5-TLS proxy:', err);
    process.exit(1);
  }
}

module.exports.init = init;
