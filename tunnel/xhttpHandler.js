/**
 * xhttp 传输层 HTTP 路由处理器
 *
 * 将 WebSocket 隧道拆分为两个独立 HTTP 通道：
 *   - 上行：POST /xhttp/upload/:sessionId/:seq（每帧一个独立请求）
 *   - 下行：GET  /xhttp/stream?token=<token>&sessionId=<sid>（SSE 长连接）
 *
 * 会话创建：POST /xhttp/create（body 为 AUTH 帧）
 *
 * 流量特征与正常 HTTP API 调用无异，无 WebSocket upgrade 握手。
 */

'use strict';

const crypto = require('crypto');
const { FRAME_TYPES, encodeFrame, decodeFrame, CAP_PADDING } = require('./protocol');
const UploadQueue = require('./uploadQueue');
const { handleDisguiseRequest } = require('./disguiseResponse');

const DEFAULT_BASE_PATH = '/xhttp';
const DEFAULT_SESSION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFERED_POSTS = 64;
const DEFAULT_KEEPALIVE_MIN_MS = 35_000;
const DEFAULT_KEEPALIVE_MAX_MS = 45_000;
const MAX_POST_BODY_SIZE = 70_000; // 略大于 MAX_FRAME_PAYLOAD + header

class XhttpHandler {
  /**
   * @param {object} options
   * @param {string} options.basePath — URL 前缀 (默认 /xhttp)
   * @param {{ username: string, password: string }} options.credentials
   * @param {number} [options.maxBufferedPosts] — 每 session 最大乱序缓冲帧数
   * @param {number} [options.sessionTimeoutMs] — create 后未建 SSE 的超时清理
   * @param {number} [options.keepaliveMinMs] — SSE keepalive 最小间隔
   * @param {number} [options.keepaliveMaxMs] — SSE keepalive 最大间隔
   * @param {boolean} [options.paddingEnabled] — 是否启用响应填充
   * @param {function} options.onFrame — 帧到达回调 (frame, sessionId) => void
   * @param {function} options.onSessionCreated — 新会话回调 (sessionId, token, capabilities) => void
   * @param {function} options.onSessionClosed — 会话关闭回调 (sessionId, token) => void
   */
  constructor(options) {
    this._basePath = (options.basePath || DEFAULT_BASE_PATH).replace(/\/+$/, '');
    this._credentials = options.credentials;
    this._maxBufferedPosts = options.maxBufferedPosts || DEFAULT_MAX_BUFFERED_POSTS;
    this._sessionTimeoutMs = options.sessionTimeoutMs || DEFAULT_SESSION_TIMEOUT_MS;
    this._keepaliveMinMs = options.keepaliveMinMs || DEFAULT_KEEPALIVE_MIN_MS;
    this._keepaliveMaxMs = options.keepaliveMaxMs || DEFAULT_KEEPALIVE_MAX_MS;
    this._paddingEnabled = options.paddingEnabled ?? true;

    this._onFrame = options.onFrame || (() => {});
    this._onSessionCreated = options.onSessionCreated || (() => {});
    this._onSessionClosed = options.onSessionClosed || (() => {});

    /** @type {Map<string, object>} sessionId → session */
    this._sessions = new Map();
    /** @type {Map<string, Set<string>>} token → Set<sessionId> */
    this._tokenSessions = new Map();
  }

  setCredentials(credentials) {
    this._credentials = credentials;
  }

