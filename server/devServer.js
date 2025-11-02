// devServer.js
const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const LocalProxy = require('../proxy/proxy');

// 检测是否在 Docker 环境中运行
function isRunningInDocker() {
  // 方法1: 检查 /.dockerenv 文件是否存在
  try {
    fs.accessSync('/.dockerenv', fs.constants.F_OK);
    return true;
  } catch (err) {
    // 文件不存在，继续检查其他方法
  }

  // 方法2: 检查 /proc/1/cgroup 文件中是否包含 docker 相关信息
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    if (cgroup.includes('docker') || cgroup.includes('containerd')) {
      return true;
    }
  } catch (err) {
    // 文件不存在或无法读取
  }

  // 方法3: 检查环境变量
  if (process.env.DOCKER === 'true' || process.env.CONTAINER === 'docker') {
    return true;
  }

  // 方法4: 检查挂载信息
  try {
    const mounts = fs.readFileSync('/proc/mounts', 'utf8');
    if (mounts.includes('docker')) {
      return true;
    }
  } catch (err) {
    // 文件不存在或无法读取
  }

  return false;
}

module.exports = {
  devServer: (devServerConfig, { env, paths, proxy, allowedHost }) => {
    // recorderManager.updateAll();
    LocalProxy.start();

    // 添加自定义代理中间件，模拟Rust中的实现
    devServerConfig.onBeforeSetupMiddleware = (devServer) => {

      function extractTrailingHttpUrl(str) {
        const regex = /\/proxy\/(http|https):\/\/.+$/;
        const match = str.match(regex);
        if (!match) {
          return null;
        } else {
          const mixed_url = match[0];
          const url = mixed_url.replace(/^\/proxy\//,'');
          return url;
        }
      }

      // 获取服务器IP地址接口
      devServer.app.get('/api/server-ip', async (req, res) => {
        try {
          const interfaces = os.networkInterfaces();
          const ipAddresses = [];
          
          // 遍历所有网络接口
          for (const interfaceName in interfaces) {
            const interface = interfaces[interfaceName];
            for (const iface of interface) {
              // 过滤掉内部地址和IPv6地址
              if (!iface.internal && iface.family === 'IPv4') {
                ipAddresses.push({
                  interface: interfaceName,
                  address: iface.address,
                  family: iface.family,
                  mac: iface.mac
                });
              }
            }
          }
          
          res.status(200).json({
            ips: ipAddresses,
            primary: ipAddresses.length > 0 ? ipAddresses[0].address : null,
            docker: isRunningInDocker() // 添加 Docker 环境信息
          });
        } catch (error) {
          res.status(500).json({ error: 'Failed to get server IP addresses: ' + error.message });
        }
      });

      // 获取配置接口
      devServer.app.get('/api/config', async (req, res) => {
        try {
          const configPath = path.join(__dirname, '../config.json');
          if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            res.status(200).json(config);
          } else {
            res.status(404).json({ error: 'Config file not found' });
          }
        } catch (error) {
          res.status(500).json({ error: 'Failed to read config file' });
        }
      });

      // 更新配置接口
      devServer.app.post('/api/config', async (req, res) => {
        try {
          let body = '';
          req.on('data', chunk => {
            body += chunk.toString();
          });
          req.on('end', () => {
            try {
              const newConfig = JSON.parse(body);
              const configPath = path.join(__dirname, '../config.json');
              fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
              res.status(200).json({ message: 'Config updated successfully' });
            } catch (err) {
              res.status(400).json({ error: 'Invalid JSON or write error: ' + err.message });
            }
          });
        } catch (error) {
          res.status(500).json({ error: 'Failed to update config' });
        }
      });

      // 重启代理接口
      devServer.app.post('/api/restart', async (req, res) => {
        try {
          // 调用本地代理的重启方法
          LocalProxy.restart(function() {
            res.status(200).json({ message: 'Proxy restarted successfully' });
          });
        } catch (error) {
          res.status(500).json({ error: 'Failed to restart proxy: ' + error.message });
        }
      });

      devServer.app.use('/hello', async (req, res) => {
        LocalProxy.start();
        res.status(200).json({ ok: 'hello' });
      });

      // post /proxy/https://www.baidu.com/...
      devServer.app.use('/proxy/*', async (req, res) => {
        try {
          // 提取目标URL，移除'/proxy/'前缀
          const targetUrl = extractTrailingHttpUrl(req.originalUrl);

          // 解析URL以确定使用哪个HTTP模块
          const parsedUrl = new URL(targetUrl);
          const httpClient = parsedUrl.protocol === 'https:' ? https : http;

          // 准备代理请求选项
          const proxyOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: req.method,
            headers: { ...req.headers }
          };

          // 移除不应该转发的头部
          delete proxyOptions.headers['host'];
          delete proxyOptions.headers['connection'];

          // 创建代理请求
          const proxyReq = httpClient.request(proxyOptions, (proxyRes) => {
            // 转发状态码
            res.status(proxyRes.statusCode);

            // 转发头部（除了content-length会自动设置）
            Object.keys(proxyRes.headers).forEach(key => {
              if (key.toLowerCase() !== 'content-length') {
                res.setHeader(key, proxyRes.headers[key]);
              }
            });

            // 管道传输响应数据
            proxyRes.pipe(res);
          });

          // 处理代理请求错误
          proxyReq.on('error', (err) => {
            res.status(502).json({ error: `代理错误: ${err.message}` });
          });

          // 如果有请求体则转发
          if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            req.pipe(proxyReq);
          } else {
            proxyReq.end();
          }
        } catch (error) {
          res.status(502).json({ error: `代理错误: ${error.message}` });
        }
      });
    };

    return devServerConfig;
  },
};
