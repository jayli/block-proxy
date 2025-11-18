// requestNoValidationSync.js
const net = require('net');

/**
 * 发送 HTTP 请求并返回完整响应（绕过头校验）
 * @param {Object} options - 同 http.request 的 options
 * @returns {Promise<{ statusCode: number, headers: Object, body: string }>}
 */
function requestNoValidationSync(options) {
  return new Promise((resolve, reject) => {
    const method = (options.method || 'GET').toUpperCase();
    const hostname = options.hostname || options.host || 'localhost';
    const port = options.port || 80;
    const path = options.path || '/';
    const headers = options.headers || {};

    // 构造 Host 头
    let host = hostname;
    if (port !== 80) host += ':' + port;
    const finalHeaders = { ...headers };
    if (!('Host' in finalHeaders) && !('host' in finalHeaders)) {
      finalHeaders.Host = host;
    }

    // 构造请求头
    let headerStr = `${method} ${path} HTTP/1.1\r\n`;
    for (const [key, val] of Object.entries(finalHeaders)) {
      headerStr += `${key}: ${val}\r\n`;
    }
    headerStr += '\r\n';

    const socket = net.connect(port, hostname);

    const handleError = (err) => {
      socket.destroy();
      reject(err);
    };

    socket.on('error', handleError);

    let buffer = Buffer.alloc(0);
    let responseParsed = false;
    let statusCode, statusMessage, headersObj, rawHeaders;
    let bodyChunks = [];
    let expectedBodyLength = null;
    let receivedBodyLength = 0;

    socket.write(headerStr);

    // 如果有请求体（简单支持字符串）
    if (options.body) {
      socket.write(options.body);
    }
    // 注意：不要在这里调用 socket.end()，避免过早关闭连接

    socket.on('data', (chunk) => {
      if (!responseParsed) {
        buffer = Buffer.concat([buffer, chunk]);
        const headerEndIndex = buffer.indexOf('\r\n\r\n');
        if (headerEndIndex === -1) return;

        const headerBytes = buffer.slice(0, headerEndIndex);
        const bodyStart = headerEndIndex + 4;
        const bodyChunk = buffer.slice(bodyStart);

        const lines = headerBytes.toString('ascii').split('\r\n');
        const statusLine = lines[0];
        const match = statusLine.match(/^HTTP\/1\.1\s+(\d{3})\s*(.*)$/i);
        if (!match) {
          return handleError(new Error('Invalid HTTP status line'));
        }

        statusCode = parseInt(match[1], 10);
        statusMessage = match[2] || '';

        // 手动解析头部（不校验冲突！）
        headersObj = {};
        rawHeaders = [];
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;
          const idx = line.indexOf(':');
          if (idx === -1) continue;
          const key = line.slice(0, idx).trim();
          const val = line.slice(idx + 1).trim();
          const lowerKey = key.toLowerCase();
          rawHeaders.push(key, val);
          if (headersObj[lowerKey] === undefined) {
            headersObj[lowerKey] = val;
          } else if (Array.isArray(headersObj[lowerKey])) {
            headersObj[lowerKey].push(val);
          } else {
            headersObj[lowerKey] = [headersObj[lowerKey], val];
          }
        }

        // 获取Content-Length
        const contentLength = headersObj['content-length'];
        if (contentLength !== undefined) {
          expectedBodyLength = parseInt(contentLength, 10);
        }

        responseParsed = true;
        if (bodyChunk.length > 0) {
          bodyChunks.push(bodyChunk);
          receivedBodyLength += bodyChunk.length;
        }
        
        // 如果已知内容长度且已经接收完毕，则关闭连接
        if (expectedBodyLength !== null && receivedBodyLength >= expectedBodyLength) {
          socket.end();
        }
      } else {
        bodyChunks.push(chunk);
        receivedBodyLength += chunk.length;
        
        // 检查是否已接收完整的响应体
        if (expectedBodyLength !== null && receivedBodyLength >= expectedBodyLength) {
          socket.end();
        }
      }
    });

    socket.on('end', () => {
      const bodyBuffer = Buffer.concat(bodyChunks);
      let body = bodyBuffer.toString('utf8'); // 默认 UTF-8
      
      // 尝试修复可能的响应体问题
      // 如果body以数字开头，可能是Content-Length的值残留
      if (/^\d+\s*\n/.test(body)) {
        // 移除开头的数字和换行符
        body = body.replace(/^\d+\s*\n/, '');
      }
      
      // 移除尾部的多余回车换行符
      body = body.replace(/[\n]+$/, '');
      
      resolve({
        statusCode,
        statusMessage,
        headers: headersObj,
        body
      });
    });

    socket.on('close', (hadError) => {
      if (hadError && !responseParsed) {
        reject(new Error('Socket closed unexpectedly'));
      }
    });
  });
}

module.exports = {
  request: requestNoValidationSync
};
