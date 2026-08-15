# 客户端 TLS SOCKS 预连接 tombstone 最小修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对已被服务端关闭的 TLS SOCKS 预连接释放本地 FD，并保留无资源 tombstone 占据原有 Queue 槽位，使真实请求跳过已知失效连接而不立即触发预连接补建。

**Architecture:** 保持 `asyncio.Queue(maxsize=3)` 和原有一秒补池机制。维护协程只在 TLS SOCKS 模式扫描 Queue：将已 EOF/closing 的 `(reader, writer)` 原位替换为模块私有 `_POOL_ZOMBIE`，然后关闭 writer。`acquire()` 消费 tombstone 后继续寻找健康项或为当前请求直接建连；队列长度降低后才由既有维护逻辑补回预连接。

**Tech Stack:** Python 3、asyncio、pytest（以 `asyncio.run()` 驱动异步单元测试）。

## Global Constraints

- 仅修改客户端 `client/proxy_core.py`；不得修改服务端代码、服务端 15 秒 timeout、服务端配置或日志。
- 仅 `protocol == "socks5" and tls` 执行健康扫描与 tombstone 插入；HTTP 和非 TLS SOCKS 的既有池行为不变。
- 继续使用现有 `asyncio.Queue(maxsize=POOL_SIZE)`；不得改为持续维持健康连接的 deque/set 池。
- `POOL_SIZE = 3`、`POOL_CHECK_INTERVAL = 1.0`、预连接的 TCP/TLS-only 语义均不变。
- 不在后台调用 `reader.read()`；关闭判断仅使用 `reader.at_eof()` 与 `writer.is_closing()`。
- tombstone 不包含 reader、writer 或 FD；识别后必须调用 `_close_writer()`，不得只打标记保留 socket。
- 每次 `Queue.get_nowait()` 后必须立刻调用 `Queue.task_done()`；扫描重新 `put_nowait()` 的项使 unfinished-task 计数保持稳定。
- 严格 TDD：先写完本计划定义的测试并确认 Red，再写最小 Green 实现。
- 代码完成后等待用户验证，不自动 `git add`、commit 或 push。

---

## File structure

- Modify: `client/proxy_core.py:510-590`
  - 定义 `_POOL_ZOMBIE`，扫描 TLS SOCKS Queue、支持 tombstone 的 `acquire()` / `stop()`，保留原有建连和补池节奏。
- Create: `client/tests/test_upstream_pool_tombstone.py`
  - 以假 reader/writer 验证 EOF 替换、无立即补建、消费行为、停止清理、Queue 记账及协议隔离。
- Keep unchanged: `client/tests/test_proxy_core_doh.py`
  - 用于验证现有 `_connect_with_pool()` 的现场建连回退与 HTTP plain-TCP pool 路径未回归。

## Interfaces

新增模块私有对象和 `UpstreamPool` 私有方法：

```python
_POOL_ZOMBIE = object()

class UpstreamPool:
    def _tracks_tls_socks_preconnects(self) -> bool: ...
    async def _mark_closed_preconnects(self) -> None: ...
```

`_POOL_ZOMBIE` 只能用身份比较：`entry is _POOL_ZOMBIE`。`self._pool` 项目的有效联合类型为：

```python
(asyncio.StreamReader, asyncio.StreamWriter) | _POOL_ZOMBIE
```

现有公共方法签名不变：

```python
async def start(self) -> None: ...
async def stop(self) -> None: ...
async def create_connection(self) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]: ...
async def acquire(self) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]: ...
```

### Task 1: 编写 tombstone 行为的完整 Red 测试

**Files:**

- Create: `client/tests/test_upstream_pool_tombstone.py`
- Modify: none

**Consumes:** 现有 `proxy_core.UpstreamPool`、`POOL_SIZE`、`POOL_CHECK_INTERVAL`。

**Produces:** 覆盖 TLS SOCKS 识别、Queue tombstone、FD 释放、按需补池、停止清理、非 TLS/HTTP 隔离的失败测试。

