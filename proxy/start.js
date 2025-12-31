// 仅启动本地代理
// /proxy/start.js
const LocalProxy = require('./proxy');

(async () => {
  await LocalProxy.init();
})();
