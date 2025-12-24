// 仅启动本地代理
const LocalProxy = require('./proxy');

(async () => {
  await LocalProxy.start(() => {});
})();
