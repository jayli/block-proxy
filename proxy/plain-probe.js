'use strict';

/**
 * 明文探测应答（TLS 之前的诱饵层）。
 *
 * 8002 / 8003 都是 TLS 端口：用 http:// 明文访问时请求先落到 TLS 层，
 * OpenSSL 判定成 "http request" 后直接丢连接，客户端拿到 0 字节
 * （浏览器显示 ERR_EMPTY_RESPONSE）。扫描器一眼就看出这不是普通 web 服务。
 *
 * 这里在 TLS 之前先嗅探首字节：
 *   - 0x16（TLS handshake record）→ 原样交回 tls.createServer / http2 服务器
 *   - 其他字节 → 按明文 HTTP 处理，回一个与 8003 伪装页一致的 200 页面
 *
 * 页面复用 tunnel/disguiseResponse.js，保证两条路径外观一致。
 */

const net = require('net');
const { buildPageResponse } = require('../tunnel/disguiseResponse');

const TLS_HANDSHAKE_BYTE = 0x16;
// 明文 HTTP 请求头上限：超过按 431 丢掉
const MAX_HEAD_BYTES = 16 * 1024;
// 首个字节的等待上限。真实客户端（TLS ClientHello / SOCKS5 greeting）连上就发；
// 静默连接在这里被丢弃，公网端口不会变成免费的连接池。
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

const PLAIN_TEXT = { 'content-type': 'text/plain; charset=utf-8' };

const REASONS = {
  200: 'OK',
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  431: 'Request Header Fields Too Large',
};

/**
 * 在裸 socket（明文或已解密的 TLS socket）上写一个完整的 HTTP/1.1 响应并关闭连接。
 */
function writeHttpResponse(socket, statusCode, headers, body) {
  if (socket.destroyed) return;
  const payload = Buffer.from(body, 'utf8');
  const lines = [`HTTP/1.1 ${statusCode} ${REASONS[statusCode] || 'OK'}`];
  const merged = { ...headers, 'content-length': payload.length, connection: 'close' };
  for (const [name, value] of Object.entries(merged)) {
    lines.push(`${name}: ${value}`);
  }
  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
  socket.write(Buffer.concat([head, payload]), () => socket.destroy());
}

/**
 * 按伪装页语义回应一个非代理请求。明文与 TLS 两条路径共用，
 * 保证两个端口、两种协议看到的页面完全一致。
 */
function serveDisguise(socket, rawUrl) {
  const page = buildPageResponse(rawUrl || '/');
  writeHttpResponse(socket, page.statusCode, page.headers, page.body);
}

function servePlainRequest(socket, headBytes) {
  const requestLine = headBytes.toString('latin1').split('\r\n')[0] || '';
  const parts = requestLine.split(' ');
  const [method, rawUrl, version] = parts;

  if (parts.length !== 3 || !/^HTTP\/1\.[01]$/.test(version) || !/^[A-Z]+$/.test(method)) {
    writeHttpResponse(socket, 400, PLAIN_TEXT, 'Bad Request');
    return;
  }

  if (method === 'CONNECT') {
    // 明文 CONNECT 不是本服务的用法（真实客户端在 TLS 里说话），但明确回 403，
    // 不留下「这个端口什么都不回」的指纹。
    writeHttpResponse(socket, 403, PLAIN_TEXT, 'Forbidden');
    return;
  }

  serveDisguise(socket, rawUrl);
}

/**
 * 把已配置好证书/ALPN 的 TLS 服务器包进一层明文中转监听。
 *
 * @param {object} options
 * @param {import('tls').Server|import('http2').Http2SecureServer} options.tlsServer
 * @param {number} [options.probeTimeoutMs] 首个字节的等待上限
 * @returns {import('net').Server} 真正 listen 的 net 服务器
 */
function createPlainProbeFront(options) {
  const tlsServer = options.tlsServer;
  const probeTimeoutMs = Number.isFinite(options.probeTimeoutMs)
    ? options.probeTimeoutMs
    : DEFAULT_PROBE_TIMEOUT_MS;

  return net.createServer({ pauseOnConnect: true }, (socket) => {
    socket.on('error', () => socket.destroy());

    let settled = false;
    const cleanup = () => {
      settled = true;
      if (timer) clearTimeout(timer);
      socket.removeListener('readable', onReadable);
      socket.removeListener('close', onClose);
    };

    const onReadable = () => {
      if (settled) return;
      // 只取 1 字节，其余留在缓冲区里给 TLS 层或明文解析器
      const first = socket.read(1);
      if (first === null) return;
      cleanup();
      socket.unshift(first);

      if (first[0] === TLS_HANDSHAKE_BYTE) {
        tlsServer.emit('connection', socket);
        socket.resume();
        return;
      }

      // 明文 HTTP：继续攒请求头再判定
      let buffer = Buffer.alloc(0);
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const headEnd = buffer.indexOf('\r\n\r\n');
        if (headEnd === -1) {
          if (buffer.length > MAX_HEAD_BYTES) {
            socket.removeListener('data', onData);
            writeHttpResponse(socket, 431, PLAIN_TEXT, 'Request Header Fields Too Large');
          }
          return;
        }
        socket.removeListener('data', onData);
        servePlainRequest(socket, buffer.slice(0, headEnd));
      };
      socket.on('data', onData);
      socket.resume();
    };

    const onClose = () => cleanup();

    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      socket.destroy();
    }, probeTimeoutMs);
    timer.unref?.();

    socket.on('close', onClose);
    socket.on('readable', onReadable);
    onReadable();
  });
}

module.exports = {
  createPlainProbeFront,
  serveDisguise,
  writeHttpResponse,
  TLS_HANDSHAKE_BYTE,
  DEFAULT_PROBE_TIMEOUT_MS,
};