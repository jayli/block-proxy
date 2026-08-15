# 已替代：客户端预连接池鲁棒性实施计划

> 本计划对应“始终维持 3 条健康连接”的旧设计，不能执行。
> 修订设计见 `docs/plans/2026-08-16-client-tls-preconnect-tombstone-design.md`；
> 新实施计划将在该设计审阅后生成。

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 客户端在服务端回收空闲预连接后自动恢复 3 条可用连接，并在连接被真实请求消费后立即补位，同时不引入 socket、FD 或后台 task 泄漏。

**Architecture:** 将 `UpstreamPool` 从只按 `asyncio.Queue.qsize()` 判断容量，改为显式管理 idle 连接集合。唯一维护协程以“补位事件 + 1 秒健康巡检”驱动：清理 EOF/closing 的 idle 连接，再串行补足至 3 条。借出的连接不回池，仍由既有 SOCKS5/HTTP 握手和中继路径负责。

**Tech Stack:** Python 3、asyncio、pytest（以 `asyncio.run()` 驱动异步单元测试）。

## Global Constraints

- 仅修改客户端；不得修改 `socks5/`、服务端配置、服务端 15 秒 timeout 或服务端日志。
- `POOL_SIZE = 3` 与 `POOL_CHECK_INTERVAL = 1.0` 保持默认值，不新增用户配置项。
- 预连接只建立 TCP/TLS；不得提前发送 SOCKS5 greeting、认证、SOCKS CONNECT 或 HTTP CONNECT。
- SOCKS5-over-TLS 与 HTTP plain-TCP 必须共享池生命周期，后续握手及现场重连语义不变。
- 不在后台调用 `reader.read()`；健康检测只使用 `reader.at_eof()` 和 `writer.is_closing()`。
- 严格 TDD：先写完本计划定义的全部行为测试并确认 Red，再写实现使其 Green。
- 代码完成后等待用户验证，不自动 `git add`、commit 或 push。

---

## File structure

- Modify: `client/proxy_core.py:1-20,510-590`
  - 将 `UpstreamPool` 改为受管 idle 集合、补位事件和唯一维护协程；保留
    `create_connection()` 的 SOCKS TLS / HTTP plain-TCP 参数分支。
- Create: `client/tests/test_upstream_pool.py`
  - 不依赖真实网络和 15 秒 timeout 的异步单元测试；用 reader/writer 假对象验证
    生命周期、补位、失败节流和关闭所有权。
- Keep unchanged: `client/tests/test_proxy_core_doh.py`
  - 作为 `_connect_with_pool()` 现场重连和 HTTP pool 握手的既有回归测试。

## Interfaces

`UpstreamPool` 保持如下外部接口，现有 `ProxyCore` 调用点无需变动：

```python
class UpstreamPool:
    def __init__(self, server_config, ssl_ctx, verify_cert_pin=None, *, check_interval=None): ...
    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    async def create_connection(self) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]: ...
    async def acquire(self) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]: ...
```

`check_interval` 仅是测试注入参数；传入 `None` 时使用 `POOL_CHECK_INTERVAL`。它不是配置文件
字段，`ProxyCore` 继续按现有 3 个构造参数调用。

新增私有成员和方法：

```python
self._idle: deque[tuple[reader, writer]]  # 仅池拥有的空闲连接
self._refill_event: asyncio.Event         # 启动、借用或失效时唤醒维护协程
self._task: asyncio.Task | None           # 唯一后台维护协程
self._check_interval: float               # 默认 1.0，仅测试可缩短

def _is_usable(self, reader, writer) -> bool: ...
def _request_refill(self) -> None: ...
async def _discard_stale_idle(self) -> None: ...
async def _maintain(self) -> None: ...
```

`_idle` 中没有 borrowed 连接。所有从 `_idle` 移除的连接先失去池所有权，再由当前路径调用
`_close_writer()`；避免同一个 writer 被两个池路径关闭。

### Task 1: 写出预连接池完整生命周期的 Red 测试

**Files:**

- Create: `client/tests/test_upstream_pool.py`
- Modify: none

**Consumes:** 现有 `proxy_core.UpstreamPool`、`POOL_SIZE` 与 `_close_writer()`。

**Produces:** 覆盖启动、EOF、借用、失败、重复信号与 stop 的行为测试。当前 Queue 实现无法
接受 `check_interval`、没有 `_idle` 和 `_request_refill()`，因此测试必须整体 Red。

- [ ] **Step 1: 建立不使用真实网络的测试辅助对象**

