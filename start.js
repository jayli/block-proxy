#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

// 获取当前脚本所在目录
const scriptDir = path.dirname(__filename);

// 启动子进程：在 scriptDir 目录下运行 `npm run start`
const child = spawn('npm', ['run', 'start'], {
  cwd: scriptDir,       // 设置工作目录
  stdio: 'inherit'      // 继承父进程的 stdin/stdout/stderr（可看到日志）
});

// 监听子进程退出
child.on('exit', (code) => {
  process.exit(code);
});

// 监听错误（如 npm 未找到）
child.on('error', (err) => {
  console.error('Failed to start npm:', err.message);
  process.exit(1);
});
