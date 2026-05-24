const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

// ── 工具函数 ─────────────────────────────────────────────

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── SOCKS5 客户端 ────────────────────────────────────────

function socks5Connect(targetHost, targetPort, proxyConfig, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const { host, port, username, password } = proxyConfig;
    const rawSocket = net.createConnection({ host, port });

    const timer = setTimeout(() => {
      rawSocket.destroy();
      reject(new Error('SOCKS5: connection timeout'));
    }, timeoutMs);

    function done(err, socket) {
      clearTimeout(timer);
      if (err) {
        if (socket) socket.destroy();
        reject(err);
      } else {
        resolve(socket);
      }
    }

    rawSocket.once('connect', () => {
      const tlsSocket = tls.connect(
        { socket: rawSocket, rejectUnauthorized: false },
        () => {
          // Step 1: Greeting (0x02 = user/password auth)
          tlsSocket.write(Buffer.from([0x05, 0x01, 0x02]));

          tlsSocket.once('data', (data) => {
            if (data.length < 2 || data[0] !== 0x05 || data[1] !== 0x02) {
              return done(new Error(`SOCKS5: unexpected auth method 0x${data[1]?.toString(16)}`), tlsSocket);
            }

            // Step 2: Authentication
            const userBuf = Buffer.from(username || '');
            const passBuf = Buffer.from(password || '');
            const authMsg = Buffer.concat([
              Buffer.from([0x01, userBuf.length]),
              userBuf,
              Buffer.from([passBuf.length]),
              passBuf,
            ]);
            tlsSocket.write(authMsg);

            tlsSocket.once('data', (authResp) => {
              if (authResp.length < 2 || authResp[0] !== 0x01 || authResp[1] !== 0x00) {
                return done(new Error('SOCKS5: authentication failed'), tlsSocket);
              }

              // Step 3: CONNECT command (0x03 = domain name)
              const hostBuf = Buffer.from(targetHost);
              const portBuf = Buffer.alloc(2);
              portBuf.writeUInt16BE(targetPort, 0);

              const connectMsg = Buffer.concat([
                Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
                hostBuf,
                portBuf,
              ]);
              tlsSocket.write(connectMsg);

              tlsSocket.once('data', (connectResp) => {
                const replyCode = connectResp[1];
                if (replyCode !== 0x00) {
                  const errors = {
                    0x01: 'General failure', 0x02: 'Connection not allowed',
                    0x03: 'Network unreachable', 0x04: 'Host unreachable',
                    0x05: 'Connection refused', 0x06: 'TTL expired',
                    0x07: 'Command not supported', 0x08: 'Address type not supported',
                  };
                  return done(new Error(`SOCKS5 CONNECT: ${errors[replyCode] || `code ${replyCode}`}`), tlsSocket);
                }
                done(null, tlsSocket);
              });
            });
          });
        }
      );

      tlsSocket.once('error', (err) => done(new Error(`SOCKS5 TLS: ${err.message}`), tlsSocket));
    });

    rawSocket.once('error', (err) => done(new Error(`SOCKS5 TCP: ${err.message}`), rawSocket));
  });
}

function socks5HttpGet(targetHost, targetPort, path, proxyConfig, timeoutMs = 10000) {
  return socks5Connect(targetHost, targetPort, proxyConfig, timeoutMs).then((socket) => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('SOCKS5 HTTP: request timeout'));
      }, timeoutMs);

      const chunks = [];
      socket.on('data', (c) => chunks.push(c));
      socket.once('end', () => {
        clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString();
        resolve(parseHttpResponse(raw));
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`SOCKS5 HTTP: ${err.message}`));
      });

      const hostHeader = targetPort !== 80 ? `${targetHost}:${targetPort}` : targetHost;
      const req = [
        `GET ${path} HTTP/1.1`,
        `Host: ${hostHeader}`,
        'Connection: close',
        'User-Agent: block-proxy-test/1.0',
        '',
        '',
      ].join('\r\n');
      socket.write(req);
    });
  });
}

function parseHttpResponse(raw) {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd === -1) return { status: 0, headers: {}, body: raw };

  const headerPart = raw.substring(0, headerEnd);
  const body = raw.substring(headerEnd + 4);
  const lines = headerPart.split('\r\n');
  const statusLine = lines[0];
  const statusMatch = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(':');
    if (colonIdx > 0) {
      headers[lines[i].substring(0, colonIdx).trim().toLowerCase()] = lines[i].substring(colonIdx + 1).trim();
    }
  }

  return { status, headers, body };
}

