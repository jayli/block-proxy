const http = require('http');

function getLanIp() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

class MockServer {
  constructor() {
    this.server = null;
    this.port = 0;
    this.host = '0.0.0.0';
    this.lanIp = getLanIp();
  }

  get baseUrl() {
    return `http://${this.lanIp}:${this.port}`;
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        try {
          this._handle(req, res);
        } catch (_err) {
          if (!res.headersSent) {
            res.writeHead(500);
            res.end('Internal Server Error');
          }
        }
      });

      this.server.on('error', reject);
      this.server.listen(0, this.host, () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  _handle(req, res) {
    const url = new URL(req.url, `http://${this.host}`);
    const path = url.pathname;

    if (path === '/ping') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '4' });
      res.end('pong');
      return;
    }

    if (path.startsWith('/size/')) {
      const bytes = parseInt(path.split('/')[2], 10);
      if (isNaN(bytes) || bytes < 0 || bytes > 100 * 1024 * 1024) {
        res.writeHead(400);
        res.end('Invalid size (0-104857600)');
        return;
      }
      const buf = Buffer.alloc(bytes, 0x58);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes),
      });
      res.end(buf);
      return;
    }

    if (path.startsWith('/delay/')) {
      const ms = parseInt(path.split('/')[2], 10);
      if (isNaN(ms) || ms < 0 || ms > 30000) {
        res.writeHead(400);
        res.end('Invalid delay (0-30000)');
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`delayed ${ms}ms`);
      }, ms);
      return;
    }

    if (path.startsWith('/status/')) {
      const code = parseInt(path.split('/')[2], 10) || 200;
      res.writeHead(code);
      res.end(`Status: ${code}`);
      return;
    }

    if (path === '/echo' && req.method === 'POST') {
      const body = [];
      req.on('data', (c) => body.push(c));
      req.on('end', () => {
        const buf = Buffer.concat(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          bodyLength: buf.length,
        }));
      });
      return;
    }

    // default: dump request info
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      method: req.method,
      url: req.url,
      path,
      headers: req.headers,
    }));
  }

  async stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

module.exports = MockServer;
