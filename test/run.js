#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const MockServer = require('./lib/mock-server');
const { runAllTests, checkProxyAccessible } = require('./proxy-tests');

// ── 配置 ──────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG = {
  httpProxy: { host: '127.0.0.1', port: 8001, username: 'admin', password: 'admin' },
  socks5: { host: '127.0.0.1', port: 8002, username: 'admin', password: 'admin' },
};

// ── CLI 参数解析 ──────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    httpPort: 8001,
    socks5Port: 8002,
    httpUser: 'admin',
    httpPass: 'admin',
    skipExternal: false,
    autoStart: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--http-port' || a === '-p') opts.httpPort = parseInt(args[++i], 10);
    else if (a === '--socks5-port' || a === '-s') opts.socks5Port = parseInt(args[++i], 10);
    else if (a === '--http-user' || a === '-u') opts.httpUser = args[++i];
    else if (a === '--http-pass') opts.httpPass = args[++i];
    else if (a === '--skip-external') opts.skipExternal = true;
    else if (a === '--auto-start') opts.autoStart = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }

  return opts;
}

function printHelp() {
  console.log(`
Block-Proxy 测试工具

用法: node test/run.js [选项]

选项:
  -p, --http-port <port>    HTTP 代理端口 (默认: 8001)
  -s, --socks5-port <port>  SOCKS5 代理端口 (默认: 8002)
  -u, --http-user <user>    代理认证用户名 (默认: admin)
  --http-pass <pass>         代理认证密码 (默认: admin)
  --skip-external            跳过外部站点测试
  --auto-start               自动启动代理服务 (如未运行)
  -h, --help                 显示帮助信息
`);
  process.exit(0);
}

// ── 输出工具 ──────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function icon(passed) {
  return passed ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
}

function pad(str, len) {
  return str.padEnd(len, ' ');
}

// ── 报告渲染 ──────────────────────────────────────────────

function printReport(data) {
  const { categories, summary } = data;

  console.log('');
  console.log(`${C.bold}${C.cyan}══════════════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}${C.cyan}  Block-Proxy 代理测试报告${C.reset}`);
  console.log(`${C.bold}${C.cyan}══════════════════════════════════════════════════════════${C.reset}`);
  console.log('');

  let maxNameLen = 0;
  for (const cat of categories) {
    for (const r of cat.results) {
      if (r.name.length > maxNameLen) maxNameLen = r.name.length;
    }
  }
  maxNameLen = Math.min(maxNameLen + 4, 70);

  for (const cat of categories) {
    const catIcon = icon(cat.passed);
    console.log(`${C.bold}${catIcon} ${cat.category}${C.reset}`);
    console.log(`${C.dim}${'─'.repeat(58)}${C.reset}`);

    for (const r of cat.results) {
      const statusIcon = icon(r.passed);
      const name = pad(r.name, maxNameLen);
      const dur = `${r.duration}ms`.padStart(8);
      console.log(`  ${statusIcon} ${C.gray}${name}${C.reset} ${dur}  ${r.detail}`);
    }
    console.log('');
  }

  // ── 总结 ──
  console.log(`${C.bold}${'─'.repeat(58)}${C.reset}`);
  console.log(`${C.bold}  总结${C.reset}`);
  console.log(`${C.bold}${'─'.repeat(58)}${C.reset}`);

  const summaryIcon = summary.failed === 0 ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
  console.log(`  ${summaryIcon} 总测试项: ${summary.total}  |  通过: ${summary.passed}  |  失败: ${summary.failed}`);
  console.log(`  分类通过: ${summary.categoriesPassed}/${summary.categoriesTotal}`);

  // 关键指标
  for (const cat of categories) {
    if (cat.metrics) {
      if (cat.metrics.p50 !== undefined) {
        console.log(`  ${C.dim}${cat.category}: P50=${cat.metrics.p50}ms P95=${cat.metrics.p95}ms P99=${cat.metrics.p99}ms${C.reset}`);
      } else if (cat.metrics.qps !== undefined) {
        console.log(`  ${C.dim}${cat.category}: QPS=${cat.metrics.qps} 平均延迟=${cat.metrics.avgLatency}ms${C.reset}`);
      } else if (cat.metrics.mbps !== undefined) {
        console.log(`  ${C.dim}${cat.category}: ${cat.metrics.mbps} MB/s${C.reset}`);
      }
    }
  }

  console.log('');

  // ── 判定 ──
  if (summary.failed === 0) {
    console.log(`${C.green}${C.bold}  ✓ 所有测试通过${C.reset}`);
  } else {
    console.log(`${C.red}${C.bold}  ✗ 存在 ${summary.failed} 个失败项${C.reset}`);
  }
  console.log('');

  return summary.failed === 0;
}

// ── 服务管理 ──────────────────────────────────────────────

async function waitForPort(host, port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { accessible } = await checkProxyAccessible(host, port);
    if (accessible) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

let childProcesses = [];

async function startProxyService(name, scriptPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [scriptPath], {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
    });

    childProcesses.push(proc);

    let started = false;
    proc.stdout.on('data', (data) => {
      const text = data.toString();
      if (!started && (text.includes('start') || text.includes('启动') || text.includes('listen'))) {
        started = true;
        resolve(proc);
      }
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      if (!started && (text.includes('start') || text.includes('启动') || text.includes('listen'))) {
        started = true;
        resolve(proc);
      }
    });

    proc.on('error', reject);

    // timeout fallback
    setTimeout(() => {
      if (!started) {
        started = true;
        resolve(proc);
      }
    }, 3000);
  });
}

