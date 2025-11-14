const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const LocalProxy = require('../proxy/proxy');

module.exports = {
  // 检测是否在 Docker 环境中运行
  isRunningInDocker: () => {
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
  },

  // 获取Docker宿主机IP地址
  getDockerHostIP: () => {
    const methods = [];
    
    // 方法1: 检查默认网关 (通常是宿主机在容器网络中的IP)
    try {
      const gateway = this.getDefaultGateway();
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
  },

  // 获取默认网关IP
  getDefaultGateway: () => {
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
            const gatewayIP = this.hexToIP(gateway);
            return gatewayIP;
          }
        }
      }
    } catch (err) {
      // 文件不存在或无法读取
    }
    return null;
  },

  // 将十六进制IP地址转换为点分十进制格式
  hexToIP: (hex) => {
    const ip = [];
    for (let i = 0; i < 4; i++) {
      ip.push(parseInt(hex.substr(i * 2, 2), 16));
    }
    return ip.reverse().join('.');
  },

  // 检查当前时间是否在拦截时间段内
  isWithinFilterTime: (filterItem) => {
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
  },

  extractTrailingHttpUrl: (str) => {
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
};
