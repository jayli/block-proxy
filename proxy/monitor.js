const os = require('os');
const { exec } = require('child_process');
const fs = require('fs').promises;

function promisifyExec(cmd, timeout = 3000) {
  return new Promise(resolve => {
    exec(cmd, { timeout }, (error, stdout) => {
      resolve(stdout ? stdout.trim() : '');
    });
  });
}

// 填充工具函数
const padRight = (str, len) => {
  str = String(str);
  return str.length < len ? str + ' '.repeat(len - str.length) : str;
};
const padLeft = (str, len) => {
  str = String(str);
  return str.length < len ? ' '.repeat(len - str.length) + str : str;
};

const isLinux = os.platform() === 'linux';

async function getSystemMonitorInfo() {
  // 非 Linux 平台直接返回提示
  if (!isLinux) {
    return 'cannot access website via the same proxy ip';
  }

  const keywords = ['/node', '/proxy', '/express', 'x-ui', 'xray', 'memo'];

  // === 1. CPU 使用率 ===
  const cpuCores = os.cpus().length;
  let cpuUsage = 0;

  const readCPUStat = async () => {
    const stat = await promisifyExec('cat /proc/stat | grep "^cpu "');
    const parts = stat.split(/\s+/).slice(1);
    const total = parts.reduce((a, b) => a + parseInt(b || '0', 10), 0);
    const idle = parseInt(parts[3] || '0', 10);
    return { total, idle };
  };

  const start = await readCPUStat();
  await new Promise(r => setTimeout(r, 500));
  const end = await readCPUStat();
  cpuUsage = Math.min(100, Math.max(0,
    (1 - (end.idle - start.idle) / (end.total - start.total)) * 100
  ));

  // === 2. Memory ===
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memUsedMB = Math.round(usedMem / 1024 / 1024);
  const memTotalMB = Math.round(totalMem / 1024 / 1024);
  const memPercent = Math.round((usedMem / totalMem) * 100);

  // === 3. Disk ===
  let diskUsedGB = 'N/A', diskTotalGB = 'N/A', diskPerc = 'N/A';
  try {
    const dfLine = await promisifyExec(`df / | awk 'NR==2 {print $2,$3,$5}'`);
    const [totalKB, usedKB, perc] = dfLine.split(' ');
    if (totalKB && usedKB && perc) {
      diskUsedGB = Math.round(parseInt(totalKB) / 1024 / 1024);
      diskTotalGB = Math.round(parseInt(usedKB) / 1024 / 1024);
      diskPerc = perc.replace('%', '');
    }
  } catch (e) {}

  // === 4. Connections (TCP/UDP) ===
  let tcp = 0, udp = 0;
  try {
    tcp = (await promisifyExec("cat /proc/net/tcp 2>/dev/null")).split('\n').length - 1;
    udp = (await promisifyExec("cat /proc/net/udp 2>/dev/null")).split('\n').length - 1;
  } catch (e) {}

  // === 5. Load Average ===
  const [load1, load5, load15] = os.loadavg();
  const loadAvg = `${load1.toFixed(2)}, ${load5.toFixed(2)}, ${load15.toFixed(2)}`;

  // === 6. CPU Temperature ===
  let cpuTemp = 'N/A';
  const tempPaths = [
    '/sys/class/thermal/thermal_zone0/temp',
    '/sys/class/hwmon/hwmon0/temp1_input',
    '/sys/class/hwmon/hwmon1/temp1_input'
  ];
  for (const path of tempPaths) {
    try {
      const tempStr = await fs.readFile(path, 'utf8');
      const tempRaw = parseInt(tempStr.trim(), 10);
      if (!isNaN(tempRaw)) {
        const celsius = Math.round(tempRaw / 1000);
        if (celsius > 0 && celsius < 120) {
          cpuTemp = `${celsius}°C`;
          break;
        }
      }
    } catch {}
  }

  // === 7. Hostname & Platform ===
  const hostname = os.hostname();
  const platform = os.platform();

  // === 8. Target Processes ===
  const matchedProcesses = [];
  try {
    const pids = (await fs.readdir('/proc')).filter(pid => /^\d+$/.test(pid));
    for (const pid of pids) {
      let cmdline = '';
      try {
        const buf = await fs.readFile(`/proc/${pid}/cmdline`);
        cmdline = buf.toString().replace(/\0/g, ' ').trim();
      } catch { /* skip */ }
      if (!cmdline) continue;
      if (keywords.some(kw => cmdline.includes(kw))) {
        const rssKB = await promisifyExec(`awk '/VmRSS/ {print $2}' /proc/${pid}/status 2>/dev/null`);
        const cpuPerc = await promisifyExec(`ps -p ${pid} -o %cpu= 2>/dev/null`);
        matchedProcesses.push({
          name: cmdline.split(' ')[0].split('/').pop() || 'unknown',
          pid,
          memoryMB: rssKB ? Math.round(parseInt(rssKB) / 1024) : 0,
          cpuPercent: cpuPerc ? parseFloat(cpuPerc.trim()) || 0 : 0
        });
      }
    }
  } catch (e) {}

  // === 格式化输出 ===
  let output = '';
  const labelWidth = 12;

  output += '=== 系统基本信息 ===\n';
  output += `${padRight('CPU: ', labelWidth)}${cpuCores} 核, 使用: ${padLeft(Math.round(cpuUsage), 3)}%\n`;
  output += `${padRight('负载: ', labelWidth)}${loadAvg}\n`;
  output += `${padRight('温度: ', labelWidth)}${cpuTemp}\n`;
  output += `${padRight('内存: ', labelWidth)}${padLeft(memUsedMB, 5)} / ${padLeft(memTotalMB, 5)} MB (${padLeft(memPercent, 3)}%)\n`;
  output += `${padRight('硬盘: ', labelWidth)}${padLeft(diskUsedGB, 3)} / ${padLeft(diskTotalGB, 3)} GB (${padLeft(diskPerc, 3)}%)\n`;
  output += `${padRight('连接数: ', labelWidth)}TCP=${padLeft(tcp, 4)}, UDP=${padLeft(udp, 4)}\n`;
  output += `${padRight('主机名: ', labelWidth)}${hostname}, 平台: ${platform}\n\n`;

  if (matchedProcesses.length > 0) {
    output += '--- 目标进程 ---\n';
    for (const p of matchedProcesses) {
      const name = p.name.length > 18 ? p.name.substring(0, 15) + '...' : p.name;
      const namePart = padRight(`${name} (PID ${p.pid})`, 25);
      const cpuPart = padRight(`CPU: ${p.cpuPercent.toFixed(1)}%`, 12);
      const memPart = `内存: ${padLeft(p.memoryMB, 4)} MB`;
      output += `${namePart}${cpuPart}${memPart}\n`;
    }
    output += '\n';
  }

  return output.trim();
}

module.exports = { getSystemMonitorInfo };