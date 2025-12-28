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


function getHostLanIP() {
  const interfaces = os.networkInterfaces();
  let fallbackIP = '127.0.0.1';

  // 先尝试找 br-lan（OpenWrt/软路由常见）
  if (interfaces['br-lan']) {
    for (const net of interfaces['br-lan']) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('127.')) {
        return net.address; // 优先返回 br-lan 的 IP
      }
    }
  }

  // 如果没有 br-lan，再遍历其他非虚拟接口
  for (const name of Object.keys(interfaces)) {
    // 只跳过明确不需要的
    if (
      name === 'lo' ||
      name.startsWith('veth') ||          // Docker 虚拟对端
      name === 'docker0' ||               // Docker 默认网桥
      name.startsWith('pppoe') ||         // PPPoE 是外网，通常不需要作为“局域网 IP”
      name.startsWith('vap-')             // 你的 vap-lan 是虚拟 AP，可选跳过
    ) {
      continue;
    }

    const nets = interfaces[name];
    for (const net of nets) {
      if (net.family === 'IPv4' && !net.internal) {
        const addr = net.address;
        // 排除回环和链路本地
        if (!addr.startsWith('127.') && !addr.startsWith('169.254.')) {
          // 优先选择 192.168.x.x 或 10.x.x.x 等私有地址
          if (addr.startsWith('192.168.') || addr.startsWith('10.') || addr.startsWith('172.16.') || addr.startsWith('172.17.') || addr.startsWith('172.18.') || addr.startsWith('172.19.') || addr.startsWith('172.20.') || addr.startsWith('172.21.') || addr.startsWith('172.22.') || addr.startsWith('172.23.') || addr.startsWith('172.24.') || addr.startsWith('172.25.') || addr.startsWith('172.26.') || addr.startsWith('172.27.') || addr.startsWith('172.28.') || addr.startsWith('172.29.') || addr.startsWith('172.30.') || addr.startsWith('172.31.')) {
            return addr;
          }
          fallbackIP = addr;
        }
      }
    }
  }

  return fallbackIP;
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
