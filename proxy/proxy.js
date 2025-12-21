// 文件名: proxy.js

const AnyProxy = require('anyproxy');
const fs = require('fs');
const path = require('path');
const { start } = require('repl');
const net = require('net');
const scanNetwork = require("./scan").scanNetwork;
const util = require('util');
const os = require('os');
const http = require("http");
const https = require('https');
const { URL } = require('url');
const axios = require('axios');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const _request = require("./http.js").request;

// 全局变量存储关键配置参数
const configPath = path.join(__dirname, '../config.json');
let blockHosts = [];
let proxyPort = 8001;
let webInterfacePort = 8002;
let vpn_proxy = "";
let devices = [];
let localMac = getLocalMacAddress();

// 读取配置文件的函数
function loadConfig() {
  let config = {
    block_hosts: blockHosts, // 使用全局变量的默认值
    proxy_port: proxyPort,
    web_interface_port: webInterfacePort,
    vpn_proxy:"",
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

      if (loadedConfig.vpn_proxy) {
        vpn_proxy = loadedConfig.vpn_proxy;
        config.vpn_proxy = vpn_proxy;
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
        web_interface_port: webInterfacePort,
        vpn_proxy: ""
      }, null, 2));
      console.log('Created default config.json file');
    }
  } catch (err) {
    console.error('Error reading config file, using default config:', err);
  }
  
  return config;
}

// F4:6B:8c:90:29:5  ->  f4:6b:8c:90:29:05
function normalizeMacAddress(mac) {
  // 去除可能的空格，并转为小写
  const cleaned = mac.trim().toLowerCase();
  
  // 按冒号分割成6个部分
  const parts = cleaned.split(':');
  
  // 验证是否为6段
  if (parts.length !== 6) {
    throw new Error('Invalid MAC address: must have 6 parts separated by colons');
  }
  
  // 对每一段：补前导零（确保长度为2），并验证是否为合法十六进制
  const normalized = parts.map(part => {
    if (!/^[0-9a-f]{1,2}$/.test(part)) {
      throw new Error(`Invalid hex part: "${part}"`);
    }
    return part.padStart(2, '0'); // 补0到长度为2
  });
  
  return normalized.join(':');
}

