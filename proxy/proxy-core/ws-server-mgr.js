'use strict';

/**
 * WebSocket server manager extracted from @bachi/anyproxy/lib/wsServerMgr.js.
 *
 * Creates ws.Server instances attached to HTTP/HTTPS servers,
 * wiring up connection callbacks and the x-anyproxy-websocket header.
 */

const ws = require('ws');
const logUtil = require('./log');

const WsServer = ws.Server;

/**
 * Create a new WebSocket server attached to the given HTTP(S) server.
 *
 * @param {object} config
 * @param {http.Server|https.Server} config.server
 * @param {function} config.connHandler
 * @returns {ws.Server}
 */
function getWsServer(config) {
  const wss = new WsServer({
    server: config.server
  });

  wss.on('connection', config.connHandler);

  wss.on('headers', (headers) => {
    headers.push('x-anyproxy-websocket:true');
  });

  wss.on('error', (e) => {
    logUtil.error(`error in websocket proxy: ${e.message},\r\n ${e.stack}`);
    console.error('error happened in proxy websocket:', e);
  });

  wss.on('close', () => {
    console.error('==> closing the ws server');
  });

  return wss;
}

module.exports.getWsServer = getWsServer;
