# 抽离 AnyProxy 核心逻辑设计文档

**日期**: 2026-07-09  
**状态**: 设计已确认  
**方案**: A — 搬运 + 裁剪

---

## 背景与动机

项目当前依赖私有 npm 包 `@bachi/anyproxy`（AnyProxy 的 fork），作为 HTTP/HTTPS 代理的核心引擎。该包存在以下问题：

1. **私有包依赖**：新环境安装需要特殊配置 npm registry
2. **大量无用功能**：Web 监控面板、请求录制、WebSocket 拦截、流量限速等功能从未被使用
3. **调试困难**：核心代理逻辑在 node_modules 中，修改需要 fork + link，不便于版本管理
4. **间接依赖过多**：引入 ~30 个间接依赖（nedb、pug、qrcode-npm、inquirer 等），增加供应链风险

**目标**：将 AnyProxy 的核心逻辑（HTTP 代理 + HTTPS MITM）抽离到 `proxy/proxy-core/`，去掉对 `@bachi/anyproxy` 的依赖，保持现有 `proxy/proxy.js` 架构和 Rule 回调体系不变。

---

## 模块结构

```
proxy/
  proxy.js                    ← 现有，改动最小化（仅改 require 路径）
  fs.js, attacker.js, ...     ← 现有，不动
  mitm/                       ← 现有，不动
  proxy-core/                 ← 新建
    index.js                  ← 入口，导出 ProxyServer + utils.certMgr
    proxy-server.js           ← 搬运自 anyproxy/proxy.js（服务器创建/生命周期）
    request-handler.js        ← 搬运自 anyproxy/lib/requestHandler.js（请求处理管线）
    https-server-mgr.js       ← 搬运自 anyproxy/lib/httpsServerMgr.js（MITM 服务器管理）
    cert-mgr.js               ← 搬运自 anyproxy/lib/certMgr.js（证书管理）
    util.js                   ← 搬运自 anyproxy/lib/util.js（工具函数精简版）
```

**关键原则**：
- 文件一一对应原始 AnyProxy 文件，方便搬运时逐行对照
- 文件名用 kebab-case（`request-handler.js`），符合 block-proxy 现有风格
- `index.js` 模拟原 AnyProxy 的导出结构，让 proxy.js 的改动最小

---

## 裁剪清单

搬运不是整文件复制，而是"搬运有用逻辑，删掉无用分支"。以下按文件列出删除项：

### request-handler.js（原 1152 行 → 预计 ~850 行）

| 删除项 | 原因 |
|--------|------|
| `recorder` 相关全部代码（appendRecord, updateRecord, resourceInfo 等） | 项目不使用录制功能 |
| `getWsHandler` 函数（~150 行） | `wsIntercept: false`，从未启用 |
| `global._throttle` 限速分支（fetchRemoteResponse 和 sendFinalResponse 中） | 项目不传 throttle 选项 |
| `CommonReadableStream` 类 | 仅 throttle 和 recorder 使用 |
| 日志中的 `logUtil` 调用 | 替换为 `console.log`/`console.error`，去掉 `colorful` 依赖 |

### https-server-mgr.js（原 217 行 → 预计 ~150 行）

| 删除项 | 原因 |
|--------|------|
| `wsServerMgr.getWsServer` 调用 | 不拦截 WebSocket |
| `async-task-mgr` 依赖 | 替换为简单的 Promise 锁（同一 host 不重复创建服务器） |
| `createHttpsIPServer` 函数 | 项目的 `beforeDealHttpsRequest` 对裸 IP 返回 false，不会走 MITM |

### cert-mgr.js（原 104 行 → 预计 ~40 行）

| 删除项 | 原因 |
|--------|------|
| `trustRootCA` generator 函数（交互式 inquirer） | 项目手动管理证书信任 |
| `getCAStatus` generator 函数 | 从未调用 |
| `defaultCertAttrs` 自定义属性 | 保持默认即可 |

### util.js（原 339 行 → 预计 ~120 行）

| 删除项 | 原因 |
|--------|------|
| `filewalker`, `simpleRender`, `contentType`, `contentLength` | 仅 webInterface 使用 |
| `formatDate` | 仅 logUtil 使用 |
| `execScriptSync`, `guideToHomePage` | 仅 certMgr.trustRootCA 使用 |
| `deleteFolderContentsRecursive` | 仅 recorder 使用 |

### proxy-server.js（原 364 行 → 预计 ~200 行）

