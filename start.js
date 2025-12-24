#!/usr/bin/env node

const { spawn, exec } = require('child_process');
const path = require('path');

const appDir = process.cwd(); // 获取当前工作目录，通常是 /app

console.log('Starting initialization script...');

// 1. 执行 npm run cp
console.log('Running pre-start script: npm run cp');
const cpProcess = exec('npm run cp', { cwd: appDir }, (error, stdout, stderr) => {
  if (error) {
    console.error(`Error executing 'npm run cp': ${error.message}`);
    process.exit(1); // 如果 npm run cp 失败，则退出脚本，导致容器重启或失败
  }
  if (stderr) {
    console.error(`stderr from 'npm run cp': ${stderr}`);
  }
  console.log(`stdout from 'npm run cp': ${stdout}`);

  // 2. npm run cp 成功后，启动 PM2
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
      // 注意：这里 PM2 启动命令本身可能很快结束（因为它启动了守护进程）
      // 但我们主要关心的是它是否成功启动了应用实例
      // 如果 PM2 启动失败，可能需要更复杂的错误处理
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
});

cpProcess.on('error', (err) => {
  console.error('Failed to execute npm run cp:', err);
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
    // 可以选择退出脚本，让 Docker 容器重启
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
  // 可以在这里向子进程发送关闭信号
  // 例如，可以调用 npx pm2 stop 或 npx pm2 delete
  // 但通常让 Docker 处理进程生命周期即可
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

