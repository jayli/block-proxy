#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const pkgDir = path.join(__dirname, '..');
const startScript = path.resolve(pkgDir, 'server/start.js');
const MAX_RESTARTS = 10000; // 最多重启 10000 次
let restartCount = 0;

function startApp() {
  const command = `npm run cp && node "${startScript}"`;
  console.error(`[💟] Block-Proxy 启动 (第 ${restartCount + 1} 次): ${command}`);

  const child = spawn(command, {
    cwd: pkgDir,
    shell: true,
    stdio: 'pipe'
  });

  child.stdout.on('data', (data) => {
    process.stdout.write(data);
  });

  child.stderr.on('data', (data) => {
    process.stderr.write(data);
  });

  child.on('close', (code, signal) => {
    console.error(`\n[my_app] 进程退出，code=${code}, signal=${signal}`);

    // 正常退出（例如手动 Ctrl+C 并已处理）则不再重启
    if (code === 0) {
      console.error('[my_app] 正常退出，不重启。');
      process.exit(0);
    }

    // 如果是被 SIGINT/SIGTERM 主动终止，也不重启（比如用户想停服务）
    if (signal === 'SIGINT' || signal === 'SIGTERM') {
      console.error('[my_app] 被信号终止，不重启。');
      process.exit(128 + (signal === 'SIGINT' ? 2 : 15)); // 标准退出码
    }

    // 异常崩溃：尝试重启
    if (restartCount < MAX_RESTARTS) {
      restartCount++;
      console.error(`[my_app] 将在 3 秒后自动重启...（已重启 ${restartCount}/${MAX_RESTARTS} 次）`);
      setTimeout(() => {
        startApp(); // 递归重启
      }, 3000);
    } else {
      console.error(`[my_app] 已达到最大重启次数 (${MAX_RESTARTS})，停止尝试。`);
      process.exit(1);
    }
  });

  // 转发 Ctrl+C 到子进程（但不会触发重启）
  process.on('SIGINT', () => {
    console.error('\n[my_app] 收到 SIGINT，正在关闭子进程...');
    child.kill('SIGINT');
    // 注意：这里不要立即 exit，等 child 的 close 事件处理
  });

  // 可选：也监听 SIGTERM
  process.on('SIGTERM', () => {
    console.error('\n[my_app] 收到 SIGTERM，正在关闭子进程...');
    child.kill('SIGTERM');
  });
}

// 启动应用
startApp();