| 删除项 | 原因 |
|--------|------|
| `Recorder` 实例化和使用 | 不录制 |
| `WebInterface` 实例化和使用 | 不启动 Web 面板 |
| `ThrottleGroup` 初始化 | 不限速 |
| `wsServerMgr` WebSocket 服务器 | 不拦截 WS |
| ProxyCore / ProxyServer 两层继承 | 合并为单个 ProxyServer 类 |

**总计**：从 AnyProxy 的 ~2700 行核心代码裁剪到 ~1360 行，去掉约一半无用逻辑。

---

## API 接口设计

### proxy-core/index.js 导出结构

```js
// proxy/proxy-core/index.js
const ProxyServer = require('./proxy-server');
const certMgr = require('./cert-mgr');

module.exports = {
  ProxyServer,
  utils: { certMgr }  // 保持 AnyProxy 的 utils.certMgr 路径，proxy.js 改动最小
};
```

### proxy.js 改动点（共 4 处）

```diff
// 改动 1：require 路径
- const AnyProxy = require('@bachi/anyproxy');
+ const { ProxyServer, utils: { certMgr } } = require('./proxy-core');

// 改动 2：startProxyServer() 中的证书检查
- if (!AnyProxy.utils.certMgr.ifRootCAFileExists()) {
-   AnyProxy.utils.certMgr.generateRootCA((error, keyPath) => {
+ if (!certMgr.ifRootCAFileExists()) {
+   certMgr.generateRootCA((error, keyPath) => {

// 改动 3：创建服务器
- proxyServerInstance = new AnyProxy.ProxyServer(options);
+ proxyServerInstance = new ProxyServer(options);

// 改动 4：getAnyProxyOptions() 中删除无用选项
  function getAnyProxyOptions() {
    return {
      port: proxyPort,
      customConnect: ...,
      rule: { ... },           // ← Rule 回调完全不变
-     throttle: 800 * 1024 * 1024,
-     wsIntercept: false,
      silent: true,
      timeout: 120 * 1000
    };
  }
```

### 不变的部分

- `LocalProxy` 对象（init/start/restart）— 对外 API 完全不变
- `getAnyProxyOptions()` 中的 `rule` 对象 — 所有回调完全不变：
  - `beforeDealHttpsRequest`
  - `beforeSendRequest`
  - `beforeSendResponse`
  - `onError`
  - `onConnectError`
  - `checkProxyAuth`
  - `sendAuthRequired`
  - `send407bySocket`
- `customConnect` 隧道拦截逻辑 — 不变
- CONNECT 事件劫持（`proxyServerInstance.httpProxyServer`）— 不变
- 所有 MITM 规则系统（proxy/mitm/）— 不变

---

## 请求处理管线

proxy-core 内部的请求处理流程与 AnyProxy 保持一致，去掉无用分支：

```
客户端请求
    │
    ▼
http.createServer (HTTP 请求)  ─────┐
httpServer.on('connect') (CONNECT)  │
    │                               │
    ▼                               │
┌─ getUserReqHandler ─────────────┐ │
│  1. 收集请求 body               │ │
│  2. 构建 requestDetail          │ │
│  3. rule.beforeSendRequest()    │◄┘
│     ├─ 返回 {response} → 本地响应
│     └─ 返回 {requestOptions} → fetchRemoteResponse()
│  4. rule.beforeSendResponse()
│  5. sendFinalResponse()
└─────────────────────────────────┘

CONNECT 请求单独路径：
┌─ getConnectReqHandler ──────────┐
│  1. rule.beforeDealHttpsRequest()
│     ├─ false → net.connect(目标服务器) → 双向 pipe
│     └─ true  → httpsServerMgr 创建本地 MITM 服务器
│                → 客户端 TLS 流量解密后回灌 getUserReqHandler
│  2. customConnect 优先（隧道域名）
└─────────────────────────────────┘
```

### 与 AnyProxy 的关键差异

| AnyProxy 原版 | 搬运后 |
|--------------|--------|
| CONNECT → recorder.appendRecord → 处理 | CONNECT → 直接处理（无 recorder） |
| fetchRemoteResponse 有 throttle 分支 | 去掉 throttle，直接返回 |
| wsHandler 处理 WebSocket 升级 | 删除，wsIntercept=false 时不会触发 |
| cltSocket 写入时有详细错误处理链 | 保留 EPIPE/ECONNRESET 容错，简化日志 |

### customConnect 保留

这是 proxy.js 劫持隧道域名 CONNECT 的关键入口。在 `getConnectReqHandler` 中搬运这段逻辑：