// ── HTTP 代理请求工具 ─────────────────────────────────────

function createProxyAxios(proxyConfig, timeoutMs = 10000) {
  const axios = require('axios');
  const auth = proxyConfig.username
    ? `${encodeURIComponent(proxyConfig.username)}:${encodeURIComponent(proxyConfig.password)}@`
    : '';
  const proxyUrl = `http://${auth}${proxyConfig.host}:${proxyConfig.port}`;

  return axios.create({
    httpAgent: new HttpProxyAgent(proxyUrl),
    httpsAgent: new HttpsProxyAgent(proxyUrl),
    timeout: timeoutMs,
    validateStatus: () => true,
  });
}

function timed(fn) {
  return async (...args) => {
    const start = Date.now();
    let error = null;
    let result = null;
    try {
      result = await fn(...args);
    } catch (e) {
      error = e;
    }
    return { result, error, duration: Date.now() - start };
  };
}

// ── 连通性检查 ────────────────────────────────────────────

async function checkProxyAccessible(host, port, label) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port, timeout: 3000 });
    sock.on('connect', () => {
      sock.destroy();
      resolve({ accessible: true, label });
    });
    sock.on('error', () => {
      sock.destroy();
      resolve({ accessible: false, label });
    });
    sock.on('timeout', () => {
      sock.destroy();
      resolve({ accessible: false, label });
    });
  });
}

// ── 测试：HTTP 代理连通性 ─────────────────────────────────

async function testHttpProxyConnectivity(mockBaseUrl, proxyConfig) {
  const results = [];
  const client = createProxyAxios(proxyConfig);

  // HTTP to mock server
  {
    const { result, error, duration } = await timed(() => client.get(`${mockBaseUrl}/ping`))();
    const bodyOk = result?.data === 'pong';
    results.push({
      name: 'HTTP 代理 > HTTP GET /ping (mock)',
      passed: !error && result?.status === 200 && bodyOk,
      duration,
      detail: error ? error.message
        : !bodyOk ? `status=${result?.status}, body="${String(result?.data).substring(0, 60)}"`
        : `status=${result?.status}`,
    });
  }

  // HTTP with larger payload
  {
    const { result, error, duration } = await timed(() => client.get(`${mockBaseUrl}/size/102400`))();
    const sizeOk = result?.headers?.['content-length'] === '102400';
    results.push({
      name: 'HTTP 代理 > HTTP GET /size/100k (mock)',
      passed: !error && result?.status === 200 && sizeOk,
      duration,
      detail: error ? error.message : `status=${result?.status}, size=${result?.headers?.['content-length'] || '?'}`,
    });
  }

  // HTTP POST echo
  {
    const payload = 'x'.repeat(1024);
    const { result, error, duration } = await timed(() => client.post(`${mockBaseUrl}/echo`, payload, {
      headers: { 'Content-Type': 'text/plain' },
    }))();
    let bodyOk = false;
    try {
      const echoData = typeof result?.data === 'string' ? JSON.parse(result.data) : result?.data;
      bodyOk = echoData?.bodyLength === 1024;
    } catch (_) {}
    results.push({
      name: 'HTTP 代理 > HTTP POST /echo (mock)',
      passed: !error && result?.status === 200 && bodyOk,
      duration,
      detail: error ? error.message : `status=${result?.status}`,
    });
  }

  // HTTPS to external site
  {
    const HTTPS_TIMEOUT = 30000;
    const extClient = createProxyAxios(proxyConfig, HTTPS_TIMEOUT);
    const { result, error, duration } = await timed(() => extClient.get('https://www.baidu.com', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }))();
    results.push({
      name: 'HTTP 代理 > HTTPS GET baidu.com',
      passed: !error && result?.status === 200,
      duration,
      detail: error ? error.message : `status=${result?.status}`,
    });
  }

  return {
    category: 'HTTP 代理 - 连通性',
    passed: results.every((r) => r.passed),
    results,
  };
}

// ── 测试：HTTP 代理延迟 ──────────────────────────────────

