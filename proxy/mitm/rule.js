const YoutubeResponse = require('./youtube/youtube.response.js');

function getContentLength(body) {
  let contentLength = 0;

  // 1. 检查是否为 Uint8Array 类型
  if (body instanceof Uint8Array) {
    contentLength = body.length; // Uint8Array 的 length 就是字节数
  }
  // 2. 检查是否为 Buffer 类型 (注意：Buffer 是 Uint8Array 的子类)
  else if (Buffer.isBuffer(body)) {
    contentLength = body.length;
  }
  // 3. 检查是否为字符串类型
  else if (typeof body === 'string') {
    // 如果是字符串，按 UTF-8 编码转换为字节
    const encoder = new TextEncoder();
    const uint8Array = encoder.encode(body);
    contentLength = uint8Array.length; // 或 uint8Array.byteLength，两者在此处等价
  }
  // 4. 如果都不是，可以返回 0 或根据需要处理其他类型（如 null, undefined, 对象等）
  //    这里保持原样返回 0

  return contentLength;
}

// 这里增加规则即可，不用修改 proxy.js
// callback 被 MITMHandler 调用
// callback 返回值是一个包含 response 的对象，如果不做处理则返回 null
module.exports = {
  Youtube: [
    // Rule1
    {
      'type': 'beforeSendResponse',
      'host': 'youtubei.googleapis.com',
      'regexp': "\/youtubei\/v1\/(browse|next|player|search|reel\/reel_watch_sequence|guide|account\/get_setting|get_watch)",
      'callback': async function(url, request, response) {
        return new Promise((resolve, reject) => {
          var responseResult = {};
          YoutubeResponse.injection({
            callback: function(obj) {
              console.log('💙💙💙',obj);
              var contentLength = 0;
              if (obj.hasOwnProperty('body')) {
                contentLength = getContentLength(obj.body);
              }
              response.header['Content-Length'] = String(contentLength);
              responseResult = {
                response: {
                  statusCode: response.statusCode,
                  header: response.header,
                  body: obj.hasOwnProperty('body') ? obj.body : Buffer.alloc(0)
                }
              }
              resolve(responseResult);
            },
            url: url,
            response: response,
            request: request
          });
          YoutubeResponse.main();
        }); // -- promise
      } // -- callback
    },
    // Rule2...
    {
      type: "beforeSendRequest",
      host: "googlevideo.com",
      regexp: "(^https?:\/\/[\\w-]+\.googlevideo\.com\/.+)(ctier=L)(&.+)",
      callback: async function(url, request, response) {
        const matchRegExp = new RegExp(this.regexp);
        const matchResult = url.match(matchRegExp);
        if (matchResult !== null) {
          const newUrl = matchResult[1] + matchResult[3];
          console.log(`302 ---------------- ${newUrl}`);
          return {
            response: {
              statusCode: 302,
              header: {
                'Location': newUrl,
                'Content-Length': '0'
              },
              body: Buffer.alloc(0)
            }
          };
        }
      } // -- callback
    }
  ]
};
