const os = require('os');
const { exec } = require('child_process');
const fs = require('fs').promises;

const isLinux = os.platform() === 'linux';
const isMacOS = os.platform() === 'darwin';

const guideLine = [
  "\n\n",
  "操作：",
  "1. <a href='/enable_express'>启用管理后台</a>",
  "2. <a href='/disable_express'>关闭管理后台</a>",
  "3. <a href='/restart_docker'>重启 Docker</a>"
].join("\n");

function promisifyExec(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

async function getSystemMonitorInfo() {
  if (isLinux) {
    let output = '';

    // === 1. 主机名 & 系统信息 ===
    const hostname = os.hostname();
    const platform = os.type();
    const machine = os.machine();
    const release = os.release();
    const osVersion = os.version();
    output += `主机名：${hostname}\n`;
    output += `系统架构：${machine}\n`;
    output += `系统名称和类型：${platform} ${release}\n`;
    output += `系统版本：${osVersion}\n\n`;

    // === 2. CPU ===
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
    output += `CPU 核数：${cpuCores}，使用占比：${Math.round(cpuUsage)}%\n`;

    // === CPU 负载 ===
    const [load1, load5, load15] = os.loadavg();
    output += `CPU 负载：${load1.toFixed(2)}, ${load5.toFixed(2)}, ${load15.toFixed(2)}\n`;

    // === CPU 温度 ===
    let cpuTemp = 'N/A';
    const tempPaths = [
      '/sys/class/thermal/thermal_zone0/temp',
      '/sys/class/hwmon/hwmon0/temp1_input',
      '/sys/class/hwmon/hwmon1/temp1_input'
    ];
    for (const p of tempPaths) {
      try {
        const tempStr = await fs.readFile(p, 'utf8');
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
    output += `CPU 温度：${cpuTemp}\n`;

    // === 3. Memory ===
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memTotalMB = Math.round(totalMem / 1024 / 1024);
    const memUsedMB = Math.round(usedMem / 1024 / 1024);
    const memPercent = Math.round((usedMem / totalMem) * 100);
    output += `内存总数：${memTotalMB} MB，使用数量：${memUsedMB} MB，使用占比：${memPercent}%\n`;

    // === 4. Disk ===
    let diskUsedGB = 'N/A', diskTotalGB = 'N/A', diskPerc = 'N/A';
    try {
      const dfLine = await promisifyExec(`df / | awk 'NR==2 {print $2,$3,$5}'`);
      const [totalKB, usedKB, percStr] = dfLine.split(/\s+/);
      if (totalKB && usedKB && percStr) {
        diskUsedGB = Math.round(parseInt(usedKB) / 1024 / 1024);
        diskTotalGB = Math.round(parseInt(totalKB) / 1024 / 1024);
        diskPerc = percStr.replace('%', '');
      }
    } catch (e) {}
    output += `硬盘总数：${diskTotalGB} GB，使用数量：${diskUsedGB} GB，使用占比：${diskPerc}%\n`;

    // === 5. TCP / UDP Connections ===
    let tcp = 0, udp = 0;
    try {
      tcp = (await promisifyExec("cat /proc/net/tcp 2>/dev/null")).split('\n').length - 1;
      udp = (await promisifyExec("cat /proc/net/udp 2>/dev/null")).split('\n').length - 1;
    } catch (e) {}
    output += `TCP 连接数：${tcp}，UDP 连接数：${udp}\n\n`;

    // === 6. 所有 node 进程（含真实 CPU%）===
    output += '所有 node 进程的 CPU 占比和内存占用：\n';

    try {
      let allPidRss = new Map();
      try {
        const psOutput = await promisifyExec('ps -o pid,rss --no-headers 2>/dev/null');
        psOutput.split('\n').forEach(line => {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2) {
            const pidNum = parseInt(parts[0], 10);
            const rssKB = parseInt(parts[1], 10) || 0;
            if (!isNaN(pidNum) && !isNaN(rssKB)) {
              allPidRss.set(pidNum, rssKB);
            }
          }
        });
      } catch (e) {}

      const pids = (await fs.readdir('/proc')).filter(pid => /^\d+$/.test(pid));
      let hasNode = false;
      const ticksPerSec = 100; // standard on most Linux systems
      const cpuCores = os.cpus().length;

      for (const pid of pids) {
        let cmdline = '';
        try {
          const buf = await fs.readFile(`/proc/${pid}/cmdline`);
          cmdline = buf.toString().replace(/\0/g, ' ').trim();
        } catch (e) {
          continue;
        }

        if (!cmdline || !cmdline.startsWith('node')) continue;
        hasNode = true;

        // --- Memory ---
        let rssKB = allPidRss.get(parseInt(pid, 10)) || 0;
        if (rssKB === 0) {
          try {
            const statusContent = await fs.readFile(`/proc/${pid}/status`, 'utf8');
            const match = statusContent.match(/VmRSS:\s*(\d+)/);
            if (match) rssKB = parseInt(match[1], 10) || 0;
          } catch (e) {
            rssKB = 0;
          }
        }
        const memoryMB = rssKB ? Math.round(rssKB / 1024) : 0;

        // --- CPU % via /proc/pid/stat ---
        let cpuPercent = 0;
        try {
          const stat1 = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
          const fields1 = stat1.trim().split(/\s+/);
          const utime1 = parseInt(fields1[13], 10) || 0;
          const stime1 = parseInt(fields1[14], 10) || 0;

          await new Promise(r => setTimeout(r, 500));

          const stat2 = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
          const fields2 = stat2.trim().split(/\s+/);
          const utime2 = parseInt(fields2[13], 10) || 0;
          const stime2 = parseInt(fields2[14], 10) || 0;

          const deltaTicks = (utime2 + stime2) - (utime1 + stime1);
          const cpuUsageSingleCore = (deltaTicks / ticksPerSec) / 0.5 * 100; // over 0.5 seconds
          cpuPercent = Math.min(100 * cpuCores, Math.max(0, cpuUsageSingleCore));
        } catch (e) {
          cpuPercent = 0;
        }

        output += `PID ${pid}: ${cmdline}\n`;
        output += `  CPU: ${cpuPercent.toFixed(1)}%, 内存: ${memoryMB} MB\n`;
      }

      if (!hasNode) {
        output += '（无 node 进程）\n';
      }
    } catch (e) {
      output += '（无法读取进程信息）\n';
    }

    return output + guideLine;
  }

  // --- macOS 实现 ---
  if (isMacOS) {
    let output = '';

    const hostname = os.hostname();
    const machine = os.machine();
    const osInfo = await promisifyExec('sw_vers -productName').catch(() => 'macOS');
    const osVersion = await promisifyExec('sw_vers -productVersion').catch(() => os.release());
    output += `主机名：${hostname}\n`;
    output += `系统型号：${machine}\n`;
    output += `系统名称和类型：${osInfo} ${osVersion}\n\n`;

    const cpuCores = os.cpus().length;
    let cpuUsage = 0;
    try {
      const topOutput = await promisifyExec('top -l 2 -n 0 | grep -E "^CPU" | tail -1');
      const match = topOutput.match(/(\d+\.\d+)%\s+idle/);
      if (match) cpuUsage = 100 - parseFloat(match[1]);
    } catch (e) {
      cpuUsage = 0;
    }
    output += `CPU 核数：${cpuCores}，使用占比：${Math.round(cpuUsage)}%\n`;

    const [load1, load5, load15] = os.loadavg();
    output += `CPU 负载：${load1.toFixed(2)}, ${load5.toFixed(2)}, ${load15.toFixed(2)}\n`;

    let cpuTemp = 'N/A';
    try {
      const tempOutput = await promisifyExec('osx-cpu-temp 2>/dev/null || echo "N/A"');
      if (tempOutput && !tempOutput.includes('N/A') && !tempOutput.includes('command not found')) {
        const match = tempOutput.match(/(\d+\.?\d*)/);
        if (match) {
          const t = parseFloat(match[1]);
          if (!isNaN(t) && t > 0 && t < 120) cpuTemp = `${t}°C`;
        }
      }
    } catch (e) {}
    output += `CPU 温度：${cpuTemp}\n`;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memTotalMB = Math.round(totalMem / 1024 / 1024);
    const memUsedMB = Math.round(usedMem / 1024 / 1024);
    const memPercent = Math.round((usedMem / totalMem) * 100);
    output += `内存总数：${memTotalMB} MB，使用数量：${memUsedMB} MB，使用占比：${memPercent}%\n`;

    let diskUsedGB = 'N/A', diskTotalGB = 'N/A', diskPerc = 'N/A';
    try {
      const dfLine = await promisifyExec(`df -g / | awk 'NR==2 {print $2,$3,$5}'`);
      const [totalGB, usedGB, percStr] = dfLine.split(/\s+/);
      if (totalGB && usedGB && percStr) {
        diskUsedGB = Math.round(parseFloat(usedGB));
        diskTotalGB = Math.round(parseFloat(totalGB));
        diskPerc = percStr.replace('%', '');
      }
    } catch (e) {}
    output += `硬盘总数：${diskTotalGB} GB，使用数量：${diskUsedGB} GB，使用占比：${diskPerc}%\n`;

    let tcp = 0, udp = 0;
    try {
      tcp = parseInt((await promisifyExec("netstat -an -p tcp | grep -E '^tcp' | wc -l")).trim(), 10) || 0;
      udp = parseInt((await promisifyExec("netstat -an -p udp | grep -E '^udp' | wc -l")).trim(), 10) || 0;
    } catch (e) {}
    output += `TCP 连接数：${tcp}，UDP 连接数：${udp}\n\n`;

    output += '（macOS 不支持单独列出 node 进程的 CPU/内存）\n';

    return output + guideLine;
  }

  return 'Platform not supported for system monitoring.';
}

module.exports = { getSystemMonitorInfo };