- [ ] **Step 1: 创建异步测试辅助类**

在 `client/tests/test_upstream_pool_tombstone.py` 写入：

```python
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import proxy_core


class FakeReader:
    def __init__(self, eof=False):
        self.eof = eof

    def at_eof(self):
        return self.eof


class FakeWriter:
    def __init__(self, closing=False):
        self.closing = closing
        self.close_calls = 0

    def is_closing(self):
        return self.closing

    def close(self):
        self.close_calls += 1
        self.closing = True

    async def wait_closed(self):
        pass


async def wait_until(predicate, timeout=0.2):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0)
    raise AssertionError("condition was not reached before timeout")


def tls_socks_config():
    return {"protocol": "socks5", "tls": True}
```

- [ ] **Step 2: 写入 TLS 扫描、tombstone 和 Queue 记账测试**

在同一文件加入：

```python
def test_tls_socks_maintainer_marks_eof_entry_without_immediate_reconnect(monkeypatch):
    monkeypatch.setattr(proxy_core, "POOL_CHECK_INTERVAL", 0.001)

    async def scenario():
        pool = proxy_core.UpstreamPool(tls_socks_config(), None)
        stale_reader, stale_writer = FakeReader(eof=True), FakeWriter()
        live_entries = [(FakeReader(), FakeWriter()), (FakeReader(), FakeWriter())]
        for entry in [(stale_reader, stale_writer), *live_entries]:
            await pool._pool.put(entry)

        create_calls = 0

        async def create_connection():
            nonlocal create_calls
            create_calls += 1
            raise AssertionError("tombstone must not trigger immediate preconnect")

        pool.create_connection = create_connection
        await pool.start()
        await wait_until(lambda: stale_writer.close_calls == 1)

        assert pool._pool.qsize() == proxy_core.POOL_SIZE
        assert list(pool._pool._queue)[0] is proxy_core._POOL_ZOMBIE
        assert pool._pool._unfinished_tasks == proxy_core.POOL_SIZE
        assert create_calls == 0
        await pool.stop()

    asyncio.run(scenario())
```

该测试通过 Queue 的私有 `_queue` 只读检查 FIFO 结果；生产代码不得访问 `_queue`。若扫描
漏掉 `task_done()`，`_unfinished_tasks` 会从 3 增至 6，测试必须失败。

- [ ] **Step 3: 写入消费和后续补池测试**

在同一文件加入：

```python
def test_acquire_discards_tombstone_then_returns_next_live_connection():
    async def scenario():
        pool = proxy_core.UpstreamPool(tls_socks_config(), None)
        live_reader, live_writer = FakeReader(), FakeWriter()
        await pool._pool.put(proxy_core._POOL_ZOMBIE)
        await pool._pool.put((live_reader, live_writer))

        async def create_connection():
            raise AssertionError("healthy entry after tombstone must be reused")

        pool.create_connection = create_connection
        assert await pool.acquire() == (live_reader, live_writer)
        assert pool._pool.qsize() == 0
        assert pool._pool._unfinished_tasks == 0

    asyncio.run(scenario())


def test_acquire_with_only_tombstones_creates_connection_for_current_request():
    async def scenario():
        pool = proxy_core.UpstreamPool(tls_socks_config(), None)
        for _ in range(proxy_core.POOL_SIZE):
            await pool._pool.put(proxy_core._POOL_ZOMBIE)
        fresh_reader, fresh_writer = FakeReader(), FakeWriter()
        create_calls = 0

        async def create_connection():
            nonlocal create_calls
            create_calls += 1
            return fresh_reader, fresh_writer

        pool.create_connection = create_connection
        assert await pool.acquire() == (fresh_reader, fresh_writer)
        assert create_calls == 1
        assert pool._pool.qsize() == 0
        assert pool._pool._unfinished_tasks == 0

    asyncio.run(scenario())


def test_existing_maintainer_refills_only_after_tombstone_is_consumed(monkeypatch):
    monkeypatch.setattr(proxy_core, "POOL_CHECK_INTERVAL", 0.001)

    async def scenario():
        pool = proxy_core.UpstreamPool(tls_socks_config(), None)
        for _ in range(proxy_core.POOL_SIZE):
            await pool._pool.put(proxy_core._POOL_ZOMBIE)
        replacements = [(FakeReader(), FakeWriter()) for _ in range(proxy_core.POOL_SIZE + 1)]

        async def create_connection():
            return replacements.pop(0)

        pool.create_connection = create_connection
        await pool.acquire()  # drains tombstones, then receives a direct current-request connection
        assert pool._pool.qsize() == 0
        await pool.start()
        await wait_until(lambda: pool._pool.qsize() == proxy_core.POOL_SIZE)
        assert all(entry is not proxy_core._POOL_ZOMBIE for entry in pool._pool._queue)
        await pool.stop()

    asyncio.run(scenario())
```

