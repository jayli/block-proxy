# 反向隧道设计规格

## 概述

为 block-proxy 的 Server 端和 Client 端增加反向隧道能力（类似 frps），让外部用户可以通过 Server 代理访问 Client 所在内网中才能访问的域名。

### 核心场景

Client 运行在内网环境中（如公司 VPN），某些域名（如 `internal.corp.net`）只有从 Client 所在网络才能解析和访问。通过反向隧道，Server 端的 HTTP Proxy 和 SOCKS5 Proxy 收到这些域名的请求时，自动通过已建立的 TLS 隧道转发给 Client，由 Client 在内网中执行请求并返回结果。

### 关键约束

- **单并发**：同一时间只处理一个隧道请求
- **纯 TCP 隧道**：不做 MITM 解密，只做透明 TCP 隧道转发
- **单 Client 限制**：Server 只接受一个 Client 的隧道连接
- **域名白名单**：只有 `tunnel_domains` 中列出的域名走隧道
- **防死循环**：Client 执行隧道请求时强制直连，跳过本地代理和路由引擎

---

## 架构

### 新增组件

**Server 端新增：**
- `tunnel/protocol.js` — 帧类型常量、编码/解码函数
- `tunnel/server.js` — TunnelServer：TLS 监听、认证、单连接管理
- `tunnel/manager.js` — TunnelManager：域名匹配、forward()、REQID 管理

**Server 端修改：**
- `proxy/proxy.js` — LocalProxy 管理 TunnelServer 生命周期，注入 customConnect 到 AnyProxy options
- `server/express.js` — config 导入校验（tunnel 字段）
- `node_modules/@bachi/anyproxy/lib/requestHandler.js` — customConnect 钩子（3 行，symlink 到 @bachi/anyproxy 仓库）
- `config.json` — 新增 enable_tunnel、tunnel_port、tunnel_domains 字段（无默认值填充，消费点处理）

**Client 端新增：**
- `client/tunnel_client.py` — TunnelClient：反向隧道连接、请求处理、重连
- `client/tunnel_window.py` — 隧道配置窗口（PyObjC）

**Client 端修改：**
- `client/app.py` — 集成 TunnelClient、菜单项、状态回调
- `client/config.py` — 新增 tunnel 配置字段和默认值

### 完整请求流程

```
外部用户
  |
  ├── HTTP Proxy (8001) ──┐
  │                       │
  └── SOCKS5 (8002) ──┐   │
                      │   │
                      ▼   ▼
                  HTTP Proxy 处理 (AnyProxy)
                      |
                  shouldTunnel(host)?
                      |
              ┌───────┴───────┐
              │ 否             │ 是
              ▼               ▼
         net.connect()    TunnelManager.forward()
         → Internet           |
                        [TLS 反向隧道:8004]
                              |
                              ▼
                          Client (tunnel_client.py)
                              |
                     asyncio.open_connection()
                     (强制直连，跳过本地代理)
                              |
                              ▼
                         内网站点
```

### 连接生命周期

```
Client 启动
  |
  ├── 1. 建立正向代理连接 (SOCKS5 over TLS → 8002) [现有]
  |
  └── 2. 如果 tunnel.enabled 且 Server 的 enable_tunnel == "1":
         建立反向隧道连接 (TLS → Server:8004)
         发送 AUTH 帧（复用 auth_username/auth_password）
         收到 AUTH_OK → 进入长连接监听模式
         收到 ERROR → 显示"隧道端口已被占用"，不重试

Client 断开/重连
  |
  └── 反向隧道连接断开 → 自动重连 (指数退避 1s→2s→4s→...→60s 上限)

Server 重启
  |
  └── TLS 连接断开 → Client 检测到 → 自动重连
      TunnelServer 随 Server 启动而启动
      Client 在下一个退避周期自动恢复连接
```

---

## 帧协议

### 帧格式

每个帧以 2 字节大端长度前缀开头（与 UDP over TCP 风格一致）：

```
+----------+-------+-------+------+---------+------+
| 帧长度    | TYPE  | REQID | ATYP | ADDR    | PORT |
| 2B BE    | 1B    | 2B    | 1B   | var     | 2B   |
+----------+-------+-------+------+---------+------+
```

### 帧类型

