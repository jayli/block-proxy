const https = require('https');
const { encodeFrame } = require('./protocol');
const { handleDisguiseRequest } = require('./disguiseResponse');
const SseControlHandler = require('./sseControl');
const XhttpHandler = require('./xhttpHandler');

const DEFAULT_XHTTP_BASE_PATH = '/xhttp';
const DEFAULT_ROTATION_DRAIN_TIMEOUT = 10;
const DEFAULT_ROTATION_DRAIN_IDLE_TIMEOUT = 20;

class TunnelServer {
  constructor(options) {
    this.port = options.port;
    this.cert = options.cert;
    this.key = options.key;
    this.credentials = options.credentials;
    this.xhttpBasePath = options.xhttpBasePath || options.tunnel_xhttp_base_path || DEFAULT_XHTTP_BASE_PATH;
    this.rotationDrainTimeout = options.rotationDrainTimeout || options.tunnel_rotation_drain_timeout || DEFAULT_ROTATION_DRAIN_TIMEOUT;
    this.rotationDrainIdleTimeout = options.rotationDrainIdleTimeout || options.tunnel_rotation_drain_idle_timeout || DEFAULT_ROTATION_DRAIN_IDLE_TIMEOUT;
    this.paddingEnabled = options.paddingEnabled ?? false;
    this.paddingProbability = Math.max(0, Math.min(1, options.paddingProbability ?? 0.3));
    this.paddingMinBytes = Math.max(0, Math.min(65534, options.paddingMinBytes ?? 64));
    this.paddingMaxBytes = Math.max(this.paddingMinBytes, Math.min(65534, options.paddingMaxBytes ?? 512));
    this.onConnect = options.onConnect || (() => {});
    this.onDisconnect = options.onDisconnect || (() => {});

    this._frameHandlers = [];
    this._server = null;
    this._tunnelManager = null;
    this._drainCheckCallback = null;

    // 旧 SSE 控制路径适配器：只负责 410 迁移提示，xhttp stream 才是下行通道。
    this._sseControlHandler = new SseControlHandler({
      path: options.ssePath || options.tunnel_sse_path || '/api/v1/events',
    });
    this._sseControlHandler.setCredentials(this.credentials);

    // xhttp 处理器（核心）
    this._xhttpHandler = new XhttpHandler({
      basePath: this.xhttpBasePath,
      credentials: this.credentials,
      maxBufferedPosts: options.maxBufferedPosts || 64,
      sessionTimeoutMs: options.sessionTimeoutMs || 30_000,
      keepaliveMinMs: options.sseKeepaliveMinMs || options.tunnel_sse_keepalive_min_ms || 35_000,
      keepaliveMaxMs: options.sseKeepaliveMaxMs || options.tunnel_sse_keepalive_max_ms || 45_000,
      paddingEnabled: this.paddingEnabled,
      paddingProbability: this.paddingProbability,
      paddingMinBytes: this.paddingMinBytes,
      paddingMaxBytes: this.paddingMaxBytes,
      onFrame: (frame, sessionId) => this._handleXhttpFrame(frame, sessionId),
      onSessionCreated: (sessionId, token, info) => this._handleSessionCreated(sessionId, token, info),
      onSessionClosed: (sessionId, token) => this._handleSessionClosed(sessionId, token),
    });

    // 将 xhttpHandler 绑定到 sseControl 适配器
    this._sseControlHandler.setXhttpHandler(this._xhttpHandler);
  }

  start() {
    return new Promise((resolve, reject) => {
      this._server = https.createServer({
        key: this.key,
        cert: this.cert,
        minVersion: 'TLSv1.2',
        sessionTimeout: 300,
      }, (req, res) => this._handleHttpRequest(req, res));

      this._server.once('error', reject);
      this._server.listen(this.port, () => {
        this._server.removeListener('error', reject);
        const localIp = require('../proxy/domain').getLocalIp();
        console.log(`✅ \x1b[32m隧道服务启动 (xhttp)，IP ${localIp}, 端口 ${this.port}\x1b[0m`);
        resolve();
      });
    });
  }

