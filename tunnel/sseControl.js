/**
 * SSE 控制通道适配器
 *
 * 在 xhttp 模式下，SSE 数据通道已迁移到 XhttpHandler 的 /xhttp/stream。
 * 本文件只保留旧 /api/v1/events 路径的迁移提示。
 */

'use strict';

class SseControlHandler {
  /**
   * @param {object} options
   * @param {string} [options.path] — 旧 SSE 路径（保留兼容，实际由 xhttpHandler 处理）
   */
  constructor(options = {}) {
    this._path = options.path || '/api/v1/events';
    this._credentials = null;
    /** @type {import('./xhttpHandler') | null} */
    this._xhttpHandler = null;
  }

  setCredentials(credentials) {
    this._credentials = credentials;
  }

  /**
   * 绑定 xhttpHandler 实例（由 server.js 在启动时调用）。
   */
  setXhttpHandler(handler) {
    this._xhttpHandler = handler;
  }

  /**
   * HTTP 请求入口。
   *
   * 优先委托给 xhttpHandler 处理 /xhttp/* 路由。
   * 对旧 SSE 路径 (/api/v1/events) 返回 404（已迁移到 xhttp stream）。
   */
  handleRequest(req, res) {
    const url = new URL(req.url, 'https://localhost');

    // xhttp 路由 → 委托给 xhttpHandler
    if (this._xhttpHandler) {
      if (this._xhttpHandler.handleRequest(req, res)) {
        return true;
      }
    }

    // 旧 SSE 路径 → 不再支持（返回 410 Gone）
    if (url.pathname === this._path) {
      const payload = JSON.stringify({ error: 'migrated to xhttp', mode: 'xhttp' });
      res.writeHead(410, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      res.end(payload);
      return true;
    }

    return false;
  }

  /**
   * 检查 token 是否有活跃 SSE 连接（委托给 xhttpHandler）。
   */
  hasActiveConnection(token) {
    if (this._xhttpHandler) {
      return this._xhttpHandler.hasActiveSse(token);
    }
    return false;
  }

  clearConnection(token) {
    // xhttp 模式下 session 由 xhttpHandler 管理。
  }
}

module.exports = SseControlHandler;
