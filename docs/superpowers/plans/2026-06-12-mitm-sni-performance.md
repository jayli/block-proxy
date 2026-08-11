# MITM SNI Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cache MITM SNI `SecureContext` objects and clean stale CONNECT socket map entries without changing proxy behavior.

**Architecture:** Implement the code change in the local AnyProxy fork at `/Users/bachi/jaylli/anyproxy`, which is symlinked from `block-proxy/node_modules/@bachi/anyproxy`. Add bounded LRU caching in the SNI HTTPS server path and identity-safe cleanup in CONNECT socket bookkeeping. Use AnyProxy's existing Jest test suite for focused unit coverage, then run block-proxy's integration smoke test.

**Tech Stack:** Node.js built-ins (`tls`, `crypto`, `events`, `Map`), Jest in the AnyProxy fork, existing block-proxy npm scripts.

---

## File Structure

| File | Role |
|------|------|
| `/Users/bachi/jaylli/anyproxy/lib/httpsServerMgr.js` | Modify - SNI `SecureContext` LRU cache and test-visible helper exports |
| `/Users/bachi/jaylli/anyproxy/lib/requestHandler.js` | Modify - identity-safe cleanup for `conns` and `cltSockets` |
| `/Users/bachi/jaylli/anyproxy/test/lib/httpsServerMgr.spec.js` | Modify - add SNI cache regression tests |
| `/Users/bachi/jaylli/anyproxy/test/lib/requestHandlerSocketCleanup.spec.js` | Create - focused socket cleanup tests |
| `/Users/bachi/jaylli/block-proxy/docs/superpowers/specs/2026-06-12-mitm-sni-performance-design.md` | Reference design |

## Implementation Notes

- Do not edit `block-proxy/node_modules/@bachi/anyproxy` as an ignored package directory. In this checkout it resolves to `/Users/bachi/jaylli/anyproxy`; commit there.
- Keep the cache local to `createHttpsSNIServer()` so each SNI server owns its contexts.
- Use a default cache limit of `1000`.
- Use native `Map` insertion order for LRU behavior.
- Do not cache failed certificate lookups.
- Do not change `_httpsAgent`, TLS session cache settings, or first-time certificate generation.
- Cleanup map entries only when the value still points to the socket being closed.

---

### Task 1: Add failing SNI cache tests in AnyProxy

**Files:**
- Modify: `/Users/bachi/jaylli/anyproxy/test/lib/httpsServerMgr.spec.js`

- [ ] **Step 1: Confirm clean AnyProxy worktree**

Run:

```bash
git -C /Users/bachi/jaylli/anyproxy status --short
```

Expected: no output, or only unrelated user changes that must not be touched.

- [ ] **Step 2: Add LRU helper tests**

Append to `/Users/bachi/jaylli/anyproxy/test/lib/httpsServerMgr.spec.js`:

```javascript
describe('httpsServerMgr SNI context cache', () => {
  it('refreshes LRU entries and evicts the oldest hostname', () => {
    expect(httpsServerMgr._test).toBeDefined();

    const cache = httpsServerMgr._test.createLRUCache(2);
    cache.set('a.example', 'ctx-a');
    cache.set('b.example', 'ctx-b');

    expect(cache.get('a.example')).toBe('ctx-a');

    cache.set('c.example', 'ctx-c');

    expect(cache.get('b.example')).toBeUndefined();
    expect(cache.get('a.example')).toBe('ctx-a');
    expect(cache.get('c.example')).toBe('ctx-c');
  });

  it('normalizes SNI hostnames for stable cache keys', () => {
    expect(httpsServerMgr._test.normalizeSNIName('WWW.Example.COM')).toBe('www.example.com');
    expect(httpsServerMgr._test.normalizeSNIName(null)).toBe('');
  });
});
```

- [ ] **Step 3: Run the focused test and verify it fails**

Run:

```bash
cd /Users/bachi/jaylli/anyproxy
npx jest test/lib/httpsServerMgr.spec.js --runInBand
```

Expected: FAIL because `httpsServerMgr._test` is not defined.

- [ ] **Step 4: Commit the failing test**

Run:

```bash
cd /Users/bachi/jaylli/anyproxy
git add test/lib/httpsServerMgr.spec.js
git commit -m "test: add SNI context cache coverage"
```

