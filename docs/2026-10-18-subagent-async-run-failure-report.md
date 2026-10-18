# pi-subagents 异步子代理运行失败调研报告

- 日期：2026-10-18
- 环境：macOS，Node v26.4.0，pi（pi-coding-agent）1.3.0（2026-10-15 发布），pi-subagents 0.79.0（2026-10-17 发布）
- 现象：后台（async）子代理在**子代理本身已经跑完并产出完整答案**之后，runner 进程以 `exit 0` 退出，不写结果文件、不写终态。父会话把它判定为 `failed`，回给我一句 `Async runner process <pid> exited with code 0 before writing a result.`
- 结论（一句话）：**失败的是 pi-subagents 的 detached runner 收尾阶段，不是子代理的推理/工具执行，也不是评审内容本身。** 子代理结束时 runner 进程在没有活句柄的情况下退出了（exit 0），收尾持久化（结果文件 / status / completed 事件 / process-terminal 凭证）一个都没执行。同步（`async: false`）子代理正常，是本报告验证过的可用替代。

---

## 1. 结论摘要（按证据强度分级）

| 判断 | 证据强度 | 依据 |
| --- | --- | --- |
| 子代理工作完成、答案完整 | 已确认 | 4 个失败 run 的 `output-0.log` 都有完整最终答案；子会话 `session.jsonl` 最后一条是 `stopReason: "stop"` 的 assistant 消息 |
| runner 在 `agent_end` 后 39–103ms 内以 exit 0 退出，stderr/stdout 全空 | 已确认 | `status.json` 的 `lastActivityAt` vs `processTerminal.closeObservedAt`；`runner.stderr.log`、`runner.stdout.log` 均为 0 字节 |
| 结果文件、终态 status、`subagent.run.completed` 事件、process-terminal candidate 全部缺失 | 已确认 | 4 个 run 的 `events.jsonl` 都没有 `subagent.run.completed`；`async-subagent-results/` 下没有 `<runId>.json`；`process-terminal-candidate.json` 仍是启动时的空 `writers: {}` |
| 与 agent 类型、任务长度、模型超时无关 | 已确认 | reviewer（27 轮 / 38 轮 / 2 轮）与 worker（2 轮）全部同样失败；无 timeout 记录；2 轮任务 4 秒内就失败 |
| 同步（`async:false`）子代理正常 | 已确认 | 同环境同步 worker 返回 `probe-ok OK`，`state=completed` |
| 失败判定机制（为什么显示 "failed" 而不是 "无结果"） | 已确认 | `stale-run-reconciler.js` + `process-terminal.js` 源码（见 §2） |
| 退出不是显式 `process.exit(0)` 可达路径 | 高 | host 是 Node 路径；runner 内 `process.exit(0)` 只在 `runConfiguredSubagent` resolve 之后；pi 里其余 `process.exit` 都在 runner 走不到的 CLI/信号分支；本地扩展无 `process.exit`（见 §4.3） |
| 根因是收尾链路上某个 `await` 悬空，事件循环耗尽后 Node 以 0 退出 | 推断（强） | 上述排除后只剩这一种机制；未能定位到具体哪一行 `await`（见 §4.4 的局限） |
| 与 pi 1.3.0 / Node 26 / 0.79.0 版本组合有关 | 推断 | 时间上吻合，但没有本机历史成功样本可对照，也未做降级实验（见 §7） |

---

## 2. 「失败」是怎么被判定的（机制，已从源码确认）

一次 async 运行的产物分三处：`async-subagent-runs/<runId>/`（status、events、candidate）、`async-subagent-results/<runId>.json`（结果，父会话真正消费的东西）、子会话 `session.jsonl`。正常收尾时，runner 的收尾块（`src/runs/background/subagent-runner.js` 约 4807–4890 行）按顺序做：

1. `publishRunResult()` → 写 `async-subagent-results/<runId>.json`（结果文件）
2. `writeStatusPayload()` → `status.json` 置终态
3. `appendJsonl(eventsPath, {type:"subagent.run.completed"})`
4. `writeRunLog()`
5. `disposeChildSessions()` + 排空持久化队列
6. 最后才重写 `process-terminal-candidate.json`，写入 `writers` 与 `expectedWriters`

本次四个失败 run 里，1–6 **一个都没发生**：没有结果文件、status 仍是 `running`、没有 completed 事件、candidate 还是启动时写的那份（无 `expectedWriters`）。

随后父会话侧的 `stale-run-reconciler.js` 在一个扫描周期里看到「status 还是 running + 没有结果文件 + 记录的 pid 已经不存在」，就调用 `writeFailedRepair()`：