| TYPE | 方向 | 名称 | 说明 |
|------|------|------|------|
| `0x01` | S→C | CONNECT | Server 请求 Client 连接目标 |
| `0x02` | 双向 | DATA | 传输数据 |
| `0x03` | 双向 | CLOSE | 关闭连接 |
| `0x04` | C→S | CONNECT_OK | Client 成功连接目标 |
| `0x10` | S→C | PING | 心跳探测 |
| `0x11` | C→S | PONG | 心跳响应 |
| `0x20` | C→S | AUTH | Client 认证 |
| `0x21` | S→C | AUTH_OK | 认证成功 |
| `0x22` | S→C | AUTH_FAIL | 认证失败 |
| `0x23` | S→C | ERROR | 服务端错误（如端口被占） |
| `0x81` | C→S | CONNECT_FAILED | Client 连接目标失败 |

### 地址编码 (ATYP)

| ATYP | 类型 | 格式 |
|------|------|------|
| `0x01` | IPv4 | 4 字节 |
| `0x03` | 域名 | 1 字节长度 + N 字节域名 |
| `0x04` | IPv6 | 16 字节 |

### REQID

- 2 字节，Server 分配，范围 0x0001–0xFFFF，循环使用
- 单并发模式下同一时间只有一个活跃的 REQID

### 连接建立流程

```
Client                              Server (TunnelServer:8004)
  |                                    |
  |── TCP + TLS ──────────────────────→|
  |                                    |
  |── AUTH [username+password] ───────→|
  |                                    |  验证凭证
  |                                    |  检查是否已有 Client 连接
  |←── AUTH_OK ────────────────────────|  (或 ERROR 如果已被占用)
  |                                    |
  |  ═══ 长连接建立，进入监听模式 ═══    |
```

### 隧道请求流程

```
Server (HTTP Proxy 匹配到隧道域名)
  |
  |── CONNECT [REQID=1, ATYP=0x03, ADDR="a.com", PORT=443] ──→ Client
  |                                                                 |
  |                                                          asyncio.open_connection("a.com", 443)
  |                                                          (强制直连，DNS 解析在 Client 端完成)
  |                                                                 |
  |←── CONNECT_OK [REQID=1] ──────────────────────────────────────|  (连接成功确认)
  |     (或 CONNECT_FAILED [REQID=1] 如果连接失败)
  |                                                                 |
  |←── DATA [REQID=1, 数据] ───────────────────────────────────────|
  |     (TLS 握手数据、HTTP 请求/响应等，多个 DATA 帧双向传输)
  |                                                                 |
  |── DATA [REQID=1, 数据] ──→ Client
  |                                                                 |
  |── CLOSE [REQID=1] ──→ Client (或 Client → Server)
  |←── CLOSE [REQID=1] ── (确认关闭)
```

### 心跳机制

- Server 每 30 秒发送 PING
- Client 收到后立即回复 PONG
- Server 如果 60 秒未收到 PONG → 判定 Client 断连，清理状态
- Client 如果 60 秒未收到任何数据 → 主动断开并重连

### DNS 解析

Server 端不解析隧道域名的 IP。CONNECT 帧直接携带域名（ATYP=0x03），DNS 解析完全在 Client 端完成，利用 Client 所在内网的 DNS 服务器。不需要 UDP 支持，纯 TCP 隧道即可。

---

## Server 端实现

### tunnel/protocol.js

```javascript
// 帧类型常量
const FRAME_TYPES = {
  CONNECT: 0x01,
  DATA: 0x02,
  CLOSE: 0x03,
  CONNECT_OK: 0x04,
  PING: 0x10,
  PONG: 0x11,
  AUTH: 0x20,
  AUTH_OK: 0x21,
  AUTH_FAIL: 0x22,
  ERROR: 0x23,
  CONNECT_FAILED: 0x81,
};

// 地址类型
const ATYP = { IPV4: 0x01, DOMAIN: 0x03, IPV6: 0x04 };

// encodeFrame(frame) → Buffer（含 2 字节长度前缀）
// decodeFrame(buffer) → { type, reqid, ...fields }
// encodeAddress(atyp, addr) → Buffer
// decodeAddress(buffer, offset) → { atyp, addr, bytesRead }
```

### tunnel/server.js — TunnelServer