  async stop() {
    this._drainCheckCallback = null;

    // 关闭所有 xhttp sessions
    if (this._xhttpHandler) {
      this._xhttpHandler.closeAll();
    }

    const closeServer = this._server
      ? new Promise((resolve) => {
        const server = this._server;
        this._server = null;
        const timer = setTimeout(resolve, 500);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      })
      : Promise.resolve();

    await closeServer;
  }

  _handleHttpRequest(req, res) {
    // sseControl 适配器会先尝试 xhttpHandler，然后尝试旧 SSE 路径
    if (this._sseControlHandler.handleRequest(req, res)) return;
    handleDisguiseRequest(req, res);
  }

  // ── xhttp 事件处理 ──────────────────────────────────────────────

  /**
   * xhttpHandler 的帧回调：解码后的帧交给 manager 处理。
   */
  _handleXhttpFrame(frame, sessionId) {
    // 分发给所有注册的 frame handlers（兼容旧接口）
    this._frameHandlers.forEach(handler => handler(frame, sessionId));

    // 如果 manager 存在，直接调用 handleFrame
    if (this._tunnelManager && typeof this._tunnelManager.handleFrame === 'function') {
      this._tunnelManager.handleFrame(frame, sessionId);
    }
  }

  /**
   * xhttpHandler 的 session 创建回调。
   */
  _handleSessionCreated(sessionId, token, info) {
    console.log(`[Tunnel] xhttp session created: ${sessionId}`);

    // 通知外部
    this.onConnect(sessionId, token);
  }

  /**
   * xhttpHandler 的 session 关闭回调。
   */
  _handleSessionClosed(sessionId, token) {
    console.log(`[Tunnel] xhttp session closed: ${sessionId}`);

    // 通知外部
    this.onDisconnect(sessionId);
  }

  // ── 公共 API（供 manager 和其他模块调用）───────────────────────

  /**
   * 向指定 session 发送一个帧（编码后通过 SSE 推送）。
   *
   * @param {object} frame — 帧对象（会被 encodeFrame 编码）
   * @param {string} sessionId — 目标 session
   * @returns {Promise<boolean>}
   */
  sendFrame(frame, sessionId) {
    const encoded = encodeFrame(frame);
    return Promise.resolve(this._xhttpHandler.pushFrame(sessionId, encoded));
  }

  /**
   * 向指定 session 推送已编码的帧。
   *
   * @param {string} sessionId
   * @param {Buffer} encodedFrame
   * @returns {boolean}
   */
  sendEncodedFrame(sessionId, encodedFrame) {
    return this._xhttpHandler.pushFrame(sessionId, encodedFrame);
  }

  /**
   * 注册帧处理回调。
   */
  onFrame(handler) {
    this._frameHandlers.push(handler);
  }

  /**
   * 获取当前活跃的 sessionId。
   */
  getActiveSessionId() {
    return this._xhttpHandler.getActiveSessionId();
  }

  getSessionToken(sessionId) {
    const session = this._xhttpHandler._sessions.get(sessionId);
    return session ? session.token : null;
  }

  /**
   * 设置 drain 检查回调（兼容旧接口）。
   */
  setActiveRequestChecker(fn) {
    this._drainCheckCallback = fn;
  }

  /**
   * 获取连接统计。
   */
  getConnectionCounts() {
    return this._xhttpHandler.getConnectionCounts();
  }

  /**
   * 设置 TunnelManager 引用。
   */
  setTunnelManager(manager) {
    this._tunnelManager = manager;
  }

  /**
   * 获取 SseControlHandler（适配器）。
   */
  getSseControlHandler() {
    return this._sseControlHandler;
  }

  /**
   * 获取 XhttpHandler 实例。
   */
  getXhttpHandler() {
    return this._xhttpHandler;
  }
}

module.exports = TunnelServer;