最后一个测试中 `acquire()` 的直接连接不属于池；维护协程只在 tombstone 被消费、`qsize()`
降为 0 后才创建 3 条新的预连接。

- [ ] **Step 4: 写入 stop 与协议隔离测试**

在同一文件加入：

```python
def test_stop_skips_tombstone_and_closes_each_live_writer_once():
    async def scenario():
        pool = proxy_core.UpstreamPool(tls_socks_config(), None)
        writer = FakeWriter()
        await pool._pool.put(proxy_core._POOL_ZOMBIE)
        await pool._pool.put((FakeReader(), writer))

        await pool.stop()

        assert pool._pool.qsize() == 0
        assert writer.close_calls == 1
        assert pool._pool._unfinished_tasks == 0

    asyncio.run(scenario())


def test_non_tls_socks_and_http_do_not_mark_closed_entries_as_tombstones():
    async def scenario():
        for config in (
            {"protocol": "socks5", "tls": False},
            {"protocol": "http", "tls": True},
        ):
            pool = proxy_core.UpstreamPool(config, None)
            reader, writer = FakeReader(eof=True), FakeWriter()
            await pool._pool.put((reader, writer))

            await pool._mark_closed_preconnects()

            assert pool._pool.qsize() == 1
            assert pool._pool._queue[0] == (reader, writer)
            assert writer.close_calls == 0

    asyncio.run(scenario())
```

- [ ] **Step 5: 运行测试，确认 Red**

Run:

```bash
cd client && pytest tests/test_upstream_pool_tombstone.py -q
```

Expected: FAIL。当前模块没有 `_POOL_ZOMBIE`、`_mark_closed_preconnects()` 或 tombstone-aware
`acquire()` / `stop()`；不得改变断言以迁就当前行为。

### Task 2: 实现 TLS SOCKS tombstone 扫描与消费（Green）

**Files:**

- Modify: `client/proxy_core.py:510-590`
- Test: `client/tests/test_upstream_pool_tombstone.py`

**Consumes:** Task 1 的 Red 测试和 `FakeReader` / `FakeWriter` 语义。

**Produces:** 仅 TLS SOCKS 启用的 tombstone 队列行为；服务端关闭不触发即时预连接，而消费后仍使用既有补池节奏。

- [ ] **Step 1: 定义哨兵和 TLS SOCKS 判定方法**

在 `POOL_CONNECT_TIMEOUT` 后增加：

```python
_POOL_ZOMBIE = object()
```

在 `UpstreamPool` 中新增：

```python
def _tracks_tls_socks_preconnects(self):
    protocol = self._server_config.get("protocol", "socks5")
    return protocol == "socks5" and bool(self._server_config.get("tls"))
```

- [ ] **Step 2: 实现无 await 的 Queue 快照与 tombstone 替换**

在 `UpstreamPool` 中添加：