- 它把 `steps[0]` 从 running 改成 failed，`error` 写成 `Async runner process <pid> exited with code 0 before writing a result.`
- 生成一份 `success: false` 的失败结果文件并投递给父会话——**这就是我收到的通知**。

`process-terminal.json` 里的 `state: "unknown"` + `reason: "writer-close-unverified"` 来自 `process-terminal.js:186-187`：candidate 的 `writers` 为空且没有 `expectedWriters`，runner 退出凭证无法被证明，只能记成 unknown。它不影响上面的判定，只是让「退出是否干净」也变成不可证。

> 换句话说：通知里那句话不是「评审内容失败」，而是「runner 没交卷」。而 runner 的收尾代码并没有机会跑。

---

## 3. 复现

四个失败 run（时间戳为 epoch ms；差值 = 最后一次活动到进程退出）：

| runId | agent | 轮次/工具 | 最后活动 | 进程退出 | 差值 | exit | 有结果文件 | 有 completed 事件 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `cec4f049…` | reviewer | 27 / 35 | 1792335781369 | 1792335781472 | 103 ms | 0 | 否 | 否 |
| `5b7a0b0b…` | reviewer | 38 / 59 | 1792331635236 | 1792331635275 | 39 ms | 0 | 否 | 否 |
| `0eb1f29a…` | reviewer | 2 / 1 | 1792337159799 | 1792337159900 | 101 ms | 0 | 否 | 否 |
| `8c2a166b…` | worker | 2 / 1 | 1792337202463 | 1792337202509 | 46 ms | 0 | 否 | 否 |

前两个是真实任务（218KB / 268KB 的评审正文，均已完整写入 `output-0.log`，其中第一个的结论是 `Merge verdict: BLOCK`，我在修复代码时逐条采用了）；后两个是我为定位问题做的最小复现：

- 极小 reviewer：`读 /tmp/h2-probe.txt，回一行 "<内容> OK"` → 答案 `probe-ok OK` 已生成，仍失败
- 极小 worker：同一任务 → 同样失败
- **同步** worker：同一任务、`async: false` → 成功返回 `probe-ok OK`

复现率 4/4（异步），替代方案 1/1（同步）。两个真实失败 run 来自**不同的父会话**（13:23Z 与 14:22Z 启动的两个 session），排除了「我的会话里某次操作误伤」这一解释。

---

## 4. 根因分析

### 4.1 排除：扩展强制退出（pi-subagents 已知问题 #2883）

0.79.0 的 CHANGELOG 里有一条与错误文案完全一致的记录：

