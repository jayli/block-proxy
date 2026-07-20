// 文件名: proxy/proxy.js
const { ProxyServer, utils: { certMgr, certLifecycle } } = require('./proxy-core');
const { exec } = require('child_process');
const fs = require('fs');
const _fs = require('./fs.js');
const path = require('path');
const { start } = require('repl');
const net = require('net');
const scanNetwork = require("./scan").scanNetwork;
const setScanStatus = require("./scan").setScanStatus;
const util = require('util');
const zlib = require('zlib');
const _util = require('../server/util.js');
const os = require('os');
const http = require("http");
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const axios = require('axios');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const _request = require("./http.js").request;
const uaFilter = require("./mitm/uaFilter.js");
const attacker = require('./attacker.js');
const domain = require('./domain.js');
const wanip = require('./wanip.js');
const operator = require("./operator.js");
const mitmRegistry = require("./mitm/registry.js");
const TunnelServer = require('../tunnel/server');
const TunnelManager = require('../tunnel/manager');
let ruleRegistry = mitmRegistry.createRegistry({ config: {} });
let cliRulePath = null;

// Tunnel module-level variables
let tunnelServer = null;
let tunnelManager = null;

// Tunnel TLS 证书路径
function getTunnelCertPaths() {
  // 优先使用命令行参数指定的路径
  if (process.env.TUNNEL_PUBKEY && process.env.TUNNEL_PRIVKEY) {
    return {
      cert: process.env.TUNNEL_PUBKEY,
      key: process.env.TUNNEL_PRIVKEY,
      type: '命令行指定'
    };
  }

  // 默认复用 SOCKS5 证书
  return {
    cert: path.join(__dirname, '../cert/socks5_tls.crt'),
    key: path.join(__dirname, '../cert/socks5_tls.key'),
    type: '复用 SOCKS5 证书 (socks5_tls.crt/key)'
  };
}

// 启用全局 keep-alive，使 AnyProxy 内部转发也复用连接
http.globalAgent.keepAlive = true;
https.globalAgent.keepAlive = true;
// 连接上限 50 应该足够了，设置 100 留足 buffer
http.globalAgent.maxSockets = 100;
https.globalAgent.maxSockets = 100;

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

// 全局参数
const configPath = path.join(__dirname, '../config.json');
var anyproxy_started = false;
var blockHosts = [];
var proxyPort = 8001; // http 代理端口
var socks5Port = 8002; // socks5 端口
var expressPort = 8004; // 管理面板端口

var vpn_proxy = "";
var devices = [];
var progress_time_stamp = "";
var localMac = getLocalMacAddress();
var localIp = getLocalIp();
var network_scanning_status = "0";
var auth_username = "";
var auth_password = "";
var your_domain = "";
var wan_ip = "0.0.0.0";
var is_running_in_docker = false;
var docker_host_IP = '';
var enable_express = "1"; // "0", "1"
var enable_socks5 = "1";
var socks5_tls = "1";

var enable_mitm = "1"; // "0", "1"，是否对 HTTPS 启用 MITM 解密（关闭后纯隧道转发，不拦截）
var mitm_debug_log = "0"; // "0", "1"，是否输出 MITM 调试日志（[DEBUG-REQ] 等）
var chain_proxy_enabled = "0"; // "0", "1"，是否启用下游链式代理
var chain_proxy_type = "http"; // "http" 或 "socks5"
var chain_proxy_address = ""; // 上游代理地址，格式: username:password@host:port 或 host:port
const chainProxyAgentCache = new Map();
// 域名判断，区分浏览器和 App
var filtered_mitm_domains = [
  ...uaFilter.filtered_mitm_domains
];

// 从 registry 获取已启用的规则列表
function getEnabledMitmRules() {
  return ruleRegistry.getEnabledRules();
}

// 判断内置 YouTube MITM 是否启用（UA filter 依赖此判断）
function isBuiltinYoutubeMitmEnabled() {
  return enable_mitm === "1" && ruleRegistry.isBuiltinYoutubeEnabled();
}

