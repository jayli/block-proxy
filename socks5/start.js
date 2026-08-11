// 启动 Socks5 代理
// /socks5/start.js
const Socks5 = require('./server');

(async () => {
  await Socks5.init();
})();