创建 `client/tests/test_upstream_pool.py`，加入：

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
    def __init__(self):
        self.closed = False
        self.close_calls = 0

    def is_closing(self):
        return self.closed

    def close(self):
        self.close_calls += 1
        self.closed = True

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
```

- [ ] **Step 2: 写入 EOF 回收与借用即时补位测试**

在同一文件加入以下两项测试。`connections.pop(0)` 确保超建会立即变成测试失败。

```python
def test_pool_refills_after_server_closes_idle_connection():
    async def scenario():
        connections = [(FakeReader(), FakeWriter()) for _ in range(4)]
        pool = proxy_core.UpstreamPool({}, None, check_interval=0.001)

        async def create_connection():
            return connections.pop(0)

        pool.create_connection = create_connection
        await pool.start()
        await wait_until(lambda: len(pool._idle) == proxy_core.POOL_SIZE)

        stale_reader, stale_writer = pool._idle[0]
        stale_reader.eof = True

        await wait_until(lambda: stale_writer.close_calls == 1)
        await wait_until(lambda: len(pool._idle) == proxy_core.POOL_SIZE)
        assert stale_writer not in [writer for _, writer in pool._idle]
        await pool.stop()

    asyncio.run(scenario())


def test_pool_borrow_triggers_immediate_refill_without_closing_borrowed_connection():
    async def scenario():
        connections = [(FakeReader(), FakeWriter()) for _ in range(4)]
        pool = proxy_core.UpstreamPool({}, None, check_interval=10)

        async def create_connection():
            return connections.pop(0)

        pool.create_connection = create_connection
        await pool.start()
        await wait_until(lambda: len(pool._idle) == proxy_core.POOL_SIZE)

        _, borrowed_writer = await pool.acquire()
        await wait_until(lambda: len(pool._idle) == proxy_core.POOL_SIZE)
        await pool.stop()

        assert borrowed_writer.close_calls == 0

    asyncio.run(scenario())
```

第二项使用 `check_interval=10`：如果借用不通过事件即时唤醒维护协程，0.2 秒测试超时前
不会补位。

- [ ] **Step 3: 写入失败节流、重复信号和 stop 所有权测试**

在同一文件加入：

```python
def test_pool_coalesces_refill_signals_after_temporary_connect_failure():
    async def scenario():
        attempts = 0
        connections = [(FakeReader(), FakeWriter()) for _ in range(3)]
        pool = proxy_core.UpstreamPool({}, None, check_interval=0.001)

        async def create_connection():
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise OSError("temporary failure")
            return connections.pop(0)

        pool.create_connection = create_connection
        await pool.start()
        await wait_until(lambda: attempts >= 1)
        maintenance_task = pool._task
        for _ in range(20):
            pool._request_refill()

        await wait_until(lambda: len(pool._idle) == proxy_core.POOL_SIZE)
        assert attempts == 4
        assert pool._task is maintenance_task
        await pool.stop()

    asyncio.run(scenario())


def test_pool_stop_closes_idle_once_and_leaves_borrowed_connection_to_caller():
    async def scenario():
        connections = [(FakeReader(), FakeWriter()) for _ in range(4)]
        pool = proxy_core.UpstreamPool({}, None, check_interval=0.001)

        async def create_connection():
            return connections.pop(0)

        pool.create_connection = create_connection
        await pool.start()
        await wait_until(lambda: len(pool._idle) == proxy_core.POOL_SIZE)
        _, borrowed_writer = await pool.acquire()
        await wait_until(lambda: len(pool._idle) == proxy_core.POOL_SIZE)
        idle_writers = [writer for _, writer in pool._idle]

        await pool.stop()

        assert pool._task is None
        assert len(pool._idle) == 0
        assert borrowed_writer.close_calls == 0
        assert all(writer.close_calls == 1 for writer in idle_writers)

    asyncio.run(scenario())
```

`attempts == 4` 精确表示“一次失败 + 三次成功补足”；每个补位信号另建 task 的实现会消耗
超过 3 条测试连接并失败。

- [ ] **Step 4: 运行测试，确认 Red**

Run:

```bash
cd client && pytest tests/test_upstream_pool.py -q
```

Expected: FAIL。当前 `UpstreamPool.__init__()` 不接受 `check_interval`，也没有 `_idle` 和
`_request_refill()`。不得修改断言、增加 sleep 或降低容量要求来让当前 Queue 实现通过。

### Task 2: 实现受管 idle 集合、单维护协程与幂等关闭（Green）

**Files:**

- Modify: `client/proxy_core.py:1-20,510-590`
- Test: `client/tests/test_upstream_pool.py`

**Consumes:** Task 1 的全部 Red 测试与假 reader/writer 语义。

**Produces:** 使用 idle deque、补位事件和唯一维护 task 的 `UpstreamPool`；所有新测试 Green。

- [ ] **Step 1: 用 deque 和 event 替换 Queue 状态**

在 `client/proxy_core.py` 的 import 区添加：

```python
from collections import deque
```

把 `UpstreamPool.__init__` 改成：

```python
def __init__(self, server_config, ssl_ctx, verify_cert_pin=None, *, check_interval=None):
    self._server_config = server_config
    self._ssl_ctx = ssl_ctx
    self._verify_cert_pin = verify_cert_pin
    self._check_interval = POOL_CHECK_INTERVAL if check_interval is None else check_interval
    self._idle = deque()
    self._refill_event = asyncio.Event()
    self._running = False
    self._task = None
