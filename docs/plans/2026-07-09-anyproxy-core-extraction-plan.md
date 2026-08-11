# AnyProxy Core Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the AnyProxy capabilities currently used by `block-proxy` into `proxy/proxy-core/`, preserve current MITM/proxy forwarding/WebSocket/tunnel behavior, and remove the `@bachi/anyproxy` package dependency.

**Architecture:** Add regression tests first around the capabilities that must not regress, then extract the local AnyProxy fork modules into a small local facade. Preserve current fork-specific behavior before deleting unused AnyProxy modules or dependencies.

**Tech Stack:** Node.js, `http`, `https`, `net`, streams, `node-easy-cert`, `ws`, `co`, existing `proxy/proxy.js` rule callbacks.

---

## Non-Negotiable Requirements

- Do not lose HTTP proxy forwarding.
- Do not lose HTTPS CONNECT pass-through.
- Do not lose HTTPS MITM.
- Do not lose WebSocket proxy support.
- Do not lose reverse tunnel domain forwarding.
- Do not remove large response stream mode.
- Do not remove current keep-alive/retry behavior.
- Do not remove source IP recovery for MITM requests.
- Do not rely on transitive dependencies from `@bachi/anyproxy` after it is removed.

---

## Target Files

Create:

- `proxy/proxy-core/index.js`
- `proxy/proxy-core/proxy-server.js`
- `proxy/proxy-core/request-handler.js`
- `proxy/proxy-core/https-server-mgr.js`
- `proxy/proxy-core/cert-mgr.js`
- `proxy/proxy-core/util.js`
- `proxy/proxy-core/ws-server-mgr.js`
- `proxy/proxy-core/rule-default.js`
- `proxy/proxy-core/request-error-handler.js`

Modify:

- `proxy/proxy.js`
- `package.json`
- `package-lock.json`

Add tests where practical:

- `test/proxy-core-*.test.js`
- Extend `test/proxy-tests.js` or add focused regression tests for WS, MITM, stream mode, and tunnel CONNECT.

---

## Task 1: Add Regression Test Inventory

**Files:**

- Modify: `docs/plans/2026-07-09-anyproxy-core-extraction-plan.md`
- Create or modify tests in later tasks

- [ ] **Step 1: Record the baseline capability list**

Use the list in this plan and the design document as the acceptance criteria.

- [ ] **Step 2: Run current baseline tests**

Run:

```bash
npm run test:proxy
npm run test:mitm-runtime
npm run test:registry
```

Expected:

- Existing tests pass before migration. These commands exist in the current `package.json`.
- If any test fails before migration, record it as pre-existing and do not attribute it to extraction.

- [ ] **Step 3: Identify missing test coverage**

Missing coverage that should be added before removing AnyProxy:

- plain `ws://` through HTTP proxy
- `wss://` pass-through via CONNECT
- CONNECT `head` preservation
- large response stream mode
- tunnel domain CONNECT calls `tunnelManager.forward`
- MITM dynamic certificate path

- [ ] **Step 4: Commit if only tests/docs changed**

```bash
git add docs/plans/2026-07-09-anyproxy-core-extraction-design.md docs/plans/2026-07-09-anyproxy-core-extraction-plan.md
git commit -m "docs: revise anyproxy extraction plan for capability parity"
```

---

## Task 2: Extract Utility And Certificate Modules

**Files:**

- Create: `proxy/proxy-core/util.js`
- Create: `proxy/proxy-core/cert-mgr.js`
- Create: `proxy/proxy-core/request-error-handler.js`

- [ ] **Step 1: Create `util.js`**

Extract only helpers needed by local core from `node_modules/@bachi/anyproxy/lib/util.js`:

- `merge`
- `freshRequire`
- `getUserHome`
- `getAnyProxyHome`
- `getAnyProxyPath`
- `getHeaderFromRawHeaders`
- `getAllIpAddress` if referenced
- `getFreePort`
- `collectErrorLog`
- `getByteSize`
- `isIp`

Do not include AnyProxy web UI/recorder-only helpers.

- [ ] **Step 2: Verify `util.js` loads**

Run:

```bash
node -e "const util = require('./proxy/proxy-core/util'); console.log(typeof util.getFreePort, typeof util.getHeaderFromRawHeaders, typeof util.isIp)"
```

Expected:

```text
function function function
```

- [ ] **Step 3: Create `cert-mgr.js`**

Extract certificate manager behavior from `node_modules/@bachi/anyproxy/lib/certMgr.js`.

Keep:

- `node-easy-cert`
- `ifRootCAFileExists`
- `generateRootCA`
- `getCertificate`
- `getRootCAFilePath`
- existing `~/.anyproxy/certificates` location

Remove:

- `trustRootCA`
- `getCAStatus`
- `inquirer`
- trust-store shell commands

- [ ] **Step 4: Verify `cert-mgr.js` loads**

Run:

```bash
node -e "const certMgr = require('./proxy/proxy-core/cert-mgr'); console.log(typeof certMgr.ifRootCAFileExists, typeof certMgr.generateRootCA, typeof certMgr.getCertificate)"
```

Expected:

```text
function function function
```

- [ ] **Step 5: Create `request-error-handler.js`**

Provide a minimal function that returns an HTML string for `getErrorResponse()`.

Do not copy AnyProxy's current helper as-is if it pulls in `pug` or `resource/` templates. The extracted core only needs a fallback body; `proxy/proxy.js` still handles custom `onError()` responses.

- [ ] **Step 6: Commit**

```bash
git add proxy/proxy-core/util.js proxy/proxy-core/cert-mgr.js proxy/proxy-core/request-error-handler.js
git commit -m "feat(proxy-core): add utility and certificate modules"
```

---

## Task 3: Extract WebSocket Server Manager

**Files:**

- Create: `proxy/proxy-core/ws-server-mgr.js`

- [ ] **Step 1: Extract `ws-server-mgr.js`**

Copy the behavior of `node_modules/@bachi/anyproxy/lib/wsServerMgr.js`.

Keep:

- `new ws.Server({ server })`
- `connection` callback wiring
- `headers` hook adding `x-anyproxy-websocket:true`
- error handling

- [ ] **Step 2: Add direct dependency decision**

Ensure `ws` will be a direct dependency before `@bachi/anyproxy` is removed.

- [ ] **Step 3: Verify module loads**

Run:

```bash
node -e "const wsMgr = require('./proxy/proxy-core/ws-server-mgr'); console.log(typeof wsMgr.getWsServer)"
```

Expected:

```text
function
```

- [ ] **Step 4: Commit**

```bash
git add proxy/proxy-core/ws-server-mgr.js
git commit -m "feat(proxy-core): add websocket server manager"
```

---

## Task 4: Extract HTTPS Server Manager

**Files:**

- Create: `proxy/proxy-core/https-server-mgr.js`

- [ ] **Step 1: Extract SNI server behavior**

Start from `node_modules/@bachi/anyproxy/lib/httpsServerMgr.js`.

Keep:

- `createHttpsSNIServer`
- SNI context cache
- dynamic `certMgr.getCertificate(serverName)`
- `ALPNProtocols: ['http/1.1']`
- active server cleanup
- internal HTTPS server WebSocket upgrade support via `ws-server-mgr`

- [ ] **Step 2: Preserve or intentionally handle IP MITM**

Keep `createHttpsIPServer` unless `proxy/proxy.js` is changed so `beforeDealHttpsRequest()` can never return `true` for IP hosts.

Reason: current `vpn_proxy` logic can force MITM before the IP bypass check.

- [ ] **Step 3: Replace `async-task-mgr`**

Use a local Promise lock map:

- key `hostname` for IP hosts
- key `127.0.0.1` for shared SNI server
- remove failed pending entries so later retries can recreate the server

- [ ] **Step 4: Verify module loads**

Run:

```bash
node -e "const HttpsServerMgr = require('./proxy/proxy-core/https-server-mgr'); console.log(typeof HttpsServerMgr)"
```

Expected:

```text
function
```

- [ ] **Step 5: Commit**

```bash
git add proxy/proxy-core/https-server-mgr.js
git commit -m "feat(proxy-core): add https server manager"
```

---

## Task 5: Extract Request Handler

**Files:**

- Create: `proxy/proxy-core/request-handler.js`
- Create: `proxy/proxy-core/rule-default.js`

- [ ] **Step 1: Extract `rule-default.js`**

Copy default callbacks from `node_modules/@bachi/anyproxy/lib/rule_default.js`.

Keep:

- `beforeSendRequest`
- `beforeSendResponse`
- `beforeDealHttpsRequest`
- `onError`
- `onConnectError`
- `onClientSocketError`

- [ ] **Step 2: Extract request handler from current fork**

Start from `node_modules/@bachi/anyproxy/lib/requestHandler.js`, not upstream AnyProxy.

Relevant source ranges in the current fork:

