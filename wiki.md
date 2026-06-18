# Block-Proxy Wiki

## 1）Docker 构建与发布

### 构建命令

| 命令 | 说明 |
|:-----|:------|
| `npm run docker:build` | 本地构建 amd64 镜像 |
| `npm run docker:build:arm` | 本地构建 arm64 镜像 |
| `npm run docker:push` | 构建并推送 amd64 + arm64 双架构到 ACR |
| `npm run docker:push:amd64` | 仅推送 amd64 |
| `npm run docker:push:arm64` | 仅推送 arm64 |

### 首次推送前登录 ACR

```bash
docker login --username=hi50078584@aliyun.com crpi-x1zji86f6jpcd7t1.cn-hangzhou.personal.cr.aliyuncs.com
```

> 如果打包时磁盘空间不够：`docker system prune -a --volumes`

### Docker 部署 - host 网络模式（推荐）

先导入：

`docker load -i block-proxy.tar`

然后：

网关里为了方便获取子网机器 IP 和 MAC 地址，容器需要和宿主机共享同一个网络：

```bash
docker run --init -d --restart=unless-stopped \
  -e TZ=Asia/Shanghai --network=host \
  --user=root \
  --log-driver local \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  --cpus="5" \
  --memory 400m \
  --name block-proxy \
  crpi-x1zji86f6jpcd7t1.cn-hangzhou.personal.cr.aliyuncs.com/lijing00333/block-proxy:latest
```

### 配置文件

#### config.json

容器首次启动时会自动生成一份默认配置。你也可以预先创建：

```json
{
  "block_hosts": [],
  "proxy_port": 8001,
  "socks5_port": 8002,
  "auth_username": "admin",
  "auth_password": "your-password",
  "enable_express": "1",
  "enable_socks5": "1"
}
```

配置修改后通过后台面板（`:8003`）保存，或重启容器后生效。

#### rule.js（自定义 MITM 规则）

