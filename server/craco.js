// craco 具体的配置，只给开发环境使用
const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function initExpress() {
  const expressPath = path.join(__dirname, '/app.js');

  // 执行命令并获取输出（同步阻塞）
  const output = execSync(`node ${expressPath}`, {
    encoding: 'utf-8',     // 自动将 Buffer 转为字符串
    stdio: 'pipe'          // 默认值，捕获 stdout/stderr
  });
}

module.exports = {
  devServer: (devServerConfig, { env, paths, proxy, allowedHost }) => {

    // 添加自定义代理中间件，模拟Rust中的实现
    devServerConfig.onBeforeSetupMiddleware = (devServer) => {
      // 启动 Express API 服务
      initExpress();

      // get/post /api/config...
      devServer.app.use('/api', async (req, res) => {
        const proxyReq = http.request({
          hostname: 'localhost',
          port: 8003,
          path: '/api' + req.url,  // 关键修改：添加缺失的 /api 前缀
          method: req.method,
          headers: req.headers
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          console.error('Proxy error:', err);
          res.status(500).send('Proxy Error');
        });

        req.pipe(proxyReq);
      });
    };

    // 保存原始的onListening回调（如果存在）
    const originalOnListening = devServerConfig.onListening;
    
    // 在服务监听完成后启动LocalProxy
    devServerConfig.onListening = (devServer) => {
      // 调用原始的onListening（如果存在）
      if (originalOnListening) {
        originalOnListening(devServer);
      }
      
      LocalProxy.init();
    };

    return devServerConfig;
  },
};
