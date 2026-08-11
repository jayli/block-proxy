// server/util.js
const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
// const LocalProxy = require('../proxy/proxy');

// 将十六进制IP地址转换为点分十进制格式
function hexToIP(hex) {
  const ip = [];
  for (let i = 0; i < 4; i++) {
    ip.push(parseInt(hex.substr(i * 2, 2), 16));
  }
  return ip.reverse().join('.');
}


function isPrivateIPv4(ip) {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
  const [a, b, c, d] = ip.split('.').map(Number);
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 10) return true;               // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  return false;
}

// 可能返回多个局域网IP，逗号分隔
function getHostLanIP() {
  const interfaces = os.networkInterfaces();
  const lanIPs = new Set(); // 自动去重

  for (const name of Object.keys(interfaces)) {
    // 跳过回环接口（lo）
    if (name === 'lo') continue;

    const nets = interfaces[name];
    for (const net of nets) {
      if (net.family === 'IPv4' && !net.internal) {
        const addr = net.address;
        if (isPrivateIPv4(addr)) {
          lanIPs.add(addr);
        }
      }
    }
  }

  // 如果没找到私有 IP，fallback 到 127.0.0.1
  if (lanIPs.size === 0) {
    return '127.0.0.1';
  }

  return Array.from(lanIPs).sort().join(',');
}


// 使用
// const hostIP = getHostLanIP();
// console.log('宿主机局域网 IP:', hostIP);

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
    return getHostLanIP();
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
            const gatewayIP = hexToIP(gateway);
            return gatewayIP;
          }
        }
      }
    } catch (err) {
      // 文件不存在或无法读取
    }
    return null;
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