function cleanupChildProcesses() {
  for (const proc of childProcesses) {
    try { proc.kill('SIGTERM'); } catch (_) {}
  }
  childProcesses = [];
}

// ── 主流程 ────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  if (opts.help) printHelp();

  const httpProxyConfig = {
    host: '127.0.0.1',
    port: opts.httpPort,
    username: opts.httpUser,
    password: opts.httpPass,
  };

  const socks5Config = {
    host: '127.0.0.1',
    port: opts.socks5Port,
    username: opts.httpUser,
    password: opts.httpPass,
  };

  // ── 检查代理服务状态 ──
  console.log(`${C.bold}检查代理服务...${C.reset}`);

  let [httpStatus, socks5Status] = await Promise.all([
    checkProxyAccessible(httpProxyConfig.host, httpProxyConfig.port, 'HTTP Proxy'),
    checkProxyAccessible(socks5Config.host, socks5Config.port, 'SOCKS5 Proxy'),
  ]);

  console.log(`  HTTP Proxy (${httpProxyConfig.port}): ${httpStatus.accessible ? `${C.green}运行中${C.reset}` : `${C.red}不可达${C.reset}`}`);
  console.log(`  SOCKS5   (${socks5Config.port}): ${socks5Status.accessible ? `${C.green}运行中${C.reset}` : `${C.red}不可达${C.reset}`}`);

  if (!httpStatus.accessible && !socks5Status.accessible) {
    if (opts.autoStart) {
      console.log(`\n${C.yellow}代理服务未运行，自动启动...${C.reset}`);

      startProxyService('proxy', path.join(PROJECT_ROOT, 'proxy/start.js'));
      startProxyService('socks5', path.join(PROJECT_ROOT, 'socks5/start.js'));

      const [httpReady, socks5Ready] = await Promise.all([
        waitForPort(httpProxyConfig.host, httpProxyConfig.port),
        waitForPort(socks5Config.host, socks5Config.port),
      ]);

      if (!httpReady) console.log(`  ${C.red}HTTP Proxy 启动失败${C.reset}`);
      else console.log(`  HTTP Proxy ${C.green}已就绪${C.reset}`);

      if (!socks5Ready) console.log(`  ${C.red}SOCKS5 启动失败${C.reset}`);
      else console.log(`  SOCKS5 ${C.green}已就绪${C.reset}`);

      if (!httpReady && !socks5Ready) {
        console.log(`\n${C.red}无法启动代理服务，请手动启动后再运行测试。${C.reset}`);
        console.log(`启动方式: npm run dev\n`);
        process.exit(1);
      }

      [httpStatus, socks5Status] = await Promise.all([
        checkProxyAccessible(httpProxyConfig.host, httpProxyConfig.port, 'HTTP Proxy'),
        checkProxyAccessible(socks5Config.host, socks5Config.port, 'SOCKS5 Proxy'),
      ]);
    } else {
      console.log(`\n${C.red}代理服务未运行！请先启动代理服务：${C.reset}`);
      console.log(`  npm run dev        # 启动全部服务`);
      console.log(`  npm run proxy      # 仅 HTTP 代理`);
      console.log(`  npm run socks5     # 仅 SOCKS5`);
      console.log(`\n或使用 --auto-start 自动启动\n`);
      process.exit(1);
    }
  }

  const effectiveHttpProxy = httpStatus.accessible ? httpProxyConfig : null;
  const effectiveSocks5 = socks5Status.accessible ? socks5Config : null;

  // ── 启动 Mock Server ──
  console.log(`\n${C.bold}启动 Mock Server...${C.reset}`);
  const mockServer = new MockServer();
  await mockServer.start();
  console.log(`  Mock Server: ${mockServer.baseUrl} ${C.green}就绪${C.reset}`);

  // ── 运行测试 ──
  console.log(`\n${C.bold}开始测试...${C.reset}\n`);

  const startTime = Date.now();
  let allPassed = false;

  try {
    const results = await runAllTests({
      mockBaseUrl: mockServer.baseUrl,
      httpProxy: effectiveHttpProxy,
      socks5: effectiveSocks5,
      skipExternal: opts.skipExternal,
    });

    const elapsed = Date.now() - startTime;
    results._elapsed = elapsed;

    allPassed = printReport(results);
    console.log(`${C.dim}  总耗时: ${(elapsed / 1000).toFixed(1)}s${C.reset}\n`);
  } catch (err) {
    console.error(`${C.red}测试执行异常: ${err.message}${C.reset}`);
    console.error(err.stack);
  } finally {
    // ── 清理 ──
    await mockServer.stop();
    cleanupChildProcesses();
  }

  process.exit(allPassed ? 0 : 1);
}

// 优雅退出
process.on('SIGINT', () => {
  cleanupChildProcesses();
  process.exit(130);
});

process.on('SIGTERM', () => {
  cleanupChildProcesses();
  process.exit(143);
});

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  console.error(err.stack);
  cleanupChildProcesses();
  process.exit(1);
});