```javascript
class TunnelServer {
  constructor(options) {
    // options: { port, cert, key, credentials }
    this._socketBuffers = new Map(); // socket → Buffer (每连接独立缓存)
  }

  start()
  // 创建 TLS server，监听指定端口
  // 只接受一个 Client 连接
  // 第二个连接：发送 ERROR 帧（"隧道端口已被占用"）→ 断开

  stop()
  // 关闭 server，断开当前 Client 连接

  // 供 TunnelManager 调用：
  sendFrame(frame)
  // 向当前连接的 Client 发送帧

  onFrame(handler)
  // 注册帧接收回调

  // 心跳：
  _startHeartbeat()
  // 每 30 秒发送 PING，60 秒未收到 PONG → 判定断连
}
```

**缓冲区管理**：每个 socket 独立维护接收缓冲区（`socket._tunnelBuffer` 或 `Map<socket, Buffer>`），避免 pending/authenticated socket 共享状态导致半包污染。

### tunnel/manager.js — TunnelManager

```javascript
class TunnelManager {
  constructor(tunnelServer, config) {
    // 从 config 读取 tunnel_domains
  }

  matchesTunnelDomain(host) → boolean
  // 纯域名匹配，与连接状态无关
  // 例如 tunnel_domains = ["a.com"] 匹配 "a.com", "sub.a.com"

  isAvailable() → boolean
  // 隧道是否可用（Client 已连接）
  // 用于状态展示或诊断，不参与 customConnect 的错误分支判断

  forward(host, port, callback) → Duplex stream
  // 始终返回 Duplex stream：
  // - 隧道未连接 → 返回 tunnel-disconnected error stream
  // - 隧道忙 → 返回 tunnel-busy error stream
  // - 可转发时：
  // 1. 分配 REQID
  // 2. 通过 TunnelServer 发送 CONNECT 帧
  // 3. 创建隧道 Duplex stream：
  //    write() → 编码为 DATA 帧发送给 Client
  //    收到 DATA 帧 → push() 到 stream
  // 4. 收到 CONNECT_OK 帧 → 调用 callback()（连接确认）
  // 5. 收到 CLOSE 帧 → stream end
  // 6. 收到 CONNECT_FAILED 帧 → stream destroy(new Error('tunnel-connect-failed'))
  // 7. 超时 30 秒无 CONNECT_OK → stream destroy(new Error('tunnel-connect-timeout'))

  reloadConfig(config)
  // 热更新 tunnel_domains 列表

  getStatus() → { connected: boolean, clientAddress: string }
}
```

**关键设计**：隧道域名**绝不 fallback** 到正常连接。`forward()` 自己处理所有错误路径并返回 error stream，调用方只负责域名匹配：

```javascript
if (tunnelManager && tunnelManager.matchesTunnelDomain(host)) {
  return tunnelManager.forward(host, port, callback);
}
return null; // 非隧道域名，走正常连接
```

### proxy.js 集成

在 AnyProxy options 中注入 `customConnect`：

```javascript
const options = {
  port: proxyPort,
  // ... 现有 options
  customConnect: (host, port, callback) => {
    if (tunnelManager && tunnelManager.matchesTunnelDomain(host)) {
      return tunnelManager.forward(host, port, callback);
    }
    return null; // 非隧道域名，走正常 net.connect
  }
};
```

`beforeDealHttpsRequest` 对隧道域名返回 `false`（不 MITM 解密），AnyProxy 走到 `net.connect` 时被 `customConnect` 拦截。

**错误语义**：AnyProxy 在 `customConnect` 调用前已向客户端发送 `HTTP/1.1 200 Connection Established`，因此隧道失败时无法返回 502/504 状态码。实际行为是 error stream 触发 socket destroy，客户端看到连接中断（connection reset）。这是 HTTPS CONNECT 隧道的固有限制。

### @bachi/anyproxy 修改

在 `node_modules/@bachi/anyproxy/lib/requestHandler.js` 第 877 行附近：

```javascript
// 原代码:
const conn = net.connect(serverInfo.port, serverInfo.host, () => { ... });

// 修改为:
let conn;
if (reqHandlerCtx.customConnect) {
  conn = reqHandlerCtx.customConnect(serverInfo.host, serverInfo.port, () => { ... });
  if (!conn) {
    conn = net.connect(serverInfo.port, serverInfo.host, () => { ... });
  }
} else {
  conn = net.connect(serverInfo.port, serverInfo.host, () => { ... });
}
```

### 生命周期管理

**TunnelServer 由 LocalProxy（`proxy/proxy.js`）管理**，不在 `server/start.js` 中独立启动。理由：

