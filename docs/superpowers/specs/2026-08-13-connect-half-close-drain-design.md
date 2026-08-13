# CONNECT 半关闭 Drain 设计

## 背景

服务端重启后的 FD 诊断仍显示 `tcp_fin_wait2` 与 `tcp_close_wait` 成对累积。现有中继依赖 socket 的 `close` 事件统一清理，但 TCP 收到 FIN 时先触发 `end`；若另一端未完成关闭，两个 socket 会分别停留在 `CLOSE_WAIT` 与 `FIN_WAIT2`，而不会触发既有清理。

## 目标

在不截断合法半关闭响应的前提下，对 proxy-core CONNECT 中继施加有界 drain，确保单侧 FIN 不能无限占用文件描述符。

## 范围

- 修改 `proxy/proxy-core/request-handler.js` 的 HTTP CONNECT 中继。
- 为 HTTP CONNECT 路径增加仅 FIN、不 close 的回归测试。
- 运行 tunnel 回归测试，验证 xhttp 协议、会话和轮换逻辑不变。

不修改 xhttp 帧协议、TunnelManager 会话管理、隧道客户端或普通 HTTP GET/POST 代理路径。

## 生命周期语义

1. 两端使用 `pipe({ end: false })`，避免 Node 默认 pipe 在源端 `end` 时隐式关闭目标端而失去可控性。
2. 任一端收到 `end`：调用对端 `end()` 转发 FIN；保留另一方向的数据，开始 half-close drain。proxy-core 的 client → upstream 方向已有 `cltSocket.on('end') → requestStream.push(null) → pipe` 的 FIN 传播，实施时保留该单一数据流，不再额外重复调用 `conn.end()`。
3. 双端均收到 `end`：立即调用幂等 cleanup，销毁两端并释放计数、映射和定时器。
4. 任一端发生 `error` 或 `close`：立即调用同一个 cleanup。
5. 单侧半关闭后，30 秒内无任意方向数据则 cleanup；即使仍有反向数据，5 分钟硬上限到期也 cleanup。
6. 每次任意方向数据均重置 drain idle timer，但不会延长 hard timer；两个 drain timer 都调用 `unref()`，不得阻止进程退出。

## 隧道兼容性

隧道正向连接通过 `TunnelManager._handleForwardConnect()` 对 `127.0.0.1:8001` 发起 HTTP CONNECT，因此会使用 proxy-core 的有界 drain。它仍可在一侧结束写入后接收剩余下行数据；只有不完成关闭的半关闭连接才会被收回。xhttp SSE、POST upload、帧编解码和 session drain 不受改动。

## 验收标准

- proxy-core CONNECT：目标仅发送 FIN 且保持连接不 close 时，client socket 在 drain 窗口后被销毁；客户端先 FIN 后目标仍可返回数据的既有行为保持。
- 所有 cleanup 路径均为幂等，活跃连接计数不会重复递减；drain timer 均已清除并 unref。
- proxy-core 回归测试使用现有内联 rule 形式，不引入未定义的测试 helper。
- `test/socks5-server-limits-tests.js`、`test/proxy-core-connect-tests.js`、`test/fd-diagnostics-tests.js`、`tunnel/test/manager.test.js` 和 `test/tunnel-integration.test.js` 通过。
