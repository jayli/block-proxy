# 隧道伪装传输设计文档

**日期**: 2026-07-11
**状态**: 待实施
**范围**: 服务端 + Python client；Android client 暂不纳入本期

## 目标

把当前 TLS 上的自定义双 TCP 隧道，改造成可配置端口上的 HTTPS + WebSocket 传输。第一阶段先保证服务端和 Python client 的双向隧道可用；第二阶段再引入 NAT 映射轮换，允许短暂两条连接并存，以降低长期固定连接的特征。

本期不解决两个问题：

- 端口与证书暴露面：默认仍使用 `8003`，证书仍允许自签。后续再切换 443、真实域名、合法证书和 SNI。
- 更深的 HTTP 行为随机化：本期保留简单 HTTP 伪装入口，不把路径、资源访问序列、Header 组合做成复杂策略。

## 当前问题

当前实现的主要外部特征如下：

| 特征 | 当前实现 | 本期处理 |
|------|----------|----------|
| 心跳 | 固定 30 秒 PING | 改为随机间隔，并支持随机 payload |
| 传输协议 | TLS 内自定义二进制流 | 改为 WebSocket binary message 承载原始帧 |
| 连接数 | Python client 默认建立 2 条 TCP 通道 | Phase A 改为 1 条 active WebSocket |
| NAT 映射 | 长连接长期不变 | Phase B 支持 active + candidate/draining 短暂并存轮换 |
| 端口 | 默认 8003 | 保持可配置，默认仍为 8003 |
| TLS 证书 | 自签证书 | 本期接受；后续单独优化 |

## 分阶段设计

### Phase A: HTTPS + WebSocket + 随机心跳

Phase A 的目标是用最小行为变化跑通功能：

- 服务端使用 `https.createServer()` 提供 HTTPS。
- 同一个 HTTPS server 同时处理普通 HTTP 请求和 `/ws` WebSocket upgrade。
- WebSocket binary message 直接承载现有 `[2-byte length][payload]` 隧道帧。
- 客户端只建立 1 条 active WebSocket。
- 服务端和客户端都关闭 WebSocket 库内置 ping，使用现有协议里的 `FRAME_PING` / `FRAME_PONG`。
- `FRAME_PING` / `FRAME_PONG` 支持可选随机 payload。
- 正向和反向隧道 reqid 规则保持不变。

Phase A 完成后必须满足：

- Python client 能认证并保持连接。
- 正向代理可用。
- 反向代理可用。
- 心跳间隔不再固定。
- 服务端可通过 `curl -k https://host:8003/` 返回伪装 HTML。

### Phase B: NAT 轮换

Phase B 在 Phase A 稳定后再做。核心状态机：

| 状态 | 含义 | 允许新请求 |
|------|------|------------|
| `active` | 当前承载新请求和已有请求的连接 | 是 |
| `candidate` | 新建连接，认证通过但尚未接管 | 否 |
| `draining` | 老连接，不再接收新请求，只等待已有请求结束 | 否 |

轮换流程：

1. 客户端按随机间隔发起第二条 WebSocket 连接。
2. 服务端允许同一认证主体短暂存在 2 条连接：一个 `active`，一个 `candidate`。
3. 新连接认证成功后，服务端把 `candidate` 提升为 `active`。
4. 老连接降级为 `draining`，manager 不再把新请求分配给它。
5. 老连接等待已有请求自然结束，超过 drain timeout 后关闭。
6. 如果新连接建立或认证失败，旧 `active` 保持不变。

Phase B 的关键约束：

- 不允许长期超过 2 条已认证 WebSocket。
- `candidate` 必须在短时间内完成接管，否则关闭。
- manager 必须按连接绑定请求，不能把某个 reqid 的后续 DATA/CLOSE 发到另一条连接。
- 轮换失败不能影响当前 active 连接。

## 协议栈

```
┌──────────────────────────┐
│  existing tunnel frames  │  CONNECT/DATA/CLOSE/AUTH/PING/PONG
├──────────────────────────┤
│  WebSocket binary        │  one tunnel frame per WS message
├──────────────────────────┤
│  HTTPS                   │  fake HTTP routes + /ws upgrade
├──────────────────────────┤
│  TLS                     │  self-signed allowed in this phase
├──────────────────────────┤
│  TCP                     │
└──────────────────────────┘
```

## WebSocket 封装

WebSocket 消息格式保持简单：

```
WebSocket Binary Message
┌──────────────────────────────────────┐
│ 2 bytes: 原始隧道帧长度，大端         │
│ N bytes: 原始隧道帧 payload          │
└──────────────────────────────────────┘
```

不额外添加 WebSocket 内部 padding。原因：

- 原始帧协议已经有长度边界。
- WebSocket 库已经处理分片、mask、opcode。
- 额外 padding 会改变协议解析，需要额外字段定义，增加 Phase A 风险。

`FRAME_PING` / `FRAME_PONG` payload 扩展：

- 无 payload 时保持兼容：`[type]`。
- 有 payload 时格式为：`[type][random bytes...]`。
- PONG 应回显 PING payload，便于确认不是旧包或误包。

## HTTP 伪装

服务端在同一个 HTTPS 端口上提供：

| 路径 | 行为 |
|------|------|
| `/` / `/index.html` | 返回静态 HTML |
| `/favicon.ico` | 返回 favicon |
| `/ws` | WebSocket upgrade |
| 其他路径 | 返回普通 404 |