| Section | Source lines |
|---------|--------------|
| `CommonReadableStream` | 96-105 |
| `_isRetryableMethod` | 130-133 |
| `fetchRemoteResponse` | 140-260 |
| `getWsReqInfo` | 267-305 |
| source IP/socket map helpers | 307-363 |
| `getUserReqHandler` | 373-652 |
| `getConnectReqHandler` | 663-940 |
| `getWsHandler` | 946-1095 |
| `RequestHandler` class | 1097-1144 |

Keep:

- custom keep-alive agents
- retry-once for retryable methods
- `CommonReadableStream`
- `responseRules` matching
- dynamic `chunkSizeThreshold`
- `rawHeaders` preservation
- `beforeSendRequest`/`beforeSendResponse` flow
- `beforeDealHttpsRequest` flow
- `getWsHandler`
- source IP recovery
- socket map cleanup
- local response support

Remove:

- recorder mutation
- `recorder` parameters from helper signatures:
  - `getUserReqHandler(userRule, recorder)` -> `getUserReqHandler(userRule)`
  - `getConnectReqHandler(userRule, recorder, httpsServerMgr)` -> `getConnectReqHandler(userRule, httpsServerMgr)`
  - `getWsHandler(userRule, recorder, wsClient, wsReq)` -> `getWsHandler(userRule, wsClient, wsReq)`
- `resourceInfo`, `resourceInfoId`, `appendRecord`, `updateRecord`, and `updateRecordWsMessage` code used only by recorder
- `colorful` logging
- `global._throttle` branches if throttle is not supported
- unused `brotli` package import

- [ ] **Step 3: Wire `customConnect`**

In constructor:

```js
this.customConnect = config.customConnect;
```

This fixes the current fork gap where `customConnect` is called in `requestHandler.js` but never passed from `ProxyServer`.

- [ ] **Step 4: Preserve CONNECT `head`**

In `getConnectReqHandler`, before waiting for future `cltSocket.on('data')`, push `head` when present:

```js
let resolved = false;

if (head && head.length > 0) {
  requestStream.push(head);
  resolved = true;
  resolve();
}

cltSocket.on('data', (chunk) => {
  requestStream.push(chunk);
  if (!resolved) {
    resolved = true;
    // Existing first-data logic, including WebSocket detection, remains here.
    resolve();
  }
});
```

The important behavior is:

- `head` is forwarded before later socket data.
- the promise resolves immediately when `head` exists, so the CONNECT flow does not hang.
- the `data` listener remains active and continues pushing later chunks into `requestStream`.

- [ ] **Step 5: Preserve stream mode**

When `resSize >= config.chunkSizeThreshold`, switch from buffered chunks to a readable stream and resolve early. Do not replace this with full `Buffer.concat`.

- [ ] **Step 6: Preserve WebSocket handling**

Keep `getWsReqInfo()` and `getWsHandler()`. `wsIntercept: false` must remain a runtime behavior flag, not a reason to delete WS support.

- [ ] **Step 7: Verify module loads**

Run:

```bash
node -e "const RequestHandler = require('./proxy/proxy-core/request-handler'); console.log(typeof RequestHandler)"
```

Expected:

```text
function
```

- [ ] **Step 8: Commit**

```bash
git add proxy/proxy-core/request-handler.js proxy/proxy-core/rule-default.js
git commit -m "feat(proxy-core): add request handler"
```

---

## Task 6: Extract Proxy Server Facade

**Files:**

- Create: `proxy/proxy-core/proxy-server.js`
- Create: `proxy/proxy-core/index.js`

- [ ] **Step 1: Extract `proxy-server.js`**

Start from `node_modules/@bachi/anyproxy/proxy.js`.

Keep:

- `ProxyServer` event emitter behavior
- `httpProxyServer` property
- `start()`
- `close()`
- socket pool cleanup
- CONNECT handler registration
- main proxy WebSocket server registration
- `forceProxyHttps`
- `dangerouslyIgnoreUnauthorized`
- `wsIntercept`
- `customConnect`

Remove:

- `Recorder`
- `WebInterface`
- AnyProxy CLI/export-only classes
- colored logging
- `stream-throttle` unless explicitly retained

- [ ] **Step 2: Pass `customConnect` to `RequestHandler`**

When creating `RequestHandler`, pass:

```js
customConnect: config.customConnect
```

- [ ] **Step 3: Register WebSocket manager**

Keep equivalent behavior:

```js
wsServerMgr.getWsServer({
  server: this.httpProxyServer,
  connHandler: this.requestHandler.wsHandler
});
```

- [ ] **Step 4: Create `index.js` facade**

