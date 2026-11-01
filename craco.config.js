// craco 具体的配置，只给开发环境使用
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// 从 config.json 读取 Express 端口
const configPath = path.join(__dirname, 'config.json');
let expressPort = 8004; // 默认值
if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expressPort = config.express_port || expressPort;
  } catch (e) {
    console.warn('[craco] Failed to read config.json, using default express_port:', expressPort);
  }
}

module.exports = {
  devServer: (devServerConfig, { env, paths, proxy, allowedHost }) => {

    devServerConfig.onBeforeSetupMiddleware = (devServer) => {

      // get/post /api/config...
      // 8004 面板固定跑 HTTPS（自签证书），所以这里必须用 https 并忽略证书校验，
      // 否则 dev 模式下所有 /api 转发都会因 TLS 握手失败而打不开数据。
      devServer.app.use('/api', async (req, res) => {
        const proxyReq = https.request({
          hostname: 'localhost',
          port: expressPort,
          path: '/api' + req.url,  // 关键修改：添加缺失的 /api 前缀
          method: req.method,
          headers: req.headers,
          rejectUnauthorized: false
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

    /*
    // 保存原始的onListening回调（如果存在）
    const originalOnListening = devServerConfig.onListening;
    
    // 在服务监听完成后启动LocalProxy
    devServerConfig.onListening = (devServer) => {
      // 调用原始的onListening（如果存在）
      if (originalOnListening) {
        originalOnListening(devServer);
      }
      
      // LocalProxy.init();
    };
    */

    return devServerConfig;
  },
};