// 对于一些流媒体的链接不支持 407 的情况要排除验证
// host 可能携带端口：a.com:443
function authPass(protocol, host, url) {
  // console.log("url:", host, url);
  const passHosts = [
    "googlevideo.com", // Toutube 视频流
    "dns.weixin.qq.com.cn", // 微信的 dns 预解析
    "weixin.qq.com",
    // xiaohongshu.com:443，小红书App和知乎 App 里发起带端口的请求，收到 407 后第二次
    "xiaohongshu.com:443",
    "xiaohongshu.com",
    "xhscdn.com",
    "zhihu.com:443",
    "zhimg.com",
    "zhihu.com",
    //-----千问客户端
    "globalsign.com",
    "quark.cn",
    "qianwen.com",
    "uc.cn",
    "ucweb.com",
    "uc.cmd",
    "alibabausercontent.com",
    "taobao.com",
    "sm.cn",
    "zaodian.com",
    "amap.com",
    "alipay.com",
    "aliyuncs.com",
    ...filtered_mitm_domains
  ];
  //  基于 http 传输的流
  const passUrl = [
    /\.(m3u8|mp4|mpd|ts|webm|avi|mkv)$/i
  ];

  var pass = false;
  // 先检查是否完全比配，即带端口的匹配
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

  // 去掉端口后匹配
  host = trimHost(host);

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


async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// 捕获命令行传入的 rule.js 路径（一次性消费，保持现有行为）
async function loadGlobalConfigFile() {
  cliRulePath = await _fs.getGlobalConfigFile();
  await _fs.clearGlobalConfigFile();
}

// 获取 Docker 挂载目录下的 rule.js 路径
async function getDockerMountedRulePath() {
  const rulePath = path.join(__dirname, '../config/rule.js');
  return await fileExists(rulePath) ? rulePath : null;
}

// 重建规则注册表（每次启动/重启代理服务前调用）
async function rebuildRuleRegistry(config) {
  const dockerRulePath = await getDockerMountedRulePath();
  ruleRegistry = mitmRegistry.createRegistryFromFiles({
    config,
    cliRulePath,
    dockerRulePath
  });
}

function isEmpty(obj) {
  if (obj === null || obj === undefined) {
    return true;
  }
  return Object.keys(obj).length === 0;
}

// 读取配置文件的函数
async function loadConfig() {
  let config = {
    network_scanning_status: network_scanning_status,
    progress_time_stamp: progress_time_stamp,
    block_hosts: blockHosts,
    proxy_port: proxyPort,
    your_domain: your_domain,
    vpn_proxy:"",
    auth_username:"",
    auth_password:"",
    enable_express: enable_express,
    enable_socks5: enable_socks5,
    socks5_tls: socks5_tls,
    socks5_port: socks5Port,
    express_port: expressPort,
    enable_tunnel: "1",
    tunnel_port: 8003,
    tunnel_xhttp_base_path: "/xhttp",
    tunnel_sse_path: "/api/v1/events",
    tunnel_sse_keepalive_min_ms: 35000,
    tunnel_sse_keepalive_max_ms: 45000,
    tunnel_silent_idle_timeout: 3000,
    tunnel_rotation_drain_timeout: 10,
    tunnel_rotation_drain_idle_timeout: 20,
    tunnel_padding: { enabled: false },
    tunnel_domains: [],
    rule_modules: {},
    devices: [],
    chain_proxy_enabled: chain_proxy_enabled,
    chain_proxy_type: chain_proxy_type,
    chain_proxy_address: chain_proxy_address,
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

      enable_express = loadedConfig.enable_express;
      config.enable_express = enable_express;

      enable_socks5 = loadedConfig.enable_socks5;
      config.enable_socks5 = enable_socks5;

      socks5_tls = loadedConfig.socks5_tls || "1";
      config.socks5_tls = socks5_tls;

      enable_mitm = loadedConfig.enable_mitm || "1"; // 默认开启，兼容旧配置文件缺少此字段
      config.enable_mitm = enable_mitm;

      mitm_debug_log = loadedConfig.mitm_debug_log || "0"; // 默认关闭
      config.mitm_debug_log = mitm_debug_log;

      chain_proxy_enabled = loadedConfig.chain_proxy_enabled || "0";
      config.chain_proxy_enabled = chain_proxy_enabled;
      
      chain_proxy_type = loadedConfig.chain_proxy_type || "http";
      config.chain_proxy_type = chain_proxy_type;
      
      chain_proxy_address = loadedConfig.chain_proxy_address || "";
      config.chain_proxy_address = chain_proxy_address;
      clearChainProxyAgentCache();

      config.enable_tunnel = loadedConfig.enable_tunnel || "1";
      config.tunnel_port = loadedConfig.tunnel_port || 8003;
      config.tunnel_xhttp_base_path = loadedConfig.tunnel_xhttp_base_path || "/xhttp";
      config.tunnel_sse_path = loadedConfig.tunnel_sse_path || "/api/v1/events";
      config.tunnel_sse_keepalive_min_ms = loadedConfig.tunnel_sse_keepalive_min_ms || 35000;
      config.tunnel_sse_keepalive_max_ms = loadedConfig.tunnel_sse_keepalive_max_ms || 45000;
      config.tunnel_silent_idle_timeout = loadedConfig.tunnel_silent_idle_timeout || 3000;
      config.tunnel_rotation_drain_timeout = loadedConfig.tunnel_rotation_drain_timeout || 10;
      config.tunnel_rotation_drain_idle_timeout = loadedConfig.tunnel_rotation_drain_idle_timeout || 20;
      config.tunnel_domains = loadedConfig.tunnel_domains || [];

      config.rule_modules = loadedConfig.rule_modules || {};

      socks5Port = loadedConfig.socks5_port;
      config.socks5_port = socks5Port;

      if (loadedConfig.express_port) {
        expressPort = loadedConfig.express_port;
        config.express_port = expressPort;
      }

      your_domain = loadedConfig.your_domain;
      config.your_domain = your_domain;
      
      if (loadedConfig.proxy_port) {
        proxyPort = loadedConfig.proxy_port;
        config.proxy_port = proxyPort;
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
        auth_password:"",
        auth_username:"",
        enable_express: enable_express,
        your_domain: your_domain,
        socks5_port: socks5Port,
        express_port: expressPort,
        enable_socks5: enable_socks5,
        socks5_tls: socks5_tls,
        enable_mitm: enable_mitm,
        mitm_debug_log: mitm_debug_log,
        chain_proxy_enabled: chain_proxy_enabled,
        chain_proxy_type: chain_proxy_type,
        chain_proxy_address: chain_proxy_address,
        enable_tunnel: "1",
        tunnel_port: 8003,
        tunnel_xhttp_base_path: "/xhttp",
        tunnel_rotation_drain_timeout: 10,
        tunnel_rotation_drain_idle_timeout: 20,
        tunnel_padding: { enabled: false },
        tunnel_domains: [],
        rule_modules: {},
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

async function updateWanIp() {
  // var ips = await domain.getDomainIP(your_domain);
  var ip = "0.0.0.0";
  try {
    ip = await wanip.getPublicIp();
  } catch(e) {
    ip = "0.0.0.0";
  }
  if (ip === null) {
    ip = "0.0.0.0";
  }
  wan_ip = ip;
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
  return domain.getLocalIp();
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

function getCertificateFingerprint(filePath) {
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(filePath));
    return cert.fingerprint256;
  } catch (e) {
    return null;
  }
}

function clearGeneratedCertCache(anyproxyDir) {
  if (!fs.existsSync(anyproxyDir)) {
    return;
  }

  for (const fileName of fs.readdirSync(anyproxyDir)) {
    if (fileName === 'rootCA.crt' || fileName === 'rootCA.key') {
      continue;
    }
    const filePath = path.join(anyproxyDir, fileName);
    if (fs.statSync(filePath).isFile()) {
      fs.unlinkSync(filePath);
    }
  }
}

function ensureRootCA(options = {}) {
  const anyproxyDir = options.anyproxyDir || path.join(__dirname, '../certificates');
  const targetCrt = path.join(anyproxyDir, 'rootCA.crt');
  const targetKey = path.join(anyproxyDir, 'rootCA.key');
  const srcCrt = options.srcCrt || path.join(__dirname, '../cert/rootCA.crt');
  const srcKey = options.srcKey || path.join(__dirname, '../cert/rootCA.key');

  if (!fs.existsSync(srcCrt) || !fs.existsSync(srcKey)) {
    return 'missing-source';
  }

  fs.mkdirSync(anyproxyDir, { recursive: true });
  const hasTarget = fs.existsSync(targetCrt) && fs.existsSync(targetKey);
  const srcFingerprint = getCertificateFingerprint(srcCrt);
  const targetFingerprint = hasTarget ? getCertificateFingerprint(targetCrt) : null;
  const shouldReplace = !hasTarget || !srcFingerprint || srcFingerprint !== targetFingerprint;

  if (!shouldReplace) {
    return 'unchanged';
  }

  clearGeneratedCertCache(anyproxyDir);
  fs.copyFileSync(srcCrt, targetCrt);
  fs.copyFileSync(srcKey, targetKey);
  console.log('✅ 已同步 cert/rootCA.* 到 certificates/，并清理旧域名证书缓存');
  return hasTarget ? 'replaced' : 'created';
}

function initCertLifecycle() {
  certLifecycle.init({
    certDir: path.join(__dirname, '../certificates'),
    mitmRegistry: ruleRegistry,
  });
}

async function runHealthCheckAndPrewarm(config = { block_hosts: blockHosts }) {
  try {
    const healthResult = await certLifecycle.healthCheck();
    console.log(`[cert-lifecycle] 健康检查完成: 保留 ${healthResult.kept}, 移除 ${healthResult.removed}`);
  } catch (e) {
    console.error('[cert-lifecycle] 健康检查失败:', e.message);
  }

  try {
    const domains = certLifecycle.getDomainsToPrewarm(config);
    if (domains.length === 0) {
      return { success: 0, fail: 0, total: 0 };
    }

    console.log(`[cert-lifecycle] 开始预热 ${domains.length} 个域名证书...`);
    const prewarmResult = await certLifecycle.prewarmCerts(domains);
    console.log(`[cert-lifecycle] 预热完成: 成功 ${prewarmResult.success}, 失败 ${prewarmResult.fail}`);
    return prewarmResult;
  } catch (e) {
    console.error('[cert-lifecycle] 预热失败:', e.message);
    return { success: 0, fail: 1, total: 0 };
  }
}

function startProxyServer() {
  ensureRootCA();
  initCertLifecycle();
  // Check if root CA is needed
  if (!certMgr.ifRootCAFileExists()) {
    certMgr.generateRootCA((error, keyPath) => {
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
    proxyServerInstance = new ProxyServer(options);

    proxyServerInstance.on('ready', () => {
      console.log(`✅ \x1b[32mHTTP 代理服务启动，IP: ${localIp}, 端口: ${proxyPort}\x1b[0m`);

      if (chain_proxy_enabled === "1" && chain_proxy_address) {
        console.log(`🔗 链式代理已启用: ${chain_proxy_type.toUpperCase()} → ${chain_proxy_address}`);
      }

      // customConnect 已正确传入 proxy-core/request-handler，隧道域名 CONNECT 由核心处理。
      // 不再需要 ready 之后接管 connect 事件。
      runHealthCheckAndPrewarm({ block_hosts: blockHosts }).catch(e => {
        console.error('[cert-lifecycle] 健康检查/预热异常:', e.message);
      });
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

function parseChainProxyAddress(address) {
  if (!address || typeof address !== 'string') {
    return null;
  }
  let username = '', password = '', hostPart = address;
  if (address.includes('@')) {
    const atIndex = address.lastIndexOf('@');
    const authPart = address.substring(0, atIndex);
    hostPart = address.substring(atIndex + 1);
    const colonIndex = authPart.indexOf(':');
    if (colonIndex !== -1) {
      username = authPart.substring(0, colonIndex);
      password = authPart.substring(colonIndex + 1);
    } else {
      username = authPart;
    }
  }
  const lastColon = hostPart.lastIndexOf(':');
  if (lastColon === -1) {
    return null;
  }
  const host = hostPart.substring(0, lastColon);
  const port = parseInt(hostPart.substring(lastColon + 1), 10);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  return { username, password, host, port };
}

function connectViaChainProxy(targetHost, targetPort, chainConfig) {
  return new Promise((resolve, reject) => {
    const { host, port, username, password, type } = chainConfig;
    const upstream = net.connect(port, host, () => {
      if (type === 'socks5') {
        socks5Connect(upstream, targetHost, targetPort, username, password, resolve, reject);
      } else {
        httpConnect(upstream, targetHost, targetPort, username, password, resolve, reject);
      }
    });
    upstream.on('error', reject);
    upstream.setTimeout(15000, () => {
      upstream.destroy(new Error('Chain proxy connect timeout'));
    });
  });
}

function httpConnect(socket, targetHost, targetPort, username, password, resolve, reject) {
  let lines = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
  if (username) {
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    lines += `Proxy-Authorization: Basic ${auth}\r\n`;
  }
  lines += '\r\n';
  let buffer = '';
  const onData = (data) => {
    buffer += data.toString();
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    socket.removeListener('data', onData);
    const statusLine = buffer.substring(0, buffer.indexOf('\r\n'));
    const statusCode = parseInt(statusLine.split(' ')[1], 10);
    if (statusCode === 200) {
      if (buffer.length > headerEnd + 4) {
        const rest = buffer.substring(headerEnd + 4);
        socket.unshift(Buffer.from(rest));
      }
      socket.setTimeout(0);
      resolve(socket);
    } else {
      socket.destroy(new Error(`Chain proxy CONNECT failed: ${statusCode}`));
    }
  };
  socket.on('data', onData);
  socket.write(lines);
}

function socks5Connect(socket, targetHost, targetPort, username, password, resolve, reject) {
  if (Buffer.byteLength(username) > 255 || Buffer.byteLength(password) > 255) {
    socket.destroy(new Error('SOCKS5 username/password too long'));
    return;
  }

  let handshakeStep = 0;
  let buffer = Buffer.alloc(0);
  const onData = (data) => {
    buffer = Buffer.concat([buffer, data]);
    if (handshakeStep === 0) {
      if (buffer.length < 2) return;
      if (buffer[0] !== 0x05 || buffer[1] === 0xFF) {
        socket.destroy(new Error('SOCKS5 handshake rejected'));
        return;
      }
      if (buffer[1] === 0x02) {
        const usernameBytes = Buffer.from(username, 'utf8');
        const passwordBytes = Buffer.from(password, 'utf8');
        const authBytes = Buffer.alloc(3 + usernameBytes.length + passwordBytes.length);
        authBytes[0] = 0x01;
        authBytes[1] = usernameBytes.length;
        usernameBytes.copy(authBytes, 2);
        authBytes[2 + usernameBytes.length] = passwordBytes.length;
        passwordBytes.copy(authBytes, 3 + usernameBytes.length);
        socket.write(authBytes);
        buffer = Buffer.alloc(0);
        handshakeStep = 1;
        return;
      }
      handshakeStep = 2;
      buffer = Buffer.alloc(0);
      sendSocks5Request();
      return;
    }
    if (handshakeStep === 1) {
      if (buffer.length < 2) return;
      if (buffer[0] !== 0x01 || buffer[1] !== 0x00) {
        socket.destroy(new Error('SOCKS5 auth failed'));
        return;
      }
      handshakeStep = 2;
      buffer = Buffer.alloc(0);
      sendSocks5Request();
      return;
    }
    if (handshakeStep === 2) {
      const responseLength = getSocks5ConnectResponseLength(buffer);
      if (responseLength === null) return;
      if (responseLength === -1) {
        socket.destroy(new Error('SOCKS5 CONNECT response has invalid address type'));
        return;
      }
      if (buffer[0] !== 0x05 || buffer[1] !== 0x00) {
        socket.destroy(new Error(`SOCKS5 CONNECT failed: 0x${buffer[1].toString(16)}`));
        return;
      }
      socket.removeListener('data', onData);
      if (buffer.length > responseLength) {
        socket.unshift(buffer.subarray(responseLength));
      }
      socket.setTimeout(0);
      resolve(socket);
    }
  };
  function sendSocks5Request() {
    const hostBytes = Buffer.from(targetHost, 'utf8');
    if (hostBytes.length > 255) {
      socket.destroy(new Error('SOCKS5 target host is too long'));
      return;
    }
    const req = Buffer.alloc(7 + hostBytes.length);
    req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
    req[4] = hostBytes.length;
    hostBytes.copy(req, 5);
    req[5 + hostBytes.length] = (targetPort >> 8) & 0xFF;
    req[6 + hostBytes.length] = targetPort & 0xFF;
    socket.write(req);
  }
  socket.on('data', onData);
  const greeting = username
    ? Buffer.from([0x05, 0x02, 0x00, 0x02])
    : Buffer.from([0x05, 0x01, 0x00]);
  socket.write(greeting);
}

function getSocks5ConnectResponseLength(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return null;
  }

  const atyp = buffer[3];
  if (atyp === 0x01) {
    return buffer.length >= 10 ? 10 : null;
  }
  if (atyp === 0x03) {
    if (buffer.length < 5) return null;
    const domainLength = buffer[4];
    const responseLength = 5 + domainLength + 2;
    return buffer.length >= responseLength ? responseLength : null;
  }
  if (atyp === 0x04) {
    return buffer.length >= 22 ? 22 : null;
  }
  return -1;
}

function getChainProxyAgent(isHttps, chainConfig) {
  const { username, password, host, port, type } = chainConfig;
  const normalizedType = type === 'socks5' ? 'socks5' : 'http';
  const cacheKey = JSON.stringify({
    isHttps: !!isHttps,
    type: normalizedType,
    username,
    password,
    host,
    port,
  });
  if (chainProxyAgentCache.has(cacheKey)) {
    return chainProxyAgentCache.get(cacheKey);
  }

  const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
  const agentOptions = { keepAlive: true, rejectUnauthorized: false };
  let agent;
  if (normalizedType === 'socks5') {
    agent = new SocksProxyAgent(`socks5://${auth}${host}:${port}`, agentOptions);
  } else {
    const agentUrl = `http://${auth}${host}:${port}`;
    agent = isHttps
      ? new HttpsProxyAgent(agentUrl, agentOptions)
      : new HttpProxyAgent(agentUrl, agentOptions);
  }
  chainProxyAgentCache.set(cacheKey, agent);
  return agent;
}

function clearChainProxyAgentCache() {
  for (const agent of chainProxyAgentCache.values()) {
    if (agent && typeof agent.destroy === 'function') {
      agent.destroy();
    }
  }
  chainProxyAgentCache.clear();
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
    proxy: false,
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
  var Ms = getEnabledMitmRules();

  for (const item of Ms) {
    // type 匹配
    // 域名匹配
    // 正则匹配
    if (item['type'].toLowerCase() == type.toLowerCase() &&
            new URL(url).hostname.toLowerCase().endsWith(item['host'].toLowerCase()) &&
            item.compiledRegexp.test(url)) {
      // 只对需要 MITM 的 beforeSendResponse 启用解压缩，确保 MITM 处理的逻辑是解压后的明文
      if (type == "beforeSendResponse" && !isEmpty(response)) {
        try {
          response = await parseResponseFromZippedChunk(response);
        } catch (e) {
          console.log(e);
        }
      }
      responseResult = await item.callback.call(item, url, request, response);
      break;
    } else {
      continue;
    }
  }

  // 要么是重写后的 response 对象，要么是 null
  // beforeSendResponse 中应当返回原 response，应当在 callback 中处理
  return responseResult;
}

// 获得需要重写响应的规则列表，符合规则的则提高chunkSizeThreshold阈值到 20M（默认）以上，来强制整包返回
// 否则就把chunkSizeThreshold阈值调整为 1M，超过阈值就流式返回，提高响应速度
function getResponseRules() {
  var Ms = getEnabledMitmRules();
  var res = [];
  for (const item of Ms) {
    if (item['type'] == "beforeSendResponse") {
      res.push({
        type: item['type'],
        host: item['host'],
        regexp: item['regexp']
      });
    }
  }
  return res;
}

// 为 MITM 处理响应结果 body 的解压缩
// 之前是在 Anyproxy 里做，每个 response 都处理解压缩，目的是为了返回明文，抓包看明文用的，这里没必要
// 只需对 mitm 做解压就可以，其他的不需要解压缩的就完全透给客户端
// requestHandler.js 120 行 request() 里的逻辑
function parseResponseFromZippedChunk(response) {
  return new Promise((resolve, reject) => {
    var resHeader = { ...(response.header || {}) };
    const contentEncoding = resHeader['content-encoding'] || resHeader['Content-Encoding'];
    const ifServerGzipped = /gzip/i.test(contentEncoding);
    const isServerDeflated = /deflate/i.test(contentEncoding);
    const isBrotlied = /br/i.test(contentEncoding);

    const serverResData = response.body ? response.body : Buffer.alloc(0);
    const originContentLen = Buffer.byteLength(serverResData);
    resHeader['x-anyproxy-origin-content-length'] = originContentLen;

    const refactContentEncoding = () => {
      if (contentEncoding) {
        resHeader['x-anyproxy-origin-content-encoding'] = contentEncoding;
        delete resHeader['content-encoding'];
        delete resHeader['Content-Encoding'];
      }
    }

    const formatResponse = (newBody) => {
      return {
        ...response,
        header: resHeader,
        body: newBody,
        // rawBody: rawResChunks,
        // _res: res
      };
    }

    if (ifServerGzipped && originContentLen) {
      refactContentEncoding();
      zlib.gunzip(serverResData, (err, buff) => {
        if (err) {
          reject(err);
        } else {
          resolve(formatResponse(buff));
        }
      });
    } else if (isServerDeflated && originContentLen) {
      refactContentEncoding();
      zlib.inflate(serverResData, (err, buff) => {
        if (err) {
          reject(err);
        } else {
          resolve(formatResponse(buff));
        }
      });
    } else if (isBrotlied && originContentLen) {
      refactContentEncoding();
      zlib.brotliDecompress(serverResData, (err, buff) => {
        if (err) {
          reject(err);
        } else {
          resolve(formatResponse(buff));
        }
      });
    } else {
      resolve(formatResponse(serverResData));
    }
  });
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

// a.com:443 → a.com
function trimHost(host) {
  if (/:\d+$/.test(host)) {
    host = host.split(":")[0];
  }
  return host;
}

// 需要强制拆包的域名从已启用的规则中获得
// host: a.com
//       a.com:443
function shouldMitm(host) {
  host = trimHost(host);
  var should = false;
  var Ms = getEnabledMitmRules();
  var mitm_list = Ms.map(function(item) {
    return item.host;
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

function passRequestWithHttpAgent(requestDetail, isHttps) {
  let agent = isHttps ? httpsAgent : httpAgent;
  if (chain_proxy_enabled === "1" && chain_proxy_address) {
    const chainConfig = parseChainProxyAddress(chain_proxy_address);
    if (chainConfig) {
      chainConfig.type = chain_proxy_type;
      agent = getChainProxyAgent(isHttps, chainConfig);
    }
  }
  return {
    ...requestDetail,
    requestOptions: {
      ...requestDetail.requestOptions,
      agent,
    }
  };
}

async function initTunnel(config) {
  await closeTunnel();

  const enableTunnel = config.enable_tunnel || "1";
  const tunnelPort = config.tunnel_port || 8003;
  if (enableTunnel !== "1") return;

  // 获取证书路径
  const certPaths = getTunnelCertPaths();

  // 如果使用默认 SOCKS5 证书且不存在，则生成
  if (!process.env.TUNNEL_PUBKEY) {
    if (!fs.existsSync(certPaths.cert) || !fs.existsSync(certPaths.key)) {
      const { ensureTempCert } = require('../cert/generator');
      await ensureTempCert('socks5_tls', certPaths.key, certPaths.cert);
    }
  }

  if (!fs.existsSync(certPaths.cert) || !fs.existsSync(certPaths.key)) {
    throw new Error(`Tunnel TLS 证书缺失: ${certPaths.cert} 或 ${certPaths.key}`);
  }

  console.log(`[Tunnel] 使用证书: ${certPaths.type}`);
  const tunnelCert = fs.readFileSync(certPaths.cert);
  const tunnelKey = fs.readFileSync(certPaths.key);
  const tunnelPadding = config.tunnel_padding || {};

  let nextTunnelManager = null;
  const nextTunnelServer = new TunnelServer({
    port: tunnelPort,
    cert: tunnelCert,
    key: tunnelKey,
    credentials: {
      username: config.auth_username,
      password: config.auth_password
    },
    tunnel_xhttp_base_path: config.tunnel_xhttp_base_path || '/xhttp',
    tunnel_sse_path: config.tunnel_sse_path || '/api/v1/events',
    tunnel_sse_keepalive_min_ms: config.tunnel_sse_keepalive_min_ms || 35000,
    tunnel_sse_keepalive_max_ms: config.tunnel_sse_keepalive_max_ms || 45000,
    tunnel_silent_idle_timeout: config.tunnel_silent_idle_timeout || 3000,
    tunnel_rotation_drain_timeout: config.tunnel_rotation_drain_timeout,
    tunnel_rotation_drain_idle_timeout: config.tunnel_rotation_drain_idle_timeout,
    paddingEnabled: tunnelPadding.enabled ?? false,
    paddingProbability: tunnelPadding.probability ?? 0.3,
    paddingMinBytes: tunnelPadding.min_bytes ?? 64,
    paddingMaxBytes: tunnelPadding.max_bytes ?? 512,
    onConnect: (sessionId, token) => {
      if (nextTunnelManager) {
        nextTunnelManager.setConnected(sessionId, true, sessionId.slice(0, 8));
      }
      console.log(`[Tunnel] Client session connected: ${sessionId.slice(0, 8)}`);
    },
    onDisconnect: (sessionId) => {
      if (nextTunnelManager) {
        nextTunnelManager.setConnected(sessionId, false);
      }
      console.log(`[Tunnel] Client session disconnected: ${sessionId ? sessionId.slice(0, 8) : 'unknown'}`);
    }
  });

  nextTunnelManager = new TunnelManager(nextTunnelServer, config);
  nextTunnelServer.setActiveRequestChecker((sessionId) => nextTunnelManager.getSessionDrainState(sessionId));
  tunnelServer = nextTunnelServer;
  tunnelManager = nextTunnelManager;
  await nextTunnelServer.start();
  console.log(`[Tunnel] Server started on port ${tunnelPort}`);
}

async function closeTunnel() {
  if (tunnelServer) {
    const currentTunnelServer = tunnelServer;
    tunnelServer = null;
    tunnelManager = null;
    await currentTunnelServer.stop();
  }
}

function getAnyProxyOptions() {
  return {
    port: proxyPort,
    mitmDebugLog: mitm_debug_log === "1",
    customConnect: async (host, port, callback) => {
      if (tunnelManager && tunnelManager.matchesTunnelDomain(host)) {
        return tunnelManager.forward(host, port, callback);
      }
      if (chain_proxy_enabled === "1" && chain_proxy_address) {
        try {
          const chainConfig = parseChainProxyAddress(chain_proxy_address);
          if (chainConfig) {
            chainConfig.type = chain_proxy_type;
            const conn = await connectViaChainProxy(host, port, chainConfig);
            callback();
            return conn;
          }
        } catch (e) {
          console.error('[ChainProxy] CONNECT failed:', host, port, e.message);
          throw e;
        }
      }
      return null;
    },
    isTunnelDomain: (host) => {
      return tunnelManager && tunnelManager.matchesTunnelDomain(host);
    },
    rule: {
      responseRules: getResponseRules(),
      // 验证 Proxy-Authorization
      // protocol: http, https
      // req: 原始的 Request
      // url: 拆包后的 URL，如果是 Connect 环节校验则为 null
      checkProxyAuth(protocol, req, sourceIp, url) {
        // 如果是 Socks 端口转发的请求，一律放行，身份校验在 Socks 代理做了
        // 这里不用在做一次身份校验了
        if (sourceIp === "127.0.0.1") {
          return true;
        }

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
        // requestDetail.host 可能是以下格式：
        // - 域名:端口     如 example.com:443
        // - IPv4:端口     如 192.168.1.1:443
        // - [IPv6]:端口   如 [2001:db8::1]:443（标准格式）
        // - IPv6:端口     如 240c:409f:1000::4:0:a5:443（非标准格式）
        let host;
        if (requestDetail.host.startsWith("[")) {
          // 标准 IPv6 格式: [2001:db8::1]:443
          const closingBracket = requestDetail.host.indexOf("]");
          if (closingBracket !== -1) {
            host = requestDetail.host.substring(1, closingBracket);
          } else {
            // 异常情况，缺少闭合括号
            host = requestDetail.host;
          }
        } else {
          // 通过最后一个冒号判断是否有端口
          // 如果最后一个冒号后面是纯数字，则认为是端口
          const lastColonIndex = requestDetail.host.lastIndexOf(":");
          if (lastColonIndex !== -1) {
            const possiblePort = requestDetail.host.substring(lastColonIndex + 1);
            if (/^\d+$/.test(possiblePort)) {
              // 最后部分是端口号，取前半部分作为 host
              host = requestDetail.host.substring(0, lastColonIndex);
            } else {
              // 最后部分不是数字，整个字符串都是 host
              host = requestDetail.host;
            }
          } else {
            // 没有冒号，整个字符串就是 host
            host = requestDetail.host;
          }
        }

        // Tunnel domains must stay pure TCP. Never MITM/decrypt them.
        if (tunnelManager && tunnelManager.matchesTunnelDomain(host)) {
          return false;
        }

        // rewrite 规则判断（YouTube 去广告、有道词典 VIP 等）
        // 这些规则需要 MITM 解密 response body，仅在 enable_mitm 开启时生效
        if (enable_mitm == "1" && shouldMitm(host)) {
          return true; // MITM 解密，执行 rewrite 规则
        }

        // 如果是裸IP请求，全部放行
        if (net.isIPv4(host) || net.isIPv6(host)) {
          return false;
        }

        // enable_mitm 关闭时纯隧道转发，不做任何拦截
        if (enable_mitm != "1") {
          return false;
        }

        let shouldBlock = shouldBlockHost(host, blockRules, "");
        if (blockRules.length > 0 && shouldBlock) {
          // 有证书：走 MITM 解密后在 beforeSendRequest 中做完整 URL 路径级过滤
          console.log('https 拦截', host, '接下来判断是否根据 match_rule 进行拦截');
          return true;
        }
        return false; // 不拦截 HTTPS，透明隧道转发
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

        // 如果直接访问当前 IP 的代理端口  http://127.0.0.1:8001
        // 如果请求的目的是自己，防止代理回环
        // 这里没办法穷举，只能约定防火墙里绑定的转发端口和 AnyProxy 的代理端口保持一致
        // 只要不绑定其他端口，就绝对不会陷入回环问题
        const isDocker = is_running_in_docker;
        var myIp = isDocker ? docker_host_IP : localIp;
        if ((myIp.includes(requestOptions.hostname) && requestOptions.port == proxyPort.toString()) ||
          (requestOptions.hostname == your_domain && requestOptions.port == proxyPort.toString()) ||
          (requestOptions.hostname == wan_ip && requestOptions.port == proxyPort.toString()) ||
          // 如果这里收到了 localhost 或 127.0.0.1 的访问，一定是本机访问
          // 其他机器访问 localhost 是不会走远端代理的
          (host == "localhost" || host == "127.0.0.1") 
        ) {
          // Operator
          return await operator.getResponseByPathname(pathname, isDocker, proxyPort);
        }

        // 如果是裸IP请求，全部放行
        if (net.isIPv4(host) || net.isIPv6(host)) {
          return passRequestWithHttpAgent(requestDetail, isHttps);
        }

        // Hack, 根据 UA 判断是否符合放行条件，比如 Youtube 的 MITM 只对 App 生效，则浏览器的 UA 就需要放行
        if (isBuiltinYoutubeMitmEnabled() && uaFilter.match(requestOptions.headers, host)) {
          return passRequestWithHttpAgent(requestDetail, isHttps);
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
            return passRequestWithHttpAgent(requestDetail, isHttps);
          }
        }
        // 如果当前 IP 有针对域名和 url 匹配 matchRule 的规则，则拦截
        if (shouldBlockHost(host, blockRules, url)) {
          // 如果是列表中的域名则拦截
          /// console.log(`[⭕️] ${url}`);
          // 为被拦截的域名返回自定义响应
          let customHosts = filtered_mitm_domains;
          if (customHosts.some(domain => host.endsWith(domain) || host === domain)) {
            // 如果是拦截域名
            return {
              response: {
                statusCode: 200,
                header: {
                  'Content-Type': 'text/html; charset=UTF-8',
                  Pragma: 'no-cache',
                  Expires: 'Fri, 01 Jan 1990 00:00:00 GMT',
                  'Cache-Control': 'no-cache, must-revalidate',
                  'X-Content-Type-Options': 'nosniff',
                  'Server':'Video Stats Server',
                  'Content-Length': 0,
                  'X-XSS-Protection': 0,
                  'X-Frame-Options': 'SAMEORIGIN',
                  'Alt-Svc': 'h3=":443"; ma=2592000,h3-29=":443"; ma=2592000'
                },
                body: Buffer.alloc(0)
              }
            };
          } else {
            // 如果是其他域名
            var customBody = "Blocked by anyproxy."
            return {
              response: {
                statusCode: 200,
                header: {
                  'Content-Type': 'text/plain; charset=UTF-8',
                  'Content-Length': getContentLength(customBody)
                },
                body: customBody
              }
            };
          }
        }

        // 最后做一轮重写逻辑检查
        var rewriteResult = await rewriteRuleBeforeRequest(host, url, _request);
        if (rewriteResult !== false) {
          return rewriteResult;
        }
        /// console.log("[✅] 2 " + url);
        // 如果重写逻辑也不匹配，则请求放行
        return passRequestWithHttpAgent(requestDetail, isHttps);
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
    forceProxyHttps: false, // 关闭全局 HTTPS 拦截
    wsIntercept: false,
    silent: true,
    timeout: 120 * 1000 // 120秒
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
      setScanStatus("0");
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
    // 每次启动时都重新加载配置并重建规则注册表
    const config = await loadConfig();
    await rebuildRuleRegistry(config);
    await initTunnel(config);

    // 如果代理服务器已在运行，先停止它
    if (proxyServerInstance && proxyServerInstance.httpProxyServer && proxyServerInstance.httpProxyServer.listening) {
      proxyServerInstance.close();
      proxyServerInstance = null;
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
    await closeTunnel();
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

    // 加载命令行里携带的配置文件（一次性捕获 CLI rule 路径）
    await loadGlobalConfigFile();

    // 启动时重置 Scan 本地扫描
    setScanStatus("0");

    console.log('启动代理服务');
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
      await updateWanIp();
    }, 2 * 60 * 60 * 1000); // 2小时 = 2 * 60 * 60 * 1000 毫秒

    // 设置定时任务，每2分钟清理一次超过 10 分钟未活动的攻击 IP
    setInterval(async () => {
      attacker.cleanupInactiveIPs();
    }, 2 * 60 * 1000);

    anyproxy_started = true;
  },
  getRuleModules: async function() {
    return ruleRegistry.getRuleModules();
  }
};

module.exports = LocalProxy;

// 测试钩子（仅在测试环境中使用）
module.exports._test = {
  setRuleRegistryForTest(nextRegistry) {
    ruleRegistry = nextRegistry;
  },
  setEnableMitmForTest(nextValue) {
    enable_mitm = nextValue;
  },
  getResponseRules,
  shouldMitm,
  shouldBypassByUa(headers, host) {
    return isBuiltinYoutubeMitmEnabled() && uaFilter.match(headers, host);
  },
  async runMITMHandler(type, url, request, response) {
    return MITMHandler(type, url, request, response);
  },
  ensureRootCA,
  initCertLifecycle,
  runHealthCheckAndPrewarm,
  getCertificateFingerprint,
  parseChainProxyAddress,
  getChainProxyAgent,
  clearChainProxyAgentCache,
  getSocks5ConnectResponseLength,
  getAnyProxyOptions,
  setChainProxyConfigForTest(nextConfig) {
    chain_proxy_enabled = nextConfig.enabled;
    chain_proxy_type = nextConfig.type;
    chain_proxy_address = nextConfig.address;
    clearChainProxyAgentCache();
  }
};