```js
const ProxyServer = require('./proxy-server');
const certMgr = require('./cert-mgr');

module.exports = {
  ProxyServer,
  utils: { certMgr }
};
```

- [ ] **Step 5: Verify facade loads**

Run:

```bash
node -e "const core = require('./proxy/proxy-core'); console.log(typeof core.ProxyServer, typeof core.utils.certMgr.ifRootCAFileExists)"
```

Expected:

```text
function function
```

- [ ] **Step 6: Commit**

```bash
git add proxy/proxy-core/proxy-server.js proxy/proxy-core/index.js
git commit -m "feat(proxy-core): add proxy server facade"
```

---

## Task 7: Add Focused Regression Tests

**Files:**

- Create or modify tests under `test/`

- [ ] **Step 1: Add WebSocket proxy test**

Create a local WS echo server and verify a client can connect through the HTTP proxy using `ws://`.

Expected:

- client sends a message
- upstream echo server receives it
- client receives echoed message

- [ ] **Step 2: Add CONNECT pass-through test**

Use a local TCP/TLS target and manually issue CONNECT through the proxy.

Expected:

- proxy replies `200`
- bytes after CONNECT are delivered to target and echoed back

- [ ] **Step 3: Add CONNECT `head` preservation test**

Send CONNECT request and first payload bytes in the same socket write.

Expected:

- target receives the payload bytes
- no first-packet loss

- [ ] **Step 4: Add large response streaming test**

Use a local HTTP target serving a response larger than the non-response-rule threshold.

Expected:

- response completes
- process does not require full response buffering
- `beforeSendResponse` is skipped for stream-mode non-matching responses

- [ ] **Step 5: Add tunnel customConnect test**

Use a fake `customConnect` duplex stream or fake tunnel manager.

Expected:

- tunnel domain calls `customConnect`
- non-tunnel domain falls back to normal net connect
- tunnel domain does not MITM

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm run test:proxy
```

Also run any new focused test command added by this task.

- [ ] **Step 7: Commit**

```bash
git add test proxy/proxy-core
git commit -m "test(proxy-core): cover extracted proxy capabilities"
```

---

## Task 8: Switch `proxy/proxy.js` To Local Core

**Files:**

- Modify: `proxy/proxy.js`

- [ ] **Step 1: Replace import**

```diff
- const AnyProxy = require('@bachi/anyproxy');
+ const { ProxyServer, utils: { certMgr } } = require('./proxy-core');
```

- [ ] **Step 2: Replace certificate calls**

```diff
- AnyProxy.utils.certMgr.ifRootCAFileExists()
+ certMgr.ifRootCAFileExists()

- AnyProxy.utils.certMgr.generateRootCA(...)
+ certMgr.generateRootCA(...)
```

- [ ] **Step 3: Replace server construction**

```diff
- proxyServerInstance = new AnyProxy.ProxyServer(options);
+ proxyServerInstance = new ProxyServer(options);
```

- [ ] **Step 4: Remove ready-time CONNECT override**

After local core correctly passes `customConnect` into `RequestHandler` and preserves `head`, remove the current `proxy/proxy.js` ready-time CONNECT override block. At the time this plan was written it is the block around `proxy/proxy.js:560-598` that:

- reads `httpServer.listeners('connect')[0]`
- calls `httpServer.removeAllListeners('connect')`
- manually handles tunnel domains in `proxy/proxy.js`

Reason: tunnel CONNECT should now be handled inside `proxy-core/request-handler.js` via `customConnect`.

- [ ] **Step 5: Keep `customConnect` option**

Do not remove:

```js
customConnect: (host, port, callback) => {
  if (tunnelManager && tunnelManager.matchesTunnelDomain(host)) {
    return tunnelManager.forward(host, port, callback);
  }
  return null;
}
```

- [ ] **Step 6: Remove throttle option only if core removed throttle**

Remove:

```js
throttle: 800 * 1024 * 1024
```

Keep or omit `wsIntercept: false`; either is acceptable as long as WebSocket proxy support remains implemented.

- [ ] **Step 7: Verify module loads**

Run:

```bash
node -e "const LocalProxy = require('./proxy/proxy'); console.log(typeof LocalProxy.init)"
```

Expected:

```text
function
```

- [ ] **Step 8: Commit**

```bash
git add proxy/proxy.js
git commit -m "refactor(proxy): switch to local proxy core"
```

---

## Task 9: Add Direct Dependencies And Remove AnyProxy

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Update dependencies**

Remove:

```json
"@bachi/anyproxy": "^0.1.9"
```

Add:

```json
"node-easy-cert": "^1.0.0",
"ws": "^5.1.0",
"co": "^4.6.0"
```

For v1, `co` is a required direct dependency. Current rule callback flow is generator-based and deeply wired through `co.wrap`; rewriting it to native `async` is a later refactor.

- [ ] **Step 2: Install with npm**

Run:

```bash
npm install
```

Expected:

- `package-lock.json` updates.
- `@bachi/anyproxy` is no longer a dependency.

- [ ] **Step 3: Verify no runtime references remain**

Run:

```bash
rg "@bachi/anyproxy|AnyProxy" proxy package.json package-lock.json
```

Expected:

- No runtime references in `proxy/`, `package.json`, or `package-lock.json`.
- Documentation references are acceptable outside runtime paths.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): remove anyproxy package dependency"
```

