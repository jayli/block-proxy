const _fs = require('./fs.js');
const monitor = require('./monitor.js');

async function getResponseByPathname(pathname, isDocker, proxyPort) {
  if (pathname === "/favicon.ico") {
    return {
      response:{
        statusCode:200,
        body: Buffer.alloc(0)
      }
    };
  } else if (pathname == "/restart_docker") {
    if (isDocker) {
      var msg = "请手动重启 Docker 容器。";
    } else {
      var msg = "当前程序不在 Docker 容器内，请在终端终止程序后再 npm run start 启动。";
    }
    return {
      response: {
        statusCode: 200,
        header: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: msg
      }
    };
  } else if (pathname == "/enable_express") {
    var configData = await _fs.readConfig();
    _fs.writeConfig({
      ...configData,
      enable_express: "1"
    });
    return {
      response: {
        statusCode: 200,
        header: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: "开启 express 后台设置成功，请重启 Docker。"
      }
    };
  } else if (pathname == "/disable_express") {
    var configData = await _fs.readConfig();
    _fs.writeConfig({
      ...configData,
      enable_express: "0"
    });
    return {
      response: {
        statusCode: 200,
        header: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: "关闭 express 后台设置成功，请重启 Docker。"
      }
    };
  } else if (pathname == "/enable_socks5") {
    var configData = await _fs.readConfig();
    _fs.writeConfig({
      ...configData,
      enable_socks5: "1"
    });
    return {
      response: {
        statusCode: 200,
        header: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: "开启 socks5 成功，请重启 Docker。"
      }
    };
  } else if (pathname == "/disable_socks5") {
    var configData = await _fs.readConfig();
    _fs.writeConfig({
      ...configData,
      enable_socks5: "0"
    });
    return {
      response: {
        statusCode: 200,
        header: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: "关闭 socks5 成功，请重启 Docker。"
      }
    };
  } else if (pathname == "/disable_webinterface") {
    var configData = await _fs.readConfig();
    _fs.writeConfig({
      ...configData,
      enable_webinterface: "0"
    });
    return {
      response: {
        statusCode: 200,
        header: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: "关闭 webinterface 成功，请重启 Docker。"
      }
    };
  } else if (pathname == "/enable_webinterface") {
    var configData = await _fs.readConfig();
    _fs.writeConfig({
      ...configData,
      enable_webinterface: "1"
    });
    return {
      response: {
        statusCode: 200,
        header: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: "启用 webinterface 成功，请重启 Docker。"
      }
    };
  } else {
    return {
      response: {
        statusCode: 200,
        header: { 'Content-Type': 'text/html; charset=utf-8' },
        body: '<pre>' + await monitor.getSystemMonitorInfo(proxyPort) + '</pre>'
      }
    };
  }
}

module.exports.getResponseByPathname = getResponseByPathname;
