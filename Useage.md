# Block-Proxy 用户手册

Block-Proxy 是一个基于 MITM 的代理过滤工具，用于家长控制、广告拦截和网络内容过滤。提供 HTTP 代理、SOCKS5 over TLS 代理、Web 管理界面和 macOS 状态栏客户端。还提供双向隧道和 NAT 内网穿透反代能力。

## 目录

- [快速开始](#快速开始)
- [服务端部署](#服务端部署)
  - [Docker 部署（推荐）](#docker-部署推荐)
  - [命令行安装 & 启动](#命令行安装启动openwrt--linux--macos)
- [配置管理界面](#配置管理界面)
- [端口说明](#端口说明)
- [HTTP 代理使用](#http-代理使用)
  - [设备端设置代理](#设备端设置代理)
  - [代理认证](#代理认证)
- [SOCKS5 over TLS 代理](#socks5-over-tls-代理)
  - [服务端开启 TLS](#服务端开启-tls)
  - [关闭 TLS（纯 TCP）](#关闭-tls纯-tcp)
- [HTTPS MITM 解密](#https-mitm-解密)
  - [开启 MITM](#开启-mitm)
  - [安装根证书](#安装根证书)
  - [关闭 MITM（纯隧道模式）](#关闭-mitm纯隧道模式)
- [拦截规则配置](#拦截规则配置)
  - [基于域名的拦截](#基于域名的拦截)
  - [URL 路径正则匹配](#url-路径正则匹配)
  - [时间段控制](#时间段控制)
  - [星期控制](#星期控制)
  - [MAC 地址定向拦截](#mac-地址定向拦截)
- [自定义 MITM 规则（高级）](#自定义-mitm-规则高级)
  - [内置规则模块](#内置规则模块)
  - [外部规则文件](#外部规则文件)
- [MacOS 客户端](#macos-客户端)
  - [下载与安装](#下载与安装)
  - [客户端配置](#客户端配置)
  - [分流规则](#分流规则)
  - [使用 Claude Code](#使用-claude-code)
  - [日志查看](#日志查看)
- [Android 客户端](#android-客户端)
- [NAT 隧道反代](#nat-隧道反代)
- [常见问题](#常见问题)

---

## 快速开始

Block-Proxy 服务端部署在路由器或服务器上，客户端设备配置代理后即可使用。

**最简流程：**

1. **部署服务端**：在路由器/服务器上通过 Docker 启动 block-proxy（见下方部署章节）
2. **打开管理界面**：浏览器访问 `http://<服务器IP>:8004`，配置拦截规则
3. **设备设置代理**：在手机/电脑的 Wi-Fi 设置中填写代理服务器 IP 和端口 `8001`
4. **（可选）安装证书**：如需 HTTPS 内容过滤和设备定向拦截以及 MTIM，必须扫码安装根证书

启动后默认端口：
- HTTP 代理：`8001`
- SOCKS5（可选 打开TLS）：`8002`
- 双向隧道（可选）：`8003`
- Web 管理界面：`8004`

---

## 服务端部署

### Docker 部署（推荐）

从阿里云容器镜像仓库拉取预构建镜像（`latest` 标签支持多架构，Docker 会自动选择匹配当前系统的版本）：

```bash
docker run --init -d --restart=unless-stopped \
  -e TZ=Asia/Shanghai --network=host \
  --user=root \
  --log-driver local \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  --cpus="4" \
  --memory 400m \
  --name block-proxy crpi-x1zji86f6jpcd7t1.cn-hangzhou.personal.cr.aliyuncs.com/lijing00333/block-proxy:latest
```

挂载自定义配置（可选）：

```bash
docker run -d \
  --name block-proxy \
  --network=host \
  -v /path/to/config.json:/app/config.json \
  -v /path/to/rule.js:/app/config/rule.js \
  --restart=unless-stopped \
  crpi-x1zji86f6jpcd7t1.cn-hangzhou.personal.cr.aliyuncs.com/lijing00333/block-proxy:latest
```

> **注意**：必须使用 `--network=host` 模式，否则无法获取客户端真实 MAC 地址且 ARP 扫描不工作。Docker 环境下管理界面显示的"服务器 IP"是容器内部 IP，客户端代理地址应填写**宿主机 IP**。

自己导入也可以：`docker load -i xxx.tar`（导出`docker save -o xxx.tar`）

### 命令行安装&启动（OpenWRT / Linux / macOS）

适用于有 Node.js 18+ 环境的设备（OpenWRT 路由器、Linux 服务器、macOS）。

直接运行：

```bash
# 全局安装
npm i -g block-proxy --registry=https://registry.npmmirror.com

# 也可以直接通过 npx 启动
# npx block-proxy

# npm 全局安装后，启动
block-proxy

# 加载外部 MITM 规则文件启动
block-proxy -c /path/to/rule.js
```

也可以选择通过 `pm2` 来管理 block-proxy 进程：

```bash
# 安装 pm2
npm i -g pm2

# 启动并设为开机自启
pm2 start block-proxy -- -c /path/to/rule.js
pm2 save
pm2 startup

# 常用管理命令
pm2 status          # 查看运行状态
pm2 logs block-proxy  # 查看日志
pm2 restart block-proxy # 重启
pm2 stop block-proxy    # 停止
```

---

## 配置管理界面

启动后在浏览器访问 `http://<服务器IP>:8004`。

> 如果 8004 端口无法访问，可先访问 `http://<服务器IP>:8001`（代理端口），页面会提示开启 Express 管理界面。

管理界面包含三个标签页：

**端口设置（Tab 1）**：常规代理参数设置

**拦截主机列表（Tab 2）**：拦截目标配置

**路由表（Tab 3）**：查看内网设备列表（ARP 扫描发现）

管理界面底部显示客户端代理设置指引和证书下载二维码。

---

## 端口说明

| 端口 | 用途 | 说明 |
|------|------|------|
| 8001 | HTTP 代理 | 默认打开，MITM 代理入口，设备 Wi-Fi 代理填写此端口 |
| 8002 | SOCKS5 over TLS | 可选，TLS 加密的 SOCKS5 代理，macOS 客户端远程连接用 |
| 8003 | 双向隧道 | 可选，NAT 穿透隧道服务端口，Android/macOS 客户端连接用 |
| 8004 | Web 管理界面 | 可选，浏览器打开配置拦截规则和查看状态 |

---

## HTTP 代理使用

### 设备端设置代理

**iPhone/iPad：**
1. 设置 → 无线局域网 → 点击当前 Wi-Fi 右侧的 (i)
2. 配置代理 → 手动
3. 服务器：填写 block-proxy 所在设备的 IP 地址
4. 端口：`8001`
5. 如设置了用户名密码，一并填写

**macOS：**
1. 系统设置 → 网络 → 当前 Wi-Fi → 详细信息
2. 代理 → 网页代理(HTTP) + 安全网页代理(HTTPS)
3. 服务器：填写 block-proxy IP，端口：`8001`

**Android：**
1. 设置 → WLAN → 长按当前 Wi-Fi → 修改网络
2. 高级选项 → 代理 → 手动
3. 服务器：填写 block-proxy IP，端口：`8001`

### 代理认证

在管理界面设置代理用户名和密码后，客户端连接时需提供对应凭证。留空则不认证。

> **注意**：iOS Safari 限制——如果代理地址与网关 IP 相同（即 block-proxy 部署在网关上），则不能同时启用认证，否则 iOS 设备无法使用代理。有两个办法：
>
> 1. 不填写代理认证用户名和密码（留空则验证始终通过）
> 2. 给 OpenWrt LAN 口额外绑定一个 IP，iOS 设备使用该 IP 作为代理地址

---

## SOCKS5 over TLS 代理

SOCKS5 over TLS 将 SOCKS5 协议承载在 TLS 加密连接上，适合在公网环境下安全使用（如 macOS 客户端在公司或外出时连回家中代理）。需要客户端支持 socks 套 tls才可以（因为我用的是自签证书，需要客户端勾选“AllowInsecure/允许不安全”），通常 xray、v2rayU 等工具支持。[block-proxy 客户端](https://github.com/jayli/block-proxy/releases)也支持。

### 服务端开启 TLS

在管理界面 Tab 1 中：
1. 确保 SOCKS5 端口已配置（默认 8002）
2. 将"启用 TLS"设为「开启（加密传输）」

**数据流向：**

```
客户端 → TLS 加密连接 → SOCKS5(8002) → CONNECT 隧道 → HTTP 代理(8001) → 目标服务器
```

SOCKS5 还支持 UDP over TCP（通过自定义帧协议在 TLS 隧道中承载 UDP 流量），可用于游戏、语音等 UDP 应用代理。

### 关闭 TLS（纯 TCP）

在内网环境或不需要加密时，在管理界面将 TLS 设为「关闭（纯 TCP）」。此时客户端使用普通 SOCKS5 TCP 连接即可。

---

## HTTPS MITM 解密

MITM（中间人解密）是 block-proxy 的核心能力。开启后代理可解密 HTTPS 流量，实现 URL 路径级过滤和请求内容重写。

<img width="700" alt="image" src="https://github.com/user-attachments/assets/2d8a4ec7-8ced-446d-8777-6eaa30e27bc0" />

MITM 用在两个地方，第一个是内网小朋友上网的（定向）拦截，二是一些请求的 MITM 重写，重写规则以自定义的方式开放了出来，可自己添加和定制。

### 开启 MITM

管理界面 Tab 1 → HTTPS MITM 解密 → 选择「开启」。

**开启后必须**在每台客户端设备上**安装并信任根证书**，否则访问 HTTPS 网站会报证书错误。

### 安装根证书

在浏览器访问管理界面 `http://<服务器IP>:8004`，使用页面底部的二维码扫码下载证书，或直接访问 `http://<服务器IP>:8004/fetchCrtFile`。

**iOS：**
1. 下载证书 → 前往「设置」→「已下载的描述文件」→ 安装
2. 前往「设置」→「通用」→「关于本机」→「证书信任设置」
3. 找到 BlockProxy 证书，开启「完全信任」

**macOS：**
1. 双击 `.crt` 文件 → 打开「钥匙串访问」
2. 找到 BlockProxy 证书 → 双击 → 信任 →「使用此证书时」选择「始终信任」

**Android：**
1. 下载证书 → 设置 → 安全 → 加密与凭据 → 从存储设备安装
2. 选择下载的证书文件完成安装

### 关闭 MITM（纯隧道模式）

如果不需要解密 HTTPS 流量，在管理界面将 MITM 设为「关闭」。

关闭后的行为：

| 功能 | MITM 开启 | MITM 关闭 |
|------|-----------|-----------|
| 需要安装证书 | 需要 | 不需要 |
| 域名拦截（filter_host） | 生效 | 生效 |
| URL 路径正则拦截 | 生效 | 不生效 |
| 广告内容重写（内置规则） | 生效 | 不生效 |
| HTTPS 证书错误 | 无（已安装证书） | 无（纯转发） |

> 关闭 MITM 适合只需要按域名拦截的场景，零配置、零证书错误。

---

## 拦截规则配置

所有规则通过管理界面 Tab 2 配置，点击「保存配置」后即时生效。

### 基于域名的拦截

在输入框中填写要拦截的域名，例如：

```
youtube.com
facebook.com
tiktok.com
```

添加后该域名下的所有请求被拦截。

### URL 路径正则匹配

每条规则可选填写一个正则表达式，仅拦截匹配的 URL 路径。留空则拦截该域名下所有请求。

```
# 只拦截 YouTube 广告相关请求
^https?:\/\/(www|s)\.youtube\.com\/(pagead|ptracking)

# 只拦截 googlevideo 的广告参数请求
^https?:\/\/[\w-]+\.googlevideo\.com\/.&oad
```

> 路径正则需要 MITM 开启才生效。

### 时间段控制

每条规则可设置生效时间段（24 小时制），支持跨天：

- `08:00` ~ `20:00`：白天生效
- `21:00` ~ `07:00`：晚上到次日早上生效（跨天）

典型场景：固定时间禁止游戏网站、以及禁止娱乐网站。

### 星期控制

点击星期按钮（一 二 三 四 五 六 日）设置规则生效日期：
- 蓝色 = 当天规则生效
- 灰色 = 当天规则不生效

典型场景：周一至周五禁止娱乐网站，周末自动放开。

### MAC 地址定向拦截

每条规则可绑定一个设备 MAC 地址，实现按设备差异化管控：

- **填写 MAC**：该规则仅对指定设备生效
- **留空 MAC**：该规则对内网所有设备生效

> **注意**：MAC 定向仅在 HTTP 代理下有效，SOCKS5 代理无法识别客户端 MAC。

---

## 自定义 MITM 规则（高级）

### 内置规则模块

Block-Proxy 内置了两套 MITM 规则样例，在管理界面 Tab 1 中勾选即可启用：

| 规则模块 | 说明 |
|----------|------|
| YouTube 广告拦截 | 拦截 YouTube App 视频广告（对 App 生效，浏览器不处理） |
| 有道词典 VIP | 解锁有道词典 VIP 会员功能 |

### 外部规则文件

你可以编写自定义规则文件，启动时加载：

```bash
block-proxy -c /home/user/my-rules.js
```

规则文件结构参考项目中的 [`example/rule.js`](https://github.com/jayli/block-proxy/blob/main/example/rule.js)。规则类型分两种：
- `beforeSendRequest`：请求发出前拦截，可修改请求或直接返回伪造响应
- `beforeSendResponse`：收到响应后拦截，可修改响应内容

---

## MacOS 客户端

Block-Proxy 提供 macOS 客户端 **BlockProxyClient**，用于在 Mac 上连接远程 block-proxy 服务端，支持 Socks5 套 TLS 并支持分流规则。当然 BlockProxyClient 可以链接任何 Socks 节点，只要是标准的 Socks5/http 协议即可。

### 下载与安装

从 GitHub Releases 下载：

> 下载地址：https://github.com/jayli/block-proxy/releases

根据 Mac 芯片选择对应版本：
- M系列芯片（arm架构） → `BlockProxyClient-macos-arm64.zip`
- Intel（x86架构） → `BlockProxyClient-macos-x86_64.zip`

下载后解压，拖入「应用程序」文件夹即可。

首次打开时，如果提示"无法验证开发者"：
1. 打开「系统设置」→「隐私与安全性」
2. 在页面底部找到 BlockProxyClient 并点击「仍要打开」
3. 或终端运行：`xattr -d com.apple.quarantine /Applications/BlockProxyClient.app`

### 客户端配置

点击菜单栏的 BlockProxyClient 图标 → 节点配置窗口：

| 配置项 | 说明 |
|--------|------|
| 服务器地址 | 代理服务端的 IP 或域名 |
| 端口 | 服务端 SOCKS5 端口（默认 8002） |
| 用户名 / 密码 | 与服务端代理认证一致 |
| TLS | 是否启用 TLS 加密（需与服务端一致） |
| Allow Insecure | 是否允许自签名证书（服务端使用自签名证书时需勾选） |
| 本地 SOCKS5 端口 | 本地监听的 SOCKS5 端口（默认 1080） |
| 本地 HTTP 端口 | 本地监听的 HTTP 代理端口（默认 1087） |
| UDP | 是否启用 UDP 代理 |

配置保存后客户端自动重连。客户端启动后会自动设置 macOS 系统代理为本地 SOCKS5 端口。

### 分流规则

菜单栏图标 → “分流规则” 打开分流规则窗口。

支持两种代理模式：
- **Global（全局模式）**：所有流量走代理
- **Rule（规则模式）**：根据分流规则决定走代理还是直连

分流引擎兼容 Xray/V2Ray 的 geosite/geoip 数据格式，支持的规则类型：

| 规则类型 | 格式 | 示例 | 说明 |
|----------|------|------|------|
| 域名关键字 | `domain:keyword` | `domain:google` | 匹配含该关键词的域名 |
| 域名后缀 | `domain:suffix` | `domain:google.com` | 匹配该域名及子域名 |
| 域名全匹配 | `domain:full` | `domain:www.google.com` | 精确匹配 |
| Geosite 分类 | `geosite:tag` | `geosite:google` | 匹配 geosite 分类下所有域名 |
| GeoIP | `geoip:code` | `geoip:cn` | 匹配指定国家/地区 IP |
| IP CIDR | `ip:cidr` | `ip:10.0.0.0/8` | 匹配 IP 地址段 |

> [格式规范参照](https://xtls.github.io/document/level-1/routing-lv1-part1.html#_3-4-%E7%AE%80%E6%9E%90%E5%9F%9F%E5%90%8D%E6%96%87%E4%BB%B6-geosite-dat)

**典型分流配置：**

直连规则（不走代理）：
```
geosite:cn           # 中国大陆域名直连
geosite:apple        # Apple 服务直连
geoip:cn             # 中国大陆 IP 直连
```

代理规则（走代理）：
```
geosite:google       # Google 服务走代理
geosite:youtube      # YouTube 走代理
geosite:twitter      # Twitter 走代理
geosite:openai       # OpenAI/ChatGPT 走代理
```

内网地址（10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、127.0.0.0/8）默认直连，无需额外配置。

默认策略（不匹配任何规则时）可在窗口底部切换：`proxy`（走代理）或 `direct`（直连）。

### 使用 Claude Code

Claude 对分流规则很挑剔，本机用 claude code 的时候需要挂代理，在 ~/.zshrc 里重写 claude code 启动命令：

```
claude() {
	ALL_PROXY='http://127.0.0.1:1087' claude "$@"
}
```

在 BlockProxyClient 的分流规则里，代理中要包含"geosite:claude"。

### 日志查看

菜单栏图标 → **Logs** 打开日志窗口，可查看连接记录和错误信息。日志文件存储在 `~/Library/Application Support/SocksClient/logs/`。


## Android 客户端

BlockProxyClient 提供 [android 客户端](https://github.com/jayli/block-proxy/releases)（适配 Android 6+），Android 客户端只提供一种“双向隧道”模式连接 block-proxy 服务端。

## NAT 隧道反代

Block-Proxy 服务端和 BlockProxyClient 客户端通过私有协议建立双向隧道，目的是为了穿透 NAT 网络，实现内网穿透的代理。

隧道服务运行在 **端口 8003**，使用 TLS 加密传输。客户端通过该端口与服务端建立隧道连接，服务端通过隧道将请求反向转发给客户端处理。

<img width="700" alt="Image" src="https://github.com/user-attachments/assets/a9db3a1c-dd05-4fde-a452-5eb72b5a869e" />

客户端 B 访问内网资源 C，通过双向隧道来架桥。

安全起见，需要穿透隧道代理的资源必须匹配白名单，白名单在 block-proxy 配置面板中隧道配置 Tab 中添加。

---

## 常见问题

### Q: 开启 MITM 后 HTTPS 网站打不开/提示不安全？

A: 客户端需要安装并信任 block-proxy 的根证书。参见[安装根证书](#安装根证书)。每台使用代理的设备都需要安装。

### Q: 不想解密 HTTPS，但想按域名拦截？

A: 关闭 MITM（`enable_mitm: "0"`）即可。域名级拦截基于 CONNECT 阶段的 SNI，不需要解密流量。只有 URL 路径过滤和广告重写才需要 MITM。

### Q: macOS 客户端连不上服务器？

A: 检查：
1. 服务端 `enable_socks5` 是否为「开启」
2. 防火墙是否开放了 SOCKS5 端口（默认 8002）
3. 客户端 TLS 设置与服务端是否一致（都开或都关）
4. 用户名密码是否正确
5. 如果是自签名证书，是否勾选了"Allow Insecure"

### Q: 如何给不同的孩子设置不同的上网时间？

A: 为每个孩子的设备创建单独的拦截规则，在 MAC 地址栏填写对应设备的 MAC，设置各自的时间段和生效日期。孩子的 MAC 地址可在管理界面「路由表」标签页查看。

### Q: Docker 容器看不到设备 MAC 地址 / 路由表为空？

A: 确保使用了 `--network=host` 模式。桥接网络下容器无法访问宿主机网络层，ARP 扫描不工作。

### Q: 路由表没有设备？

A: 点击管理界面「刷新路由表」按钮手动触发 ARP 扫描。系统会每 2 小时自动扫描一次，新上线设备可能需等待或手动刷新。

### Q: iOS 设置了代理但无法上网？

A: 如果 block-proxy 部署在路由器上且配置了代理认证，iOS 会拒绝连接（Safari 安全限制：带认证的代理地址不能与网关 IP 相同）。解决方案：去掉代理认证，或将 block-proxy 部署在路由器以外的独立设备上。

### Q：还能做哪些用途？

MITM 作为 服务中心，外围嫁接节点线路（起点），远程办公/代理，虚拟通道...

<img width="700" alt="image" src="https://github.com/user-attachments/assets/08cf212d-f856-4bbd-a1cd-5e78e81ab861" />

