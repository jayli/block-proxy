// socks5-proxy.js
const net = require('net');
const dgram = require('dgram');
const _fs = require('../proxy/fs.js');
const { pipeline } = require('stream');

// ===== 配置 =====
const DOWNSTREAM_HTTP_PROXY_HOST = '127.0.0.1';

async function init() {
  const loadedConfig = await _fs.readConfig();
  
  const DOWNSTREAM_HTTP_PROXY_PORT = loadedConfig.proxy_port;
  const LISTEN_PORT = loadedConfig.socks5_port;
  // 认证凭据（可替换为数据库/配置文件）
  const AUTH_CREDENTIALS = {
    username: loadedConfig.auth_username,
    password: loadedConfig.auth_password 
  };

  // 工具函数：解析地址（IPv4 / IPv6 / 域名）
  function parseAddress(buf, offset) {
    const atyp = buf[offset];
    let host, port, nextOffset;

    if (atyp === 0x01) {
      // IPv4 (4 bytes)
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
      // IPv6 (16 bytes) — 简化处理，实际需格式化
      host = `[${buf.slice(offset + 1, offset + 17).toString('hex')}]`;
      port = buf.readUInt16BE(offset + 17);
      nextOffset = offset + 19;
    } else {
      throw new Error('Unsupported address type');
    }

    return { host, port, nextOffset };
  }

  // 发送 SOCKS5 响应
  function sendResponse(socket, status, atyp = 0x01, bindAddr = '0.0.0.0', bindPort = 0) {
    const resp = Buffer.alloc(10);
    resp[0] = 0x05; // VER
    resp[1] = status; // REP
    resp[2] = 0x00; // RSV
    resp[3] = atyp; // ATYP

    if (atyp === 0x01) {
      resp[4] = 0;
      resp[5] = 0;
      resp[6] = 0;
      resp[7] = 0;
    }
    resp.writeUInt16BE(bindPort, 8);
    socket.write(resp.slice(0, 10));
  }

  // ===== SOCKS5 服务器 =====
  const server = net.createServer(async (socket) => {
    try {
      // Step 1: 协商认证方法
      const authMethodsBuf = await new Promise((resolve) => {
        socket.once('data', resolve);
      });
      const nmethods = authMethodsBuf[1];
      if (authMethodsBuf.length !== 2 + nmethods) {
        socket.destroy();
        return;
      }

      let method = 0xff; // 无支持方法
      for (let i = 0; i < nmethods; i++) {
        const m = authMethodsBuf[2 + i];
        if (m === 0x02) method = 0x02; // 用户名/密码认证
        if (m === 0x00 && method === 0xff) method = 0x00; // 匿名（可选）
      }

      // 回复支持的认证方式
      socket.write(Buffer.from([0x05, method]));

      // Step 2: 执行认证（如果需要）
      if (method === 0x02) {
        const authData = await new Promise((resolve) => {
          socket.once('data', resolve);
        });
        const ulen = authData[1];
        const username = authData.slice(2, 2 + ulen).toString();
        const plen = authData[2 + ulen];
        const password = authData.slice(2 + ulen + 1, 2 + ulen + 1 + plen).toString();

        if (username !== AUTH_CREDENTIALS.username || password !== AUTH_CREDENTIALS.password) {
          socket.write(Buffer.from([0x01, 0xff])); // 认证失败
          socket.destroy();
          return;
        }
        socket.write(Buffer.from([0x01, 0x00])); // 认证成功
      }

      // Step 3: 接收请求
      const requestBuf = await new Promise((resolve) => {
        socket.once('data', resolve);
      });
      const cmd = requestBuf[1];
      const { host, port } = parseAddress(requestBuf, 3);

      if (cmd === 0x01) {
        // CONNECT 命令（TCP）
        handleTcpRequest(socket, host, port);
      } else if (cmd === 0x03) {
        // UDP ASSOCIATE（简化：直接绑定本地 UDP）
        handleUdpAssociate(socket);
      } else {
        sendResponse(socket, 0x07); // Command not supported
        socket.destroy();
      }
    } catch (err) {
      console.error('SOCKS5 error:', err.message);
      socket.destroy();
    }
  });

  // 处理 TCP 请求（转发到下游 HTTP 代理）
  function handleTcpRequest(clientSocket, targetHost, targetPort) {
    const proxySocket = net.connect(DOWNSTREAM_HTTP_PROXY_PORT, DOWNSTREAM_HTTP_PROXY_HOST, () => {
      // 发送 HTTP CONNECT 请求
      const connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`;
      proxySocket.write(connectReq);

      // 等待代理响应
      let buffer = '';
      const onProxyData = (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes('\r\n\r\n')) {
          proxySocket.removeListener('data', onProxyData);
          if (!buffer.startsWith('HTTP/1.1 200')) {
            clientSocket.destroy();
            proxySocket.destroy();
            return;
          }
          // 隧道建立成功，双向转发
          sendResponse(clientSocket, 0x00); // Success
          pipeline(clientSocket, proxySocket, (err) => {
            clientSocket.destroy();
            proxySocket.destroy();
          });
          pipeline(proxySocket, clientSocket, () => {});
        }
      };
      proxySocket.on('data', onProxyData);
    });

    proxySocket.on('error', () => {
      sendResponse(clientSocket, 0x05); // Connection refused
      clientSocket.destroy();
    });
  }

  // 处理 UDP ASSOCIATE（直接本地 UDP 转发）
  function handleUdpAssociate(clientSocket) {
    const udpRelay = dgram.createSocket('udp4');
    const localPort = udpRelay.address().port;

    udpRelay.on('message', (msg, rinfo) => {
      // 构造 SOCKS5 UDP 响应包（此处简化：直接回传）
      // 实际需按 RFC 1928 格式封装，但多数客户端只用于 DNS，可简化
      clientSocket.write(msg);
    });

    // 告诉客户端 UDP 中继地址（这里返回本机）
    sendResponse(clientSocket, 0x00, 0x01, '127.0.0.1', localPort);

    // 客户端关闭时清理
    clientSocket.on('close', () => udpRelay.close());
  }

  // 启动服务器
  server.listen(LISTEN_PORT, () => {
    console.log(`✅ SOCKS5 proxy with auth running on port ${LISTEN_PORT}`);
    console.log(`➡️  TCP → HTTP proxy at ${DOWNSTREAM_HTTP_PROXY_HOST}:${DOWNSTREAM_HTTP_PROXY_PORT}`);
    console.log(`➡️  UDP → direct relay`);
  });

};

module.exports.init = init;
