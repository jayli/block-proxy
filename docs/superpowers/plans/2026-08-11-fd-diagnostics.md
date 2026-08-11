# FD Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute FD growth to descriptor categories, SOCKS5 lifecycle stages, and outbound keep-alive agents.

**Architecture:** Add a side-effect-free diagnostics helper that inspects `/proc/self/fd` and Node agents. Inject it into the existing SOCKS5 five-minute statistics callback, which already owns the process FD counter. Track handshake and UDP socket lifecycle locally in the SOCKS5 connection handler.

**Tech Stack:** Node.js CommonJS, `node:test`/`assert`, Linux procfs with cross-platform fallback.

## Global Constraints

- Preserve proxy forwarding behaviour and current log cadence.
- Diagnostics must aggregate counts only and must not emit credentials or client IPs.
- Do not deploy, commit, or push.

---

### Task 1: Add a testable FD/agent snapshot helper

**Files:**
- Create: `proxy/fd-diagnostics.js`
- Test: `test/fd-diagnostics-tests.js`

- [ ] **Step 1: Write the failing test**

```js
assert.deepEqual(summarizeAgent({ sockets: { a: [1, 2] }, freeSockets: { b: [1] }, requests: { c: [1, 2, 3] } }), {
  active: 2, free: 1, queued: 3, origins: 3,
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/fd-diagnostics-tests.js`

- [ ] **Step 3: Write minimal implementation**

Implement `summarizeAgent(agent)` and `getFdSnapshot(options)` with injectable `readlinkSync`/`readdirSync`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/fd-diagnostics-tests.js`

### Task 2: Include pre-CONNECT and UDP sockets in SOCKS5 statistics

**Files:**
- Modify: `socks5/server.js`
- Modify: `test/socks5-server-limits-tests.js`

- [ ] **Step 1: Write the failing test**

```js
assert.ok(logs.some(line => line.includes('handshaking=1') && line.includes('udp=0')));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/socks5-server-limits-tests.js`

- [ ] **Step 3: Write minimal implementation**

Increment on handler entry, decrement once on socket close, and include the two lifecycle counters plus `fdSnapshot` in the existing statistics line.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/socks5-server-limits-tests.js`

### Task 3: Wire proxy outbound agents into the snapshot

**Files:**
- Modify: `proxy/proxy.js`
- Test: `test/fd-diagnostics-tests.js`

- [ ] **Step 1: Write the failing test**

```js
assert.match(formatSnapshot({ agents: { http: { active: 1, free: 2, queued: 0, origins: 2 } } }), /agent_http_active=1/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/fd-diagnostics-tests.js`

- [ ] **Step 3: Write minimal implementation**

Register the long-lived proxy HTTP and HTTPS agents with the SOCKS5 statistics callback without adding a second interval.

- [ ] **Step 4: Run focused tests**

Run: `node test/fd-diagnostics-tests.js && node test/socks5-server-limits-tests.js`