---

### Task 2: Implement SNI SecureContext LRU cache

**Files:**
- Modify: `/Users/bachi/jaylli/anyproxy/lib/httpsServerMgr.js`
- Test: `/Users/bachi/jaylli/anyproxy/test/lib/httpsServerMgr.spec.js`

- [ ] **Step 1: Add cache helpers near the top of `httpsServerMgr.js`**

Add after the `require(...)` block:

```javascript
const DEFAULT_SNI_CONTEXT_CACHE_LIMIT = 1000;

function createLRUCache(limit) {
  const maxEntries = Math.max(1, limit || DEFAULT_SNI_CONTEXT_CACHE_LIMIT);
  const store = new Map();

  return {
    get(key) {
      if (!store.has(key)) return undefined;
      const value = store.get(key);
      store.delete(key);
      store.set(key, value);
      return value;
    },

    set(key, value) {
      if (store.has(key)) store.delete(key);
      store.set(key, value);

      while (store.size > maxEntries) {
        const oldestKey = store.keys().next().value;
        store.delete(oldestKey);
      }
    },

    size() {
      return store.size;
    }
  };
}

function normalizeSNIName(serverName) {
  return String(serverName || '').toLowerCase();
}
```

- [ ] **Step 2: Create the cache inside `createHttpsSNIServer()`**

Inside `createHttpsSNIServer(port, handler)`, after `createSecureContext`:

```javascript
const secureContextCache = createLRUCache(DEFAULT_SNI_CONTEXT_CACHE_LIMIT);
```

- [ ] **Step 3: Add cache lookup at the start of `SNIPrepareCert()`**

At the start of `SNIPrepareCert(serverName, SNICallback)`:

```javascript
const cacheKey = normalizeSNIName(serverName);
const cachedCtx = secureContextCache.get(cacheKey);
if (cachedCtx) {
  SNICallback(null, cachedCtx);
  return;
}
```

- [ ] **Step 4: Cache successful context creation**

After `ctx = createSecureContext({ key: keyContent, cert: crtContent })` succeeds:

```javascript
secureContextCache.set(cacheKey, ctx);
```

Cache insertion must happen only after `createSecureContext()` succeeds.

- [ ] **Step 5: Export test helpers**

Before `module.exports = httpsServerMgr;`, add:

```javascript
httpsServerMgr._test = {
  createLRUCache,
  normalizeSNIName,
};
```

- [ ] **Step 6: Run the focused SNI tests**

Run:

```bash
cd /Users/bachi/jaylli/anyproxy
npx jest test/lib/httpsServerMgr.spec.js --runInBand
```

Expected: PASS.

- [ ] **Step 7: Commit SNI cache implementation**

Run:

```bash
cd /Users/bachi/jaylli/anyproxy
git add lib/httpsServerMgr.js
git commit -m "perf: cache SNI secure contexts"
```

---

### Task 3: Add failing socket cleanup tests in AnyProxy

**Files:**
- Create: `/Users/bachi/jaylli/anyproxy/test/lib/requestHandlerSocketCleanup.spec.js`

- [ ] **Step 1: Create the test file**

Create `/Users/bachi/jaylli/anyproxy/test/lib/requestHandlerSocketCleanup.spec.js`:

```javascript
const { EventEmitter } = require('events');
const RequestHandler = require('../../lib/requestHandler');

describe('requestHandler socket map cleanup', () => {
  it('deletes the map entry when the tracked socket closes', () => {
    expect(RequestHandler._test).toBeDefined();

    const map = new Map();
    const socket = new EventEmitter();
    const key = '127.0.0.1:12345';
    map.set(key, socket);

    RequestHandler._test.registerSocketMapCleanup(map, key, socket);
    socket.emit('close');

    expect(map.has(key)).toBe(false);
  });

  it('does not delete a newer socket that replaced the old entry', () => {
    const map = new Map();
    const oldSocket = new EventEmitter();
    const newSocket = new EventEmitter();
    const key = '127.0.0.1:12345';

    map.set(key, oldSocket);
    RequestHandler._test.registerSocketMapCleanup(map, key, oldSocket);

    map.set(key, newSocket);
    oldSocket.emit('close');

    expect(map.get(key)).toBe(newSocket);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd /Users/bachi/jaylli/anyproxy
npx jest test/lib/requestHandlerSocketCleanup.spec.js --runInBand
```

