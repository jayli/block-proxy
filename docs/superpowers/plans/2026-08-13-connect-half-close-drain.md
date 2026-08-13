# CONNECT 半关闭 Drain 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 回收 HTTP CONNECT 中永久半关闭的 socket，避免 `FIN_WAIT2`/`CLOSE_WAIT` 累积至 EMFILE，同时保留合法的半关闭响应排空。

**Architecture:** proxy-core CONNECT 显式控制 FIN：以 `pipe({ end: false })` 保留反向数据通道，收到单侧 `end` 后向对端转发 FIN 并启动 30 秒无数据 drain 与 5 分钟 hard deadline。双方结束、任一端关闭或出错时走同一个幂等 cleanup。隧道协议不改；TunnelManager 的正向 8001 CONNECT 自动使用 proxy-core 的回收语义。SOCKS5 的下游使用 Node 默认 `allowHalfOpen=false` 的 `net.connect()`，FIN 会自动完成另一半关闭，未复现同一泄漏，故不改变其生命周期逻辑。

**Tech Stack:** Node.js streams、`net.Socket`、现有 Node assert 测试、TunnelManager/xhttp 回归测试。

## Global Constraints

- 不修改 xhttp 帧协议、TunnelManager 会话逻辑、隧道客户端或普通 HTTP GET/POST 路径。
- CONNECT 单侧 FIN 后允许 30 秒无数据 drain，最多保留 5 分钟；两个 drain timer 必须 `unref()`。
- 所有生产行为变更先有失败测试；每个测试必须观察到预期 RED 后再写实现。
- 不提交代码，除非用户后续明确要求。

---

### Task 1: proxy-core CONNECT 半关闭 Drain

**Files:**
- Modify: `test/proxy-core-connect-tests.js`（`testConnectKeepsUpstreamOpenAfterClientHalfClose` 附近）
- Modify: `proxy/proxy-core/request-handler.js`（`getConnectReqHandler()` 的 `attachConnection()`）

**Interfaces:**
- Consumes: `RequestHandler` 现有 `timeout` 配置与 socket-like upstream。
- Produces: CONNECT 内部 drain 状态；使用 `reqHandlerCtx.halfCloseDrainIdleTimeoutMs`（默认 `30_000`）和 `reqHandlerCtx.halfCloseDrainMaxTimeoutMs`（默认 `300_000`）。

- [ ] **Step 1: 写失败测试：目标仅 FIN、不彻底 close 时销毁 client**

让 `HalfOpenUpstream` 只 `push(null)` 并保持对象存活；构造 RequestHandler 时传入短 drain timeout。断言 client 在 idle drain 后被 destroy，而不是依赖 upstream `.destroy()`。

```js
async function testConnectDrainsClientAfterUpstreamFinWithoutClose() {
  const upstream = new HalfOpenUpstream();
  const handler = new RequestHandler({
    httpServerPort: 18888,
    forceProxyHttps: false,
    halfCloseDrainIdleTimeoutMs: 40,
    halfCloseDrainMaxTimeoutMs: 120,
    customConnect: () => upstream,
  }, {
    *beforeDealHttpsRequest() { return null; },
    *onConnectError() {},
    *onClientSocketError() {},
  });
  // 建立 CONNECT 后仅发送 EOF，不调用 upstream.destroy()
  upstream.push(null);
  await waitFor(() => socket.destroyed, 500);
}
```

- [ ] **Step 2: 运行 CONNECT 测试并确认 RED**

Run: `node test/proxy-core-connect-tests.js`

Expected: 新测试超时，client socket 未被销毁。

- [ ] **Step 3: 最小实现 CONNECT drain**

在 `attachConnection()` 建立连接后，以 `requestStream.pipe(conn, { end: false })` 和 `conn.pipe(cltSocket, { end: false })` 取代默认 pipe。保留前段 `cltSocket.on('end') → requestStream.push(null)` 作为 client → upstream 唯一 FIN 入口；由 requestStream 的 `end` 处理转发 `conn.end()`，不要再在 `cltSocket.on('end')` 中重复调用。`conn.once('end')` 对称接入；单端 EOF 时向对端 `.end()` 并启动 drain，双方 EOF 时 cleanup。idle 与 hard timer 均 `unref()`。保留 client `close` 立刻销毁 conn 的语义；在 cleanup 中清定时器并销毁仍打开的一端。RequestHandler 构造函数须显式读取两个新增 config 键并赋默认值，不能依赖未定义键隐式透传。

- [ ] **Step 4: 运行 CONNECT 测试并确认 GREEN**

Run: `node test/proxy-core-connect-tests.js`

Expected: 新旧 CONNECT、MITM、chain-proxy 测试全部通过；既有“client half-close 后可接收 upstream response”用例仍通过。

### Task 2: 跨路径验证与代码审查

**Files:**
- Verify only: `proxy/proxy-core/request-handler.js`, `test/proxy-core-connect-tests.js`

- [ ] **Step 1: 运行 FD 诊断单测**

Run: `node test/fd-diagnostics-tests.js`

Expected: PASS。

- [ ] **Step 2: 运行隧道 Manager 与端到端回归**

Run: `node --test tunnel/test/manager.test.js && node test/tunnel-integration.test.js`

Expected: PASS；证明 xhttp 会话和 TunnelManager 未受影响。

- [ ] **Step 3: 运行完整 SOCKS5/CONNECT 聚焦回归**

Run: `node test/proxy-core-connect-tests.js`

Expected: PASS，且不出现未处理 rejection 或资源清理警告。

- [ ] **Step 4: 审查 diff 与工作区状态**

Run: `git diff --check && git diff -- socks5/server.js proxy/proxy-core/request-handler.js test/socks5-server-limits-tests.js test/proxy-core-connect-tests.js && git status --short`

Expected: 无空白错误；变更仅包含设计/计划及半关闭 drain 实现与测试，不包含运行时配置文件。
