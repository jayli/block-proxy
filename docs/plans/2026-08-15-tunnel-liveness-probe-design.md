# 隧道保活与客户端存活探测（最小补丁）设计文档

**日期**: 2026-08-15
**状态**: 已实施
**范围**: 仅服务端 tunnel/xhttpHandler.js 与 tunnel/test/xhttpHandler.test.js；不改客户端、配置、Express、proxy 启动链或 TunnelServer。

## 目标

补齐 PONG 未回应时的主动追问：

1. 服务端正常 SSE keepalive PING 发出后，等待 10 秒。
2. 未收到上行回应时，立即补发一个新的 PING，不等待下一次 20~25 秒的 keepalive 周期。
3. 连续 10 次 PING 都没有任何上行回应时，以现有 liveness-timeout 关闭会话；默认情况下，90 秒 sweeper 通常会先于该次数上限触发，因此次数上限是 sweeper 被放宽或异常时的兜底。
4. 原有 90 秒 liveness sweeper 继续作为最长静默时间限制；无需改变其语义。

这里的“上行回应”包括匹配 PONG、迟到/重复 PONG 和 DATA 等所有已按 UploadQueue 顺序消费的帧。任何这类帧都证明客户端及上行链路仍可用。

## 非目标

- 不增加运行时配置或 UI 字段；10 秒、10 次上限沿用代码内常量。
- 不修改现有 20~25 秒 SSE 空闲 keepalive 周期。
- 不修改 409 接管、lastActivityAt 的用途、上传乱序机制或客户端协议。
- 不引入 deadline 字段、退避策略、时钟注入或新的关闭原因。

## 最小状态

每个 session 新增：

| 字段 | 初始值 | 含义 |
|---|---:|---|
| pingAttempts | 0 | 当前连续未获上行回应的 PING 次数 |
| pongProbeTimer | null | 等待本次 PING 回应的定时器 |

复用：

- lastPingPayload：最后一次 PING 的 nonce。
- lastActivityAt：任意已消费上行帧的时间；继续供现有 sweeper 和 409 接管使用。

模块内部常量：

~~~js
const PONG_PROBE_TIMEOUT_MS = 10_000;
const PONG_PROBE_MAX_ATTEMPTS = 10;
~~~

## 行为

### 发送 PING

新增 _sendProbePing(session)：

~~~text
若 session 已关闭、无 SSE 或 SSE 已结束：返回 false
向 SSE 写入携带新 nonce 的 PING；写失败：返回 false
lastPingPayload = nonce
pingAttempts += 1
清除旧 pongProbeTimer
启动 10 秒 pongProbeTimer
重新调度常规 keepalive
返回 true
~~~

只有写入成功后才更新 nonce、次数和 timer。

### 常规 keepalive 与 probe 的关系

_scheduleKeepalive() 的 timer 到点时：

~~~text
若 pingAttempts > 0：已有活跃 probe，不发送 PING，只从当前时刻重调下一次常规 keepalive
否则：调用 _sendProbePing(session)
~~~

跳过时必须从当前时刻开始计算新的 keepalive delay，不能复用 lastSseWriteAt + delay - now 的“距最后真实 SSE 写入”公式；否则该写入已过期时会退化为每 1ms 重调度的热循环。建议将内部方法扩展为 _scheduleKeepalive(session, fromNow = false)，并在跳过分支传入 true；fromNow 为 true 时用 Date.now() 作为计算基准，不改写 lastSseWriteAt。

因此即使测试或未来配置将 keepalive 间隔设置得短于 10 秒，也不能反复重置 probe timer，导致补发 PING 永远无法执行或产生热循环。

不能仅用 lastPingPayload 是否为空判断活跃 probe：迟到/不匹配 PONG 需要保留 nonce 供日志诊断，但它已经将 pingAttempts 重置为 0，下一次常规 PING 应能覆盖旧 nonce。

### Probe 超时

新增 _handlePongProbeTimeout(session)：

~~~text
若 session 已关闭、无 SSE，或 pingAttempts 为 0：返回
若 pingAttempts >= 10：_closeSession(sessionId, 'liveness-timeout')
否则：_sendProbePing(session)
~~~

首次常规 PING 计为第 1 次。每 10 秒无回应则补发，最多 10 次。若次数上限未先触发，现有 _sweepStaleSessions() 仍会按 lastActivityAt 的 90 秒静默时间关闭会话。

### 收到上行帧

在 UploadQueue 的有序消费循环中，对每一个成功解码的 frame：

~~~text
lastActivityAt = Date.now()
pingAttempts = 0
清除 pongProbeTimer

若 frame 是 PONG 且 nonce 与 lastPingPayload 匹配：
  lastPingPayload = null
若 PONG 不匹配：
  记录 warning，但仍算存活并继续分发 frame
调用现有 _onFrame(frame, sessionId)
~~~

PONG 已到达 HTTP 服务端但被前序缺失 seq 阻塞时，尚未进入消费循环，不算回应；这是现有 UploadQueue 的顺序语义。

### 清理

以下路径均清除 pongProbeTimer：

- SSE response close；
- _closeSession()，因此也覆盖显式关闭、队列关闭、接管和 closeAll()。

保持 _closeSession() 的幂等性和现有 liveness-timeout 字符串。

## 测试

在 tunnel/test/xhttpHandler.test.js 添加最小覆盖，沿用现有 mock response 和短真实 timer：

1. keepalive PING 后 10 秒无 PONG，在下一次 keepalive 前出现补发 PING。
2. 连续无回应达到 10 次时会话关闭，closed 事件只触发一次。
3. 匹配 PONG 清除 timer、次数归零，会话保持存在。
4. DATA 清除 timer、次数归零，但不清除当前 nonce。
5. 不匹配 PONG 刷新 lastActivityAt 并取消 probe，但保留 nonce。
6. keepalive 间隔小于 probe timeout 时，活跃 probe 仍会超时补发/关闭。
7. SSE close 或 _closeSession() 后，timer 不会再发送 PING。

回归运行：

~~~bash
node --test tunnel/test/xhttpHandler.test.js
node --test tunnel/test/*.test.js
node --test test/tunnel-integration.test.js
~~~

## 文件清单

- 修改：tunnel/xhttpHandler.js
- 修改：tunnel/test/xhttpHandler.test.js

回滚只需还原这两个文件。
