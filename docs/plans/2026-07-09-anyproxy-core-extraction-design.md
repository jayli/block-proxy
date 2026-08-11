# AnyProxy Core Extraction Design

**Date**: 2026-07-09
**Status**: Revised after local code review
**Strategy**: Capability-equivalent extraction, then dependency removal

---

## Goal

Move the subset of `node_modules/@bachi/anyproxy` that `block-proxy` actually depends on into this repository, so `package.json` no longer depends on `@bachi/anyproxy`.

The migration must preserve current `block-proxy` behavior. The objective is not to reimplement upstream AnyProxy from scratch, and not to aggressively remove code that looks unused inside AnyProxy but is part of current proxy forwarding behavior.

Current behavior is the combination of:

- `proxy/proxy.js` rule system, authentication, tunnel integration, MITM registry, and lifecycle.
- The local `@bachi/anyproxy` fork under `node_modules`, including its fork-specific changes.
- The extra CONNECT listener override in `proxy/proxy.js` used for reverse tunnel domains.

The extracted core must match that combined behavior.

---

## Current Dependency Surface

`block-proxy` directly uses AnyProxy in these places:

- `AnyProxy.utils.certMgr.ifRootCAFileExists()`
- `AnyProxy.utils.certMgr.generateRootCA()`
- `new AnyProxy.ProxyServer(options)`
- `proxyServerInstance.httpProxyServer` after `ready`, to override CONNECT handling for tunnel domains

`getAnyProxyOptions()` also relies on the rule callback contract:

- `beforeDealHttpsRequest`
- `beforeSendRequest`
- `beforeSendResponse`
- `onError`
- `onConnectError`
- `checkProxyAuth`
- `sendAuthRequired`
- `send407bySocket`
- `responseRules`
- `customConnect`

Important finding: the current AnyProxy fork contains `customConnect` usage in `requestHandler.js`, but `proxy.js` does not pass `config.customConnect` into `RequestHandler`. That is why `proxy/proxy.js` currently re-wraps `httpProxyServer`'s `connect` listener after `ready`.

---

## Required Capabilities To Preserve

These capabilities are in scope and must remain working:

1. HTTP proxy forwarding
   - Absolute-form HTTP requests through the proxy.
   - GET/POST and binary payload forwarding.
   - `beforeSendRequest` rule handling.
   - Local synthetic responses returned from rules.

2. HTTPS CONNECT forwarding without MITM
   - `beforeDealHttpsRequest()` can return `false`.
   - Proxy replies `200 Connection Established`.
   - Client socket is piped to the target server.
   - `head` bytes from Node's CONNECT event must be forwarded.

3. HTTPS MITM
   - `beforeDealHttpsRequest()` can return `true`.
   - Dynamic SNI certificate generation.
   - Internal HTTPS server receives decrypted HTTP requests.
   - `beforeSendRequest` and `beforeSendResponse` run on decrypted requests/responses.
   - Source IP is recovered for MITM requests via socket maps.

4. WebSocket proxy forwarding
   - Plain `ws://` over the HTTP proxy is currently supported through `wsServerMgr`.
   - `wss://` without MITM is supported as raw CONNECT TCP forwarding.
   - `wss://` inside MITM is supported through the internal HTTPS server's `upgrade` path.
   - `wsIntercept: false` does not mean WebSocket support can be removed. It only disables forcing CONNECT WebSocket traffic into the local WS handler.

5. Reverse tunnel domains
   - Tunnel domains must remain pure TCP and must never be MITM-decrypted.
   - Tunnel CONNECT must call `tunnelManager.forward(host, port, callback)`.
   - `head` bytes must be forwarded into the tunnel stream.
   - A tunnel domain must never fall back to `net.connect()` if the tunnel manager returns a failure stream.

6. Response streaming and large response safety
   - Current fork uses `CommonReadableStream` when a response exceeds the chunk threshold.
   - Non-response-rule traffic uses a low threshold for early streaming.
   - Response-rule traffic uses a higher threshold so `beforeSendResponse` can inspect whole bodies.
   - This is core proxy forwarding behavior and must not be removed.

7. Existing fork transport tuning
   - Bounded keep-alive agents.
   - Retry once with a fresh connection on `ECONNRESET`/`EPIPE` for retryable methods.
   - Header handling based on `rawHeaders`.
   - Transfer-Encoding and Content-Length handling compatible with current behavior.