```js
// request-handler.js 中搬运这段逻辑
let conn;
if (reqHandlerCtx.customConnect) {
  conn = reqHandlerCtx.customConnect(host, port, () => {
    setupPipe(conn);
  });
}
if (!conn) {
  conn = net.connect(port, host, () => {
    setupPipe(conn);
  });
}
```

这段逻辑使 `tunnelManager.forward()` 能接管隧道域名的连接，搬运后行为完全一致。

---

## 依赖管理

### 新增直接依赖

```json
{
  "dependencies": {
    "node-easy-cert": "^1.0.0"
  }
}
```

仅这一个，用于证书生成（原 AnyProxy 的间接依赖，搬运后需要直接依赖）。

### 可移除的间接依赖

随 `@bachi/anyproxy` 一起删除：

| 依赖 | 原用途 |
|------|--------|
| async | AnyProxy 内部流程控制 |
| async-task-mgr | HTTPS 服务器去重 |
| colorful | 日志着色 |
| co | generator 异步控制 |
| nedb | 请求录制数据库 |
| pug | 错误页面模板 |
| stream-throttle | 流量限速 |
| ws | WebSocket 代理 |
| qrcode-npm | Web UI 二维码 |
| juicer | 模板引擎 |
| moment | 日期格式化 |
| inquirer | 交互式命令行 |
| ... 等约 20 个依赖 |

---

## 测试策略

| 测试类型 | 方法 |
|---------|------|
| 冒烟测试 | `npm run test:proxy` — 验证 HTTP/SOCKS5 连通性、延迟、并发 |
| HTTPS MITM | 浏览器设置代理 → 访问 https://example.com → 验证 MITM 解密正常 |
| 隧道域名 | 配置 tunnel_domains → 验证 CONNECT 走隧道转发 |
| 规则拦截 | 配置 block_hosts → 验证域名拦截 + match_rule 路径过滤 |
| 认证 | 设置 auth_username/password → 验证 407 认证流程 |

---

## 迁移顺序（分步验证）

```
步骤 1: 创建 proxy/proxy-core/ 目录结构
        ↓
步骤 2: 搬运 cert-mgr.js + util.js（无依赖，可独立测试）
        ↓
步骤 3: 搬运 https-server-mgr.js（依赖 cert-mgr）
        ↓
步骤 4: 搬运 request-handler.js（核心，最复杂）
        ↓
步骤 5: 搬运 proxy-server.js，创建 index.js 入口
        ↓
步骤 6: 修改 proxy.js 的 require 路径（4 处改动）
        ↓
步骤 7: npm run test:proxy 冒烟测试
        ↓
步骤 8: 从 package.json 移除 @bachi/anyproxy
```

每个步骤完成后都可以独立运行验证，不需要一次性完成所有搬运。

---

## 风险与缓解

| 风险 | 影响 | 缓解方案 |
|------|------|---------|
| HTTPS MITM 流程复杂 | 高 — SNI 证书生成 + 动态端口 + 流量导入本地服务器 | 现有代码逻辑清晰，可直接参考移植 |
| socket 映射追踪 sourceIP | 中 — HTTPS 拆包后 sourceIP 变为 127.0.0.1，需要 cltSockets Map 找回原始 IP | 逻辑已在 requestHandler.js 中实现，直接复用 |
| CONNECT 隧道与 MITM 分支 | 中 — 非 MITM 时直接 pipe 到目标服务器，MITM 时 pipe 到本地 HTTPS 服务器 | 两条路径逻辑独立，可分别实现和测试 |
| node-easy-cert 兼容性 | 低 — 该包较稳定，仅用于证书生成 | 如需要可进一步替换为直接调用 openssl |

---

## 收益

- **去除 ~30 个间接依赖**，减少供应链风险和包体积
- **完全掌控代理核心逻辑**，方便调试和定制（如之前修改 keep-alive 策略、responseRules chunkSize 等都需要改 AnyProxy 源码）
- **消除私有 npm 包依赖**（`@bachi/anyproxy` 是私有 fork，新环境安装需要特殊配置）
- **代码量反而更少**：去掉无用功能后，核心代码约 1360 行 vs AnyProxy 的 ~2700 行

---

## 确认状态

- [x] 模块结构已确认
- [x] 裁剪清单已确认
- [x] API 接口设计已确认
- [x] 请求处理管线已确认
- [x] 依赖管理、测试策略与迁移顺序已确认

**设计完成，待实施。**