客户端 Phase A 连接流程：

1. 如果 `http_disguise=true`，访问 `https://host:port/`。
2. 等待 0.5 到 2 秒随机时间。
3. 如果 `http_disguise=true`，访问 `https://host:port/favicon.ico`。
4. 再等待 0.5 到 2 秒随机时间。
5. 建立 `wss://host:port/ws`。
6. 发送 `FRAME_AUTH`。
7. 收到 `FRAME_AUTH_OK` 后进入隧道读写循环。

注意：固定访问 `/` + `/favicon.ico` + `/ws` 的序列可能形成新特征。本期可以先保留简单流程；后续任务再做路径、资源、Header 和访问序列随机化。

## 心跳

服务端和客户端都关闭 WebSocket 内置 ping/pong：

- Node `ws`: 不主动使用 `ws.ping()`。
- Python `websockets`: `ping_interval=None`。

本期使用自定义帧：

- 心跳间隔：默认 15 到 40 秒随机。
- 心跳 payload：8 到 40 字节随机数据。
- 超时阈值：默认 60 秒无有效响应则断开。
- PONG 回显 PING payload。

默认采用服务端驱动心跳：服务端主动 PING，客户端收到后立即回显 PONG。这样服务端到客户端的 PING 和客户端到服务端的 PONG 都会产生流量，可维持普通 NAT 映射。客户端主动 PING 做成配置项，默认关闭；如果遇到会按单方向空闲清理映射的网关，再开启客户端主动 PING。

## Manager 连接绑定

manager 继续把 reqid 和连接对象绑定在 `_activeRequests` 中：

```javascript
{
  reqid,
  direction: 'forward' | 'reverse',
  socket: ws,
  ...
}
```

发送规则：

- 新请求只分配给当前 `active` 连接。
- 已有请求后续 DATA/CLOSE 始终发送到 entry 绑定的连接。
- `draining` 连接只允许完成已有请求，不允许分配新 reqid。
- 某条连接断开时，只清理绑定在这条连接上的请求。

Phase A 只有一条 `active` 连接，但仍保留连接绑定逻辑，为 Phase B 轮换做准备。

## 客户端状态

Phase A 客户端状态：

- `_ws`: 当前 active WebSocket。
- `_read_task`: 当前读循环。
- `_heartbeat_task`: 心跳任务。
- `_forward_requests`: 正向请求状态，按 reqid 存储。
- `_active_writers`: 反向请求目标 writer，按 reqid 存储。

客户端停止时不在同步 `stop()` 方法里直接 await WebSocket close。`stop()` 只负责通过 event loop 线程安全地发出停止信号、取消任务或调度关闭协程；最终资源清理由 `_connect_and_serve()` 的 `finally` 完成，避免跨线程 await 或事件循环已停止时遗留 socket。

Phase B 增加：

- `_active_ws`: 当前 active。
- `_candidate_ws`: 正在接管的新连接。
- `_draining_ws`: 等待关闭的旧连接。
- 每个 reqid 必须记录所属 ws。

服务端 candidate 认证成功后必须立即 promotion；不能允许 candidate 长期停留。实现中仍应保留 candidate deadline 作为防御，超过期限未 promotion 的 candidate 必须关闭。

## 配置

服务端新增可选配置：

```json
{
  "tunnel_port": 8003,
  "tunnel_ws_path": "/ws",
  "tunnel_heartbeat_min": 15,
  "tunnel_heartbeat_max": 40,
  "tunnel_heartbeat_timeout": 60,
  "tunnel_rotation_drain_timeout": 10
}
```

Python client 新增可选配置：

```python
config['tunnel'] = {
    'server_address': '...',
    'server_port': 8003,
    'ws_path': '/ws',
    'http_disguise': True,
    'heartbeat_min': 15,
    'heartbeat_max': 40,
    'heartbeat_timeout': 60,
    'rotation_enabled': False,
    'rotation_min': 600,
    'rotation_max': 1800,
    'rotation_drain_timeout': 10,
}
```

Phase A 默认 `rotation_enabled=False`。Phase B 实施完成并通过稳定性测试后再考虑默认开启。

## TLS 与端口限制

本期明确接受以下限制：

- 默认端口仍为 `8003`，但必须可配置。
- 自签证书仍可用，client 继续支持 `allowInsecure`。
- 不承诺消除 TLS 指纹、证书指纹和非 443 端口特征。

后续独立任务再处理：

- 443 端口。
- 真实域名。
- Let's Encrypt 或其他可信证书。
- SNI / ALPN / HTTP/2 行为。

## 验收标准

Phase A 验收：

- `tunnel/protocol.js` 和 `client/tunnel_client.py` 的 PING/PONG payload 互通。
- HTTPS server 能返回伪装 HTML 和 favicon。
- WebSocket `/ws` 能认证成功和失败。
- 服务端拒绝未认证帧。
- 正向代理通过 WebSocket 可用。
- 反向代理通过 WebSocket 可用。
- 心跳随机间隔可通过日志或测试观察。
- 服务端 stop 后释放监听端口。
- Python client stop 后不遗留 task 或 socket。

Phase B 验收：

- 轮换失败时旧 active 不中断。
- 轮换成功时新请求走新 active。
- 老 draining 连接只处理已有请求。
- drain timeout 后老连接关闭。
- 同一客户端不会长期超过 2 条认证连接。
- 连续轮换多次后正向和反向代理仍可用。