- `server/start.js` 只决定启动完整栈还是仅代理模式
- `server/express.js` 通过 `LocalProxy.init()` 启动代理
- `LocalProxy.start()` / `LocalProxy.restart()` 需要完整启动/关闭/重启 TunnelServer
- 避免配置热重启时端口占用冲突

```javascript
// proxy/proxy.js 中的 LocalProxy 对象：
const LocalProxy = {
  _tunnelServer: null,
  _tunnelManager: null,

  async start(callback) {
    const config = await loadConfig();
    await rebuildRuleRegistry(config);
    await initTunnel(config);
    // ... 现有代理启动逻辑
  },

  async restart(callback) {
    await closeTunnel();
    await this.start(callback);
  }
};
```

---

## Client 端实现

### 配置 (`client/config.py`)

在 `DEFAULT_CONFIG` 中增加：

```python
DEFAULT_CONFIG = {
    # ... 现有字段
    "tunnel": {
        "enabled": False,
        "server_address": "",   # 空 = 使用 server.address
        "server_port": 8004
    }
}
```

### client/tunnel_client.py — TunnelClient

```python
class TunnelOccupiedError(Exception):
    """Server 端隧道端口已被其他 Client 占用"""
    pass

class TunnelClient:
    def __init__(self, config, on_status_change):
        """
        config: 完整配置 dict（包含 server 和 tunnel 两个 section）
        on_status_change: 回调函数 (status: str, detail: str) → None
        """

    def start(self):
        """在后台线程中启动 asyncio 事件循环"""

    def stop(self):
        """停止隧道连接，关闭后台线程"""

    async def _run_loop(self):
        """主循环：连接 → 监听 → 断连 → 重连"""
        # 指数退避：1s → 2s → 4s → 8s → ... → 60s
        # TunnelOccupiedError 不重试，直接停止

    async def _connect_and_serve(self):
        """建立 TLS 连接，认证，进入请求处理循环"""
        # 1. asyncio.open_connection(addr, port, ssl=ssl_ctx)
        # 2. 发送 AUTH 帧（复用 server.username/password）
        # 3. 读取响应：AUTH_OK / AUTH_FAIL / ERROR
        # 4. 进入帧处理循环

    async def _handle_connect(self, frame):
        """处理 Server 下发的 CONNECT 请求"""
        # 1. asyncio.open_connection(frame.host, frame.port)
        #    强制直连！不走本地代理，不走路由引擎
        #    超时 30 秒 → 发送 CONNECT_FAILED 帧
        # 2. 双向转发：隧道帧 ↔ 目标 TCP
        #    DATA 帧 → 写入目标 writer
        #    目标 reader → 编码为 DATA 帧发送
        # 3. 任一端关闭 → 发送 CLOSE 帧

    async def _heartbeat(self):
        """心跳处理"""
        # 收到 PING → 发送 PONG
        # 60 秒无数据 → 判定断连
```

### client/tunnel_window.py — 隧道配置窗口

独立进程窗口（与现有 config_window.py 模式一致）。窗口仅包含配置控件，不显示实时连接状态——子进程窗口与父 App 之间无 IPC 通道，状态数据会过时或误导。实时状态通过主状态栏菜单展示：

```
┌──────────────────────────────────┐
│ 隧道配置                          │
│                                  │
│ 启用反向隧道     [  开关  ]        │
│                                  │
│ 隧道服务器地址   [server.com   ]  │
│ 隧道服务器端口   [8004        ]   │
│                                  │
│         [ 应用并重启代理 ]          │
└──────────────────────────────────┘
```

### client/app.py 集成

```python
class AppController:
    def init(self):
        # ... 现有初始化
        self.tunnel_client = None

    def _connect(self):
        # 现有：启动 ProxyCore
        # 新增：如果 tunnel.enabled，启动 TunnelClient
        if self.config.data.get("tunnel", {}).get("enabled"):
            self.tunnel_client = TunnelClient(
                self.config.data, on_status_change=self._on_tunnel_status_change
            )
            self.tunnel_client.start()

    def _disconnect(self):
        # 现有：停止 ProxyCore
        # 新增：停止 TunnelClient
        if self.tunnel_client:
            self.tunnel_client.stop()
            self.tunnel_client = None

    def _on_tunnel_status_change(self, status, detail=""):
        """隧道状态回调 → 更新菜单标题"""
        # "隧道配置" / "隧道配置(已连接)" / "隧道配置(重连中)"
```

