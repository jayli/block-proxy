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

// 获取Docker宿主机IP地址
function getDockerHostIP() {
  const methods = [];
  
  // 方法1: 检查默认网关 (通常是宿主机在容器网络中的IP)
  try {
    const gateway = getDefaultGateway();
    if (gateway) {
      methods.push({ method: 'default_gateway', ip: gateway });
    }
  } catch (err) {
    // 忽略错误
  }

  // 方法2: 检查 docker0 网桥接口
  try {
    const interfaces = os.networkInterfaces();
    for (const interfaceName in interfaces) {
      if (interfaceName.startsWith('eth') || interfaceName.startsWith('en')) {
        const interface = interfaces[interfaceName];
        for (const iface of interface) {
          if (!iface.internal && iface.family === 'IPv4') {
            // 检查是否是常见的Docker网络IP范围
            if (iface.address.startsWith('172.17.') || 
                iface.address.startsWith('172.18.') ||
                iface.address.startsWith('172.19.') ||
                iface.address.startsWith('172.20.')) {
              methods.push({ method: 'docker_bridge', ip: iface.address });
            }
          }
        }
      }
    }
  } catch (err) {
    // 忽略错误
  }

  // 方法3: 通过环境变量获取
  if (process.env.DOCKER_HOST_IP) {
    methods.push({ method: 'environment_variable', ip: process.env.DOCKER_HOST_IP });
  }

  // 方法4: 通过特殊DNS名称获取 (Docker for Mac/Windows)
  try {
    const hostDockerInternal = require('dns').lookupSync('host.docker.internal');
    if (hostDockerInternal) {
      methods.push({ method: 'host_docker_internal', ip: hostDockerInternal.address });
    }
  } catch (err) {
    // 忽略错误
  }

  return methods;
}

// 获取默认网关IP
function getDefaultGateway() {
  try {
    // 读取路由表信息
    const routes = fs.readFileSync('/proc/net/route', 'utf8');
    const lines = routes.split('\n');
    
    for (let i = 1; i < lines.length; i++) {
      const fields = lines[i].trim().split(/\s+/);
      if (fields.length >= 3) {
        const destination = fields[1];
        const gateway = fields[2];
        
        // 检查默认路由 (目标为00000000)
        if (destination === '00000000' && gateway !== '00000000') {
          // 将十六进制网关地址转换为点分十进制
          const gatewayIP = hexToIP(gateway);
          return gatewayIP;
        }
      }
    }
  } catch (err) {
    // 文件不存在或无法读取
  }
  return null;
}

// 将十六进制IP地址转换为点分十进制格式
function hexToIP(hex) {
  const ip = [];
  for (let i = 0; i < 4; i++) {
    ip.push(parseInt(hex.substr(i * 2, 2), 16));
  }
  return ip.reverse().join('.');
}

// 检查当前时间是否在拦截时间段内
function isWithinFilterTime(filterItem) {
  // 如果没有设置时间段，则始终拦截
  if (!filterItem.filter_start_time || !filterItem.filter_end_time) {
    return true;
  }
  
  const now = new Date();
  const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
  
  const startTime = filterItem.filter_start_time;
  const endTime = filterItem.filter_end_time;
  
  // 处理跨天的情况（例如 22:00 到 06:00）
  if (startTime > endTime) {
    return currentTime >= startTime || currentTime <= endTime;
  } else {
    return currentTime >= startTime && currentTime <= endTime;
  }
}

module.exports = {
  devServer: (devServerConfig, { env, paths, proxy, allowedHost }) => {

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
          
          const isDocker = isRunningInDocker();
          const response = {
            ips: ipAddresses,
            primary: ipAddresses.length > 0 ? ipAddresses[0].address : null,
            docker: isDocker
          };
          
          // 如果在Docker环境中，尝试获取宿主机IP
          if (isDocker) {
            response.hostIPs = getDockerHostIP();
          }
          
          res.status(200).json(response);
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

    // 保存原始的onListening回调（如果存在）
    const originalOnListening = devServerConfig.onListening;
    
    // 在服务监听完成后启动LocalProxy
    devServerConfig.onListening = (devServer) => {
      // 调用原始的onListening（如果存在）
      if (originalOnListening) {
        originalOnListening(devServer);
      }
      
      // 延迟启动LocalProxy，确保端口完全准备好
      setTimeout(async () => {
        console.log('Dev server started, starting LocalProxy...');
        LocalProxy.start();
        await LocalProxy.updateDevices();
        console.log('local network devices updated!');
      }, 100);
    };

    return devServerConfig;
  },
};