async function testHttpProxyLatency(mockBaseUrl, proxyConfig, samples = 50) {
  const client = createProxyAxios(proxyConfig);
  const durations = [];
  const errors = [];

  for (let i = 0; i < samples; i++) {
    const { error, duration } = await timed(() => client.get(`${mockBaseUrl}/size/10240`))();
    if (error) {
      errors.push(error.message);
    } else {
      durations.push(duration);
    }
  }

  const passed = errors.length <= samples * 0.05; // 95% success
  return {
    category: 'HTTP 代理 - 延迟',
    passed,
    results: [{
      name: `延迟测试 (10KB x ${samples})`,
      passed,
      duration: Math.round(mean(durations)),
      detail: passed
        ? `P50=${Math.round(percentile(durations, 50))}ms P95=${Math.round(percentile(durations, 95))}ms P99=${Math.round(percentile(durations, 99))}ms avg=${Math.round(mean(durations))}ms`
        : `${errors.length}/${samples} 失败`,
    }],
    metrics: {
      samples: durations.length,
      errors: errors.length,
      p50: Math.round(percentile(durations, 50)),
      p95: Math.round(percentile(durations, 95)),
      p99: Math.round(percentile(durations, 99)),
      min: Math.round(Math.min(...durations)),
      max: Math.round(Math.max(...durations)),
      avg: Math.round(mean(durations)),
    },
  };
}

// ── 测试：HTTP 代理并发 ──────────────────────────────────

async function testHttpProxyConcurrency(mockBaseUrl, proxyConfig, concurrency = 50, total = 100) {
  const client = createProxyAxios(proxyConfig);
  let idx = 0;
  const durations = [];
  const errors = [];

  async function worker() {
    while (idx < total) {
      const cur = idx++;
      const { result, error, duration } = await timed(() => client.get(`${mockBaseUrl}/size/10240`))();
      if (error || result?.status !== 200) {
        errors.push(`#${cur}: ${error ? error.message : 'status=' + result?.status}`);
      } else {
        durations.push(duration);
      }
    }
  }

  const start = Date.now();
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  const elapsed = Date.now() - start;

  const qps = total / (elapsed / 1000);
  const passed = errors.length === 0;

  return {
    category: 'HTTP 代理 - 并发吞吐',
    passed,
    results: [{
      name: `并发测试 (${concurrency}并发, ${total}请求, 10KB)`,
      passed,
      duration: elapsed,
      detail: passed
        ? `QPS=${qps.toFixed(1)} 平均延迟=${Math.round(mean(durations))}ms`
        : `失败 ${errors.length}/${total}: ${errors.slice(0, 3).join(', ')}`,
    }],
    metrics: {
      concurrency,
      total,
      qps: Math.round(qps * 10) / 10,
      avgLatency: Math.round(mean(durations)),
      elapsed,
      errors: errors.length,
    },
  };
}

// ── 测试：HTTP 代理稳定性 ─────────────────────────────────

async function testHttpProxyStability(mockBaseUrl, proxyConfig, count = 100) {
  const client = createProxyAxios(proxyConfig);
  const durations = [];
  const errors = [];

  for (let i = 0; i < count; i++) {
    const { error, duration } = await timed(() => client.get(`${mockBaseUrl}/ping`))();
    if (error) {
      errors.push({ index: i, message: error.message });
    } else {
      durations.push(duration);
    }
  }

  const successRate = (count - errors.length) / count;
  const passed = successRate === 1.0;

  return {
    category: 'HTTP 代理 - 稳定性',
    passed,
    results: [{
      name: `稳定性测试 (${count} 次顺序请求)`,
      passed,
      duration: Math.round(mean(durations)),
      detail: passed
        ? `成功率 ${(successRate * 100).toFixed(0)}% avg=${Math.round(mean(durations))}ms P95=${Math.round(percentile(durations, 95))}ms`
        : `成功率 ${(successRate * 100).toFixed(1)}% 失败 ${errors.length} 次`,
    }],
    metrics: {
      total: count,
      success: count - errors.length,
      failed: errors.length,
      avg: Math.round(mean(durations)),
      p95: Math.round(percentile(durations, 95)),
      max: durations.length > 0 ? Math.round(Math.max(...durations)) : 0,
    },
  };
}

// ── 测试：HTTP 代理吞吐量 ────────────────────────────────

