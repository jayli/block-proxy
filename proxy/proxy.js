// 文件名: proxy.js
const AnyProxy = require('anyproxy');
const fs = require('fs');
const _fs = require('./fs.js');
const path = require('path');
const { start } = require('repl');
const net = require('net');
const scanNetwork = require("./scan").scanNetwork;
const util = require('util');
const _util = require('../server/util.js');
const os = require('os');
const http = require("http");
const https = require('https');
const { URL } = require('url');
const axios = require('axios');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const _request = require("./http.js").request;
const Rule = require("./mitm/rule.js");
const attacker = require('./attacker.js');
const monitor = require('./monitor.js');
const domain = require('./domain.js');

// 全局参数
const configPath = path.join(__dirname, '../config.json');
var anyproxy_started = false;
var blockHosts = [];
var proxyPort = 8001;
var webInterfacePort = 8002;
var vpn_proxy = "";
var devices = [];
var progress_time_stamp = "";
var localMac = getLocalMacAddress();
var localIp = getLocalIp();
var network_scanning_status = "0";
var auth_username = "";
var auth_password = "";
var your_domain = "yui.cool";
var yui_cool_ip = "0.0.0.0";
var is_running_in_docker = false;
var docker_host_IP = '';

// 对 Rule 里的正则表达式进行预编译
function preCompileRuleRegexp() {
  Object.keys(Rule).forEach(key => {
    if (Array.isArray(Rule[key])) {
      Rule[key] = Rule[key].map(item => {
        if (typeof item.regexp === 'string' && item.regexp.trim() !== '') {
          try {
              item.compiledRegexp = new RegExp(item.regexp);
          } catch (e) {
              console.error(`Invalid regex in MITM rule: "${item.regexp}", skipping compilation. Error:`, e.message);
              item.compiledRegexp = /^$/; // 或其他处理方式
          }
        }
        return item;
      });
    }
  });
}

// 读取配置文件的函数
async function loadConfig() {
  let config = {
    network_scanning_status: network_scanning_status,
    progress_time_stamp: progress_time_stamp,
    block_hosts: blockHosts,
    proxy_port: proxyPort,
    web_interface_port: webInterfacePort,
    vpn_proxy:"",
    auth_username:"",
    auth_password:"",
    devices: []
  };

  try {
    if (fs.existsSync(configPath)) {
      const loadedConfig = await _fs.readConfig();
      
      // 更新全局变量
      if (loadedConfig.block_hosts) {
        // 原始信息
        config.block_hosts = [...loadedConfig.block_hosts];
        // 缓存正则表达式
        blockHosts = loadedConfig.block_hosts.map(item => {
          // 如果是对象格式且包含 filter_match_rule，则预编译正则
          if (typeof item === 'object' && item.filter_match_rule && item.filter_match_rule.trim() !== '') {
            try {
              // 预编译正则表达式
              item.compiledFilterRegexp = new RegExp(item.filter_match_rule);
            } catch (e) {
              console.error(`Invalid regex in block rule: "${item.filter_match_rule}", skipping compilation. Error:`, e.message);
              // 如果正则无效，可以设置一个永远不匹配的正则，或者标记此项无效
              item.compiledFilterRegexp = /^$/; // 一个永远不匹配非空字符串的正则
              // 或者 item.compiledFilterRegexp = null; 然后在 shouldBlockHost 中检查 if (!blockItem.compiledFilterRegexp) return false;
            }
          }
          return item;
        });
      }

      vpn_proxy = loadedConfig.vpn_proxy;
      config.vpn_proxy = vpn_proxy;

      auth_username = loadedConfig.auth_username;
      config.auth_username = auth_username;

      auth_password = loadedConfig.auth_password;
      config.auth_password = auth_password;

      progress_time_stamp = loadedConfig.progress_time_stamp;
      config.progress_time_stamp = progress_time_stamp;

      network_scanning_status = loadedConfig.network_scanning_status;
      config.network_scanning_status = network_scanning_status;
      
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
      
    } else {
      // 如果配置文件不存在，则创建默认配置文件
      _fs.writeConfig({
        network_scanning_status:network_scanning_status,
        progress_time_stamp: progress_time_stamp,
        block_hosts: blockHosts,
        proxy_port: proxyPort,
        web_interface_port: webInterfacePort,
        auth_password:"",
        auth_username:"",
        vpn_proxy: ""
      });
      // fs.writeFileSync(configPath, JSON.stringify({
      // }, null, 2));
      console.log('Created default config.json file');
    }
  } catch (err) {
    console.error('Error reading config file, using default config:', err);
  }
  
  return config;
}

