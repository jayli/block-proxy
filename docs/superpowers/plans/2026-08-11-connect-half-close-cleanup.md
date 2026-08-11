# CONNECT Half-Close Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close orphaned CONNECT upstream descriptors after a downstream full close without losing reverse-direction response data after a normal TCP half-close.

**Architecture:** Keep both existing `pipe()` directions for their backpressure behavior. On downstream `close`, destroy the paired upstream `conn`; retain an early-close flag so a late asynchronous connection is also destroyed. `end` is deliberately untouched. Tests assert orphan closure and reverse-direction response delivery after a half-close.

**Tech Stack:** Node.js 20, built-in `net`, `http`, `assert`, and existing `node` test scripts.

## Global Constraints

- Preserve existing TCP CONNECT concurrency limits and 120-second timeouts.
- Preserve reverse-direction data after the client sends FIN.
- Do not alter HTTP/HTTPS keep-alive agent configuration.
- Use real loopback sockets in regression tests.
- Do not use `destroy()` for a normal `end` unless the peer has already closed or errored.

---

### Task 1: CONNECT relay downstream-close cleanup

**Files:**
- Modify: `test/proxy-core-connect-tests.js`
- Modify: `proxy/proxy-core/request-handler.js:719-765`

**Interfaces:**
- Consumes: `getConnectReqHandler()`'s `cltSocket`, `conn`, and existing `requestStream.pipe(conn)` / `conn.pipe(cltSocket)` setup.
- Produces: a lifecycle that destroys an upstream socket only when its paired downstream socket fully closes.

- [ ] **Step 1: Write the failing test**

Add a CONNECT handler regression with an attached upstream duplex stream. Destroy the client socket and assert the upstream stream is destroyed.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/proxy-core-connect-tests.js`

Expected: the test times out waiting for the upstream stream to be destroyed because `pipe()` only unpipes it.

- [ ] **Step 3: Write minimal implementation**

Before connection attachment, record downstream closure; when attaching, handle
the already-closed race:

```js
let clientSocketClosed = cltSocket.destroyed;
cltSocket.once('close', () => {
  clientSocketClosed = true;
  if (conn && !conn.destroyed) conn.destroy();
});
// In attachConnection():
if (clientSocketClosed || cltSocket.destroyed) {
  conn.destroy();
  return true;
}
```

Keep the existing `pipe()` calls and leave the current `requestStream.push(null)` `end` path intact.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/proxy-core-connect-tests.js`

Expected: all proxy-core CONNECT tests pass, including full-close, half-close, and async-connect race regressions.

### Task 2: Regression verification

**Files:**
- Verify: `test/proxy-core-connect-tests.js`
- Verify: `test/run.js`

**Interfaces:**
- Consumes: the lifecycle behavior added in Tasks 1 and 2.
- Produces: test evidence that normal forwarding and error handling still work.

- [x] **Step 1: Run focused test suites**

Run: `node test/proxy-core-connect-tests.js && node test/socks5-server-limits-tests.js && node test/fd-diagnostics-tests.js`

Observed: all commands exited 0 on 2026-08-11.

- [ ] **Step 2: Run proxy regression suite**

Run: `node test/run.js`

Expected: exit 0 with no failed proxy tests.

- [x] **Step 3: Review the diff**

Run: `git diff --check && git diff -- proxy/proxy-core/request-handler.js test/proxy-core-connect-tests.js`

Observed: no whitespace errors; changes are limited to CONNECT lifecycle handling and regression coverage.
