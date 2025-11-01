// 文件名: proxy.js

const AnyProxy = require('anyproxy');
const fs = require('fs');
const path = require('path');

// 全局变量存储关键配置参数
let blockHosts = ["baidu.com", "bilibili.com"];
let proxyPort = 8001;
let webInterfacePort = 8002;

// 读取配置文件的函数
function loadConfig() {
  const configPath = path.join(__dirname, '../config.json');
  let config = {
    block_hosts: blockHosts, // 使用全局变量的默认值
    proxy_port: proxyPort,
    web_interface_port: webInterfacePort
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

// 检查主机名是否在拦截列表中
function shouldBlockHost(host) {
  if (!host) return false;
  
  return blockHosts.some(blockedHost => 
    host.includes(blockedHost)
  );
}

// 保存代理服务器实例的变量
let proxyServerInstance = null;

module.exports = {
  start: function() { 
    // 每次启动时都重新加载配置
    const config = loadConfig();
    
    // 更新options配置
    const options = {
      port: proxyPort,
      rule: {
        // 只对特定域名启用 HTTPS 拦截
        async beforeDealHttpsRequest(requestDetail) {
          const host = requestDetail.host;
          // 只对配置中的域名进行 HTTPS 拦截
          if (shouldBlockHost(host)) {
            return true; // 允许 HTTPS 拦截
          }
          return false; // 不拦截 HTTPS
        },
        
        // 拦截 HTTP 请求
        async beforeSendRequest(requestDetail) {
          const host = requestDetail.requestOptions.hostname;
          
          // 检查请求是否发往配置中的域名
          if (shouldBlockHost(host)) {
            console.log(`拦截到请求: ${host}${requestDetail.requestOptions.path}`);
            
            // 为被拦截的域名返回自定义响应
            return {
              response: {
                statusCode: 200,
                header: { 'Content-Type': 'text/html' },
                body: `<html><body><h1>request from ${host} is blocked!</h1><p>blocked..</p></body></html>`
              }
            };
          }
          
          // 允许其他请求通过
          return null;
        },
        
        // 可选：记录所有请求
        async beforeSendResponse(requestDetail, responseDetail) {
          const host = requestDetail.requestOptions.hostname;
          console.log(`请求完成: ${host}${requestDetail.requestOptions.path} - 状态码: ${responseDetail.response.statusCode}`);
          return null;
        }
      },
      webInterface: {
        enable: true,
        webPort: webInterfacePort
      },
      throttle: 10000,
      forceProxyHttps: false, // 关闭全局 HTTPS 拦截
      wsIntercept: false,
      silent: false
    };
    
    // 如果代理服务器已在运行，先停止它
    if (proxyServerInstance && proxyServerInstance.httpProxyServer && proxyServerInstance.httpProxyServer.listening) {
      console.log('Stopping existing proxy server...');
      proxyServerInstance.close(() => {
        console.log('Previous proxy server stopped.');
        startProxyServer();
      });
    } else {
      startProxyServer();
    }
    
    function startProxyServer() {
      // Check if root CA is needed
      if (!AnyProxy.utils.certMgr.ifRootCAFileExists()) {
        AnyProxy.utils.certMgr.generateRootCA((error, keyPath) => {
          if (!error) {
            console.log('Root CA generated successfully, please install the certificate');
            console.log('Certificate path:', keyPath);
          } else {
            console.error('Failed to generate root CA:', error);
          }
        });
      } else {
        // Start proxy server
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

        proxyServerInstance.start();
      }
    }
  },
  restart: function() { 
    // 实现重启功能
    if (proxyServerInstance) {
      console.log('Restarting proxy server...');
      proxyServerInstance.close(() => {
        console.log('Previous proxy server stopped. Starting new one...');
        // 直接调用start方法，它会自动重新加载配置
        this.start();
      });
    } else {
      // 如果没有运行中的实例，直接启动
      this.start();
    }
  }
};