  /**
   * HTTP 请求入口。匹配 xhttp 路径则处理并返回 true，
   * 否则返回 false 由调用方交给 disguiseResponse。
   */
  handleRequest(req, res) {
    const url = new URL(req.url, 'https://localhost');
    const pathname = url.pathname;

    if (!pathname.startsWith(this._basePath + '/') && pathname !== this._basePath) {
      return false;
    }

    const subPath = pathname.slice(this._basePath.length) || '/';

    // POST /xhttp/create
    if (subPath === '/create' && req.method === 'POST') {
      this._handleCreate(req, res);
      return true;
    }

    // POST /xhttp/upload/:sessionId/:seq
    if (subPath.startsWith('/upload/') && req.method === 'POST') {
      const parts = subPath.slice('/upload/'.length).split('/');
      if (parts.length === 2) {
        this._handleUpload(req, res, subPath);
        return true;
      }
      this._sendJson(res, 404, { error: 'not found' });
      return true;
    }

    // GET /xhttp/stream
    if (subPath === '/stream' && req.method === 'GET') {
      this._handleStream(req, res, url);
      return true;
    }

    // OPTIONS 预检
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-padding',
        'access-control-max-age': '86400',
      });
      res.end();
      return true;
    }

    // 不匹配的子路径 → 伪装页面
    handleDisguiseRequest(req, res);
    return true;
  }

  // ── POST /xhttp/create ──────────────────────────────────────────────

  _handleCreate(req, res) {
    this._readBody(req, MAX_POST_BODY_SIZE, (err, body) => {
      if (err) {
        this._sendJson(res, 400, { error: 'bad request' });
        return;
      }

      // body 是 AUTH 帧（含 2-byte length prefix）
      let frame;
      try {
        frame = decodeFrame(body);
      } catch (e) {
        console.warn('[xhttp] Create: failed to decode AUTH frame:', e.message);
        this._sendJson(res, 400, { error: 'bad frame' });
        return;
      }

      if (frame.type !== FRAME_TYPES.AUTH) {
        console.warn('[xhttp] Create: expected AUTH frame, got type', frame.type);
        this._sendJson(res, 400, { error: 'auth required' });
        return;
      }

      // 验证凭据
      if (frame.username !== this._credentials.username ||
          frame.password !== this._credentials.password) {
        console.warn('[xhttp] Create: auth failed for user', frame.username);
        this._sendJson(res, 401, { error: 'auth failed' });
        return;
      }

      // 生成 sessionId
      const sessionId = crypto.randomUUID();
      const token = this._computeToken();
      const clientCapabilities = new Set(frame.capabilities || []);

      // 协商 capabilities
      const serverCapabilities = new Set();
      if (this._paddingEnabled && clientCapabilities.has(CAP_PADDING)) {
        serverCapabilities.add(CAP_PADDING);
      }

      // 创建 session
      const session = {
        sessionId,
        token,
        authenticated: true,
        uploadQueue: new UploadQueue(this._maxBufferedPosts),
        sseRes: null,
        capabilities: serverCapabilities,
        keepaliveTimer: null,
        lastSseWriteAt: 0,
        cleanupTimer: null,
        createdAt: Date.now(),
        consumeLoopRunning: false,
      };

      this._sessions.set(sessionId, session);

      // 注册 token → session 映射
      if (!this._tokenSessions.has(token)) {
        this._tokenSessions.set(token, new Set());
      }
      this._tokenSessions.get(token).add(sessionId);

      // 30 秒内若无 SSE stream 连接则自动清理
      session.cleanupTimer = setTimeout(() => {
        if (!session.sseRes) {
          console.log(`[xhttp] Session ${sessionId} timed out without SSE stream`);
          this._closeSession(sessionId);
        }
      }, this._sessionTimeoutMs);
      session.cleanupTimer.unref();

      // 启动帧消费循环
      this._startConsumeLoop(session);

      // 通知 manager
      this._onSessionCreated(sessionId, token, {
        capabilities: [...serverCapabilities],
      });

      console.log(`[xhttp] Session created: ${sessionId}`);
      this._sendJson(res, 200, { sessionId }, this._buildPaddingHeaders());
    });
  }

  // ── POST /xhttp/upload/:sessionId/:seq ──────────────────────────────

  _handleUpload(req, res, subPath) {
    // 解析 /:sessionId/:seq
    const parts = subPath.slice('/upload/'.length).split('/');
    if (parts.length < 2) {
      this._sendJson(res, 400, { error: 'bad path' });
      return;
    }

    const sessionId = parts[0];
    const seqStr = parts[1];
    const seq = parseInt(seqStr, 10);

    if (isNaN(seq) || seq < 0) {
      this._sendJson(res, 400, { error: 'bad seq' });
      return;
    }

    const session = this._sessions.get(sessionId);
    if (!session) {
      this._sendJson(res, 404, { error: 'session not found' });
      return;
    }

    this._readBody(req, MAX_POST_BODY_SIZE, (err, body) => {
      if (err) {
        this._sendJson(res, 400, { error: 'bad request' });
        return;
      }

      if (body.length === 0) {
        // 空 POST 可能是 keep-alive ping，静默接受
        this._sendJson(res, 200, { ok: true }, this._buildPaddingHeaders());
        return;
      }

      const ok = session.uploadQueue.push(seq, body);
      if (!ok) {
        this._sendJson(res, 503, { error: 'queue overflow' });
        return;
      }

      this._sendJson(res, 200, { ok: true }, this._buildPaddingHeaders());
    });
  }

  // ── GET /xhttp/stream ───────────────────────────────────────────────

  _handleStream(req, res, url) {
    const token = url.searchParams.get('token');
    const sessionId = url.searchParams.get('sessionId');

    if (!token || !sessionId) {
      this._sendJson(res, 400, { error: 'missing token or sessionId' });
      return;
    }

    // 验证 token
    if (!this._verifyToken(token)) {
      console.warn('[xhttp] Stream: invalid token');
      this._sendJson(res, 401, { error: 'invalid token' });
      return;
    }

    const session = this._sessions.get(sessionId);
    if (!session) {
      this._sendJson(res, 404, { error: 'session not found' });
      return;
    }

    // 如果该 session 已有 SSE 连接，关闭旧的
    if (session.sseRes) {
      try { session.sseRes.end(); } catch (_) {}
    }

    // 取消清理定时器（SSE 已连上）
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }

    // 设置 SSE 响应头
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
    });

    // 发送 SSE retry 指令
    session.sseRes = res;
    this._writeSse(session, 'retry: 5000\n\n');

    // 发送 AUTH_OK
    this._pushSseFrame(session, FRAME_TYPES.AUTH_OK, encodeFrame({ type: FRAME_TYPES.AUTH_OK }));

    // 发送 CAPABILITIES（如果有协商结果）
    if (session.capabilities.size > 0) {
      const capsFrame = encodeFrame({
        type: FRAME_TYPES.CAPABILITIES,
        capabilities: [...session.capabilities],
      });
      this._pushSseFrame(session, FRAME_TYPES.CAPABILITIES, capsFrame);
      console.log(`[xhttp] Capabilities negotiated: ${sessionId} caps=${[...session.capabilities].join(',')}`);
    }

    console.log(`[xhttp] SSE stream opened: ${sessionId}`);

    // 启动 keepalive
    this._scheduleKeepalive(session);

    // 处理 SSE 断开
    req.on('close', () => {
      if (session.sseRes === res) {
        console.log(`[xhttp] SSE stream closed: ${sessionId}`);
        session.sseRes = null;
        if (session.keepaliveTimer) {
          clearTimeout(session.keepaliveTimer);
          session.keepaliveTimer = null;
        }
        // SSE 断开不关闭 session，设置重连超时
        if (!session.cleanupTimer) {
          session.cleanupTimer = setTimeout(() => {
            if (!session.sseRes) {
              console.log(`[xhttp] Session ${sessionId} timed out without SSE reconnection`);
              this._closeSession(sessionId);
            }
          }, this._sessionTimeoutMs);
          session.cleanupTimer.unref();
        }
      }
    });
  }

  // ── 下行帧推送 ─────────────────────────────────────────────────────

  /**
   * 向指定 session 的 SSE stream 推送一个帧。
   *
   * @param {string} sessionId
   * @param {Buffer} encodedFrame — 已编码的帧（含 2-byte length prefix）
   * @returns {boolean} 是否成功
   */
  pushFrame(sessionId, encodedFrame) {
    const session = this._sessions.get(sessionId);
    if (!session || !session.sseRes) return false;
    return this._pushSseFrame(session, FRAME_TYPES.DATA, encodedFrame);
  }

  /**
   * 向指定 session 推送任意已编码帧。
   */
  sendEncodedFrame(sessionId, encodedFrame) {
    const session = this._sessions.get(sessionId);
    if (!session || !session.sseRes) return false;
    return this._pushSseFrame(session, 0, encodedFrame);
  }

  /**
   * 检查 token 是否有活跃的 SSE 连接。
   */
  hasActiveSse(token) {
    const sessionIds = this._tokenSessions.get(token);
    if (!sessionIds || sessionIds.size === 0) return false;
    for (const sid of sessionIds) {
      const session = this._sessions.get(sid);
      if (session && session.sseRes) return true;
    }
    return false;
  }

  /**
   * 获取当前活跃的 sessionId（用于 manager.forward()）。
   * 返回最新创建的有 SSE 连接的 session。
   */
  getActiveSessionId() {
    let latest = null;
    let latestTime = 0;
    for (const [sid, session] of this._sessions) {
      if (session.sseRes && session.createdAt > latestTime) {
        latest = sid;
        latestTime = session.createdAt;
      }
    }
    return latest;
  }

  /**
   * 获取 token 对应的活跃 sessionId。
   */
  getActiveSessionIdForToken(token) {
    const sessionIds = this._tokenSessions.get(token);
    if (!sessionIds) return null;
    let latest = null;
    let latestTime = 0;
    for (const sid of sessionIds) {
      const session = this._sessions.get(sid);
      if (session && session.sseRes && session.createdAt > latestTime) {
        latest = sid;
        latestTime = session.createdAt;
      }
    }
    return latest;
  }

  /**
   * 获取连接统计。
   */
  getConnectionCounts() {
    let active = 0;
    let total = 0;
    for (const session of this._sessions.values()) {
      if (!session.authenticated) continue;
      total++;
      if (session.sseRes) active++;
    }
    return { active, candidate: 0, draining: 0, total };
  }

  /**
   * 清理所有 session（服务关闭时调用）。
   */
  closeAll() {
    const sessionIds = [...this._sessions.keys()];
    for (const sid of sessionIds) {
      this._closeSession(sid);
    }
  }

  // ── 内部方法 ──────────────────────────────────────────────────────

  /**
   * 启动 session 的帧消费循环：从 uploadQueue 按序读帧，
   * 解码后调用 _onFrame 回调交给 manager 处理。
   */
  _startConsumeLoop(session) {
    if (session.consumeLoopRunning) return;
    session.consumeLoopRunning = true;

    const loop = async () => {
      try {
        while (!session.uploadQueue.closed) {
          const payload = await session.uploadQueue.read();
          if (payload === null) break; // 队列关闭

          let frame;
          try {
            frame = decodeFrame(payload);
          } catch (e) {
            console.warn(`[xhttp] Frame decode error in session ${session.sessionId}:`, e.message);
            continue;
          }

          try {
            this._onFrame(frame, session.sessionId);
          } catch (e) {
            console.error(`[xhttp] onFrame error for session ${session.sessionId}:`, e.message);
          }
        }
      } catch (e) {
        console.error(`[xhttp] Consume loop error for session ${session.sessionId}:`, e.message);
      } finally {
        session.consumeLoopRunning = false;
      }
    };

    loop().catch((e) => {
      console.error(`[xhttp] Consume loop crashed for session ${session.sessionId}:`, e);
    });
  }

  /**
   * 关闭一个 session：清理队列、定时器、SSE 连接。
   */
  _closeSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    this._sessions.delete(sessionId);

    // 从 token 映射中移除
    const tokenSet = this._tokenSessions.get(session.token);
    if (tokenSet) {
      tokenSet.delete(sessionId);
      if (tokenSet.size === 0) {
        this._tokenSessions.delete(session.token);
      }
    }

    // 清理定时器
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }
    if (session.keepaliveTimer) {
      clearTimeout(session.keepaliveTimer);
      session.keepaliveTimer = null;
    }

    // 关闭 uploadQueue（唤醒所有等待者）
    session.uploadQueue.close();

    // 关闭 SSE 连接
    if (session.sseRes) {
      try { session.sseRes.end(); } catch (_) {}
      session.sseRes = null;
    }

    console.log(`[xhttp] Session closed: ${sessionId}`);
    this._onSessionClosed(sessionId, session.token);
  }

  /**
   * 向 SSE response 推送一个帧事件。
   *
   * @param {object} session
   * @param {number} frameType — 帧类型（仅用于日志）
   * @param {Buffer} encodedFrame — 已编码帧
   * @returns {boolean}
   */
  _pushSseFrame(session, frameType, encodedFrame) {
    try {
      const base64 = encodedFrame.toString('base64');
      return this._writeSse(session, `event: frame\ndata: ${base64}\n\n`);
    } catch (e) {
      console.warn('[xhttp] SSE frame push failed:', e.message);
      return false;
    }
  }

  _writeSse(session, chunk, resetKeepalive = true) {
    const res = session.sseRes;
    if (!res || res.writableEnded) return false;
    try {
      res.write(chunk);
      session.lastSseWriteAt = Date.now();
      if (resetKeepalive && session.keepaliveTimer) {
        this._scheduleKeepalive(session);
      }
      return true;
    } catch (e) {
      console.warn('[xhttp] SSE write failed:', e.message);
      return false;
    }
  }

  /**
   * 调度 SSE keepalive 注释。
   */
  _scheduleKeepalive(session) {
    if (!session.sseRes) return;
    if (session.keepaliveTimer) {
      clearTimeout(session.keepaliveTimer);
      session.keepaliveTimer = null;
    }

    const minMs = Math.max(1, this._keepaliveMinMs);
    const maxMs = Math.max(minMs, this._keepaliveMaxMs);
    const delay = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
    const lastWriteAt = session.lastSseWriteAt || Date.now();
    const timeoutMs = Math.max(1, lastWriteAt + delay - Date.now());

    session.keepaliveTimer = setTimeout(() => {
      session.keepaliveTimer = null;
      if (session.sseRes && !session.sseRes.writableEnded) {
        if (!this._writeSse(session, ': keepalive\n\n', false)) return;
        this._scheduleKeepalive(session);
      }
    }, timeoutMs);
    session.keepaliveTimer.unref();
  }

  /**
   * 读取 HTTP request body。
   */
  _readBody(req, maxSize, callback) {
    const chunks = [];
    let totalLen = 0;

    req.on('data', (chunk) => {
      totalLen += chunk.length;
      if (totalLen > maxSize) {
        req.destroy();
        callback(new Error('body too large'), null);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      callback(null, Buffer.concat(chunks, totalLen));
    });

    req.on('error', (err) => {
      callback(err, null);
    });
  }

  /**
   * 发送 JSON 响应。
   */
  _sendJson(res, statusCode, body, extraHeaders) {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      ...extraHeaders,
    });
    res.end(payload);
  }

  /**
   * 构建随机填充响应头（如果启用）。
   */
  _buildPaddingHeaders() {
    if (!this._paddingEnabled) return {};
    if (Math.random() > 0.3) return {};
    const size = 64 + Math.floor(Math.random() * 449); // 64~512
    const padding = crypto.randomBytes(size).toString('base64');
    return { 'x-padding': padding };
  }

  /**
   * 验证 SSE token。
   */
  _verifyToken(token) {
    if (!token || !this._credentials) return false;
    const expected = this._computeToken();
    return token === expected;
  }

  /**
   * 计算凭据的 token 哈希。
   */
  _computeToken() {
    return crypto
      .createHash('sha256')
      .update(`${this._credentials.username}:${this._credentials.password}`)
      .digest('hex');
  }
}

module.exports = XhttpHandler;
