const os = require('os');
const { exec } = require('child_process');

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

const isMac = os.platform() === 'darwin';
const isLinux = os.platform() === 'linux';

function portToHex(port) {
  const hex = port.toString(16).toUpperCase();
  return hex.padStart(4, '0');
}

async function getSystemMonitorInfo(port = 8001) {
  const keywords = ['/node', '/proxy', '/express', 'x-ui', 'xray', 'memo'];

  // === 1. CPU ===
  const cpuCores = os.cpus().length;
  let cpuUsage = 0;

  if (isLinux) {
    const readCPUStat = async () => {
      const stat = await promisifyExec('cat /proc/stat | grep "^cpu "');
      const parts = stat.split(/\s+/).slice(1);
      const total = parts.reduce((a, b) => a + parseInt(b, 10), 0);
      const idle = parseInt(parts[3], 10);
      return { total, idle };
    };
    const start = await readCPUStat();
    await new Promise(r => setTimeout(r, 500));
    const end = await readCPUStat();
    cpuUsage = Math.min(100, Math.max(0,
      (1 - (end.idle - start.idle) / (end.total - start.total)) * 100
    ));
  } else if (isMac) {
    const after = await promisifyExec("top -l 2 -n 0 | tail -1 | grep 'CPU usage'");
    const idleMatch = after.match(/([\d.]+)%\s+idle/);
    if (idleMatch) {
      cpuUsage = 100 - parseFloat(idleMatch[1]);
    }
  }

  // === 2. Memory ===
  let memUsedMB, memTotalMB, memPercent;
  if (isLinux) {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    memUsedMB = Math.round(used / 1024 / 1024);
    memTotalMB = Math.round(total / 1024 / 1024);
    memPercent = Math.round((used / total) * 100);
  } else if (isMac) {
    const vm = await promisifyExec('vm_stat');
    const pageSizeMatch = vm.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 4096;
    const freePages = parseInt(vm.match(/Pages free:\s+(\d+)/)?.[1] || '0', 10);
    const inactivePages = parseInt(vm.match(/Pages inactive:\s+(\d+)/)?.[1] || '0', 10);
    const totalPhys = os.totalmem();
    const freeMem = (freePages + inactivePages) * pageSize;
    const usedMem = totalPhys - freeMem;
    memUsedMB = Math.round(usedMem / 1024 / 1024);
    memTotalMB = Math.round(totalPhys / 1024 / 1024);
    memPercent = Math.round((usedMem / totalPhys) * 100);
  }

  // === 3. Disk ===
  let diskUsedGB = 'N/A', diskTotalGB = 'N/A', diskPerc = 'N/A';
  try {
    if (isLinux || isMac) {
      const dfLine = await promisifyExec(`df / | awk 'NR==2 {print $2,$3,$5}'`);
      const [totalKB, usedKB, perc] = dfLine.split(' ');
      if (totalKB && usedKB && perc) {
        diskUsedGB = Math.round(parseInt(usedKB) / 1024 / 1024);
        diskTotalGB = Math.round(parseInt(totalKB) / 1024 / 1024);
        diskPerc = perc.replace('%', '');
      }
    }
  } catch (e) {}

  // === 4. Connections ===
  let tcp = 0, udp = 0;
  try {
    if (isLinux) {
      tcp = (await promisifyExec("cat /proc/net/tcp 2>/dev/null")).split('\n').length - 1;
      udp = (await promisifyExec("cat /proc/net/udp 2>/dev/null")).split('\n').length - 1;
    } else if (isMac) {
      tcp = parseInt(await promisifyExec("netstat -an | grep '^tcp' | wc -l")) || 0;
      udp = parseInt(await promisifyExec("netstat -an | grep '^udp' | wc -l")) || 0;
    }
  } catch (e) {}

  // === 5. Hostname & Platform ===
  const hostname = os.hostname();
  const platform = os.platform();

  // === 6. Target Processes ===
  const matchedProcesses = [];
  if (isLinux) {
    try {
      const pids = (await require('fs').promises.readdir('/proc'))
        .filter(pid => /^\d+$/.test(pid));
      for (const pid of pids) {
        let cmdline = '';
        try {
          const buf = await require('fs').promises.readFile(`/proc/${pid}/cmdline`);
          cmdline = buf.toString().replace(/\0/g, ' ').trim();
        } catch (e) { /* skip */ }
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
  } else if (isMac) {
    const psOut = await promisifyExec("ps aux");
    const psLines = psOut.split('\n').slice(1);
    for (const line of psLines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;
      const pid = parts[1];
      const cpu = parseFloat(parts[2]) || 0;
      const rssKB = parseInt(parts[5], 10) || 0;
      const cmdline = parts.slice(10).join(' ');
      if (keywords.some(kw => cmdline.includes(kw))) {
        matchedProcesses.push({
          name: cmdline.split(' ')[0].split('/').pop() || 'unknown',
          pid,
          memoryMB: Math.round(rssKB / 1024),
          cpuPercent: cpu
        });
      }
    }
  }

  // === 7. Port Connections ===
  let portConns = 0;
  try {
    if (isLinux) {
      const portHex = portToHex(port);
      const tcpContent = await promisifyExec("cat /proc/net/tcp 2>/dev/null");
      const entries = tcpContent.split('\n').slice(1);
      for (const entry of entries) {
        const parts = entry.trim().split(/\s+/);
        if (parts.length >= 4) {
          const localPortHex = parts[1].split(':')[1];
          const state = parts[3];
          if (state === '01' && localPortHex === portHex) {
            portConns++;
          }
        }
      }
    } else if (isMac) {
      const lsofOut = await promisifyExec(`lsof -i :${port} -sTCP:ESTABLISHED 2>/dev/null | wc -l`);
      portConns = Math.max(0, (parseInt(lsofOut) || 0) - 1);
    }
  } catch (e) {}

  // === 格式化输出（无行首 \t，但列对齐）===
  let output = '';

  // 固定标签宽度：12 字符（"CPU:       "）
  const labelWidth = 12;

  output += '=== System Monitor ===\n';
  output += `${padRight('CPU:', labelWidth)}${cpuCores} cores, Usage: ${padLeft(Math.round(cpuUsage), 3)}%\n`;
  output += `${padRight('Memory:', labelWidth)}${padLeft(memUsedMB, 5)} / ${padLeft(memTotalMB, 5)} MB (${padLeft(memPercent, 3)}%)\n`;
  output += `${padRight('Disk:', labelWidth)}${padLeft(diskUsedGB, 3)} / ${padLeft(diskTotalGB, 3)} GB (${padLeft(diskPerc, 3)}%)\n`;
  output += `${padRight('Connections:', labelWidth)}TCP=${padLeft(tcp, 4)}, UDP=${padLeft(udp, 4)}\n`;
  output += `${padRight('Hostname:', labelWidth)}${hostname}, Platform: ${platform}\n\n`;

  if (matchedProcesses.length > 0) {
    output += '--- Target Processes ---\n';
    for (const p of matchedProcesses) {
      const name = p.name.length > 18 ? p.name.substring(0, 15) + '...' : p.name;
      const namePart = padRight(`${name} (PID ${p.pid})`, 25);
      const cpuPart = padRight(`CPU: ${p.cpuPercent.toFixed(1)}%`, 12);
      const memPart = `Mem: ${padLeft(p.memoryMB, 4)} MB`;
      output += `${namePart}${cpuPart}${memPart}\n`;
    }
    output += '\n';
  }

  output += `--- Port ${port} Connections ---\n`;
  output += `Active TCP connections: ${padLeft(portConns, 4)}\n`;

  return output;
}

module.exports = { getSystemMonitorInfo };
