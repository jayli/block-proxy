#!/usr/bin/env node

const { spawn, exec } = require('child_process');
const path = require('path');

const appDir = process.cwd(); // 获取当前工作目录，通常是 /app

console.log('Starting initialization script...');

// 1. 执行 npm run express (作为一个后台进程)
console.log('Running pre-start script: npm run express (in background)...');
const expressProcess = spawn('npm', ['run', 'express'], {
  cwd: appDir,
  stdio: ['pipe', 'pipe', 'pipe'] // 可以根据需要调整 stdio
  // stdio: 'ignore' // 如果你想完全忽略它的输出，也可以这样设置
});

// 监听 express 进程的输出（可选，用于调试）
expressProcess.stdout.on('data', (data) => {
  console.log(`Express stdout: ${data.toString()}`);
});

expressProcess.stderr.on('data', (data) => {
  console.error(`Express stderr: ${data.toString()}`);
});

expressProcess.on('close', (code) => {
  console.log(`Express process exited with code ${code}`);
  // 如果 express 进程意外退出，你可能需要处理这种情况
  // 例如，记录错误或采取其他措施
});

expressProcess.on('error', (err) => {
  console.error('Failed to start npm run express:', err);
  process.exit(1); // 如果启动失败，则退出脚本
});

console.log('npm run express started in the background.');

// 2. 立即启动 PM2 (因为 npm run express 已经在后台运行)
console.log('Starting PM2 with ecosystem.config.js');
const pm2StartProcess = spawn('npx', ['pm2', 'start', 'ecosystem.config.js'], {
  cwd: appDir,
  stdio: ['pipe', 'pipe', 'pipe'] // 继承 stdin, stdout, stderr
});

pm2StartProcess.stdout.on('data', (data) => {
  console.log(`PM2 Start stdout: ${data.toString()}`);
});

pm2StartProcess.stderr.on('data', (data) => {
  console.error(`PM2 Start stderr: ${data.toString()}`);
});

pm2StartProcess.on('close', (code) => {
  if (code !== 0) {
    console.error(`PM2 start process exited with code ${code}`);
    // PM2 启动命令本身失败
    process.exit(1);
  } else {
    console.log('PM2 started successfully.');
  }
  // PM2 启动命令结束后，继续下一步
  startPm2LogTailing();
});

pm2StartProcess.on('error', (err) => {
  console.error('Failed to start PM2 process:', err);
  process.exit(1);
});

// 3. 启动 PM2 日志输出，保持脚本运行
function startPm2LogTailing() {
  console.log('Starting PM2 log tailing...');
  const pm2LogsProcess = spawn('npx', ['pm2', 'logs', '--raw', '--no-color'], {
    cwd: appDir,
    stdio: ['inherit', 'inherit', 'inherit'] // 将 PM2 日志输出直接传递给当前进程的 stdout/stderr
  });

  pm2LogsProcess.on('close', (code) => {
    console.error(`PM2 logs process exited with code ${code}`);
    // 如果 PM2 日志进程意外退出，通常意味着 PM2 守护进程有问题
    process.exit(1);
  });

  pm2LogsProcess.on('error', (err) => {
    console.error('Failed to start PM2 logs process:', err);
    process.exit(1);
  });

  // 保持当前 Node.js 进程运行，直到 PM2 logs 进程结束
  // 由于 stdio 设置为 inherit，日志会直接输出到容器 stdout/stderr
}

// 可选：处理脚本自身的退出信号，优雅地关闭子进程
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  // 你可以向 expressProcess 和 pm2StartProcess 发送信号来尝试终止它们
  // 但通常让 Docker 处理进程生命周期即可
  // 例如：expressProcess.kill('SIGTERM');
  //       exec('npx pm2 delete ecosystem.config.js', { cwd: appDir }); // 或者 stop
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});
