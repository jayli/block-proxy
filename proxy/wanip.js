const https = require('https');

/**
 * 从 ipip.net 获取当前公网 IP 地址
 * @returns {Promise<string>} 公网 IP 地址（如 "114.253.239.240"）
 * @throws {Error} 请求失败、返回格式错误或 IP 无效时抛出错误
 */
async function getPublicIp() {
  return new Promise((resolve, reject) => {
    const url = 'https://myip.ipip.net/json';

    const req = https.get(url, {
      headers: {
        'User-Agent': 'Node.js IP Fetcher'
      }
    }, (res) => {
      let data = '';

      // 监听数据块
      res.on('data', chunk => {
        data += chunk;
      });

      // 响应结束
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }

        try {
          const json = JSON.parse(data);
          if (json.ret === 'ok' && json.data?.ip) {
            const ip = json.data.ip.trim();
            // 简单校验 IPv4 或 IPv6 格式
            if (
              /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) ||
              /^[a-fA-F0-9:]+$/.test(ip) // 粗略匹配 IPv6
            ) {
              resolve(ip);
            } else {
              reject(new Error(`Invalid IP format: ${ip}`));
            }
          } else {
            reject(new Error('Unexpected response format from ipip.net'));
          }
        } catch (parseErr) {
          reject(new Error(`Failed to parse JSON: ${parseErr.message}`));
        }
      });
    });

    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Request timeout (5s)'));
    });

    req.on('error', (err) => {
      reject(new Error(`Network error: ${err.message}`));
    });
  });
}

module.exports = {
  getPublicIp
};

// 使用示例
// (async () => {
//   try {
//     const ip = await getPublicIp();
//     console.log('Your public IP is:', ip);
//   } catch (err) {
//     console.error('Failed to get IP:', err.message);
//   }
// })();
