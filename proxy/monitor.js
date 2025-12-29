const os = require('os');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
// PID 文件路径（用于记录子进程 PID，避免重复启动）
const PID_FILE = path.join(__dirname, 'proxy.pid');
const START_SCRIPT = path.join(__dirname, 'start.js');

function promisifyExec(cmd, timeout = 3000) {
  return new Promise(resolve => {
    exec(cmd, { timeout }, (error, stdout) => {
      resolve(stdout ? stdout.trim() : '');
    });
  });
}

const isLinux = os.platform() === 'linux';

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

async function killNodeExpressProcess() {
  const targetCmd = 'server/express.js';
  const pidsToKill = [];

  // 1. 遍历 /proc 下所有数字目录（即 PIDs）
  const procEntries = await fs.readdir('/proc');
  const pidDirs = procEntries.filter(dir => /^\d+$/.test(dir));

  for (const pid of pidDirs) {
    try {
      // 2. 读取 /proc/<pid>/cmdline
      const cmdlineBuffer = await fs.readFile(`/proc/${pid}/cmdline`);
      // cmdline 是以 \0 分隔的字符串
      const args = cmdlineBuffer.toString().split('\0').filter(arg => arg !== '');
      if (args.length === 0) continue;

      // 3. 重组命令行（与 targetCmd 对比）
      const fullCmd = args.join(' ');
      if (fullCmd.includes(targetCmd)) {
        pidsToKill.push(pid);
      }
    } catch (err) {
      // 进程可能已退出，跳过
      continue;
    }
  }

  if (pidsToKill.length === 0) {
    console.log('未找到进程: node ./proxy/start.js');
    return false;
  }

  let killedCount = 0;
  for (const pid of pidsToKill) {
    try {
      // 4. 先发送 SIGTERM（优雅终止）
      await promisifyExec(`kill -TERM ${pid}`);
      console.log(`已发送 SIGTERM 到 PID ${pid}`);
      killedCount++;
    } catch (err) {
      console.warn(`无法终止 PID ${pid}:`, err.message);
    }
  }

  // 可选：等待几秒后强制 kill（如果需要确保退出）
  // 这里我们只做优雅终止，不立即强杀

  return killedCount > 0;
}

async function isProcessRunning(pid) {
  try {
    // kill -0 不会真的 kill，只是检查进程是否存在
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false; // 进程不存在
  }
}

async function readPidFromFile() {
  try {
    const pidStr = await fs.readFile(PID_FILE, 'utf8');
    const pid = parseInt(pidStr.trim(), 10);
    if (!isNaN(pid) && pid > 0) {
      return pid;
    }
  } catch (e) {
    // 文件不存在或格式错误，忽略
  }
  return null;
}

async function startProxyProcess() {
  // 1. 检查是否已有运行中的进程
  const existingPid = await readPidFromFile();
  if (existingPid && await isProcessRunning(existingPid)) {
    console.log(`proxy 已在运行，PID: ${existingPid}`);
    return { started: false, pid: existingPid };
  }

  // 2. 启动新进程
  console.log(`正在启动 proxy: node ${START_SCRIPT}`);
  const child = spawn('node', [START_SCRIPT], {
    detached: true,        // 与父进程分离（后台运行）
    stdio: 'ignore',       // 不继承 stdin/stdout/stderr
    cwd: __dirname         // 工作目录设为当前目录
  });

  // 3. 让子进程独立运行（父进程退出不影响它）
  child.unref();

  // 4. 保存 PID 到文件
  await fs.writeFile(PID_FILE, String(child.pid), 'utf8');

  console.log(`proxy 已启动，PID: ${child.pid}`);
  return { started: true, pid: child.pid };
}

async function getSystemMonitorInfo() {
  // 非 Linux 平台直接返回提示
  if (!isLinux) {
    return 'cannot access website via the same proxy ip';
  }

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

  return output;
}

module.exports = { 
  getSystemMonitorInfo,
  killNodeExpressProcess,
  startProxyProcess
};