菜单结构：
```
┌─────────────────────────────┐
│ 代理 (已连接, 12ms)          │
│ 隧道配置 (已连接)             │  ← 已连接时
│ 隧道配置                     │  ← 未连接时
│ ─────────────────────────── │
│ 分流规则                      │
│ 日志                         │
│ ─────────────────────────── │
│ 退出                         │
└─────────────────────────────┘
```

---

## 配置

### Server 端 (`config.json`)

新增字段：

```json
{
  "enable_tunnel": "0",
  "tunnel_port": 8004,
  "tunnel_domains": []
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `enable_tunnel` | `"0"` / `"1"` | 隧道功能总开关，默认关闭 |
| `tunnel_port` | integer | 反向隧道监听端口，默认 8004 |
| `tunnel_domains` | string[] | 域名后缀列表，匹配则走隧道 |

### Client 端 (`config.json`)

新增 section：

```json
{
  "tunnel": {
    "enabled": false,
    "server_address": "",
    "server_port": 8004
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | boolean | 是否启用反向隧道 |
| `server_address` | string | 隧道服务器地址，空则复用 server.address |
| `server_port` | integer | 隧道服务器端口 |

### 隧道建立条件

两端都需要开启，隧道才能建立：
- Server：`enable_tunnel == "1"` → TunnelServer 启动监听
- Client：`tunnel.enabled == true` → TunnelClient 发起连接

---

## 错误处理

| 场景 | Server 行为 | Client 行为 |
|------|------------|------------|
| Server 无 Client 连接，收到隧道域名请求 | 返回 error stream → 连接中断（connection reset） | — |
| Client 执行请求失败（域名不可达等） | 收到 CONNECT_FAILED → error stream → 连接中断 | 发送 CONNECT_FAILED 帧，关闭 REQID |
| TLS 连接断开 | 标记隧道不可用，清理状态 | 检测到断连，进入指数退避重连 |
| Server 端口被占（已有 Client） | 发送 ERROR 帧，断开新连接 | 显示"隧道端口已被占用"，停止重试 |
| Client 请求超时（30s） | 超时 → error stream → 连接中断 | open_connection 超时，发送 CONNECT_FAILED |
| 心跳超时（60s 无 PONG） | 判定 Client 断连，清理状态，停止心跳 timer | — |
| 心跳超时（60s 无数据） | — | 判定 Server 不可达，断开重连 |

**错误语义说明**：

HTTPS CONNECT 隧道场景下，AnyProxy 在调用 `customConnect` **之前**已向客户端发送 `HTTP/1.1 200 Connection Established`，因此无法返回 502/504 等 HTTP 状态码。隧道失败时的实际行为是 error stream 触发 socket destroy，客户端看到连接中断（connection reset）。这是 HTTPS CONNECT 隧道的固有限制。

对于 HTTP 明文请求（非 CONNECT），可以在 `beforeSendRequest` 中直接返回 502 响应，但本设计统一使用 CONNECT 隧道路径以简化实现。

---

## 安全考虑

- **认证**：复用 `auth_username` / `auth_password`，无额外凭证
- **TLS 加密**：反向隧道连接与正向连接使用相同 TLS 配置（cert/rootCA.*）
- **单 Client 限制**：避免多 Client 冲突导致的路由混乱
- **域名白名单**：只有 `tunnel_domains` 中列出的域名走隧道，其余正常转发
- **Server 端开关**：`enable_tunnel` 默认关闭，需管理员显式开启

---

## 防死循环

Client 执行反向隧道请求时，使用 `asyncio.open_connection()` 直接连接目标，**不经过本地 SOCKS5/HTTP 代理**，不走路由引擎（`_select_route`）。

即使 Client 的 routing 规则将隧道域名标记为 "proxy"，反向隧道执行上下文也强制 "direct"，避免请求再次通过正向代理回到 Server 造成死循环。

---

## 测试计划

1. **单元测试**：`tunnel/protocol.js` 的编解码函数
2. **集成测试**：
   - Client 连接 → Server 认证 → 隧道建立
   - 隧道域名请求 → CONNECT 帧 → Client 执行 → 数据回传
   - 非隧道域名请求 → 正常转发（不受影响）
   - 断连重连、端口被占、心跳超时
3. **手动验证**：配置一个内网域名，通过代理访问，确认请求从 Client 出口发出