```

添加以下私有方法。不要读取 `reader`，只检查 asyncio 已报告的状态：

```python
def _is_usable(self, reader, writer):
    return not writer.is_closing() and not reader.at_eof()

def _request_refill(self):
    if self._running:
        self._refill_event.set()

async def _discard_stale_idle(self):
    live = deque()
    stale_writers = []
    while self._idle:
        reader, writer = self._idle.popleft()
        if self._is_usable(reader, writer):
            live.append((reader, writer))
        else:
            stale_writers.append(writer)
    self._idle = live
    for writer in stale_writers:
        logger.debug("discarding closed upstream preconnect")
        await _close_writer(writer)
```

- [ ] **Step 2: 实现唯一维护协程和即时补位**

保持 `create_connection()` 的 SOCKS TLS / HTTP plain-TCP 参数分支完全不变。替换
`start()`、`_maintain()` 与 `acquire()` 为：

```python
async def start(self):
    if self._running:
        return
    self._running = True
    self._task = asyncio.ensure_future(self._maintain())
    self._request_refill()

async def _maintain(self):
    candidate = None
    try:
        while self._running:
            self._refill_event.clear()
            await self._discard_stale_idle()
            while self._running and len(self._idle) < POOL_SIZE:
                try:
                    candidate = await self.create_connection()
                except Exception as exc:
                    logger.debug("upstream preconnect failed: %s", exc)
                    break
                if not self._running or len(self._idle) >= POOL_SIZE:
                    await _close_writer(candidate[1])
                    candidate = None
                    break
                self._idle.append(candidate)
                candidate = None
            try:
                await asyncio.wait_for(
                    self._refill_event.wait(), timeout=self._check_interval
                )
            except asyncio.TimeoutError:
                pass
    finally:
        if candidate is not None:
            await _close_writer(candidate[1])

async def acquire(self):
    while self._idle:
        reader, writer = self._idle.popleft()
        if self._is_usable(reader, writer):
            self._request_refill()
            return reader, writer
        await _close_writer(writer)
        self._request_refill()
    return await self.create_connection()
```

`candidate` 只在维护协程本地拥有；它已经入池后立即置为 `None`。因此取消维护协程时，
候选连接不会遗留。任意时刻只有 `start()` 创建的这一个 `_task` 会调用后台
`create_connection()`。

- [ ] **Step 3: 实现 stop 的幂等关闭顺序**

替换 `stop()` 为：

```python
async def stop(self):
    if not self._running and self._task is None:
        return
    self._running = False
    self._refill_event.set()
    task, self._task = self._task, None
    if task:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    while self._idle:
        _, writer = self._idle.popleft()
        await _close_writer(writer)
```

先从 `_idle` 移除、再 await `_close_writer()`。不得关闭已由 `acquire()` 返回的 borrowed
连接。`_maintain()` 在每次建连返回后检查 `_running`，确保 stop 开始后不再入池。

- [ ] **Step 4: 运行池测试，确认 Green**

Run:

```bash
cd client && pytest tests/test_upstream_pool.py -q
```

Expected: PASS。EOF 会在一个缩短的测试巡检周期内回收并补位；借用时无需等 10 秒；连接
失败和 20 次重复信号只产生一个维护 task；stop 后 idle writer 恰好关闭一次。

### Task 3: 验证既有上游协议路径与完整客户端回归

**Files:**

- Modify: none unless测试揭示真实回归
- Test: `client/tests/test_proxy_core_doh.py`, `client/tests/test_upstream_pool.py`, `client/tests/`

**Consumes:** Task 2 的受管 idle 池实现。

**Produces:** 已验证的 SOCKS TLS、HTTP plain-TCP 和现场建连回退兼容性。

- [ ] **Step 1: 运行与 pool 交互的既有回归测试**

Run:

```bash
cd client && pytest tests/test_proxy_core_doh.py -q
```

Expected: PASS。特别确认：

- `test_connect_upstream_retries_fresh_connection_after_stale_pool_entry` 仍会关闭失败的借用连接，
  并现场建连重试；
- `test_http_upstream_can_use_plain_tcp_pool_when_tls_flag_is_dirty` 仍以 plain TCP 创建 HTTP
  上游连接，而不会错误套用 TLS。

- [ ] **Step 2: 运行完整客户端测试集**

Run:

```bash
cd client && pytest tests/
```

Expected: PASS，且无 `Task was destroyed but it is pending`、`unclosed transport`、
`ResourceWarning` 或未处理 asyncio 异常。

- [ ] **Step 3: 人工运行检查（不提交）**

使用现有客户端配置连接 SOCKS-over-TLS 服务端，保持客户端空闲超过 30 秒，然后发起一个
新的代理请求。确认请求可成功完成；客户端 debug 日志可出现正常的失效预连接回收，但没有
warning/error 风暴。代码和文档均保持未提交，等待用户确认后再决定提交。