```python
async def _mark_closed_preconnects(self):
    if not self._tracks_tls_socks_preconnects():
        return

    entries = []
    while not self._pool.empty():
        try:
            entry = self._pool.get_nowait()
        except asyncio.QueueEmpty:
            break
        self._pool.task_done()
        entries.append(entry)

    stale_writers = []
    for entry in entries:
        if entry is _POOL_ZOMBIE:
            self._pool.put_nowait(entry)
            continue
        reader, writer = entry
        if writer.is_closing() or reader.at_eof():
            self._pool.put_nowait(_POOL_ZOMBIE)
            stale_writers.append(writer)
        else:
            self._pool.put_nowait(entry)

    for writer in stale_writers:
        logger.debug("discarding closed TLS SOCKS preconnect")
        await _close_writer(writer)
```

所有 `get_nowait()` 与 `put_nowait()` 都发生在第一个 `await` 前，因此 Queue 只会在同一个
事件循环轮次内短暂重排，`acquire()` 不会在中途取得空队列。关闭发生时 Queue 已经恢复
FIFO 顺序，且 stale writer 已被 tombstone 替代。

- [ ] **Step 3: 接入维护、借用和停止路径**

在 `_maintain()` 每一轮、`qsize()` 判断之前调用：

```python
await self._mark_closed_preconnects()
```

将 `stop()` 的排空循环改为：

```python
while not self._pool.empty():
    try:
        entry = self._pool.get_nowait()
    except asyncio.QueueEmpty:
        break
    self._pool.task_done()
    if entry is _POOL_ZOMBIE:
        continue
    _, writer = entry
    await _close_writer(writer)
```

将 `acquire()` 的获取部分改为：

```python
while not self._pool.empty():
    try:
        entry = self._pool.get_nowait()
    except asyncio.QueueEmpty:
        break
    self._pool.task_done()
    if entry is _POOL_ZOMBIE:
        continue
    reader, writer = entry
    if writer.is_closing():
        continue
    if reader.at_eof():
        await _close_writer(writer)
        continue
    return reader, writer
return await self.create_connection()
```

保留当前 `create_connection()` 和 `ProxyCore._connect_with_pool()` 的实现，不增加即时补建
或新的后台 task。

- [ ] **Step 4: 运行 tombstone 测试，确认 Green**

Run:

```bash
cd client && pytest tests/test_upstream_pool_tombstone.py -q
```

Expected: PASS。TLS SOCKS EOF 项被替换为 tombstone 且本地 writer 被关闭；tombstone 保持
`qsize() == 3`；被消费后才触发既有补池；HTTP / 非 TLS SOCKS 不插入 tombstone。

### Task 3: 回归验证与资源警告检查

**Files:**

- Modify: none unless测试揭示真实回归
- Test: `client/tests/test_upstream_pool_tombstone.py`, `client/tests/test_proxy_core_doh.py`, `client/tests/`

**Consumes:** Task 2 的 tombstone 实现。

**Produces:** 已验证的最小 TLS SOCKS 修复，且 HTTP、非 TLS SOCKS 与现有握手回退不回归。

- [ ] **Step 1: 运行与 pool 交互的既有回归测试**

Run:

```bash
cd client && pytest tests/test_proxy_core_doh.py -q
```

Expected: PASS。特别确认：

- `test_connect_upstream_retries_fresh_connection_after_stale_pool_entry` 仍在真实握手失败后关闭
  借用连接并现场建连重试；
- `test_http_upstream_can_use_plain_tcp_pool_when_tls_flag_is_dirty` 保持 HTTP plain-TCP 语义。

- [ ] **Step 2: 运行完整客户端测试集**

Run:

```bash
cd client && pytest tests/
```

Expected: PASS，且无 `Task was destroyed but it is pending`、`unclosed transport`、
`ResourceWarning` 或未处理 asyncio 异常。

- [ ] **Step 3: 手工运行检查（不提交）**

使用现有 TLS SOCKS 客户端配置：启动后保持空闲超过 15 秒，再发起代理请求。确认服务端
超时后，客户端 debug 日志只记录预连接被标为失效；新请求不因该已知失效连接产生 SOCKS
握手失败，并能正常建立或复用可用连接。HTTP 和非 TLS SOCKS 配置各做一次普通代理请求，
确认其连接流程和日志不变。代码保持未提交，等待用户确认后再决定提交。