// 根据来源 ip 来遍历当前 blockList，把对应mac拦截配置匹配的项都找出来
function getBlockRules(ip) {
  // 获得ip对应的 mac 地址
  const mac = getMacByIp(ip);
  var currBlockList = [];
  blockHosts.forEach(function(item, index){
    try {
      if (item.filter_mac === undefined || item.filter_mac == "") {
        currBlockList.push(item);
      } else if (item.filter_mac != "" && normalizeMacAddress(item.filter_mac) === normalizeMacAddress(mac)) {
        currBlockList.push(item);
      }
    } catch(e) {
      // 如果mac地址格式不正确，则跳过
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
      
      // 在传入pathname的情况下检查路径名是否匹配（新增功能）
      if (pathname != "" && blockItem.filter_pathname && blockItem.filter_pathname.trim() !== '') {
        if (!pathname.includes(blockItem.filter_pathname)) {
          return false; // 访问路径不包含配置路径，则不拦截
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

function parseAddress(str) {
  const [ip, portStr] = str.split(':');
  const port = portStr ? parseInt(portStr, 10) : null;
  if (isNaN(port)) {
    throw new Error('Invalid port');
  }
  return { ip, port };
}

/**
 * 使用本地 HTTP 代理 (127.0.0.1:1087) 转发请求
 */
async function forwardViaLocalProxy(url, requestOptions, body = null, proxyConfig) {
  const isHttps = url.startsWith('https:') ? true : false;

  // 构造目标 URL（必须是完整 URL）
  const protocol = isHttps ? 'https:' : 'http:';
  const hostname = requestOptions.hostname || requestOptions.host;
  const port = requestOptions.port || (isHttps ? 443 : 80);
  const path = requestOptions.path || '/';
  const proxyUrl = `http://${proxyConfig.ip}:${proxyConfig.port}`;
  const agentOptions = {
    keepAlive: true,        // 启用 keep-alive
    rejectUnauthorized: false // 忽略 SSL 证书错误 (等同于 curl -k)
    // 你可以在这里添加其他 http.Agent 或 https.Agent 的选项
    // 例如: keepAliveMsecs: 1000, maxSockets: 256, timeout: 10000 等
  };
  const agent = isHttps ? new HttpsProxyAgent(proxyUrl, agentOptions) : new HttpProxyAgent(proxyUrl, agentOptions);

  // 注意：url 已包含 query string（如 /search?q=1）
  var targetUrl = url;
  const parsedTargetUrl = new URL(targetUrl);
  const finalHeaders = { ...requestOptions.headers };
  finalHeaders['host'] = hostname;

  // 准备 axios 配置
  const axiosConfig = {
    url: targetUrl,
    method: requestOptions.method || 'GET',
    // baseURL: targetUrl,
    // allowAbsoluteUrls: true,
    headers: finalHeaders,
    data: body,
    httpAgent: agent,
    httpsAgent: agent,
    responseType: 'stream', // 为了获取原始 buffer，也可用 'arraybuffer'
    // validateStatus: () => true, // 不抛错，让调用方处理状态码
    maxRedirects: 21
  };

  try {
    const response = await axios(axiosConfig);

    // 将响应流读取为 Buffer
    const chunks = [];
    for await (const chunk of response.data) {
      chunks.push(chunk);
    }
    const responseBody = Buffer.concat(chunks);

    return {
      statusCode: response.status,
      headers: response.headers,
      body: responseBody
    };
  } catch (error) {
    if (error.response) {
      // 服务器返回了错误状态码（如 4xx, 5xx）
      const chunks = [];
      if (error.response.data) {
        // 如果是 stream，需要读取；但 axios 默认非 stream 时是字符串/对象
        if (typeof error.response.data === 'string') {
          return {
            statusCode: error.response.status,
            headers: error.response.headers,
            body: Buffer.from(error.response.data)
          };
        } else if (Buffer.isBuffer(error.response.data)) {
          return {
            statusCode: error.response.status,
            headers: error.response.headers,
            body: error.response.data
          };
        }
      }
    }

    // 网络错误（如 ECONNREFUSED）
    throw error;
  }
}

function getAnyProxyOptions() {
  return {
    port: proxyPort,
    rule: {
      // 只对特定域名启用 HTTPS 拦截
      async beforeDealHttpsRequest(requestDetail, next) {
        // 如果配置了 vpn_proxy，全部走解密逻辑，仅调试使用
        if (vpn_proxy != "") {
          return true;
        }
        const clientIp = getRemoteAddressFromReq(requestDetail);
        const blockRules = getBlockRules(clientIp);
        // requestDetail.host 是域名+端口的形式
        const host = requestDetail.host.split(":")[0];

        // HTTPS 这里只判断 ip 源和 域名，pathname 和 query 的判断放到beforeSendRequest中

        // 如果是裸IP请求，全部放行
        if (net.isIPv4(host) || net.isIPv6(host)) {
          return false;
        }

        // 如果没有对应ip的匹配规则
        let shouldBlock = shouldBlockHost(host, blockRules, "");
        if (blockRules.length === 0) {
          return false;
        } else if (shouldBlock) {
          console.log('https 拦截', host, '接下来判断是否根据pathname进行拦截');
          // 只对配置中的域名进行 HTTPS 拦截
          return true; // 允许 HTTPS 拦截
        }
        return false; // 不拦截 HTTPS
      },

      // 拦截 HTTP 请求
      async beforeSendRequest(requestDetail) {
        const { url, requestOptions } = requestDetail;
        const clientIp = requestDetail._req?.sourceIp || '127.0.0.1';
        const host = requestDetail.requestOptions.hostname;
        const blockRules = getBlockRules(clientIp);
        const pathname = requestDetail.requestOptions.path?.split('?')[0];;
        const body = requestDetail.requestData;

        // 如果是裸IP请求，全部放行
        if (net.isIPv4(host) || net.isIPv6(host)) {
          return null;
        }

        // 如果是 http 请求，说明是直接访问过来的，没有经过beforeDealHttpsRequest，因此clientIp是真实的
        // 进入到这里的有两种情况：
        //  1. http 协议请求到这里
        //  2. https 协议根据域名需要拦截，转发到这里，功能上可以让所有 https 请求都转发到这里，但涉及到
        //     把 https 拆包，有性能问题，所以 beforeDealHttpsRequest 先根据域名拦截，这里统一做
        //     pathname + 域名 + mac 的拦截

        // 如果当前 IP 没有配置拦截规则，直接放行
        if (blockRules.length === 0) {
          // 如果配置了 vpn_proxy，通过 proxy 转发请求
          if (vpn_proxy != "") {
            const { ip, port } = parseAddress(vpn_proxy);
            const result = await forwardViaLocalProxy(url, requestOptions, body, {
              ip: ip, port: port
            });
            return {
              response: {
                statusCode: result.statusCode,
                header: result.headers,
                body: result.body
              }
            };
          } else {
            // 其他情况一律放行
            return null;
          }
        }
        // 如果当前 IP 有针对域名和 pathname 的规则，则拦截
        if (shouldBlockHost(host, blockRules, pathname)) {
          // 如果是列表中的域名则拦截
          console.log(`拦截到请求: ${host}${pathname}`);
          // 为被拦截的域名返回自定义响应
          // let customBody = `AnyProxy: request to ${host}${pathname} is blocked!`;
          let customBody = 'blocked';
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
        } else if (error.code =="HPE_INVALID_VERSION") {
          // 请求的返回是http 0.0版本：
          // HTTP/0.0 307 Temporary Redirect\r\n
          // Location: https://a.yui.cool:88/\r\n
          // Content-Length: 0\r\n
          // \r\n
          const result = await _request(requestDetail.requestOptions);
          // console.log(result);
          return {
            response: {
              statusCode: result.statusCode,
              header: {
                ...result.headers,
                'x-blockproxy-transfer': "true",
                'x-blockproxy-errorcode':"HPE_INVALID_VERSION"
              },
              body: result.body
            }
          };
        } else if (error.code == "HPE_INVALID_CONTENT_LENGTH" || error.code == "HPE_UNEXPECTED_CONTENT_LENGTH") {
          // HPE_INVALID_CONTENT_LENGTH 是 http 的响应同时包含了 content-length
          // 和 Transfer-Encoding: chunked 时的报错，这类响应不符合 http 的规范
          // AnyProxy 中的 http.request 报此错误。
          // 但为了保证兼容性，对于这类错误的请求也应当转发，只要是浏览器能处理的
          // Proxy 代理就应当转发。因此重写了不校验 header 字段的 _request 方法
          // 重新请求目标资源，并直接返回
          //
          // 这个方法仍可能会有错误，尽管做了转发，由于 content-length 不能保证
          // 完全正确，所以 socket 根据 content-length 截断的时机可能不对，这里
          // 不做更多的报错，一并把错误的结果发给客户端
          const result = await _request(requestDetail.requestOptions);
          return {
            response: {
              statusCode: result.statusCode,
              header: {
                ...result.headers,
                'x-blockproxy-transfer': "true",
                'x-blockproxy-errorcode':"HPE_INVALID_CONTENT_LENGTH"
              },
              body: result.body
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
    throttle: 100000, // 800 Mbps
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
  },
  
  // 代理服务启动，并同时启动定时任务
  init: function() {
    var that = this;
    setTimeout(() => {
      console.log('Dev server started, starting LocalProxy...');
      that.start(async () => {
        await that.updateDevices();
        console.log('local network devices updated!');

        // 设置定时任务，每两小时更新一次设备信息
        setInterval(async () => {
          try {
            await that.updateDevices();
            console.log('Network devices updated automatically every 2 hours');
          } catch (error) {
            console.error('Failed to automatically update network devices:', error);
          }
        }, 2 * 60 * 60 * 1000); // 2小时 = 2 * 60 * 60 * 1000 毫秒
      });
    }, 100);
  }
};