8. Error handling semantics
   - `onError()` is called for remote request errors.
   - `onConnectError()` is called for CONNECT failures.
   - Existing handling for malformed upstream HTTP responses in `proxy/proxy.js` remains intact.

---

## Modules To Extract

```
proxy/
  proxy.js
  proxy-core/
    index.js
    proxy-server.js
    request-handler.js
    https-server-mgr.js
    cert-mgr.js
    util.js
    ws-server-mgr.js
    rule-default.js
    request-error-handler.js
```

### `index.js`

Exports a small AnyProxy-compatible facade:

```js
module.exports = {
  ProxyServer,
  utils: { certMgr }
};
```

This keeps `proxy/proxy.js` migration small.

### `proxy-server.js`

Extract from `node_modules/@bachi/anyproxy/proxy.js`.

Keep:

- `EventEmitter` behavior.
- `ProxyServer` constructor options currently used by `block-proxy`.
- `httpProxyServer` property.
- `start()`, `close()`, socket pool cleanup.
- HTTP and HTTPS proxy server creation.
- CONNECT listener registration.
- WebSocket server registration on the main proxy server.

Remove:

- `Recorder` instantiation and cleanup.
- Web interface startup/shutdown.
- `ProxyRecorder`, `ProxyWebServer`, `systemProxyMgr` exports.
- `colorful` logging dependency.
- `stream-throttle` support unless tests prove it is needed.

Fix during extraction:

- Pass `customConnect: config.customConnect` into `RequestHandler`.

### `request-handler.js`

Extract from `node_modules/@bachi/anyproxy/lib/requestHandler.js`.

Keep:

- HTTP request handler.
- CONNECT request handler.
- WebSocket proxy handler.
- `CommonReadableStream` or an equivalent local stream implementation.
- `responseRules`/`chunkSizeThreshold` behavior.
- keep-alive agents and retry behavior.
- source IP socket map and cleanup.
- rule callback flow.
- local response support.
- stream bypass for large responses.
- `head` handling for CONNECT.

Remove:

- Recorder-specific parameters, fields, and updates.
- `recorder.appendRecord`, `recorder.updateRecord`, `recorder.updateRecordWsMessage`, and any `resourceInfo` state used only for recording.
- `global._throttle` branches if `throttle` is removed.
- `colorful`/`logUtil` dependency, replacing with local lightweight logging.
- Unused `brotli` package import if not referenced. Brotli response decompression in `proxy/proxy.js` already uses Node's `zlib.brotliDecompress`.

Fix during extraction:

- Set `this.customConnect = config.customConnect`.
- Remove recorder from extracted function signatures:
  - `getUserReqHandler(userRule, recorder)` -> `getUserReqHandler(userRule)`
  - `getConnectReqHandler(userRule, recorder, httpsServerMgr)` -> `getConnectReqHandler(userRule, httpsServerMgr)`
  - `getWsHandler(userRule, recorder, wsClient, wsReq)` -> `getWsHandler(userRule, wsClient, wsReq)`
- Preserve `head` bytes by pushing them into `requestStream` before normal socket data:

```js
if (head && head.length > 0) {
  requestStream.push(head);
}
```

- Do not delete `getWsHandler` or `wsServerMgr` integration.

### `https-server-mgr.js`

Extract from `node_modules/@bachi/anyproxy/lib/httpsServerMgr.js`.

Keep:

- SNI HTTPS server creation.
- certificate generation via `certMgr.getCertificate()`.
- SNI context cache.
- active server tracking and close.
- WebSocket server registration on internal HTTPS servers.
- shared-server behavior for SNI hosts.

May replace:

- `async-task-mgr` with a small Promise lock/map.
- `async` with Promise flow.
- colored logging with local logging.

Be careful:

- Do not remove `createHttpsIPServer` unless `proxy/proxy.js` is also changed so IP hosts can never return `true` from `beforeDealHttpsRequest()`. Today `vpn_proxy` can force MITM before the IP bypass check, so IP MITM is reachable.

### `ws-server-mgr.js`

Extract from `node_modules/@bachi/anyproxy/lib/wsServerMgr.js`.

Keep:

- `ws.Server({ server })`.
- `connection` callback wiring.
- `headers` hook adding `x-anyproxy-websocket:true`.
- error handling.

This module is small and directly supports current WebSocket proxy capability.

### `cert-mgr.js`

Extract from `node_modules/@bachi/anyproxy/lib/certMgr.js`.

Keep:

- `node-easy-cert` integration.
- `ifRootCAFileExists`.
- `generateRootCA`.
- inherited methods such as `getCertificate()` and `getRootCAFilePath()`.
- current certificate directory compatibility: `~/.anyproxy/certificates`.
- existing default certificate attributes unless tests confirm changing them is safe.

Remove:

- `trustRootCA`.
- `getCAStatus`.
- `inquirer`, `co`, and OS trust-store commands used only by those functions.

### `util.js`

Extract only helpers needed by local core:

- `merge`
- `freshRequire`
- `getUserHome`
- `getAnyProxyHome`
- `getAnyProxyPath`
- `getHeaderFromRawHeaders`
- `getAllIpAddress` if still referenced
- `getFreePort`
- `collectErrorLog`
- `getByteSize`
- `isIp`

Remove helpers used only by removed AnyProxy modules:

- `filewalker`
- `simpleRender`
- `contentType`
- `contentLength`
- `formatDate`
- `deleteFolderContentsRecursive`
- `execScriptSync`
- `guideToHomePage`

### `rule-default.js`

Extract default rule callbacks. Keep `onClientSocketError`, because current request handler calls it for some client socket errors.

### `request-error-handler.js`

Prefer a minimal local implementation that returns an HTML string.

The current AnyProxy helper ultimately depends on `pug` templates under AnyProxy's `resource/` directory. Pulling that helper as-is would keep an unnecessary template dependency. The extracted core only needs an error response body for `getErrorResponse()`, while `proxy/proxy.js` rule `onError()` still has the chance to replace that response.

---

## Modules Not To Extract

These AnyProxy capabilities are not required by `block-proxy` and can be removed:

- Web monitoring UI.
- Request recorder database and record mutation.
- AnyProxy CLI.
- AnyProxy CA CLI.
- System proxy manager.
- Interactive certificate trust installer.
- Rule loader/config utility for AnyProxy's standalone CLI.
- Traffic throttle implementation, as long as no caller relies on real throttling behavior.

---

## Dependency Plan

Remove:

- `@bachi/anyproxy`

Add direct dependencies only for extracted runtime code:

```json
{
  "dependencies": {
    "node-easy-cert": "^1.0.0",
    "ws": "^5.1.0",
    "co": "^4.6.0"
  }
}
```

`ws` and `co` versions should match the current fork's dependency declarations for the first extraction:

- `node_modules/@bachi/anyproxy/package.json` declares `"ws": "^5.1.0"`.
- `node_modules/@bachi/anyproxy/package.json` declares `"co": "^4.6.0"`.

`co` is intentionally retained for v1. Current request-handler flow calls rule callbacks through `co`/`co.wrap`, and rewriting that to native `async` would be a separate behavior-changing refactor.

Package manager:

- The repository has `package-lock.json`; use `npm install` and commit `package-lock.json`.
- Do not introduce or rely on `pnpm-lock.yaml` unless the project intentionally switches package managers.

---

## `proxy/proxy.js` Integration

The intended end state:

```diff
- const AnyProxy = require('@bachi/anyproxy');
+ const { ProxyServer, utils: { certMgr } } = require('./proxy-core');
```

Then:

```diff
- AnyProxy.utils.certMgr.ifRootCAFileExists()
+ certMgr.ifRootCAFileExists()

- AnyProxy.utils.certMgr.generateRootCA(...)
+ certMgr.generateRootCA(...)

- proxyServerInstance = new AnyProxy.ProxyServer(options);
+ proxyServerInstance = new ProxyServer(options);
```

`getAnyProxyOptions()` keeps:

- `customConnect`
- `rule`
- `forceProxyHttps`
- `silent`
- `timeout`

`wsIntercept` may remain explicit as `false` or be omitted with default false. It must not be used as a reason to remove WebSocket proxy support.

`throttle` should be removed only after the core no longer references `global._throttle`.

