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

async function doScan() {
  const subnet = getLocalSubnet();
  // 如果是 30 网段，直接返回空
  if (subnet.startsWith("30.")) {
    return []
  }
  console.log(`Scanning subnet: ${subnet}.0/24`);

  // Ping all IPs to populate ARP cache
  const ips = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);
  await Promise.allSettled(ips.map(ip => ping.promise.probe(ip, { timeout: 1 })));

  // Read ARP table via system command
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