在配置目录下创建 `rule.js`，代理启动时会自动加载并与内置规则合并。参照 [`example/rule.js`](https://github.com/jayli/block-proxy/blob/main/example/rule.js) 格式：

```js
module.exports = {
  MyRule: [{
    type: 'beforeSendRequest',
    host: 'example.com',
    regexp: "/123/v1/(browse|next)",
    callback: async function(url, request, response) {
      return {
        response: {
          statusCode: 403,
          header: { 'Content-Type': 'text/plain' },
          body: 'Blocked by custom rule'
        }
      };
    }
  }]
};
```

规则支持两种类型：
- `beforeSendRequest` — 在请求发出前拦截，可返回本地响应阻断请求
- `beforeSendResponse` — 在响应返回前修改，可改写响应体

修改 `rule.js` 后需重启容器使规则生效。

> 注意：`config.json` 是运行时配置文件，通过后台面板修改后由代理自动写入。`rule.js` 需要手动编辑，容器只读取不写入。

### Docker 部署 - 端口绑定模式（Windows/Mac）


```bash
docker run --init -d --restart=unless-stopped --user=root \
  -e TZ=Asia/Shanghai -p 8001:8001 -p 8002:8002 \
  --name block-proxy \
  crpi-x1zji86f6jpcd7t1.cn-hangzhou.personal.cr.aliyuncs.com/lijing00333/block-proxy:latest
```

---

## 2）服务端配置

### 端口说明

| 端口 | 说明 | 可否关闭 |
|:----:|:------|:------:|
| 3000 | 调试端口（仅 `npm run dev` 时启用） | 生产环境不启用 |
| 8001 | HTTP 代理端口 | 不可禁用 |
| 8002 | Socks5 over TLS 代理端口 | 可禁用 |
| 8003 | 后台配置面板端口 | 可禁用 |


### 配置面板

- 后台配置：访问 `http://server-ip:8003`
- 关闭/启用配置面板：`http://server-ip:8001`

首次启动后访问 `http://代理IP:8001` 根据提示操作。block-proxy 可以配置只启动 proxy 而不启动后台面板。

### 路由表

路由表每两小时自动刷新一次。如果新入网的设备未显示，在后台手动刷新路由表，添加限制条件后点击「重启代理」即可。

---

## 3）客户端配置

### 代理端口

- **8001**：HTTP 代理
- **8002**：Socks5 over TLS

> ⚠️ Socks5 代理不支持对 MAC 地址的定向拦截，MAC 地址拦截仅对局域网内 HTTP 代理绑定生效。建议局域网绑定 HTTP 代理，公网绑定 Socks5 代理。

> ⚠️ 使用小火箭的 Socks5 over TLS 代理时，TLS 选项中勾选「允许不安全」。

### 证书安装（iOS）

1. 进入后台配置面板，扫码下载证书
2. 手机设置中安装该证书
3. 设置 → 通用 → 关于本机 → 证书信任设置 → 打开对 BlockProxy 证书的完全信任

### 代理设置（iPhone/iPad）

设置 → 无线局域网 → 点击当前网络 → HTTP 代理/配置代理 → 手动 → 填写服务器地址和端口。

### 固定 MAC 地址

如果要通过 MAC 地址拦截小朋友上网，在小朋友设备中把 MAC 地址固定下来（关闭私有 Wi-Fi 地址）：

- iOS：设置 → 无线局域网 → 点击当前网络 → 关闭「私有 Wi-Fi 地址」

### macOS 客户端

提供 SocksClient.app 桌面端连接工具，支持 macOS。

下载地址：[GitHub Release](https://github.com/jayli/block-proxy/releases/latest)

> 重要：如果通过客户端代理链接 BlockProxy 服务端时，当服务端开启了 MITM，客户端则必须安装证书，否则 MITM 相关的域名请求会失败。参照下文的安装证书部分。

我常用的代理规则：

```
geosite:netflix
geosite:disney
geosite:github
geosite:youtube
geosite:google
geosite:anthropic
geosite:claude
geosite:category-ntp
geoip:netflix
geosite:gfw
geosite:npmjs
geosite:category-ai-!cn
domain:www.youtube.com
domain:netflix.com
domain:fastly.jsdelivr.net
domain:perf.qzz.io
domain:clawhub.ai
domain:baidu.com
domain:freedom.gov
domain:deepseek.com
domain:ytimg.com
domain:net.coffee
domain:bgp.he.net
domain:ip.me
```

---

## 4）防火墙配置：禁止设备直连

防止小朋友修改 Wi-Fi 连接绕过代理，在网关配置防火墙规则禁止设备直连：

```bash
iptables -I FORWARD -m mac --mac-source D2:9E:8D:1B:F1:4E -j REJECT
ip6tables -I forwarding_rule -m mac --mac-source D2:9E:8D:1B:F1:4E -j REJECT
```

执行后重启防火墙生效。

---

## 5）MITM 规则

### 生效条件

1. 当服务端开启 MITM 时，客户端设备必须安装 BlockProxy 证书，且要打开客户端的“允许 TLS 不安全连接”
2. 服务需要根据 IP 反查 MAC 地址，需要部署在可扫描子网的节点（推荐 OpenWrt 网关）
3. 路由表每 2 小时更新一次，新入网设备建议在后台手动刷新并重启代理
4. 所有拦截规则仅在 HTTP 代理中生效；Socks5 over TLS 是反向代理，MAC 地址拦截只对直连 HTTP 代理生效

### YouTube 去广告

默认 `config.json` 已内置以下 4 条 reject 规则，无需手动添加：

| 域名 | Match Rule |
|:-----|:-----------|
| `youtube.com` | `^https?:\/\/(www\|s)\.youtube\.com\/(pagead\|ptracking)` |
| `youtube.com` | `^https?:\/\/s\.youtube\.com\/api\/stats\/qoe\?adcontext` |
| `youtube.com` | `^https?:\/\/(www\|s)\.youtube\.com\/api\/stats\/ads` |
| `googlevideo.com` | `^https?:\/\/[\w-]+\.googlevideo\.com\/(?!(dclk_video_ads\|videoplayback\?)).+&oad` |

另外两条规则在源码中自动生效：[`proxy/mitm/rule.js`](https://github.com/jayli/block-proxy/blob/main/proxy/mitm/rule.js)。

### 有道词典会员

已内置，无需额外配置。

### 自定义规则

参照 [`example/rule.js`](https://github.com/jayli/block-proxy/blob/main/example/rule.js) 编写配置文件，启动时通过 `-c` 参数加载：

```bash
block-proxy -c rule.js
```

---

## 6）开发指南

### 环境准备

```bash
git clone https://github.com/jayli/block-proxy.git
cd block-proxy
pnpm i
```

### 开发命令

| 命令 | 说明 |
|:-----|:------|
| `npm run dev` | 开发模式，启动全部服务（代理 + 后台 + React HMR :3000） |
| `npm run craco` | 仅启动 React 开发服务器（端口 3000） |
| `npm run start` | 生产模式启动 |
| `npm run proxy` | 仅启动代理，不启动后台面板 |
| `npm run socks5` | 仅启动 Socks5 服务 |
| `npm run build` | 构建 React 前端 |

### 测试

```bash
npm run test:proxy   # 代理连通性/性能/吞吐量测试（需先启动代理服务）
```

### 代码结构

```
├── proxy/           # 代理核心：BlockProxy 集成、拦截逻辑、MITM 规则
│   └── mitm/        # MITM 规则定义（YouTube 去广告、有道词典 VIP）
├── socks5/          # SOCKS5 over TLS 实现
├── server/          # Express 后台 API + 管理面板
├── src/             # React 前端（CRA + CRACO）
├── client/          # macOS 客户端（Python）
├── test/            # 测试套件
├── cert/            # TLS/CA 证书
├── bin/start.js     # CLI 入口（block-proxy 命令）
└── config.json      # 运行时配置
```

---

## 7）性能测试

### 并发测试

| 直连 | 代理 |
|:----:|:----:|
| <img height="400" alt="直连测试" src="https://github.com/user-attachments/assets/8268bc5c-956f-4b67-89c1-cdd5725114b3" /> | <img height="400" alt="代理测试" src="https://github.com/user-attachments/assets/abf4bfa1-c8b8-4907-ba0e-bcc76e8899fa" /> |

### 网速测试

<img width="544" alt="网速测试" src="https://github.com/user-attachments/assets/67c61e34-67ae-4345-97ca-d266cd35ddf4" />

---

## 8）已知问题

### iOS Safari 安全限制

iOS Safari 不支持带认证的代理与网关使用相同 IP 地址。两种解决方案：

1. 不填写代理认证用户名和密码（留空则验证始终通过）
2. 给 OpenWrt LAN 口额外绑定一个 IP，iOS 设备使用该 IP 作为代理地址

<img width="300" alt="openwrt IP 绑定" src="https://github.com/user-attachments/assets/0f46d6b4-00b1-44aa-9be7-fa23a09bb199" />


## 9）网络拓扑

<img width="600" alt="image" src="https://github.com/user-attachments/assets/2d8a4ec7-8ced-446d-8777-6eaa30e27bc0" />