---

## Task 10: Full Verification

**Files:**

- No planned source edits unless tests reveal issues

- [ ] **Step 1: Run existing tests**

```bash
npm run test:proxy
npm run test:mitm-runtime
npm run test:registry
```

Expected:

- All pass.

- [ ] **Step 2: Run new focused tests**

Run the commands added in Task 7.

Expected:

- WS, CONNECT, stream, tunnel, and MITM-focused tests pass.

- [ ] **Step 3: Manual smoke test HTTP**

Start proxy:

```bash
npm run proxy
```

In another shell:

```bash
curl -x http://127.0.0.1:8001 http://example.com -I
```

Expected:

- HTTP response headers are returned through proxy.

- [ ] **Step 4: Manual smoke test HTTPS pass-through**

With MITM disabled or for a non-MITM domain:

```bash
curl -x http://127.0.0.1:8001 https://example.com -I
```

Expected:

- HTTPS response headers are returned.

- [ ] **Step 5: Manual smoke test MITM rule path**

Enable a known MITM rule and access its target through the proxy.

Expected:

- `beforeDealHttpsRequest` chooses MITM.
- `beforeSendRequest`/`beforeSendResponse` behavior matches current AnyProxy-backed behavior.

- [ ] **Step 6: Manual smoke test WebSocket**

Use the focused WS test or a local WS echo target through the proxy.

Expected:

- WS connection upgrades and messages relay both directions.

- [ ] **Step 7: Manual smoke test tunnel domain**

Configure `tunnel_domains` and connect through proxy.

Expected:

- tunnel log shows `tunnelManager.forward()`.
- tunnel domain is not MITM-decrypted.
- no fallback `net.connect()` leak for tunnel domains.

- [ ] **Step 8: Commit fixes if needed**

```bash
git add proxy test package.json package-lock.json
git commit -m "fix(proxy-core): preserve anyproxy parity"
```

---

## Implementation Notes

### Keep From Current Fork

The source of truth is the installed local fork:

- `node_modules/@bachi/anyproxy/proxy.js`
- `node_modules/@bachi/anyproxy/lib/requestHandler.js`
- `node_modules/@bachi/anyproxy/lib/httpsServerMgr.js`
- `node_modules/@bachi/anyproxy/lib/wsServerMgr.js`
- `node_modules/@bachi/anyproxy/lib/certMgr.js`
- `node_modules/@bachi/anyproxy/lib/util.js`
- `node_modules/@bachi/anyproxy/lib/rule_default.js`

Do not use upstream AnyProxy as the source for this migration unless explicitly comparing behavior.

### Delete Only After Replacement

Only remove a dependency/module after confirming the extracted core no longer imports it.

Likely removable:

- `async`
- `async-task-mgr`
- `colorful`
- `inquirer`
- `nedb`
- `pug`
- `qrcode-npm`
- `stream-throttle`

Likely retained directly:

- `node-easy-cert`
- `ws`
- `co`

`co` is retained directly for v1 because current request-handler rule invocation is generator-based. Removing it requires a separate compatibility refactor.

### Package Manager

Use `npm install`, not `pnpm i`, because this repository has `package-lock.json`.

---

## Completion Checklist

- [ ] `proxy/proxy-core/` exists and contains extracted local core.
- [ ] `proxy/proxy.js` imports `./proxy-core`, not `@bachi/anyproxy`.
- [ ] ready-time CONNECT override is removed or proven intentionally still needed.
- [ ] WebSocket proxy support is retained.
- [ ] stream mode is retained.
- [ ] tunnel `customConnect` works inside local core.
- [ ] `@bachi/anyproxy` is removed from `package.json`.
- [ ] `package-lock.json` no longer contains `@bachi/anyproxy`.
- [ ] existing tests pass.
- [ ] new capability regression tests pass.
