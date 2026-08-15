# Tunnel PONG Probe Minimal Patch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add a small server-only PONG retry to xhttp sessions so a missed PONG triggers a PING after 10 seconds instead of waiting for the next keepalive cycle.

**Architecture:** Keep all behavior inside XhttpHandler. A session owns one probe timer and a retry counter. Existing lastActivityAt, UploadQueue ordering, keepalive scheduling, and liveness sweeper remain in place; the patch only inserts prompt retry and cleanup behavior.

**Tech Stack:** Node.js 22, CommonJS, node:test, node:assert/strict.

## Constraints

- Modify only tunnel/xhttpHandler.js and tunnel/test/xhttpHandler.test.js.
- Do not modify clients, server/express.js, proxy/proxy.js, tunnel/server.js, config, or UI.
- Use constants PONG_PROBE_TIMEOUT_MS = 10_000 and PONG_PROBE_MAX_ATTEMPTS = 10.
- Preserve existing liveness-timeout close reason and existing 90 second sweeper.
- Follow red → green TDD for each task.
- Do not commit automatically.

---

## Task 1: Define the probe state and prove early retry

**Files:**

- Modify: tunnel/test/xhttpHandler.test.js
- Modify: tunnel/xhttpHandler.js

**Produces:** One PING starts one 10-second probe; a miss produces the second PING before normal keepalive.

- [ ] **Step 1: Write the failing test**

Add a test with keepaliveMinMs and keepaliveMaxMs set to 50ms. Open a mock stream as existing tests do, wait 55ms, assert one PING, then wait 20ms and assert two PING frames. The second assertion proves retry occurred before the next 50ms keepalive.

~~~js
it('retries PING before the next keepalive when PONG is missing', async () => {
  const { handler } = createHandler({
    keepaliveMinMs: 50, keepaliveMaxMs: 50,
  });
  handler._pongProbeTimeoutMs = 10;
  const sessionId = await createSession(handler);
  const res = openMockStream(handler, sessionId);

  await wait(55);
  assert.equal(pingFrames(res).length, 1);
  await wait(20);
  assert.equal(pingFrames(res).length, 2);
  handler.closeAll();
});
~~~

Add small test helpers only in this file: wait(ms), openMockStream(handler, sessionId), and pingFrames(res).

- [ ] **Step 2: Run the test while red**

Run: node --test tunnel/test/xhttpHandler.test.js

Expected: FAIL because only the ordinary 50ms PING exists.

- [ ] **Step 3: Implement the minimum probe**

In tunnel/xhttpHandler.js:

1. Define the two module constants and initialize handler-private _pongProbeTimeoutMs / _pongProbeMaxAttempts from them. This is required before the test can set the 10ms private timeout.
2. Initialize pingAttempts: 0 and pongProbeTimer: null in the session object.
3. Add _clearPongProbe(session), _armPongProbe(session), _sendProbePing(session), and _handlePongProbeTimeout(session).
4. Move existing inline PING construction from _scheduleKeepalive() into _sendProbePing().
5. Have _sendProbePing() set state only after _pushSseFrame(..., false) succeeds.
6. In _scheduleKeepalive() call _sendProbePing(session) only when pingAttempts is 0.

The timeout handler sends another probe while attempts are below 10.

- [ ] **Step 4: Run the test while green**

Run: node --test tunnel/test/xhttpHandler.test.js

Expected: the second PING occurs about 10ms after the first, before 100ms.

## Task 2: Close after repeated missed responses and avoid keepalive starvation

**Files:**

- Modify: tunnel/test/xhttpHandler.test.js
- Modify: tunnel/xhttpHandler.js

**Produces:** Probe retries stop at the static attempt cap, and a rapid keepalive never resets an active probe.

- [ ] **Step 1: Write the failing tests**

For test speed, create the handler with its normal constructor and immediately set handler._pongProbeTimeoutMs and handler._pongProbeMaxAttempts in the test. These remain private fields initialized from module constants; do not add constructor options or configuration. Add:

~~~js
it('closes once after the PONG retry limit', async () => {
  const { handler, events } = createHandler({ keepaliveMinMs: 1, keepaliveMaxMs: 1 });
  handler._pongProbeTimeoutMs = 5;
  handler._pongProbeMaxAttempts = 3;
  const sessionId = await createAndOpenMockStream(handler);

  await wait(30);
  assert.equal(handler._sessions.has(sessionId), false);
  assert.equal(events.filter(event => event.type === 'closed' && event.sessionId === sessionId).length, 1);
});

it('does not let a short keepalive reset an active probe', async () => {
  const { handler, events } = createHandler({ keepaliveMinMs: 1, keepaliveMaxMs: 1 });
  handler._pongProbeTimeoutMs = 10;
  handler._pongProbeMaxAttempts = 2;
  const sessionId = await createAndOpenMockStream(handler);

  await wait(30);
  assert.equal(handler._sessions.has(sessionId), false);
  assert.equal(events.filter(event => event.type === 'closed' && event.sessionId === sessionId).length, 1);
});
~~~

- [ ] **Step 2: Run the tests while red**

Run: node --test tunnel/test/xhttpHandler.test.js

Expected: FAIL because no retry cap exists and rapid ordinary keepalives overwrite the pending PING.

- [ ] **Step 3: Implement cap and active-probe guard**

Initialize handler-private values from module constants:

~~~js
this._pongProbeTimeoutMs = PONG_PROBE_TIMEOUT_MS;
this._pongProbeMaxAttempts = PONG_PROBE_MAX_ATTEMPTS;
~~~

Change _scheduleKeepalive to accept an internal optional flag and use it in the keepalive callback:

~~~js
_scheduleKeepalive(session, fromNow = false) {
  // existing timer cleanup and randomized delay
  const baseAt = fromNow ? Date.now() : (session.lastSseWriteAt || Date.now());
  const timeoutMs = Math.max(1, baseAt + delay - Date.now());
  // existing setTimeout
}

if (session.pingAttempts > 0) {
  this._scheduleKeepalive(session, true);
  return;
}
this._sendProbePing(session);
~~~

Do not assign Date.now() to lastSseWriteAt in the skip branch: that field must remain the time of a real SSE write. The fromNow flag prevents the expired lastSseWriteAt formula from producing a 1ms hot loop.

In _handlePongProbeTimeout(), call _closeSession(session.sessionId, 'liveness-timeout') when pingAttempts is at least _pongProbeMaxAttempts; otherwise send the next PING. Clear the timer before every new arm so only one exists.

- [ ] **Step 4: Run the tests while green**

Run: node --test tunnel/test/xhttpHandler.test.js

Expected: both sessions close exactly once; the 1ms keepalive cannot postpone the 10ms probe.

## Task 3: Treat any ordered upstream frame as a response

**Files:**

- Modify: tunnel/test/xhttpHandler.test.js
- Modify: tunnel/xhttpHandler.js

**Produces:** Matching PONG, DATA, and late PONG stop retry correctly while preserving nonce diagnostics.

- [ ] **Step 1: Write the failing tests**

Add three tests after opening a stream and waiting for its first PING:

1. Upload a matching PONG at sequence 0. Assert lastPingPayload is null, pingAttempts is 0, and pongProbeTimer is null.
2. Upload DATA at sequence 0. Assert pingAttempts is 0 and pongProbeTimer is null, but lastPingPayload is unchanged.
3. Upload a PONG with a different payload at sequence 0. Assert lastActivityAt advanced, pingAttempts is 0, pongProbeTimer is null, and lastPingPayload is unchanged.

Use the existing mock POST upload pattern and wait for two setImmediate turns so UploadQueue consumption is complete.

- [ ] **Step 2: Run the tests while red**

Run: node --test tunnel/test/xhttpHandler.test.js

Expected: FAIL because a mismatched PONG is skipped and no probe state is reset.

- [ ] **Step 3: Implement response handling**

In the ordered consume loop, before PONG-specific validation:

~~~js
session.lastActivityAt = Date.now();
session.pingAttempts = 0;
this._clearPongProbe(session);
~~~

For PONG, clear lastPingPayload only when the payload Buffer equals the outstanding nonce. For a mismatch, log the existing warning but do not continue; dispatch the frame normally.

- [ ] **Step 4: Run the tests while green**

Run: node --test tunnel/test/xhttpHandler.test.js

Expected: all three frames stop the current retry; only matching PONG clears nonce.

## Task 4: Clear probe timers on every teardown path

**Files:**

- Modify: tunnel/test/xhttpHandler.test.js
- Modify: tunnel/xhttpHandler.js

**Produces:** No delayed PING after SSE or session teardown.

- [ ] **Step 1: Write the failing tests**

For each subtest, create the handler with keepaliveMinMs and keepaliveMaxMs set to 5, set handler._pongProbeTimeoutMs = 10, open a stream, and wait 10ms for its first PING. Then run two subtests:

1. Emit close on the mock SSE response, wait 25ms, and assert PING frame count did not increase.
2. Call handler._closeSession(sessionId), wait 25ms, and assert PING frame count did not increase and closed is emitted once.

- [ ] **Step 2: Run the tests while red**

Run: node --test tunnel/test/xhttpHandler.test.js

Expected: FAIL because the probe callback can survive teardown.

- [ ] **Step 3: Implement cleanup**

Call _clearPongProbe(session) in the SSE close handler before scheduling reconnect cleanup. Call it at the beginning of _closeSession() before closing the queue and SSE response. closeAll() needs no separate branch because it already invokes _closeSession().

- [ ] **Step 4: Run the tests while green**

Run: node --test tunnel/test/xhttpHandler.test.js

Expected: no post-close PING and no duplicate closed event.

## Task 5: Regression verification

**Files:** No production edits.

- [ ] **Step 1: Run focused tests**

Run:

~~~bash
node --test tunnel/test/xhttpHandler.test.js
~~~

Expected: existing session, SSE, ordering, takeover, and new probe tests pass.

- [ ] **Step 2: Run tunnel regressions**

Run:

~~~bash
node --test tunnel/test/*.test.js
node --test test/tunnel-integration.test.js
~~~

Expected: all pass, including HTTP/1.1, HTTP/2, upload batching, SSE reconnect, and 409 takeover behavior.

- [ ] **Step 3: Inspect changes**

Run:

~~~bash
git diff --check
git status --short
~~~

Expected: only tunnel/xhttpHandler.js and tunnel/test/xhttpHandler.test.js change during implementation. Report results and wait for user confirmation before any commit.

## Coverage

- Early retry: Task 1.
- Attempt cap and keepalive/probe competition: Task 2.
- Matching, late, and non-PONG upstream activity: Task 3.
- SSE/session cleanup: Task 4.
- Regression evidence: Task 5.
