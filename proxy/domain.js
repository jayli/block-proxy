const { lookup, resolve4 } = require('dns');
const { promisify } = require('util');

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

// 使用示例
/*
getDomainIP('example.com').then(ips => {
  if (ips) {
    console.log(`${ips.length} IP(s):`, ips.join(', '));
  }
});
*/
module.exports.getDomainIP = getDomainIP;
