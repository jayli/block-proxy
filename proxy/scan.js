// 扫描当前网络，得到 ip 和 mac 的对应表
// /proxy/scan.js
//
// 实际扫描逻辑在 ./lan-scan.js（原生 UDP 探测 + 内核邻居表，不依赖 arp / ping 命令）。
// 本文件只负责：读写扫描状态、并发去重。
const _fs = require('./fs.js');
const lanScan = require('./lan-scan.js');

// "0","1"
async function setScanStatus(status) {
  const loadedConfig = await _fs.readConfig();
  loadedConfig.network_scanning_status = status.toString();
  _fs.writeConfig({
    ...loadedConfig
  });
}

// "0"，"1"
async function getScanStatus() {
  const loadedConfig = await _fs.readConfig();
  return loadedConfig.network_scanning_status;
}

async function doScan() {
  try {
    return await lanScan.scanLan();
  } catch (error) {
    console.error(`[scan] 局域网扫描失败: ${error.message}`);
    throw error;
  }
}

var tempDevices = [];
async function scanNetwork() {
  var status = await getScanStatus();
  if (status == "1") {
    // 已有扫描在进行中，直接返回上一轮结果
    return tempDevices;
  } else {
    await setScanStatus("1");
    try {
      var devices = await doScan();
      tempDevices = devices;
      return devices;
    } finally {
      // 扫描失败也要复位状态，否则后续所有调用都会直接返回上一轮的结果
      await setScanStatus("0");
    }
  }
}

module.exports.setScanStatus = setScanStatus;
module.exports.scanNetwork = scanNetwork;
module.exports.doScan = doScan;
