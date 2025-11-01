// 文件名: proxy.js

const AnyProxy = require('anyproxy');

// Create rule configuration
const options = {
  port: 8001,
  rule: {
    // 将此函数改为 async
    async beforeSendRequest(requestDetail) {
      const host = requestDetail.requestOptions.hostname;
      
      // 检查请求是否发往 baidu.com 或 bilibili.com
      if (host && (host.includes('baidu.com') || host.includes('bilibili.com'))) {
        console.log(`拦截到请求: ${host}${requestDetail.requestOptions.path}`);
        
        // 为被拦截的域名返回自定义响应
        return {
          response: {
            statusCode: 200,
            header: { 'Content-Type': 'text/html' },
            body: `<html><body><h1>请求 ${host} 被代理拦截</h1><p>此请求已被代理服务器阻止。</p></body></html>`
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
    webPort: 8002
  },
  throttle: 10000,
  forceProxyHttps: true,
  wsIntercept: false,
  silent: false
};

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
  const proxyServer = new AnyProxy.ProxyServer(options);
  
  proxyServer.on('ready', () => {
    console.log('Proxy server started on port 8001');
    console.log('Web interface available on port 8002');
    console.log('Intercepting requests to baidu.com and bilibili.com');
    console.log('All other requests will be passed through');
  });
  
  proxyServer.on('error', (e) => {
    console.error('Proxy server error:', e);
  });
  
  proxyServer.start();
}
