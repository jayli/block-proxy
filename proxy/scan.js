// 扫描当前网络，得到ip和mac的对应表
// /proxy/scan.js
const { exec } = require('child_process');
const os = require('os');
const fs = require('fs');
const _fs = require('./fs.js');
const path = require('path');
const ping = require('ping'); // 这个包通常镜像里有
const configPath = path.join(__dirname, '../config.json');

function getLocalSubnet() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('172.')) {
        const parts = net.address.split('.');
        return `${parts[0]}.${parts[1]}.${parts[2]}`;
      }
    }
  }
  throw new Error('No valid LAN IP found');
}

function parseArpTable(arpOutput, subnet) {
  const lines = arpOutput.split('\n');
  const result = [];

  for (const line of lines) {
    // macOS / Linux 格式: ? (192.168.1.5) at aa:bb:cc:dd:ee:ff on en0 ...
    // Windows 格式:   192.168.1.5            aa-bb-cc-dd-ee-ff     dynamic
    const ipMatch = line.match(/(\d+\.\d+\.\d+\.\d+)/);
    if (!ipMatch) continue;

    const ip = ipMatch[1];
    if (!ip.startsWith(subnet)) continue;

    let macMatch;
    if (process.platform === 'win32') {
      macMatch = line.match(/(([0-9a-fA-F]{1,2}[:-]){5}([0-9a-fA-F]{1,2}))/);
    } else {
      macMatch = line.match(/(([0-9a-fA-F]{1,2}[:\-]){5}([0-9a-fA-F]{1,2}))/);
    }

    if (macMatch && macMatch[0].startsWith("0:0:")) {
      // 如果 mac 是 "0:0:0:0:4:1" 之类的，说明子网禁止扫描
      continue;
    }

    if (macMatch) {
      let mac = macMatch[1].toUpperCase();
      if (process.platform !== 'win32') {
        mac = mac.replace(/-/g, ':');
      }
      result.push({ ip, mac });
    }
  }
  return result;
}

// "0","1"
async function setScanStatus(status) {
  // const configFileContent = fs.readFileSync(configPath, 'utf-8');
  // const loadedConfig = JSON.parse(configFileContent);
  const loadedConfig = await _fs.readConfig();
  loadedConfig.network_scanning_status = status.toString();
  _fs.writeConfig({
    ...loadedConfig
  });
  // fs.writeFileSync(configPath, JSON.stringify({
  // }, null, 2));
}

// "0"，"1"
async function getScanStatus() {
  // const configFileContent = fs.readFileSync(configPath, 'utf-8');
  // const loadedConfig = JSON.parse(configFileContent);
  const loadedConfig = await _fs.readConfig();
  return loadedConfig.network_scanning_status;
}

// 并发控制器，限制同时进行的 ping 数量
class ConcurrentPingController {
  constructor(maxConcurrent = 32, batchDelay = 50) {
    this.maxConcurrent = maxConcurrent;
    this.batchDelay = batchDelay; // 批次之间的延迟（毫秒）
  }

  // 批量执行 ping，控制并发数（真正的批次并发）
  async batchPing(ips, timeout = 1) {
    const results = [];

    // 将IP列表分成多个批次
    for (let i = 0; i < ips.length; i += this.maxConcurrent) {
      const batch = ips.slice(i, i + this.maxConcurrent);

      // 并发执行当前批次的所有ping
      const batchPromises = batch.map(ip =>
        ping.promise.probe(ip, { timeout })
      );

      const batchResults = await Promise.allSettled(batchPromises);

      // 将批次结果添加到总结果中
      batch.forEach((ip, index) => {
        results.push({
          ip,
          result: batchResults[index]
        });
      });

      // 如果不是最后一个批次，则添加延迟
      if (i + this.maxConcurrent < ips.length) {
        await new Promise(resolve => setTimeout(resolve, this.batchDelay));
      }
    }

    return results;
  }
}

async function doScan() {
  const subnet = getLocalSubnet();
  // 如果是 30 网段，直接返回空
  if (subnet.startsWith("30.")) {
    return [];
  }
  console.log(`正在扫描网段: ${subnet}.0/24`);

  // 创建并发控制器，限制同时进行32个ping，批次间延迟50ms
  const controller = new ConcurrentPingController(32, 50);

  // 生成所有IP地址
  const ips = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);

  // 使用并发控制器分批ping所有IP
  console.log(`开始并发ping扫描，最大并发数: 32，批次延迟: 50ms`);
  await controller.batchPing(ips, 1); // 使用1秒超时，ping结果仅用于填充ARP缓存

  // 读取ARP表以获取MAC地址
  const cmd = process.platform === 'win32' ? 'arp -a' : 'arp -a';
  const arpOutput = await new Promise((resolve, reject) => {
    exec(cmd, async (error, stdout) => {
      if (error) {
        await setScanStatus("0");
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });

  const devices = parseArpTable(arpOutput, subnet);
  return devices;
}

var tempDevices = [];
async function scanNetwork() {
  var status = await getScanStatus();
  if (status == "1") {
    // await setScanStatus("0");
    return tempDevices;
  } else {
    await setScanStatus("1");
    var devices = await doScan();
    tempDevices = devices;
    await setScanStatus("0");
    return devices;
  }
}

module.exports.setScanStatus = setScanStatus;
module.exports.scanNetwork = scanNetwork;
