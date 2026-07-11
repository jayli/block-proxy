#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const { Command } = require('commander');
const program = new Command();
const _fs = require('../proxy/fs.js');

const pkgDir = path.join(__dirname, '..');
const startScript = path.resolve(pkgDir, 'server/start.js');
const MAX_RESTARTS = 10000;
let restartCount = 0;
let restartTimer = null;
let currentChild = null; // 👈 全局引用当前子进程

function startApp() {
  const command = `npm run cp && node "${startScript}"`;
  console.error(`[💟] Block-Proxy 启动 (第 ${restartCount + 1} 次): ${command}`);

  currentChild = spawn(command, {
    cwd: pkgDir,
    shell: true,
    stdio: 'pipe'
  });

  currentChild.stdout.on('data', (data) => {
    process.stdout.write(data);
  });

  currentChild.stderr.on('data', (data) => {
    process.stderr.write(data);
  });

  currentChild.on('close', async (code, signal) => {
    currentChild = null; // 清空引用
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }

    await _fs.clearGlobalConfigFile();

    if (code === 0) {
      console.error('[block proxy] 正常退出，不重启。');
      process.exit(0);
      return;
    }

    if (signal === 'SIGINT' || signal === 'SIGTERM') {
      console.error('[block-proxy] 被信号终止，不重启。');
      process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
      return;
    }

    if (restartCount < MAX_RESTARTS) {
      restartCount++;
      console.error(`[block proxy] 将在 3 秒后自动重启...（已重启 ${restartCount}/${MAX_RESTARTS} 次）`);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        startApp();
      }, 3000);
    } else {
      console.error(`[block proxy] 已达到最大重启次数 (${MAX_RESTARTS})，停止尝试。`);
      process.exit(1);
    }
  });
}

// ✅ 只注册一次 SIGINT 监听器（在 startApp 外部！）
process.on('SIGINT', async () => {
  console.error('\n[block proxy] 收到 SIGINT，正在关闭子进程...');

  await _fs.clearGlobalConfigFile();
  
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  if (currentChild) {
    currentChild.kill('SIGINT');
    // 注意：不要在这里 exit，等 close 事件处理
  } else {
    // 如果没有子进程，直接退出
    process.exit(0);
  }
});

process.on('SIGTERM', () => {
  console.error('\n[block proxy] 收到 SIGTERM，正在关闭子进程...');
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (currentChild) {
    currentChild.kill('SIGTERM');
  } else {
    process.exit(0);
  }
});

(async function() {
  program
    .name('block-proxy')
    .description('极简的 MITM 代理工具：https://github.com/jayli/block-proxy')
    .version('0.1.3')
    .option('-c, --config <config>', 'MITM 配置文件')
    .option('--pubkey <path>', 'Tunnel TLS 公钥证书路径')
    .option('--privkey <path>', 'Tunnel TLS 私钥路径');

  program.parse(process.argv);
  const options = program.opts();

  if (options.config && options.config != "") {
    if (path.isAbsolute(options.config)) {
      await _fs.setGlobalConfigFile(options.config);
    } else {
      var pwd = process.cwd();
      var configFile = path.resolve(pwd, options.config);
      await _fs.setGlobalConfigFile(configFile);
    }
  }

  // 传递 Tunnel TLS 证书路径参数
  if (options.pubkey) {
    process.env.TUNNEL_PUBKEY = path.isAbsolute(options.pubkey)
      ? options.pubkey
      : path.resolve(process.cwd(), options.pubkey);
  }
  if (options.privkey) {
    process.env.TUNNEL_PRIVKEY = path.isAbsolute(options.privkey)
      ? options.privkey
      : path.resolve(process.cwd(), options.privkey);
  }

  // 启动
  startApp();
})();
