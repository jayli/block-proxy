# 客户端 TLS SOCKS 预连接 tombstone 最小修复设计

**日期：** 2026-08-16  
**状态：** 待审阅  
**范围：** 仅 `client/proxy_core.py` 的 `UpstreamPool`；仅对 SOCKS5-over-TLS 的空闲预连接启用新行为。

## 1. 目标

维持现有 `asyncio.Queue(maxsize=3)` 预连接池和现有按需补建节奏。服务端关闭空闲 TLS
预连接后，客户端不立即建立替代连接；而是尽早释放本地 socket/FD，并在 Queue 中留下不占
资源的 tombstone。真实请求消费 tombstone 时直接丢弃并新建 TLS SOCKS 连接，不再把已知
失效的连接交给 SOCKS 握手流程试错。

## 2. 当前行为与缺口

当前 `UpstreamPool` 以 `Queue.qsize()` 维持最多 3 条预连接。`acquire()` 已检查
`writer.is_closing()` 与 `reader.at_eof()`；若在借用当刻已经观测到关闭，会直接跳过该连接
并调用 `create_connection()`，而不是必然把它用于 SOCKS 握手。

问题在于维护协程不巡检 Queue 内连接。因此已被服务端关闭的空闲连接会继续持有到下一次
`acquire()`；客户端没有机会尽早释放本地资源，也没有把“已知失效”稳定地记录在 Queue
中。Queue 表面满载时，维护协程不会补建，这是当前设计刻意保留的节流语义。

## 3. 方案选择

### 3.1 不采用：持续补齐健康连接

服务端仍以 15 秒回收空闲 TLS 连接时，立即补齐会使每客户端的三条预连接持续重建。它
改变当前连接压力，不符合本次最小修复目标。

### 3.2 不采用：只打标记、不关闭 writer

远端已关闭时继续持有本地 `StreamWriter` 可能使 FD 停留在关闭等待状态，直到未来某个
请求借用它；这不满足无 socket/FD 泄漏的要求。

### 3.3 采用：关闭 writer + Queue tombstone

增加模块私有哨兵对象：

```python
_POOL_ZOMBIE = object()
```

Queue 项目可为 `(reader, writer)` 或 `_POOL_ZOMBIE`。tombstone 是逻辑占位符，不含 reader、
writer 或 FD，仍计入 `Queue.qsize()`。

## 4. 运行逻辑

### 4.1 仅 TLS SOCKS 的健康扫描

`_maintain()` 每轮先判断：

```python
protocol = self._server_config.get("protocol", "socks5")
enabled = protocol == "socks5" and bool(self._server_config.get("tls"))
```

只有 `enabled` 时才扫描 Queue。扫描同步地取出全部当前项、保持原有 FIFO 顺序重新放回，
避免扫描期间 `await` 导致 `acquire()` 观察到临时空队列。

Queue 被作为连接池使用而非生产者/消费者任务队列；但 `put_nowait()` 仍会增加 asyncio
的内部 unfinished-task 计数。因此扫描、`acquire()` 和 `stop()` 每次成功
`get_nowait()` 后都必须立即配对调用 `task_done()`。扫描重新 `put_nowait()` 的项会重新增加
一次计数，净值不变；被借用、丢弃或停止关闭的项则正确完成其 Queue 生命周期。

对每个真实连接，若 `writer.is_closing()` 或 `reader.at_eof()` 为真：

1. 向 Queue 放回 `_POOL_ZOMBIE`，保持逻辑长度不变；
2. 随后调用已有 `_close_writer(writer)`，释放本地资源；
3. 记录 debug 级别日志，不记录 warning/error。

已存在的 tombstone 原样放回。扫描完成后仍执行现有的 `qsize() < POOL_SIZE` 判断；因为
tombstone 计数，服务端关闭本身不会触发预连接重建。

扫描只读取 `at_eof()` / `is_closing()`，不得调用 `reader.read()`。后台读取会与以后真实
SOCKS 握手竞争输入字节，而且服务器在 greeting 前本就不应发送应用数据。

### 4.2 借用逻辑

`acquire()` 从 Queue 取得项后：

1. 若为 `_POOL_ZOMBIE`，立即丢弃并继续取下一项；不进行任何网络写入或 SOCKS 握手。
2. 若为真实连接，保留现有 `is_closing()` / `at_eof()` 检查，以覆盖“扫描后才关闭”的竞态；
   发现失效则关闭并丢弃。
3. 取得健康真实连接则原样返回。
4. Queue 耗尽时，保留现有 `create_connection()` 行为，直接建立新的 SOCKS-over-TLS 连接供
   当前请求使用。

被消费的 tombstone 或竞态失效连接会使 Queue 实际长度下降。下一次现有维护周期发现
`qsize() < 3` 后，按当前逻辑补建一条预连接；不新增即时补建 task 或重试机制。

### 4.3 停止清理

`stop()` 排空 Queue 时，遇到 tombstone 直接跳过；遇到真实 `(reader, writer)` 则沿用
`_close_writer(writer)`。tombstone 没有资源，不能按元组解包或关闭。

## 5. 非 TLS SOCKS 与 HTTP 的隔离

当前项目会为 `socks5` 和 `http` 协议创建 `UpstreamPool`。本补丁不改变这项既有创建行为，
也不改变它们按需建连和普通补池逻辑。

健康扫描和 tombstone 插入严格受 `protocol == "socks5" and tls` 限制。因此非 TLS SOCKS
和 HTTP 上游不会收到 tombstone、不会提前关闭其池项，也不会改变其连接数、FD 或时序。

## 6. 已知边界

异步运行时必须已经将远端关闭体现为 `reader.at_eof()` 或 `writer.is_closing()`，扫描才能
识别。若两者都尚未反映关闭，扫描不会猜测连接死亡；这与现有 `acquire()` 的公开状态判断
保持一致。

以 `reader.read()` 主动探测可以处理该极端情况，但会引入“后台监听与 SOCKS 握手争读”的
所有权竞态，不属于最小补丁，明确不做。

## 7. TDD 验收

新增可控异步单元测试，至少覆盖：

1. TLS SOCKS 队列中检测到 EOF 时，真实 writer 被关闭一次、对应位置变为 tombstone、
   Queue 大小仍为 3，且维护协程不会立即补建。
2. `acquire()` 遇到 tombstone 时不调用 SOCKS 握手、不返回该项；队列耗尽后直接建立当前
   请求所需的新连接。
3. tombstone 被消费后，下一次既有维护周期才补建预连接，恢复 Queue 的 3 个真实连接。
4. 扫描和 `stop()` 均能处理 tombstone；所有真实 writer 最多关闭一次。
5. 非 TLS SOCKS 与 HTTP 配置不运行扫描、不插入 tombstone，维持现有行为。
6. 现有 `_connect_with_pool()` 的现场建连回退测试和完整客户端测试集继续通过。

## 8. 成功标准

- 服务端关闭已被 asyncio 观测到后，客户端无需等真实请求即可释放相应本地 FD。
- 已知失效的 Queue 项不会被用于 SOCKS 握手。
- 服务端关闭本身不会立即触发新的预连接建连。
- tombstone 被真实请求消费后，补池仍遵循原有 `qsize() < 3` 的维护节奏。
- 非 TLS SOCKS 和 HTTP 行为无变化；不修改服务端代码。