async function testHttpProxyThroughput(mockBaseUrl, proxyConfig, sizeBytes = 1048576) {
  const client = createProxyAxios(proxyConfig, 30000);
  const { result, error, duration } = await timed(() => client.get(`${mockBaseUrl}/size/${sizeBytes}`, {
    responseType: 'arraybuffer',
  }))();

  const mbps = error ? 0 : (sizeBytes / (1024 * 1024)) / (duration / 1000);
  const passed = !error && result?.status === 200;

  return {
    category: 'HTTP 代理 - 吞吐量',
    passed,
    results: [{
      name: `吞吐量测试 (${formatBytes(sizeBytes)} 下载)`,
      passed,
      duration,
      detail: passed
        ? `${mbps.toFixed(2)} MB/s (${formatDuration(duration)})`
        : (error ? error.message : `status=${result?.status}`),
    }],
    metrics: {
      sizeBytes,
      duration,
      mbps: Math.round(mbps * 100) / 100,
    },
  };
}

// ── 测试：SOCKS5 连通性 ──────────────────────────────────

async function testSocks5Connectivity(mockBaseUrl, proxyConfig) {
  const mockUrl = new URL(mockBaseUrl);
  const mockHost = mockUrl.hostname;
  const mockPort = parseInt(mockUrl.port, 10) || 80;
  const results = [];

  // SOCKS5 GET /ping
  {
    const { result, error, duration } = await timed(() =>
      socks5HttpGet(mockHost, mockPort, '/ping', proxyConfig)
    )();
    const bodyOk = result?.body === 'pong';
    results.push({
      name: 'SOCKS5 > HTTP GET /ping (mock)',
      passed: !error && result?.status === 200 && bodyOk,
      duration,
      detail: error ? error.message
        : !bodyOk ? `status=${result?.status}, body="${String(result?.body).substring(0, 60)}"`
        : `status=${result?.status}`,
    });
  }

  // SOCKS5 GET /size/100k
  {
    const { result, error, duration } = await timed(() =>
      socks5HttpGet(mockHost, mockPort, '/size/102400', proxyConfig)
    )();
    results.push({
      name: 'SOCKS5 > HTTP GET /size/100k (mock)',
      passed: !error && result?.status === 200,
      duration,
      detail: error ? error.message : `status=${result?.status}`,
    });
  }

  // SOCKS5 to external
  {
    const { result, error, duration } = await timed(() =>
      socks5HttpGet('www.baidu.com', 80, '/', proxyConfig, 15000)
    )();
    results.push({
      name: 'SOCKS5 > HTTP GET baidu.com',
      passed: !error && (result?.status === 200 || result?.status === 302),
      duration,
      detail: error ? error.message : `status=${result?.status}`,
    });
  }

  return {
    category: 'SOCKS5 - 连通性',
    passed: results.every((r) => r.passed),
    results,
  };
}

// ── 测试：SOCKS5 延迟 ────────────────────────────────────

async function testSocks5Latency(mockBaseUrl, proxyConfig, samples = 30) {
  const mockUrl = new URL(mockBaseUrl);
  const mockHost = mockUrl.hostname;
  const mockPort = parseInt(mockUrl.port, 10) || 80;
  const durations = [];
  const errors = [];

  for (let i = 0; i < samples; i++) {
    const { result, error, duration } = await timed(() =>
      socks5HttpGet(mockHost, mockPort, '/size/10240', proxyConfig)
    )();
    if (error) {
      errors.push(error.message);
    } else if (result?.status === 200) {
      durations.push(duration);
    } else {
      errors.push(`unexpected status ${result?.status}`);
    }
  }

  const passed = errors.length <= samples * 0.1;
  return {
    category: 'SOCKS5 - 延迟',
    passed,
    results: [{
      name: `延迟测试 (10KB x ${samples})`,
      passed,
      duration: Math.round(mean(durations)),
      detail: durations.length > 0
        ? `P50=${Math.round(percentile(durations, 50))}ms P95=${Math.round(percentile(durations, 95))}ms avg=${Math.round(mean(durations))}ms`
        : `全部失败: ${errors[0]}`,
    }],
    metrics: {
      samples: durations.length,
      errors: errors.length,
      p50: Math.round(percentile(durations, 50)),
      p95: Math.round(percentile(durations, 95)),
      avg: Math.round(mean(durations)),
    },
  };
}

// ── 测试：SOCKS5 并发 ────────────────────────────────────

