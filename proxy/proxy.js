// 文件名: proxy.js

const AnyProxy = require('anyproxy');
const fs = require('fs');
const path = require('path');
const { start } = require('repl');
const net = require('net');
const scanNetwork = require("./scan").scanNetwork;
const util = require('util');
const os = require('os');

// 全局变量存储关键配置参数
const configPath = path.join(__dirname, '../config.json');
let blockHosts = [];
let proxyPort = 8001;
let webInterfacePort = 8002;
let devices = [];
let localMac = getLocalMacAddress();

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
      
      // console.log('Loaded config from config.json:', config);
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

// 根据来源 ip 来遍历当前 blockList，把对应mac拦截配置匹配的项都找出来
function getBlockRules(ip) {
  // 获得ip对应的 mac 地址
  const mac = getMacByIp(ip);
  var currBlockList = [];
  blockHosts.forEach(function(item, index){
    if (item.filter_mac === undefined || item.filter_mac == "") {
      currBlockList.push(item);
    } else if (item.filter_mac != "" && item.filter_mac.toLowerCase() === mac.toLowerCase()) {
      // TODO here f4:6b:8c:90:29:5  ->  f4:6b:8c:90:29:05
      currBlockList.push(item);
    }
  });
  return currBlockList;
}

// In proxy/proxy.js, modify the shouldBlockHost function to include pathname checking:
function shouldBlockHost(host, blockList, pathname) {
  if (!host) return false;
  
  // 获取当前时间信息
  const now = new Date();
  const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
  const currentDay = now.getDay() === 0 ? 7 : now.getDay(); // 转换为 1-7，周日为7

  return blockList.some(blockItem => {
    // 兼容旧格式（字符串格式）
    if (typeof blockItem === 'string') {
      return host.includes(blockItem);
    }
    
    // 新格式（对象格式）
    if (typeof blockItem === 'object' && blockItem.filter_host) {

      if (!host.includes(blockItem.filter_host)) {
        return false;
      }
      // console.log('访问网址 === 配置网址')

      // 检查星期几是否匹配
      if (blockItem.filter_weekday && Array.isArray(blockItem.filter_weekday)) {
        if (!blockItem.filter_weekday.includes(currentDay)) {
          return false;
        }
      }
      console.log(host, 111);
      
      // 在传入pathname的情况下检查路径名是否匹配（新增功能）
      if (pathname != "" && blockItem.filter_pathname && blockItem.filter_pathname.trim() !== '') {
        try {
          const regex = new RegExp(blockItem.filter_pathname);
          if (!regex.test(pathname)) {
            return false; // 路径不匹配，不拦截
          }
        } catch (e) {
          console.error('Invalid regex in filter_pathname:', blockItem.filter_pathname);
          // If regex is invalid, fall back to exact match
          if (!pathname.includes(blockItem.filter_pathname)) {
            return false;
          }
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

function getLocalMacAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const nets = interfaces[name];
    for (var net of nets) {
      // 跳过回环地址和 IPv6
      if (net.family === 'IPv4' && !net.internal) {
        return net.mac; // 返回第一个非回环 IPv4 网卡的 MAC
      }
    }
  }
  return null;
}

function getMacByIp(ipAddress) {
  // 从 devices 中查询 ip 对应的 mac 地址，否则返回空
  if (!ipAddress || !devices || !Array.isArray(devices)) {
    return "";
  }

  if (ipAddress == "127.0.0.1") {
    return localMac;
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

// console.log(normalizeIP('::ffff:192.168.124.118'));     // "192.168.124.118"
// console.log(normalizeIP('::FFFF:10.0.0.5'));           // "10.0.0.5"
// console.log(normalizeIP('192.168.1.100'));             // "192.168.1.100"
// console.log(normalizeIP('[::ffff:172.16.0.10]:3000')); // "172.16.0.10"
// console.log(normalizeIP('::1'));                       // "::1"
function normalizeIP(rawIP) {
  if (typeof rawIP !== 'string') return rawIP;

  // 处理 [::ffff:192.168.1.1]:8080 这类格式（来自 req.url 或 proxy）
  let ip = rawIP;
  if (ip.startsWith('[')) {
    const match = ip.match(/^\[([^\]]+)\]/);
    if (match) ip = match[1];
  }

  // 移除 ::ffff: 前缀（忽略大小写）
  return ip.replace(/^::ffff:/i, '');
}

function getRemoteAddressFromReq(requestDetail) {
  var rawIP = requestDetail?._req?.client?.remoteAddress;
  if (rawIP === undefined) {
    return "0.0.0.0";
  } else {
    return normalizeIP(rawIP);
  }
}

function getSymbolProperty(obj, symbolDescription) {
  if (typeof obj !== 'object' || obj === null) {
    return undefined;
  }

  const symbols = Object.getOwnPropertySymbols(obj);
  for (var sym of symbols) {
    if (sym.description === symbolDescription) {
      return obj[sym];
    }
  }
  return undefined;
}

function getAnyProxyOptions() {
  return {
    port: proxyPort,
    rule: {
      // 只对特定域名启用 HTTPS 拦截
      async beforeDealHttpsRequest(requestDetail) {
        const clientIp = getRemoteAddressFromReq(requestDetail);
        const blockRules = getBlockRules(clientIp);
        const host = requestDetail.host;
        console.log('\n\n\n{{{');
        // console.log(requestDetail._req.client);
        console.log(getSymbolProperty(requestDetail._req.client, 'async_id_symbol'), clientIp);
        console.log("\n\n\n")

        // HTTPS 的 requestDetail.url 为空, requestDetail.requestOptions 也为空
        // 这里只能简单的判断域名，pathname 的判断都放到 beforeSendRequest 中

        // 如果是裸IP请求，全部放行
        if (net.isIPv4(host) || net.isIPv6(host)) {
          return false;
        }

        // 如果没有对应ip的匹配规则
        let shouldBlock = shouldBlockHost(host, blockRules, "");
        if (blockRules.length === 0) {
          return false;
        } else if (shouldBlock) {
          console.log('https 拦截', host);
          // 只对配置中的域名进行 HTTPS 拦截
          return true; // 允许 HTTPS 拦截
        }
        return false; // 不拦截 HTTPS
      },

      // 拦截 HTTP 请求
      async beforeSendRequest(requestDetail) {
        const clientIp = getRemoteAddressFromReq(requestDetail);
        const host = requestDetail.requestOptions.hostname;
        const pathname = requestDetail.requestOptions.path?.split('?')[0];;
        console.log(getSymbolProperty(requestDetail._req.client, 'async_id_symbol'), clientIp);
        console.log('}}}');

        // ???????????????????????????????????????????????????? 这里得不到真实IP
        // 如果是 https 请求，说明已经被beforeDealHttpsRequest处理过且认为应当拦截，应当直接返回拦截结果
        // 之所以这样处理是https转过来的请求clientIp变成了127.0.0.1（应该是 anyproxy 的 bug）
        if (requestDetail.protocol == "https") {
          console.log(`拦截到https请求: ${host}${requestDetail.requestOptions.path}`);
          // 为被拦截的域名返回自定义响应
          let customBody = `AnyProxy: https request to ${host} is blocked!`;
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
        } else if (requestDetail.protocol == "http") {
          // 如果是 http 请求，说明是直接访问过来的，没有经过beforeDealHttpsRequest，因此clientIp是真实的
          let blockRules = getBlockRules(clientIp);
          // 没有命中规则，直接放行
          if (blockRules.length === 0) {
            return null;
          }
          if (shouldBlockHost(host, blockRules, pathname)) {
            // 如果是列表中的域名则拦截
            console.log(`拦截到http请求: ${host}${requestDetail.requestOptions.path}`);
            // 为被拦截的域名返回自定义响应
            let customBody = `AnyProxy: http request to ${host} is blocked!`;
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
        }

        return null;
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
    const config = loadConfig();
    var oldRouterMap = config.devices || []; // 确保旧路由表是数组
    var newRouterMap = []
    try {
      newRouterMap = await scanNetwork();
    } catch (e) {
      newRouterMap = [];
    }

    var mergedRouterMap = [];
    // 把新的路由表中变更和新增的部分增补到 oldRouterMap 中
    // 形成新的 mergedRouterMap
    
    // 创建一个以IP为键的映射表，用于快速查找现有设备
    const oldDeviceMap = {};
    oldRouterMap.forEach(device => {
      oldDeviceMap[device.ip] = device;
    });
    
    // 初始化合并后的设备列表为旧设备列表
    mergedRouterMap = [...oldRouterMap];
    
    // 处理每一个新扫描到的设备
    newRouterMap.forEach(newDevice => {
      const existingDevice = oldDeviceMap[newDevice.ip];
      
      // 如果这是一个新设备（IP不存在于旧列表中）
      if (!existingDevice) {
        mergedRouterMap.push(newDevice);
        console.log(`新增设备: ${newDevice.ip} (${newDevice.mac})`);
      } 
      // 如果设备已存在但MAC地址发生了变化
      else if (existingDevice.mac !== newDevice.mac) {
        // 找到该设备在合并列表中的索引
        const index = mergedRouterMap.findIndex(device => device.ip === newDevice.ip);
        // 更新设备信息
        mergedRouterMap[index] = newDevice;
        console.log(`更新设备: ${newDevice.ip} (${existingDevice.mac} -> ${newDevice.mac})`);
      }
    });

    fs.writeFileSync(configPath, JSON.stringify({
      ...config,
      devices: mergedRouterMap
    }, null, 2));
    devices = mergedRouterMap;
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
