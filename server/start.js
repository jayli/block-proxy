// express/start.js
// 总入口，根据 config.enable_express 参数判断是启动后台+代理，还是只启动代理
// 如果后台没启动，直接访问 http://代理IP:8001，打开开关后重启服务即可
const _fs = require('../proxy/fs.js');

(async function() {
  const config = await _fs.readConfig();
  if (config.enable_socks5 && config.enable_socks5 == "1") {
    console.log("启动Socks5");
    const Socks5 = require("../socks5/server.js");
    Socks5.init();
  }
  if (config.enable_express && config.enable_express == "1") {
    console.log("启动express");
    const ExpressServer = require("./express.js");
    ExpressServer.init();
  } else {
    console.log("只启动proxy");
    const LocalProxy = require('../proxy/proxy');
    await LocalProxy.init();
  }
})();