The ready-time CONNECT override in `proxy/proxy.js` should be removed after extracted `proxy-core` correctly passes `customConnect` into `RequestHandler` and preserves `head`. Keeping both paths creates duplicated tunnel logic.

---

## Request Flow

### HTTP

```
client request
  -> proxy server request handler
  -> collect request body
  -> build requestDetail
  -> rule.beforeSendRequest()
       -> returns { response }        => local response
       -> returns requestOptions/body => remote fetch
  -> fetchRemoteResponse()
       -> whole body for response-rule matches up to threshold
       -> stream mode for large/non-response-rule bodies
  -> rule.beforeSendResponse() unless stream mode or local response
  -> sendFinalResponse()
```

### CONNECT Without MITM

```
CONNECT host:port
  -> rule.beforeDealHttpsRequest() returns false
  -> write 200 Connection Established
  -> preserve head bytes
  -> customConnect(host, port) if configured and matched
  -> otherwise net.connect(port, host)
  -> bidirectional pipe
```

### CONNECT With MITM

```
CONNECT host:port
  -> rule.beforeDealHttpsRequest() returns true
  -> https-server-mgr returns local HTTPS server
  -> write 200 Connection Established
  -> preserve head bytes
  -> pipe client TLS stream to local HTTPS server
  -> decrypted request enters HTTP request flow
```

### WebSocket

```
ws:// through HTTP proxy
  -> main proxy server upgrade event
  -> wsServerMgr
  -> request-handler getWsHandler()
  -> upstream ws:// connection
  -> message relay both directions

wss:// without MITM
  -> CONNECT path returns false
  -> raw TCP tunnel

wss:// with MITM
  -> CONNECT path returns true
  -> internal HTTPS server upgrade event
  -> wsServerMgr
  -> getWsHandler()
  -> upstream wss:// connection
```

---

## Verification Requirements

Before removing `@bachi/anyproxy`, tests must cover:

- HTTP GET via proxy.
- HTTP POST via proxy.
- HTTPS CONNECT pass-through.
- HTTPS MITM with dynamic cert path.
- `beforeSendRequest` local response.
- `beforeSendResponse` rewrite with gzip/br response body.
- large response streaming without whole-body buffering.
- plain `ws://` proxy.
- `wss://` pass-through.
- `wss://` MITM upgrade path where feasible.
- tunnel domain CONNECT using `tunnelManager.forward`.
- tunnel domain does not MITM.
- CONNECT `head` preservation.
- proxy auth 407 for HTTP and HTTPS CONNECT.
- restart/close cleans sockets and internal HTTPS servers.

Existing `npm run test:proxy` is not sufficient by itself, because it does not currently cover WebSocket, MITM certificate behavior, CONNECT `head`, or large stream mode.

---

## Design Decisions

- Preserve current fork-specific behavior first; reduce dependencies second.
- Do not remove WS support.
- Do not remove stream mode.
- Move tunnel `customConnect` support into local core and remove the external CONNECT listener override after tests pass.
- Keep file names close to the original modules to make code review against `node_modules/@bachi/anyproxy` straightforward.
- Avoid unrelated refactors in `proxy/proxy.js`.

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| WebSocket path accidentally removed | Breaks ws/wss proxy forwarding | Extract `ws-server-mgr.js` and `getWsHandler`; add WS tests |
| Large responses buffered fully | Memory pressure, stalled downloads/streams | Preserve stream threshold behavior |
| Tunnel CONNECT loses `head` bytes | Intermittent TLS/tunnel failures | Explicit head preservation tests |
| `customConnect` double-handled | Tunnel behavior divergence | Move support into core, then remove outer override |
| IP MITM removed while `vpn_proxy` can force MITM | Debug path regression | Keep `createHttpsIPServer` or change `beforeDealHttpsRequest` order intentionally |
| Transitive dependencies disappear | Runtime `Cannot find module` | Add direct deps or rewrite before removing AnyProxy |

---

## Completion Criteria

- `@bachi/anyproxy` is removed from `package.json`.
- `npm install` updates `package-lock.json`.
- `rg '@bachi/anyproxy|AnyProxy' proxy package.json package-lock.json` shows no runtime dependency references.
- All existing proxy tests pass.
- New WebSocket/MITM/stream/tunnel regression tests pass.
- Manual smoke testing confirms browser HTTP/HTTPS proxying and configured MITM rules still work.
