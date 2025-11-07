// 文件名: proxy.js

const AnyProxy = require('anyproxy');
const fs = require('fs');
const path = require('path');
const { start } = require('repl');
const net = require('net');
const scanNetwork = require("./scan").scanNetwork;

// 全局变量存储关键配置参数
const configPath = path.join(__dirname, '../config.json');
let blockHosts = ["baidu.com", "bilibili.com"];
let proxyPort = 8001;
let webInterfacePort = 8002;
let devices = [];

// 读取配置文件的函数
function loadConfig() {
  let config = {
    block_hosts: blockHosts, // 使用全局变量的默认值
    proxy_port: proxyPort,
    web_interface_port: webInterfacePort,
    devices: []
  };

  try {
    if (fs.existsSync(configPath)) {
      const configFileContent = fs.readFileSync(configPath, 'utf-8');
      const loadedConfig = JSON.parse(configFileContent);
      
      // 更新全局变量
      if (loadedConfig.block_hosts) {
        blockHosts = loadedConfig.block_hosts;
        config.block_hosts = blockHosts;
      }
      
      if (loadedConfig.proxy_port) {
        proxyPort = loadedConfig.proxy_port;
        config.proxy_port = proxyPort;
      }
      
      if (loadedConfig.web_interface_port) {
        webInterfacePort = loadedConfig.web_interface_port;
        config.web_interface_port = webInterfacePort;
      }

      if (loadedConfig.devices) {
        devices = loadedConfig.devices;
        config.devices = devices;
      }
      
      console.log('Loaded config from config.json:', config);
    } else {
      // 如果配置文件不存在，则创建默认配置文件
      fs.writeFileSync(configPath, JSON.stringify({
        block_hosts: blockHosts,
        proxy_port: proxyPort,
        web_interface_port: webInterfacePort
      }, null, 2));
      console.log('Created default config.json file');
    }
  } catch (err) {
    console.error('Error reading config file, using default config:', err);
  }
  
  return config;
}

// 检查主机名是否在拦截列表中，并且当前时间在拦截时间段内，且命中来源ip
function shouldBlockHost(host, ip) {
  console.log('来源ip',ip);
  if (!host) return false;
  if (!ip) {
    ip = "0.0.0.0";
  }
  
  // 获取当前时间信息
  const now = new Date();
  const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
  const currentDay = now.getDay() === 0 ? 7 : now.getDay(); // 转换为 1-7，周日为7

  // 获得ip对应的 mac 地址
  const mac = getMacByIp(ip);
  
  return blockHosts.some(blockItem => {
    // 兼容旧格式（字符串格式）
    if (typeof blockItem === 'string') {
      return host.includes(blockItem);
    }
    
    // 新格式（对象格式）
    if (typeof blockItem === 'object' && blockItem.filter_host) {

      console.log(host, blockItem.filter_mac, mac);
      // 检查主机mac是否匹配，如果规则中mac是空，则对所有ip都生效
      if (blockItem.filter_mac && blockItem.filter_mac == "") {
        // 如果filter_mac 为空，则所有来源都做检查
      } else if (blockItem.filter_mac && blockItem.filter_mac != "" && blockItem.filter_mac.toLowerCase() != mac.toLowerCase()) {
        // return false; // 不拦截
      }
      
      // 检查主机名是否匹配
      if (!host.includes(blockItem.filter_host)) {
        return false;
      }

      // 检查星期几是否匹配
      if (blockItem.filter_weekday && Array.isArray(blockItem.filter_weekday)) {
        if (!blockItem.filter_weekday.includes(currentDay)) {
          return false;
        }
      }
      
      // 如果没有设置时间段，则始终拦截
      if (!blockItem.filter_start_time || !blockItem.filter_end_time) {
        return true;
      }
      
      // 检查当前时间是否在拦截时间段内
      const startTime = blockItem.filter_start_time;
      const endTime = blockItem.filter_end_time;
      
      // 处理跨天的情况（例如 22:00 到 06:00）
      if (startTime > endTime) {
        return currentTime >= startTime || currentTime <= endTime;
      } else {
        return currentTime >= startTime && currentTime <= endTime;
      }
    }
    
    return false;
  });
}

function getContentLength(body) {
  let contentLength = 0;
  if (Buffer.isBuffer(body)) {
    contentLength = body.length;
  } else if (typeof body === 'string') {
    // 如果是字符串，按 utf-8 编码转换为字节
    let encoder = new TextEncoder();
    let uint8Array = encoder.encode(body);
    contentLength = uint8Array.byteLength;
  }
  return contentLength;
}

function getMacByIp(ipAddress) {
  // 从 devices 中查询 ip 对应的 mac 地址，否则返回空
  if (!ipAddress || !devices || !Array.isArray(devices)) {
    return "";
  }
  
  const device = devices.find(device => device.ip === ipAddress);
  return device ? device.mac : "";
}

// 保存代理服务器实例的变量
let proxyServerInstance = null;

