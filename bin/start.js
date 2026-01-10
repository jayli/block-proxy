#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

// 获取包根目录和 start.js 路径
const pkgDir = path.join(__dirname, '..');
const startScript = path.resolve(pkgDir, 'server/start.js');

// 构造命令：先运行 npm run cp，再运行 node server/start.js
const command = `npm run cp && node "${startScript}"`;

console.error(`[💟] Block-Proxy 启动: ${command}`);

// 使用 spawn + shell: true 来支持 && 和管道
const child = spawn(command, {
  cwd: pkgDir,
  shell: true,           // ⭐ 必须启用 shell 才能解析 &&、|、> 等
  stdio: 'pipe'          // 我们要手动处理流
});

// 实时输出 stdout（流式）
child.stdout.on('data', (data) => {
  process.stdout.write(data); // 直接写到父进程 stdout
});

// 实时输出 stderr（流式）
child.stderr.on('data', (data) => {
  process.stderr.write(data);
});

// 处理子进程退出
child.on('close', (code, signal) => {
  console.error(`\n[my_app] Process exited with code ${code}`);
  process.exit(code || 0);
});

// 转发 Ctrl+C 信号（重要！）
process.on('SIGINT', () => {
  console.error('\n[my_app] Received SIGINT, shutting down...');
  child.kill('SIGINT'); // 发送中断信号给子进程
  setTimeout(() => {
    child.kill('SIGTERM'); // 2秒后强制终止
  }, 2000);
});