Expected: FAIL because `RequestHandler._test` is not defined.

- [ ] **Step 3: Commit the failing test**

Run:

```bash
cd /Users/bachi/jaylli/anyproxy
git add test/lib/requestHandlerSocketCleanup.spec.js
git commit -m "test: add CONNECT socket cleanup coverage"
```

---

### Task 4: Implement CONNECT socket map cleanup

**Files:**
- Modify: `/Users/bachi/jaylli/anyproxy/lib/requestHandler.js`
- Test: `/Users/bachi/jaylli/anyproxy/test/lib/requestHandlerSocketCleanup.spec.js`

- [ ] **Step 1: Add cleanup helper near `getConnectionPort()`**

Add after `getConnectionPort(connectionKey)`:

```javascript
function registerSocketMapCleanup(socketMap, key, socket) {
  if (!socketMap || !key || !socket || typeof socket.once !== 'function') return;

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (socketMap.get(key) === socket) {
      socketMap.delete(key);
    }
  }

  socket.once('close', cleanup);
}
```

- [ ] **Step 2: Register cleanup after storing CONNECT sockets**

Replace:

```javascript
reqHandlerCtx.conns.set(serverInfo.host + ':' + serverInfo.port, conn)
reqHandlerCtx.cltSockets.set(serverInfo.host + ':' + serverInfo.port, cltSocket)
```

with:

```javascript
const socketMapKey = serverInfo.host + ':' + serverInfo.port;
reqHandlerCtx.conns.set(socketMapKey, conn);
reqHandlerCtx.cltSockets.set(socketMapKey, cltSocket);
registerSocketMapCleanup(reqHandlerCtx.conns, socketMapKey, conn);
registerSocketMapCleanup(reqHandlerCtx.cltSockets, socketMapKey, cltSocket);
```

- [ ] **Step 3: Export test helper**

At the bottom of `requestHandler.js`, preserve the existing export and attach `_test`:

```javascript
RequestHandler._test = {
  registerSocketMapCleanup,
};

module.exports = RequestHandler;
```

- [ ] **Step 4: Run the focused socket cleanup test**

Run:

```bash
cd /Users/bachi/jaylli/anyproxy
npx jest test/lib/requestHandlerSocketCleanup.spec.js --runInBand
```

Expected: PASS.

- [ ] **Step 5: Commit socket cleanup implementation**

Run:

```bash
cd /Users/bachi/jaylli/anyproxy
git add lib/requestHandler.js
git commit -m "fix: clean stale CONNECT socket map entries"
```

---

### Task 5: Run combined verification

**Files:**
- No source changes unless verification reveals a bug.

- [ ] **Step 1: Run AnyProxy focused tests**

Run:

```bash
cd /Users/bachi/jaylli/anyproxy
npx jest test/lib/httpsServerMgr.spec.js test/lib/requestHandlerSocketCleanup.spec.js --runInBand
```

Expected: PASS.

- [ ] **Step 2: Run existing AnyProxy retry regression test**

Run:

```bash
cd /Users/bachi/jaylli/anyproxy
npx jest test/requestHandler.retry.spec.js --runInBand
```

Expected: PASS.

- [ ] **Step 3: Run block-proxy proxy smoke test**

Run:

```bash
cd /Users/bachi/jaylli/block-proxy
npm run test:proxy -- --skip-external --auto-start
```

Expected: proxy starts if needed and local mock/proxy tests pass.

If the environment cannot bind the required ports or start the proxy, record the exact failure and treat the focused AnyProxy Jest tests as the minimum verification.

- [ ] **Step 4: Inspect git status in both repositories**

Run:

```bash
git -C /Users/bachi/jaylli/anyproxy status --short
git -C /Users/bachi/jaylli/block-proxy status --short
```

Expected: no unexpected source changes. The block-proxy repository should contain only the docs from this planning task unless implementation deliberately changed integration files.

## Review

Automatic plan-document-reviewer subagent was not run because the available subagent tool is restricted to explicit user-requested delegation. Before executing, manually review this plan against `docs/superpowers/specs/2026-06-12-mitm-sni-performance-design.md`.
