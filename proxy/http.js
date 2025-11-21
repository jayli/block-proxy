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
        // 修正: 只需要跳过 \r\n\r\n (4 bytes) 而不是8 bytes
        const bodyStart = headerEndIndex + 4;
        const bodyChunk = buffer.slice(bodyStart);

        const lines = headerBytes.toString('ascii').split('\r\n');
        const statusLine = lines[0];
        const match = statusLine.match(/^HTTP\/[10]\.[10]\s+(\d{3})\s*(.*)$/i);
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

        if (expectedBodyLength == 0) {
          socket.end();
        }

        // 处理初始的bodyChunk（如果有）
        if (bodyChunk.length > 0) {
          // 检查是否为chunked编码
          const transferEncoding = headersObj['transfer-encoding'];
          if (transferEncoding && transferEncoding.includes('chunked')) {
            // 对于chunked数据，我们将其存储为原始数据，在end事件中统一处理
            bodyChunks.push(bodyChunk);
            receivedBodyLength += bodyChunk.length;
          } else {
            // 非chunked数据按原来的方式处理
            bodyChunks.push(bodyChunk);
            receivedBodyLength += bodyChunk.length;
          }
        }

        // 如果已知内容长度且已经接收完毕，则关闭连接
        if (expectedBodyLength !== null && receivedBodyLength >= expectedBodyLength) {
          socket.end();
        }
      } else {
        // 已经解析了响应头，正在接收响应体
        bodyChunks.push(chunk);
        receivedBodyLength += chunk.length;

        // 检查是否已接收完整的响应体
        if (expectedBodyLength !== null && receivedBodyLength >= expectedBodyLength) {
          socket.end();
        }
      }
    });

    socket.on('end', () => {
      // 检查是否为分块传输编码
      const transferEncoding = headersObj['transfer-encoding'];
      let finalBody = '';

      if (transferEncoding && transferEncoding.includes('chunked')) {
        // 对每个buffer分别进行解码
        for (const chunkBuffer of bodyChunks) {
          const chunkString = chunkBuffer.toString('utf8');
          let decodedChunk = '';
          let position = 0;

          while (position < chunkString.length) {
            // 查找当前块大小行的结束位置
            let lineEnding = chunkString.indexOf('\r\n', position);
            if (lineEnding === -1) break;

            // 提取块大小（十六进制字符串）
            const chunkSizeHex = chunkString.substring(position, lineEnding).trim();
            const chunkSize = parseInt(chunkSizeHex, 16);

            // 如果块大小为0，表示这是最后一个块
            if (chunkSize === 0) {
              break;
            }

            // 块数据开始位置
            const dataStart = lineEnding + 2;
            // 块数据结束位置
            const dataEnd = dataStart + chunkSize;

            // 确保我们没有超出边界
            if (dataEnd <= chunkString.length) {
              // 提取块数据
              decodedChunk += chunkString.substring(dataStart, dataEnd);
              // 移动到下一个块的大小行
              position = dataEnd + 2; // 跳过数据后的 \r\n
            } else {
              // 数据不完整，跳出循环
              break;
            }
          }

          // 将解码后的chunk添加到最终结果中
          finalBody += decodedChunk;
        }

        body = finalBody;
      } else if (expectedBodyLength != 0) {
        // 非chunked编码，直接连接buffers
        const bodyBuffer = Buffer.concat(bodyChunks);
        body = bodyBuffer.toString('utf8'); // 默认 UTF-8

        // 尝试修复可能的响应体问题
        // 如果body以数字开头，可能是Content-Length的值残留
        if (/^\d+\s*\n/.test(body)) {
          // 移除开头的数字和换行符
          body = body.replace(/^\d+\s*\n/, '');
        }
      } else {
        body = "";
      }

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
