// server.js
const express = require('express');
const fs = require('fs');
const _fs = require('../proxy/fs.js');
const path = require('path');
const util = require('./util');
const net = require('net');
const os = require('os');
const { exec, execSync } = require('child_process');
const LocalProxy = require('../proxy/proxy');

const app = express();
const PORT = 8004;
const DEV = process.env.BLOCK_PROXY_DEV || 0;
const configPath = path.join(__dirname, '../config.json');

// 1. 托管 React build 后的静态文件
const staticPath = path.join(__dirname, '../build/');
app.use(express.static(staticPath));

// 2. （可选）处理 API 接口 —— 这里可以放你原来的“本地服务”逻辑
app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello from Express!' });
});

app.get('/api/timezone', async (req, res) => {
  res.status(200).json({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
});

// 获取服务器IP地址接口
app.get('/api/server-ip', async (req, res) => {
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

    const isDocker = util.isRunningInDocker();
    const response = {
      ips: ipAddresses,
      primary: ipAddresses.length > 0 ? ipAddresses[0].address : null,
      docker: isDocker
    };

    // 如果在Docker环境中，尝试获取宿主机IP
    if (isDocker) {
      response.hostIPs = util.getDockerHostIP();
    }

    res.status(200).json(response);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get server IP addresses: ' + error.message });
  }
});

// 获取配置接口
app.get('/api/config', async (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      res.status(200).json(config);
    } else {
      res.status(404).json({ error: 'Config file not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to read config file' + error.message });
  }
});

// 更新配置接口
app.post('/api/config', async (req, res) => {
  try {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const newConfig = JSON.parse(body);
        const configPath = path.join(__dirname, '../config.json');
        // fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
        _fs.writeConfig(newConfig);
        res.status(200).json({ message: 'Config updated successfully' });
      } catch (err) {
        res.status(400).json({ error: 'Invalid JSON or write error: ' + err.message });
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update config' });
  }
});

// 在 devServer.js 的 onBeforeSetupMiddleware 中添加新的 API 端点
app.post('/api/update-devices', async (req, res) => {
  try {
    // 调用本地代理的更新设备方法
    await LocalProxy.updateDevices();
    res.status(200).json({ message: 'Devices updated successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update devices: ' + error.message });
  }
});

function sendRestartMessage(callback) {
  const configFileContent = fs.readFileSync(configPath, 'utf-8');
  const loadedConfig = JSON.parse(configFileContent);
  loadedConfig.progress_time_stamp = new Date().getTime().toString();
  // fs.writeFileSync(configPath, JSON.stringify(loadedConfig, null, 2));
  _fs.writeConfig(loadedConfig);
  setTimeout(() => {
    callback();
  }, 300);
}

// 重启代理接口
app.post('/api/restart', async (req, res) => {
  try {
    // 调用本地代理的重启方法
    // sendRestartMessage(function() {
    //   res.status(200).json({ message: 'Proxy restarted successfully' });
    // });
    await LocalProxy.restart(function() {
      res.status(200).json({ message: 'Proxy restarted successfully' });
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to restart proxy: ' + error.message });
  }
});

// post /proxy/https://www.baidu.com/...
app.use(/\/proxy\/*/, async (req, res) => {
  try {
    // 提取目标URL，移除'/proxy/'前缀
    const targetUrl = util.extractTrailingHttpUrl(req.originalUrl);

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

// 3. 所有其他请求都返回 index.html（支持 React Router 的前端路由）
app.get((req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

module.exports = {
  init: function() {
    // 启动服务器
    app.listen(PORT, async () => {
      // 如果是开发环境，则启动SSR服务，开启端口3000
      if (DEV === '1') {
        const child = exec('npm run craco', { cwd: path.join(__dirname,'../') });
        console.log('启动 craco start');

        // Stream the output to the console
        child.stdout.on('data', (data) => {
          process.stdout.write(data);
        });

        child.stderr.on('data', (data) => {
          process.stderr.write(data);
        });

        child.on('close', (code) => {
          console.log(`craco process exited with code ${code}`);
        });
      }
      // 启动本地代理
      await LocalProxy.init();
      console.log(`✅ \x1b[32m后台配置面板启动 → http://localhost:${PORT}\x1b[0m`);
    });
  }
};