> An extension that force-exits a headless run on quit could kill the background runner when one of its children ended … The runner now sets `PI_SUBAGENT_RUNNER_PID` … (#2883)

这条**不是本次原因**，逐项验证：

- `~/.pi/agent/extensions/**`（包括 `exit-command.ts`、`plan-mode`、`ask-user-question`、`sandbox-boundary` 等）里没有任何 `process.exit`；`exit-command.ts` 只在 TUI 里对整行 `exit/quit/bye` 生效。
- 子会话只加载了一个 runtime 扩展。对 `launchResolvedExtensions.runtime: ["sha256:725595a62127f7a0"]` 做了哈希反查：它是 `sha256(路径)` 前 16 位，对应 pi-subagents 自己的 `src/runs/shared/subagent-prompt-runtime.js`，不是第三方「退出」扩展。
- 该修复（`PI_SUBAGENT_RUNNER_PID`）在 0.79.0 已落地（`subagent-runner.js:89`）。

### 4.2 排除：模型、任务长度、超时、并发

- 2 轮 / 1 次工具的任务同样失败，与 27/38 轮的长评审没有区别。
- reviewer 与 worker 都失败，说明与 agent 的工具集、system prompt 无关。
- `status.json` 无 `timedOut`，`deadlineAt` 远未到（timeoutMs=3600000）。
- 失败是「答案生成之后」立刻发生的，不是推理中断。

### 4.3 排除：显式 `process.exit(0)` 的可达路径

- **host 判定**：pi 通过 pnpm shim 运行 `node .../dist/bundle/cli.js`，`process.versions.bun` 不存在；pi-subagents 的 `resolveBunPiExecutable()` 要求 Bun + `/$bunfs/` 入口，因此 `binaryHost` 为 undefined → runner 走 Node 路径（`node subagent-runner-bootstrap.js <cfg>`），不是 Bun 二进制路径。
- 该路径下 runner 的退出只有一处：`subagent-runner-bootstrap.js:223`

  ```js
  runConfiguredSubagent(config).then(() => process.exit(0), (error) => { console.error(...); process.exit(1); });
  ```

  即「退出 0」要求 `runConfiguredSubagent` 正常 resolve。
- `runConfiguredSubagent` → `runConfiguredSubagentExecution` → `await runSubagent(...)`；在 `runSubagent` 里从 4400 行到收尾块结束（约 4890 行）**没有任何 `return`**（已扫描全部缩进层级），收尾块是循环之后的顺序代码，不会被提前跳过。若它执行过，第 2 节列的 1–6 步必留痕。
- pi SDK `pi-agent-core/dist` 里没有 `process.exit`；`pi-coding-agent/dist` 里的 `process.exit` 都在 runner 走不到的 CLI / 命令分支上（`dist/main.js` 的 `--version`、`--export`、config/package 命令；`print-mode.js` 只在收到 SIGTERM/SIGHUP 时以 129/143 退出；`output-guard.js` 在 raw stdout 写失败时 exit 1；`cli/session-picker.js` 是交互选择）。它们都不能产生本次的 `exit 0 / signal null / stderr 为空`。
- 失败 run 的 `runner.stderr.log` 与 `runner.stdout.log` 都是 0 字节，因此也不是 `exit(1)` 分支。

### 4.4 唯一剩下的解释（推断）

子代理 `agent_end` 之后，runner 的收尾链路在某个 `await` 上再也不会 resolve；此时子会话已经结束，它占用的 socket / timer 等句柄也都没了，Node 的**事件循环耗尽后以退出码 0 结束进程**（未捕获的 pending promise 本身不会让 Node 停留）。于是收尾 1–6 步全部被跳过，父会话看到的就是「runner 干净退出但没有结果」。

这正是我们观察到的精确特征：exit 0、无信号、无 stderr、离 `agent_end` 只有几十毫秒、所有收尾产物都缺。

**未定位的一步**：具体是哪个 `await` 悬空，需要给 runner 进程加进程内探针（例如在 `process.on('exit')` / `--trace-exit` 下重跑并打印调用栈），或拿到父进程 launch 时的完整 config 与 env（`PI_CODING_AGENT_PACKAGE_ROOT`、`JITI_ALIAS` 等）手工复跑。本次没有做这一步：复现任务本身是交给内建 `subagent` 工具跑的，我拿不到那一份 launch 配置的完整副本（runner 启动时会删除 cfg），而手工拼一份 config 需要连带复刻 SDK 别名环境，成本与风险都高于本次调研的范围。

### 4.5 版本面

- pi 1.3.0 发布于 2026-10-15；pi-subagents 0.79.0 发布于 2026-10-17（晚于 pi 1.3.0），CHANGELOG 的 `Unreleased` 为空，说明上游还没有针对本现象的新修复。
- pi-subagents 的 `peerDependencies` 对 `@earendil-works/pi-coding-agent` 写的是 `*`，没有版本上限，因此「宿主升级引入 runner 生命周期变化」不会被依赖检查拦下。
- 本机没有更早的成功 async 样本可做前后对照（`async-subagent-runs/` 里有 status 的只有这两个失败 run，其余是空目录），所以「是不是 0.79.0 / pi 1.3.0 引入」只能算推断，未做降级实验。

---

## 5. 影响面

1. **所有 async 子代理的结果都收不回来**：reviewer、worker 一样；父会话只会收到「failed + runner 退出」的失败通知。
2. **状态缓存全丢**：`status.json` 停在 running，靠对账改成 failed；`/subagents` 里看不到真实耗时/模型统计（部分字段来自 status）。
3. **依赖结果文件的能力同样受影响**：父侧的 result watcher 只负责投递 runner 写出的结果文件，它不会从子会话重建结果；workflow 的 child 结果复用也读不到。
4. **`bg_wait` / 异步通知拿不到内容**：通知只是 repair 的失败文案。
5. **子代理实际工作量照常消耗**（本例一个 27 轮 + 一个 38 轮评审、以及 `output-0.log` 里的完整正文）。

好消息：数据没丢。每个 run 的 `output-0.log`（子代理输出流）与子会话 `session.jsonl`（完整消息与工具结果）都在，正文可以直接取回——本次代码修复就是基于失败 run 的 `output-0.log` 完成的。

---

## 6. 对策

### 6.1 立即可用（已验证）

- 单次调用显式 `async: false`（前台执行，结果直接返回）：本次同步 worker 成功。
- 全局改成前台优先：在 `~/.pi/agent/settings.json` 的 `subagents` 下加

  ```json
  { "subagents": { "asyncByDefault": false } }
  ```

  依据 pi-subagents `docs/configuration.md#asyncbydefault`：workflow 脚本调用在请求未指定 `async` 时默认转为前台；显式 `async: false` 仍可强制前台（除非同时开了 `forceTopLevelAsync`）。代价是长任务会阻塞当前轮次。

### 6.2 取证与上报

建议向上游报 issue（pi-subagents #2883 是相似文案的历史问题，但本次触发链不同），附上：

- 本报告 §1、§3、§4 的事实与时间线；
- 一个最小复现 run 目录（推荐 `0eb1f29a…`：2 轮、1 次工具、4 秒）；
- 版本组合（pi 1.3.0 + pi-subagents 0.79.0 + Node 26.4.0 + macOS）与「Node 路径（非 Bun 二进制）」这一关键事实；
- 请求上游给出「收尾块未执行」的探针方式（例如在 runner 内 `process.on('exit')` 打印栈）。

### 6.3 版本实验（未做）

- 升级到 0.79.0 之后的新版本；或临时降级到 0.78.x 观察（注意 0.78.0 的卖点是「在 Pi 1.2.0 上恢复后台子代理」，与 pi 1.3.0 的兼容性未知）。
- 无论升降级，建议先用一个 1 轮任务验证 async 是否恢复，再跑长任务。

### 6.4 已失败评审的取回方式

```bash
# 完整正文（子代理输出流）
tail -200 /var/folders/.../async-subagent-runs/<runId>/output-0.log
# 带工具调用/思考的完整会话
python3 -c "..."  # 读同目录 status.json 里的 steps[0].sessionFile
```

`output-archives/<runId>.json` 记录的就是这个 session 路径（由 repair 写入，不是 runner）。

---

## 7. 本次调研做了什么、没做什么

做了：
- 逐个读取 4 个失败 run 的 `status.json` / `events.jsonl` / `output-0.log` / `process-terminal*.json` / `recovery-descriptor.json`，以及子会话 `session.jsonl`；
- 读 pi-subagents 0.79.0 源码，定位「失败」判定链路（`stale-run-reconciler.js`、`process-terminal.js`）与 runner 收尾块（`subagent-runner.js`）、启动/退出路径（`subagent-runner-bootstrap.js`、`binary-bootstrap.js`、`async-execution.js`）；
- 用 2 个极小 async 任务（reviewer、worker）+ 1 个同步任务做对照复现；
- 校验 `launchResolvedExtensions` 的 sha256 路径摘要，确认唯一 runtime 扩展是 pi-subagents 自己的 `subagent-prompt-runtime.js`；
- 在本机 `~/.pi/agent/extensions`、pi SDK `dist`、`pi-agent-core/dist` 中检索 `process.exit`，逐个确认可达性（`output-guard.js`、`print-mode.js`、CLI 入口都不在 runner 路径上），排除显式退出。

没做：
- 没有修改全局 `settings.json`、没有改插件源码、没有降级/升级实验；
- 没有给 runner 加桩定位具体悬空的 `await`（原因见 §4.4）；
- 没有重跑那两个真实评审任务来「补结果」（正文已从 `output-0.log` 取回并使用）。

---

## 附录 A：关键产物路径

```
/var/folders/dh/gs2zz89s4kd1y_nwnjq43l6c0000gp/T/pi-subagents-uid-502/
├── async-subagent-runs/<runId>/
│   ├── status.json                    # steps[0].model/turnCount/toolCount/recentTools/recentOutput
│   ├── events.jsonl                   # 无 subagent.run.completed 即收尾未执行
│   ├── output-0.log                   # 子代理完整输出（评审正文在这里）
│   ├── process-terminal-candidate.json# writers={} 且无 expectedWriters → writer-close-unverified
│   ├── process-terminal.json          # state=unknown, exitCode=0, signal=null
│   └── recovery-descriptor.json       # agent/tools/model/sessionFile
└── async-subagent-results/
    ├── output-archives/<runId>.json   # 指向子会话（repair 写入）
    └── completion-replay/<runId>.json # 失败结果重放（repair 写入）
```

子会话 session 文件：`status.json` → `steps[0].sessionFile`。

## 附录 B：失败 run 的原始时间线（run 1）

```
15:03:01.364Z  子会话最后一条 assistant 消息（stopReason=stop，评审正文完整）
15:03:01.369Z  status.lastActivityAt（agent_end 触发的状态写）
15:03:01.472Z  runner 进程退出（exitCode=0, signal=null）
15:03:01.473Z  process_terminal: state=unknown, reason=writer-close-unverified
15:03:04.978Z  repaired_stale：判定 failed，写失败结果
15:03:05.002Z  父会话收到失败通知
```

同一秒内的前 108ms 里，收尾块需要完成「结果文件 + status + completed 事件 + run log + 会话释放 + candidate」——实际一个都没写，说明收尾块根本没开始执行，而不是写到一半失败（那样会有 stderr 或部分文件）。
