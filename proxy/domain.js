// proxy/domain.js
const { lookup, resolve4 } = require('dns');
const { promisify } = require('util');
const os = require('os');

const lookupAsync = promisify(lookup);
const resolve4Async = promisify(resolve4);

async function getDomainIP(domain) {
  try {
    const addresses = await resolve4Async(domain);
    return addresses; // 返回数组，如 ['93.184.216.34']
  } catch (err) {
    console.error(`Failed to resolve ${domain}:`, err.message);
    return null;
  }
}

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // 跳过 IPv6 和内部回环地址
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1'; // fallback
}

// 使用示例
/*
getDomainIP('example.com').then(ips => {
  if (ips) {
    console.log(`${ips.length} IP(s):`, ips.join(', '));
  }
});
*/
module.exports.getDomainIP = getDomainIP;
module.exports.getLocalIp = getLocalIp;