async function testSocks5Concurrency(mockBaseUrl, proxyConfig, concurrency = 25, total = 50) {
  const mockUrl = new URL(mockBaseUrl);
  const mockHost = mockUrl.hostname;
  const mockPort = parseInt(mockUrl.port, 10) || 80;
  let idx = 0;
  const durations = [];
  const errors = [];

  async function worker() {
    while (idx < total) {
      const cur = idx++;
      const { result, error, duration } = await timed(() =>
        socks5HttpGet(mockHost, mockPort, '/size/10240', proxyConfig)
      )();
      if (error || result?.status !== 200) {
        errors.push(`#${cur}: ${error ? error.message : 'status=' + result?.status}`);
      } else {
        durations.push(duration);
      }
    }
  }

  const start = Date.now();
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  const elapsed = Date.now() - start;

  const qps = total / (elapsed / 1000);
  const passed = errors.length <= total * 0.05;

  return {
    category: 'SOCKS5 - 并发',
    passed,
    results: [{
      name: `并发测试 (${concurrency}并发, ${total}请求, 10KB)`,
      passed,
      duration: elapsed,
      detail: passed
        ? `QPS=${qps.toFixed(1)} 平均延迟=${Math.round(mean(durations))}ms`
        : `失败 ${errors.length}/${total}: ${errors.slice(0, 3).join(', ')}`,
    }],
    metrics: {
      concurrency,
      total,
      qps: Math.round(qps * 10) / 10,
      avgLatency: Math.round(mean(durations)),
      elapsed,
      errors: errors.length,
    },
  };
}

// ── 测试：外部站点综合 ────────────────────────────────────

async function testExternalSites(proxyConfig) {
  const client = createProxyAxios(proxyConfig, 15000);
  const sites = [
    { name: 'baidu.com (HTTP)', url: 'http://www.baidu.com' },
    { name: 'baidu.com (HTTPS)', url: 'https://www.baidu.com' },
    { name: 'github.com (HTTPS)', url: 'https://github.com' },
    { name: 'bing.com (HTTPS)', url: 'https://www.bing.com' },
  ];

  const results = [];
  for (const site of sites) {
    const { result, error, duration } = await timed(() => client.get(site.url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      maxRedirects: 5,
    }))();
    results.push({
      name: `外部站点 > ${site.name}`,
      passed: !error && result?.status >= 200 && result?.status < 400,
      duration,
      detail: error ? error.message : `status=${result?.status}`,
    });
  }

  return {
    category: '外部站点 - 连通性',
    passed: results.filter((r) => r.passed).length >= 2,
    results,
  };
}

// ── 主入口 ────────────────────────────────────────────────

async function runAllTests(options) {
  const {
    mockBaseUrl,
    httpProxy,
    socks5,
    skipExternal = false,
  } = options;

  const allResults = [];

  // ── HTTP 代理测试 ──
  if (httpProxy) {
    allResults.push(await testHttpProxyConnectivity(mockBaseUrl, httpProxy));
    allResults.push(await testHttpProxyLatency(mockBaseUrl, httpProxy));
    allResults.push(await testHttpProxyConcurrency(mockBaseUrl, httpProxy));
    allResults.push(await testHttpProxyStability(mockBaseUrl, httpProxy));
    allResults.push(await testHttpProxyThroughput(mockBaseUrl, httpProxy));
  }

  // ── SOCKS5 测试 ──
  if (socks5) {
    allResults.push(await testSocks5Connectivity(mockBaseUrl, socks5));
    allResults.push(await testSocks5Latency(mockBaseUrl, socks5));
    allResults.push(await testSocks5Concurrency(mockBaseUrl, socks5));
  }

  // ── 外部站点 ──
  if (!skipExternal && httpProxy) {
    allResults.push(await testExternalSites(httpProxy));
  }

  // ── 汇总 ──
  const flatResults = allResults.flatMap((c) => c.results);
  const passed = flatResults.filter((r) => r.passed).length;
  const failed = flatResults.filter((r) => !r.passed).length;

  return {
    categories: allResults,
    summary: {
      total: flatResults.length,
      passed,
      failed,
      categoriesPassed: allResults.filter((c) => c.passed).length,
      categoriesTotal: allResults.length,
    },
  };
}

module.exports = {
  runAllTests,
  checkProxyAccessible,
  socks5Connect,
  socks5HttpGet,
};