async function updateYuiCoolIp() {
  var ips = await domain.getDomainIP(your_domain);
  var ip;
  if (ips !== null) {
    ip = ips[0];
  } else {
    ip = "0.0.0.0";
  }
  yui_cool_ip = ip;
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

// 检查是否应当拦截 host & match_rule & url
// match_rule 为空，只拦截 host
// url 不为空，域名和 url 同时匹配时拦截
// url 为空，匹配域名拦截
function shouldBlockHost(host, blockList, url) {
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
      
      // 在传入 url 的情况下检查路径名是否匹配（新增功能）
      if (url != "" && blockItem.filter_match_rule && blockItem.filter_match_rule.trim() !== '') {
        // 匹配拦截规则，拦截
        if (blockItem.compiledFilterRegexp && blockItem.compiledFilterRegexp.test(url)) { // 优化后
          // do nothing
        } else { // 不匹配拦截规则，不拦截
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

// 获得 body 的长度，入参可以是Buffer也可以是字符串
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

// 得到本机 Mac 地址
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
      console.log(`✅ Proxy server started on port ${proxyPort}`);
      console.log(`✅ Web interface available on port ${webInterfacePort}`);
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

// 暂时只支持 IPv4
function getRemoteAddressFromReq(requestDetail) {
  var rawIP = requestDetail?._req?.client?.remoteAddress;
  if (rawIP === undefined) {
    return "0.0.0.0";
  } else {
    return normalizeIP(rawIP);
  }
}

// 获得 Symbol 实例的属性
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

// "192.168.1.1:8001" → { ip, port }
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
  // const protocol = isHttps ? 'https:' : 'http:'; // 这行没用到，可以删掉
  // const hostname = requestOptions.hostname || requestOptions.host; // 这行没用到，可以删掉
  // const port = requestOptions.port || (isHttps ? 443 : 80); // 这行没用到，可以删掉
  // const path = requestOptions.path || '/'; // 这行没用到，可以删掉
  const proxyUrl = `http://${proxyConfig.ip}:${proxyConfig.port}`;
  const agentOptions = {
    keepAlive: true,
    rejectUnauthorized: false // 忽略 SSL 证书错误
  };
  const agent = isHttps ? new HttpsProxyAgent(proxyUrl, agentOptions) : new HttpProxyAgent(proxyUrl, agentOptions);

  // 注意：url 已包含 query string（如 /search?q=1）
  var targetUrl = url;
  // const parsedTargetUrl = new URL(targetUrl); // 这行没用到，可以删掉
  const finalHeaders = { ...requestOptions.headers };
  // finalHeaders['host'] = hostname; // 通常不需要手动设置 Host，axios/http(s) 会根据 URL 自动设置。删除这行。

  // 准备 axios 配置
  const axiosConfig = {
    url: targetUrl,
    method: requestOptions.method || 'GET',
    headers: finalHeaders,
    data: body, // 确保 body 是 Buffer 或其他 Axios 支持的格式 (String, Stream)
    httpAgent: agent,
    httpsAgent: agent,
    responseType: 'stream', // 正确处理二进制响应
    maxRedirects: 21
    // validateStatus: () => true, // 如果你想自己处理所有状态码，取消注释
  };

  try {
    // console.log('---------------------->');
    // console.log(targetUrl, finalHeaders['accept']);
    const response = await axios(axiosConfig);

    // 将响应流读取为 Buffer
    const chunks = [];
    for await (const chunk of response.data) {
      chunks.push(chunk);
    }
    const responseBody = Buffer.concat(chunks);

    // console.log('<-----------------------');
    // console.log(targetUrl, response.status, response.headers);

    return {
      statusCode: response.status,
      headers: response.headers,
      body: responseBody // 返回 Buffer
    };
  } catch (error) {
    if (error.code === "ERR_BAD_RESPONSE") {
      return {
        statusCode: error.response?.status,
        headers: error.response?.headers,
        body: error.response?.statusText // 返回错误响应的 Buffer 体
      };
    } else if (error.response) {
      // 服务器返回了错误状态码（如 4xx, 5xx）
      // 错误响应体也可能是二进制 (Protobuf)
      let errorResponseBody = Buffer.alloc(0); // 初始化为空 Buffer

      if (error.response.data) {
        // Axios 在 responseType: 'stream' 时，即使出错，error.response.data 也可能是一个 Stream
        if (error.response.data.readable === true) { // 检查是否是可读流
          const errorChunks = [];
          try {
            for await (const chunk of error.response.data) {
              errorChunks.push(chunk);
            }
            errorResponseBody = Buffer.concat(errorChunks);
          } catch (streamErr) {
            console.error("Error reading error response stream:", streamErr);
            // 即使读取出错，我们也返回已收集的部分或空 Buffer
            errorResponseBody = Buffer.concat(errorChunks); // 尽力而为
          }
        } else if (typeof error.response.data === 'string') {
          // 理论上在 responseType: 'stream' 下不太可能出现这种情况，但以防万一
          errorResponseBody = Buffer.from(error.response.data, 'utf-8');
        } else if (Buffer.isBuffer(error.response.data)) {
          // 如果 Axios 以某种方式直接给了 Buffer (不太常见)
          errorResponseBody = error.response.data;
        }
        // 如果都不是，则保持 errorResponseBody 为空 Buffer
      }

      return {
        statusCode: error.response.status,
        headers: error.response.headers,
        body: errorResponseBody // 返回错误响应的 Buffer 体
      };
    }

    // 网络错误（如 ECONNREFUSED, ETIMEDOUT）
    console.error("Network error in forwardViaLocalProxy:", error.message);
    throw error; // 重新抛出网络错误，让上游处理
  }
}

// Rule 里的匹配规则在这里被依次处理
// type: beforeSendResponse 和 beforeSendRequest
// 常规的 reject - 200 直接在后台界面里配就可以，复杂逻辑用 Rule
async function MITMHandler(type, url, request, response) {
  var responseResult = null;
  var Ms = [];

  Object.keys(Rule).forEach(key => {
    Ms = Ms.concat(Rule[key]);
  });

  for (const item of Ms) {
    // type 匹配
    // 域名匹配
    // 正则匹配
    if (item['type'].toLowerCase() == type.toLowerCase() &&
            new URL(url).hostname.toLowerCase().endsWith(item['host'].toLowerCase()) &&
            item.compiledRegexp.test(url)) {
            // new RegExp(item['regexp']).test(url)) {
      responseResult = await item.callback(url, request, response);
      break;
    } else {
      continue;
    }
  }

  // 要么是重写后的 response 对象，要么是 null
  // beforeSendResponse 中应当返回原 response，应当在 callback 中处理
  return responseResult;
}

async function rewriteRuleBeforeResponse(host, url, request, response) {
  var responseResult = null;
  responseResult = await MITMHandler('beforeSendResponse', url, request, response);
  if (responseResult === null) {
    return false;
  } else {
    return responseResult;
  }
}

async function rewriteRuleBeforeRequest(host, url, request) {
  var responseResult = null;
  responseResult = await MITMHandler('beforeSendRequest', url, request, {});
  if (responseResult === null) {
    return false;
  } else {
    return responseResult;
  }
}

// 需要强制拆包的域名从 Rule 里获得
// host: a.com
//       a.com:443
function shouldMitm(host) {
  if (/:\d+$/.test(host)) {
    host = host.split(":")[0];
  }
  var should = false;
  var mitm_list = [];
  Object.keys(Rule).forEach(key => {
    if (Rule.hasOwnProperty(key)) {
      Rule[key].forEach(function(item) {
        mitm_list.push(item.host);
      });
    }
  });

  var MITM_LIST = [...new Set(mitm_list)];
  MITM_LIST.some(function(item) {
    if (host.toLowerCase().endsWith(item.toLowerCase())) {
      should = true;
      return true;
    } else {
      return false;
    }
  });
  return should;
}

// 监听 progress_time_stamp 是否有变化，有的话就重启代理服务
var oldTimeStamp = progress_time_stamp;
var restartTimer = null;
function restartProxyListener() {
  fs.watch(configPath, async (eventType, filename) => {
    var newConfig = await loadConfig();
    var newTimeStamp = newConfig.progress_time_stamp;
    if (newTimeStamp === oldTimeStamp) {
      return false;
    } else {
      // 防止重复启动
      if (restartTimer == null) {
        restartTimer = setTimeout(async () => {
          await LocalProxy.restart(() => {});
          restartTimer = null;
        }, 200);
      }
      oldTimeStamp = newTimeStamp;
    }
  });
}

// 将 rawHeaders 转换为对象的辅助函数
function parseHeaders(rawHeaders) {
  const headers = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const key = rawHeaders[i].toLowerCase(); // 转换为小写以匹配标准
    const value = rawHeaders[i + 1];
    headers[key] = value;
  }
  return headers;
}

function getProxyAuthConfig() {
  return {
    auth_username,
    auth_password
  };
}

// 对于一些流媒体的链接不支持 407 的情况要排除验证
// host 可能携带端口：a.com:443
function authPass(protocol, host, url) {
  const passHosts = [
    "googlevideo.com", // Toutube 视频流
    "dns.weixin.qq.com.cn" // 微信的 dns 预解析
  ];
  //  基于 http 传输的流
  const passUrl = [
    /\.(m3u8|mp4|mpd|ts|webm|avi|mkv)$/i
  ];

  if (/:\d+$/.test(host)) {
    host = host.split(":")[0];
  }

  var pass = false;

  // 检查流媒体域名的排除项
  passHosts.some(function(item) {
    if (host.toLowerCase().endsWith(item.toLowerCase())) {
      pass = true;
      return true;
    } else {
      return false;
    }
  });

  if (pass) {
    return pass;
  }

  // 检查流媒体类型的排除项
  if (url != null) {
    passUrl.some(function(item) {
      if (item.test(url)) {
        pass = true;
        return true;
      } else {
        return false;
      }
    });
  }

  return pass;
}

function getAnyProxyOptions() {
  return {
    port: proxyPort,
    rule: {
      // 验证 Proxy-Authorization
      // protocol: http, https
      // req: 原始的 Request
      // url: 拆包后的 URL，如果是 Connect 环节校验则为 null
      checkProxyAuth(protocol, req, sourceIp, url) {
        const authConfig = getProxyAuthConfig();
        if (authConfig.auth_username === undefined) {
          console.log("authConfig.auth_username 为空，检查下 config.json 完整性");
        }
        const expectedUser = authConfig.auth_username;
        const expectedPass = authConfig.auth_password;
        // 如果 auth_username 为空，则始终验证通过
        if (expectedUser === "") {
          return true;
        }

        // 恶意扫描 IP 始终拒绝
        if (sourceIp != "127.0.0.1" &&
          sourceIp != "255.255.255.254" &&
          !sourceIp.startsWith("192.168.") &&
          attacker.isBadGuy(sourceIp)) {
          console.log('[🚫]>> 拦截 badguy', sourceIp);
          return this.sendAuthRequired();
        }

        const headers = parseHeaders(req.rawHeaders);

        // 对于一些特殊情况需要放行的
        if (authPass(protocol, headers.host, url)) {
          attacker.setGoodGuy(sourceIp);
          return true;
        }

        const authHeader = headers['proxy-authorization'];

        // Hack:
        // xiaohongshu.com:443，小红书App和知乎 App 里发起带端口的请求，收到 407 后第二次
        // 请求不会带上authentication，这是 App 的 bug，为了避免功能不可用，这里统一 Hack 掉。
        if (/:\d+$/ig.test(headers['host'])) {
          return true;
        }

        if (!authHeader || !authHeader.startsWith('Basic ')) {
          return this.sendAuthRequired();
        }

        const credentials = authHeader.substring(6); // 去掉 'Basic ' 前缀
        let decoded;
        try {
          decoded = Buffer.from(credentials, 'base64').toString('utf8');
        } catch (e) {
          return this.sendAuthRequired();
        }

        const [user, pass] = decoded.split(':');
        if (user !== expectedUser || pass !== expectedPass) {
          return this.sendAuthRequired();
        }

        attacker.setGoodGuy(sourceIp);
        return true; // 验证通过
      },

      // 返回 407 Proxy Authentication Required
      sendAuthRequired() {
        var body = "Proxy authentication required..";
        return {
          response: {
            statusCode: 407,
            header: {
              'Proxy-Authenticate': 'Basic realm="AnyProxy Secure Proxy"',
              'Connection': 'close',
              'Content-Length': getContentLength(body)
            },
            body: body
          }
        };
      },

      send407bySocket(socket, sourceIp) {
        // 拒绝一次记录一次
        var counter = attacker.countIPAccess(sourceIp);

        var body = "Proxy authentication required.";
        const response407 = [
          'HTTP/1.1 407 Proxy Authentication Required',
          'Proxy-Authenticate: Basic realm="AnyProxy Secure Proxy"',
          'Content-Type: text/plain; charset=utf-8',
          'Content-Length: ' + getContentLength(body), // 'Proxy authentication required.'.length
          'Connection: close', // 明确指示关闭连接
          '', // 空行表示头部结束
          body // 响应体
        ].join('\r\n');
        const clientSocket = socket; // 获取原始客户端 socket
        clientSocket.write(response407, () => {
          clientSocket.destroy(); // 确保 write 完成后再关闭
        });
      },
      // 只对特定域名启用 HTTPS 拦截，无规则时直接四层转发
      async beforeDealHttpsRequest(requestDetail, next) {
        const clientIp = getRemoteAddressFromReq(requestDetail);
        // 如果配置了 vpn_proxy，全部走解密逻辑，仅调试使用
        if (vpn_proxy != "" && vpn_proxy !== undefined) {
          return true;
        }

        var authResult = this.checkProxyAuth('https', requestDetail._req, clientIp, null);

        if (authResult !== true) {
          // 认证失败，立即发送 407 并关闭连接
          this.send407bySocket(requestDetail._req.socket, clientIp);
          return false; // 兜底逻辑，阻止调用 beforeSendRequest
        }

        const blockRules = getBlockRules(clientIp);
        // requestDetail.host 是域名+端口的形式
        const host = requestDetail.host.split(":")[0];

        // rewrite 规则判断
        if (shouldMitm(host)) {
          return true; // 强制 MITM
        }

        // HTTPS 这里只判断 ip 源和域名
        // 域名不匹配的就直接转发
        // 域名匹配的情况下，再去看 match_rule 的判断，放到 beforeSendRequest 中

        // 如果是裸IP请求，全部放行
        if (net.isIPv4(host) || net.isIPv6(host)) {
          return false;
        }

        // 如果没有对应ip的匹配规则
        let shouldBlock = shouldBlockHost(host, blockRules, "");
        if (blockRules.length === 0) {
          return false;
        } else if (shouldBlock) {
          console.log('https 拦截', host, '接下来判断是否根据 match_rule 进行拦截');
          // 只对配置中的域名进行 HTTPS 拦截
          return true; // 允许 HTTPS 拦截
        }
        return false; // 不拦截 HTTPS
      },

      // 拦截 HTTP 请求以及 HTTPS 拆包的请求
      async beforeSendRequest(requestDetail) {
        const { url, requestOptions } = requestDetail;
        const clientIp = requestDetail._req?.sourceIp || '127.0.0.1';
        const host = requestDetail.requestOptions.hostname;
        const blockRules = getBlockRules(clientIp);
        const pathname = requestDetail.requestOptions.path?.split('?')[0];;
        const body = requestDetail.requestData;
        const isHttps = url.startsWith('https:') ? true : false;
        const isHttp = !isHttps;

        // 如果直接访问当前 IP 的代理端口
        // 如果请求的目的是自己，防止代理回环
        // 这里没办法穷举，只能约定防火墙里绑定的转发端口和 AnyProxy 的代理端口保持一致
        // 只要不绑定其他端口，就绝对不会陷入回环问题
        const isDocker = is_running_in_docker;
        var myIp = isDocker ? docker_host_IP : localIp;
        if ((myIp.includes(requestOptions.hostname) && requestOptions.port == proxyPort.toString()) ||
          (requestOptions.hostname == your_domain && requestOptions.port == proxyPort.toString()) ||
          (requestOptions.hostname == yui_cool_ip && requestOptions.port == proxyPort.toString())
        ) {
          return {
            response: {
              statusCode: 200,
              header: { 'Content-Type': 'text/plain; charset=utf-8' },
              body: await monitor.getSystemMonitorInfo(proxyPort)
            }
          };
        }

        // 如果是裸IP请求，全部放行
        if (net.isIPv4(host) || net.isIPv6(host)) {
          return null;
        }

        // 这里验证只能处理 HTTP 请求，HTTPs 里 _req 携带的请求头是不包含验证字段的，因为
        // https 内的 header 是五层信息，proxy-Authenticate 信息属于四层，这里看不到
        if (isHttp) {
          var authResult = this.checkProxyAuth('http',requestDetail._req, clientIp, url);
          if (authResult === true) {
            // 验证通过，do Nothing
          } else {
            // 验证不通过，返回 407
            this.send407bySocket(requestDetail._req.socket, clientIp);
            return authResult; // 兜底逻辑，强制返回
          }
        }

        var _request      = { ...requestDetail.requestOptions };
        _request.host     = requestDetail.requestOptions.hostname;
        _request.url      = requestDetail.url;
        _request.body     = requestDetail.requestData;
        _request.protocol = requestDetail.protocol;

        // 如果是 http 请求，没有经过 beforeDealHttpsRequest，因此clientIp是真实的
        // 执行逻辑：
        //  1. http 协议请求到这里
        //  2. https 协议根据域名需要拦截，转发到这里，到这里已经完成了拆包
        //     这里统一做：域名 + match_rule + mac 的拦截和重写
        //  3. 在拦截之后，判断是否匹配重写规则，有则执行重写规则
        //  4. 开启 vpn_proxy 时，所有请求都走这里，主要是方便调试用，正是环境不要打开 vpn_proxy

        // 如果当前 IP 没有配置拦截规则，检查重写逻辑并判断直接放行
        if (blockRules.length === 0) {
          // 先匹配重写规则
          var rewriteResult = await rewriteRuleBeforeRequest(host, url, _request);
          if (rewriteResult !== false) {
            return rewriteResult;
          } else if (vpn_proxy != "" && vpn_proxy !== undefined) {
            // 如果配置了 vpn_proxy，不匹配拦截的情况，所有请求都通过 proxy 做七层转发
            // TODO: 需要调试所有请求转发的失败的情况，所有请求都应该转发成功
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
            /// console.log("[✅] 1 " + url);
            return null;
          }
        }
        // 如果当前 IP 有针对域名和 url 匹配 matchRule 的规则，则拦截
        if (shouldBlockHost(host, blockRules, url)) {
          // 如果是列表中的域名则拦截
          /// console.log(`[⭕️] ${url}`);
          // 为被拦截的域名返回自定义响应
          let customHosts = ["youtube.com","googlevideo.com"];
          let customBody = customHosts.some(domain => host.endsWith(domain) || host === domain) ?
                                           Buffer.alloc(0) : "Blocked by AnyProxy";
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

        // 最后做一轮重写逻辑检查
        var rewriteResult = await rewriteRuleBeforeRequest(host, url, _request);
        if (rewriteResult !== false) {
          return rewriteResult;
        }
        /// console.log("[✅] 2 " + url);
        // 如果重写逻辑也不匹配，则请求放行
        return null;
      },

      async beforeSendResponse(requestDetail, responseDetail) {
        /// console.log(`[↩️] ${requestDetail.url}`);
        const host = requestDetail.requestOptions.hostname;

        var _request = { ...requestDetail.requestOptions };
        _request.host = requestDetail.requestOptions.hostname;
        _request.url = requestDetail.url;
        _request.body = requestDetail.requestData;
        _request.protocol = requestDetail.protocol;

        var rewriteResult = await rewriteRuleBeforeResponse(host, requestDetail.url, _request, responseDetail.response);
        if (rewriteResult !== false) {
          return rewriteResult;
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
        } else if (error.code == "ENOTFOUND") {
          // DNS 请求出错
          return {
            response: {
              statusCode: 502,
              header: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Connection': 'close',
                'x-blockproxy-errorcode':"ENOTFOUND"
              },
              body: 'DNS_PROBE_FINISHED_NXDOMAIN, DNS lookup error.'
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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

var LocalProxy = {
  updateDevices: async function() {
    var configData = await loadConfig();
    var oldRouterMap = configData.devices || []; // 确保旧路由表是数组
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

    _fs.writeConfig({
      ...configData,
      devices: mergedRouterMap
    });
    // fs.writeFileSync(configPath, JSON.stringify({
    // }, null, 2));
    devices = mergedRouterMap;
    console.log('Devices updated!');
  },
  start: async function(callback) { 
    // 每次启动时都重新加载配置
    const config = await loadConfig();
    
    // 如果代理服务器已在运行，先停止它
    if (proxyServerInstance && proxyServerInstance.httpProxyServer && proxyServerInstance.httpProxyServer.listening) {
      proxyServerInstance.close();
      await delay(1000);
      console.log('重新启动代理服务器');
      startProxyServer();
      if (typeof callback === 'function') {
        callback();
      }
    } else {
      startProxyServer();
      if (typeof callback === 'function') {
        callback();
      }
    }
  },
  restart: async function(callback) { 
    // 实现重启功能
    if (proxyServerInstance) {
      console.log('Restarting proxy server...');
      proxyServerInstance.close();
      await delay(1000);
      console.log('重新启动代理服务器');
      await this.start(callback);
    } else {
      // 如果没有运行中的实例，直接启动
      await this.start(callback);
    }
  },
  
  // 代理服务启动，并同时启动定时任务
  init: async function() {
    var that = this;
    if (anyproxy_started === true) {
      console.log('代理服务已经启动，跳过 LocalProxy.init() ');
      return;
    }

    console.log('启动代理服务 LocalProxy.init() ');
    console.log('Dev server started, starting LocalProxy...');
    is_running_in_docker = _util.isRunningInDocker();
    if (is_running_in_docker) {
      try {
        docker_host_IP = _util.getDockerHostIP();
      } catch (e) {
        docker_host_IP = getLocalIp();
      }
    }
    await that.start(() => {});
    await that.updateDevices();
    console.log('local network devices updated!');
    await delay(1000);
    // restartProxyListener();
    // 设置定时任务，每两小时更新一次设备信息
    setInterval(async () => {
      try {
        await that.updateDevices();
        console.log('Network devices updated automatically every 2 hours');
      } catch (error) {
        console.error('Failed to automatically update network devices:', error);
      }
      await updateYuiCoolIp();
    }, 2 * 60 * 60 * 1000); // 2小时 = 2 * 60 * 60 * 1000 毫秒

    // 设置定时任务，每2分钟清理一次超过 10 分钟未活动的攻击 IP
    setInterval(async () => {
      attacker.cleanupInactiveIPs();
    }, 2 * 60 * 1000);

    anyproxy_started = true;
  }
};

// 预编译 MITM Rule 的正则
(function() {
  preCompileRuleRegexp();
})();

module.exports = LocalProxy;