function startProxyServer() {
  // Check if root CA is needed
  if (!AnyProxy.utils.certMgr.ifRootCAFileExists()) {
    AnyProxy.utils.certMgr.generateRootCA((error, keyPath) => {
      if (!error) {
        console.log('Root CA generated successfully, please install the certificate');
        console.log('Certificate path:', keyPath);
        startProxyServer();
      } else {
        console.error('Failed to generate root CA:', error);
      }
    });
  } else {
    // Start proxy server
    let options = getAnyProxyOptions();
    proxyServerInstance = new AnyProxy.ProxyServer(options);

    proxyServerInstance.on('ready', () => {
      console.log(`Proxy server started on port ${proxyPort}`);
      console.log(`Web interface available on port ${webInterfacePort}`);
      console.log('Intercepting requests to hosts:', blockHosts.join(', '));
      console.log('All other requests will be passed through without HTTPS interception');
    });

    proxyServerInstance.on('error', (e) => {
      console.error('Proxy server error:', e);
    });

    // 添加服务器关闭事件监听
    proxyServerInstance.on('close', () => {
      console.log('代理服务器已关闭');
      setTimeout(() => {
        // 需要判断是主动关闭还是意外关闭
        // proxyServerInstance.start();
      }, 3000);
    });

    proxyServerInstance.start();

    return proxyServerInstance;
  }
}

function getAnyProxyOptions() {
  return {
    port: proxyPort,
    rule: {
      // 只对特定域名启用 HTTPS 拦截
      async beforeDealHttpsRequest(requestDetail) {
        // ????????????????? 怎么获得来源 IP
        const clientIp = requestDetail?.socket?.remoteAddress;
        console.log('获取来源ip', clientIp);
        const host = requestDetail.host;
        // 只对配置中的域名进行 HTTPS 拦截
        if (shouldBlockHost(host, clientIp)) {
          return true; // 允许 HTTPS 拦截
        }
        return false; // 不拦截 HTTPS
      },

      async onError(requestDetail, error) {
        // 资源不可达
        if (error.code == "ENETUNREACH") {
          return {
            response: {
              statusCode: 404,
              header: { 'Content-Type': 'text/plain; charset=utf-8' },
              body: `AnyProxy Error: ${error.code}`
            }
          };
        }
      },

      async onConnectError(requestDetail, error) {
        return null;
      },
      
      // 拦截 HTTP 请求
      async beforeSendRequest(requestDetail) {
        const clientIp = requestDetail.remoteAddress;
        // ??????????????????? 怎么获取 来源IP
        console.log(clientIp);
        const host = requestDetail.requestOptions.hostname;
        // 如果是裸IP请求则直接放行
        if (net.isIPv4(host) || net.isIPv6(host)) {
          return null;
        } else if (shouldBlockHost(host, clientIp)) {
          // 如果是列表中的域名则拦截
          console.log(`拦截到请求: ${host}${requestDetail.requestOptions.path}`);
          // 为被拦截的域名返回自定义响应
          let customBody = `AnyProxy: request to ${host} is blocked!`;
          return {
            response: {
              statusCode: 200,
              header: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Content-Length': getContentLength(customBody)
              },
              body: customBody
            }
          };
        }

        return null;
      },

      async beforeSendResponse(requestDetail, responseDetail) {
        return null;
      },

    },
    webInterface: {
      enable: true,
      webPort: webInterfacePort
    },
    throttle: 10000,
    forceProxyHttps: false, // 关闭全局 HTTPS 拦截
    wsIntercept: false,
    silent: true
  };
}

module.exports = {
  updateDevices: async function() {
    var macs = []
    try {
      macs = await scanNetwork();
    } catch (e) {
      macs = [];
    }
    // TODO here 需要验证这个函数的正确性
    const config = loadConfig();
    fs.writeFileSync(configPath, JSON.stringify({
      ...config,
      devices: macs
    }, null, 2));
    devices = macs;
    console.log('Devices updated!');
  },
  start: function(callback) { 
    // 每次启动时都重新加载配置
    const config = loadConfig();
    
    // 如果代理服务器已在运行，先停止它
    if (proxyServerInstance && proxyServerInstance.httpProxyServer && proxyServerInstance.httpProxyServer.listening) {
      proxyServerInstance.close();
      setTimeout(() => {
        console.log('重新启动代理服务器');
        startProxyServer();
        if (typeof callback === 'function') {
          callback();
        }
      }, 1000);
    } else {
      startProxyServer();
      if (typeof callback === 'function') {
        callback();
      }
    }
    
  },
  restart: function(callback) { 
    // 实现重启功能
    if (proxyServerInstance) {
      console.log('Restarting proxy server...');
      proxyServerInstance.close();
      setTimeout(() => {
        console.log('重新启动代理服务器');
        this.start(callback);
      }, 1000); 
    } else {
      // 如果没有运行中的实例，直接启动
      this.start(callback);
    }
  }
};
