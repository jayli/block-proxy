const os = require('os');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

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
  // --- Linux 实现保持不变 ---
  if (isLinux) {
    let output = '';

    // === 1. 主机名 & 系统信息 ===
    const hostname = os.hostname();
    const platform = os.type(); // e.g., "Linux"
    const release = os.release(); // e.g., kernel version
    output += `主机名：${hostname}\n`;
    output += `系统名称和类型：${platform} ${release}\n\n`;

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

    // === 新增：CPU 负载（Load Average）===
    const [load1, load5, load15] = os.loadavg();
    output += `CPU 负载：${load1.toFixed(2)}, ${load5.toFixed(2)}, ${load15.toFixed(2)}\n`;

    // === 新增：CPU 温度 ===
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
      const [totalKB, usedKB, percStr] = dfLine.split(' ');
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

    // === 6. 所有 node 进程 ===
    output += '所有 node 进程的 CPU 占比和内存占用：\n';

    try {
      const pids = (await fs.readdir('/proc')).filter(pid => /^\d+$/.test(pid));
      let hasNode = false;

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
        const rssKB = await promisifyExec(`awk '/VmRSS/ {print $2}' /proc/${pid}/status 2>/dev/null`);
        const cpuPerc = await promisifyExec(`ps -p ${pid} -o %cpu= 2>/dev/null`);

        const memoryMB = rssKB ? Math.round(parseInt(rssKB) / 1024) : 0;
        const cpuPercent = cpuPerc ? parseFloat(cpuPerc.trim()) || 0 : 0;

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

    // === 1. 主机名 & 系统信息 ===
    // os.hostname() 在 macOS 上也能工作
    const hostname = os.hostname();
    // os.type() 返回 "Darwin"，os.release() 返回 XNU 内核版本
    const platform = os.type(); // "Darwin"
    const release = os.release(); // e.g., "23.5.0"
    output += `主机名：${hostname}\n`;
    // 为了更贴近 macOS 用户习惯，可以显示 "macOS" 而非 "Darwin"
    const osInfo = await promisifyExec('sw_vers -productName').catch(() => 'macOS');
    const osVersion = await promisifyExec('sw_vers -productVersion').catch(() => release);
    output += `系统名称和类型：${osInfo} ${osVersion}\n\n`; // 也可以用 ${platform} ${release} 来保持与 Linux 类似的格式

    // === 2. CPU ===
    const cpuCores = os.cpus().length;
    let cpuUsage = 0;

    // macOS 获取 CPU 使用率需要使用 `top` 或 `iostat` 等命令
    try {
      const topOutput = await promisifyExec('top -l 2 -n 0 | grep -E "^CPU" | tail -1'); // 运行两次 top，取最后一次
      // top 输出示例: "CPU usage: 5.25% user, 6.75% sys, 88.00% idle"
      const match = topOutput.match(/(\d+\.\d+)%\s+idle/);
      if (match) {
        const idlePercent = parseFloat(match[1]);
        cpuUsage = 100 - idlePercent;
      }
    } catch (e) {
      console.error("Error getting CPU usage on macOS:", e);
      cpuUsage = 0; // 设置默认值
    }
    output += `CPU 核数：${cpuCores}，使用占比：${Math.round(cpuUsage)}%\n`;

    // === CPU 负载（Load Average）===
    const [load1, load5, load15] = os.loadavg();
    output += `CPU 负载：${load1.toFixed(2)}, ${load5.toFixed(2)}, ${load15.toFixed(2)}\n`;

    // === CPU 温度 ===
    // macOS 本身不提供标准接口，需要第三方工具如 osx-cpu-temp 或 iStat Menus 的 CLI
    // 这里模拟一个获取方式，如果未安装相关工具，则返回 N/A
    let cpuTemp = 'N/A';
    try {
      // 尝试使用 osx-cpu-temp (需要预先安装: brew install osx-cpu-temp)
      const tempOutput = await promisifyExec('osx-cpu-temp 2>/dev/null || echo "N/A"');
      if (tempOutput && !tempOutput.includes('N/A') && !tempOutput.includes('command not found')) {
        // osx-cpu-temp 输出格式通常是 "45.2°C" 或 "45.2"
        const tempMatch = tempOutput.match(/(\d+\.?\d*)/);
        if (tempMatch) {
          const tempValue = parseFloat(tempMatch[1]);
          if (!isNaN(tempValue) && tempValue > 0 && tempValue < 120) {
             cpuTemp = `${tempValue}°C`;
          }
        }
      }
    } catch (e) {
      // 忽略错误，保持 N/A
    }
    output += `CPU 温度：${cpuTemp}\n`; // 即使是 N/A 也按格式输出

    // === 3. Memory ===
    const totalMem = os.totalmem();
    const freeMem = os.freemem(); // 注意：os.freemem() 在 macOS 上可能不准确，它返回的是 "free" 内存，不包含 "inactive"
    // 更准确的可用内存计算可能需要使用 `vm_stat` 或其他命令
    // 这里先使用 os.freemem() 计算已用内存，与 Linux 逻辑保持一致
    const usedMem = totalMem - freeMem;
    const memTotalMB = Math.round(totalMem / 1024 / 1024);
    const memUsedMB = Math.round(usedMem / 1024 / 1024);
    const memPercent = Math.round((usedMem / totalMem) * 100);
    output += `内存总数：${memTotalMB} MB，使用数量：${memUsedMB} MB，使用占比：${memPercent}%\n`;

    // === 4. Disk ===
    let diskUsedGB = 'N/A', diskTotalGB = 'N/A', diskPerc = 'N/A';
    try {
      // macOS 上 df 命令同样可用
      const dfLine = await promisifyExec(`df -g / | awk 'NR==2 {print $2,$3,$5}'`); // -g 以 GB 为单位
      const [totalGB, usedGB, percStr] = dfLine.split(/\s+/);
      if (totalGB && usedGB && percStr) {
        diskUsedGB = Math.round(parseFloat(usedGB));
        diskTotalGB = Math.round(parseFloat(totalGB));
        diskPerc = percStr.replace('%', '');
      }
    } catch (e) {
      console.error("Error getting disk usage on macOS:", e);
    }
    output += `硬盘总数：${diskTotalGB} GB，使用数量：${diskUsedGB} GB，使用占比：${diskPerc}%\n`;

    // === 5. TCP / UDP Connections ===
    let tcp = 0, udp = 0;
    try {
      // macOS 使用 netstat 命令
      tcp = (await promisifyExec("netstat -an -p tcp | grep -E '^tcp' | wc -l")).trim();
      udp = (await promisifyExec("netstat -an -p udp | grep -E '^udp' | wc -l")).trim();
      tcp = parseInt(tcp, 10) || 0; // 确保是数字
      udp = parseInt(udp, 10) || 0;
    } catch (e) {
      console.error("Error getting network connections on macOS:", e);
    }
    output += `TCP 连接数：${tcp}，UDP 连接数：${udp}\n\n`;

    return output + guideLine;
  }

  // --- 其他平台 ---
  return 'Platform not supported for system monitoring.';
}

module.exports = { 
  getSystemMonitorInfo
};
