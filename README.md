<img width="287" alt="image" src="https://github.com/user-attachments/assets/2bb069d8-508a-41b9-9fee-94a1e31cc0cb" />

<a href="https://nodei.co/npm/block-proxy/"><img src="https://nodei.co/npm/block-proxy.svg?style=mini"></a>

> Socks5/HTTP 代理 + 反向隧道工具，支持 MITM 和二次开发。用于家庭网关限制小朋友上网，域名/地址/设备拦截，以及内网穿透场景。

- HTTP 代理 + Socks5（可开启 TLS）代理
- 反向隧道（TLS），支持双 TCP 连接消除队头阻塞，内网客户端可通过隧道回连服务端代理
- 域名拦截、URL 正则匹配、MAC 地址定向拦截
- 按时间段和星期拦截
- [macOS 客户端](https://github.com/jayli/block-proxy/releases)，支持 SOCKS5/HTTP/隧道三种协议，内置 geosite/geoip 分流引擎

## 快速开始

**方式一：npx 直接启动（无需安装）**

```bash
npx block-proxy
```

**方式二：全局安装后启动**

```bash
npm install -g block-proxy
block-proxy
```

**方式三：带自定义 MITM 规则启动**

编写 `rule.js`（参考 [example/rule.js](example/rule.js)），通过 `-c` 参数加载：

```bash
npx block-proxy -c rule.js
```

规则文件导出规则组对象，每个规则组包含一组拦截规则，支持 `beforeSendRequest` 和 `beforeSendResponse` 两种类型。

**方式四：Docker（推荐长期运行）**

```bash
docker run --init -d --restart=unless-stopped \
  -e TZ=Asia/Shanghai --network=host \
  --name block-proxy \
  crpi-x1zji86f6jpcd7t1.cn-hangzhou.personal.cr.aliyuncs.com/lijing00333/block-proxy:latest
```

首次启动后访问 `http://代理IP:8004` 进入后台配置面板。

## 端口说明

| 端口 | 说明 | 可否关闭 |
|:----:|:----|:------:|
| 8001 | HTTP 代理端口 | 不可 |
| 8002 | Socks5 over TLS 代理端口 | 可 |
| 8003 | 反向隧道端口（TLS） | 可 |
| 8004 | 后台配置面板 | 可 |

## 反向隧道

反向隧道允许位于内网的 macOS 客户端通过 TLS 连接主动回连服务端，建立双向代理通道。服务端收到隧道客户端的请求后，通过本地 HTTP 代理（8001）转发，从而让隧道客户端的请求也能经过服务端的 MITM 规则处理。

**特性：**
- TLS 加密传输，用户名密码认证
- 双 TCP 连接并行，消除单连接队头阻塞
- 自动心跳检测（30s PING / 60s 超时）
- 断线自动重连与连接补充
- 可配置隧道域名列表，指定哪些域名的请求走隧道转发
- 支持反向 CONNECT（服务端主动通过隧道访问客户端侧的目标）

**请求流向：**
```
内网客户端 → 隧道 TLS (8003) → TunnelManager → HTTP Proxy (8001) → MITM → 目标服务器
```

## 开发

```bash
pnpm i
npm run dev       # 开发模式（React HMR 端口 3000，Express 端口 8004）
npm run start     # 生产启动
npm run proxy     # 仅启动代理，不开后台面板
```

## macOS 客户端

纯 Python（PyObjC）实现的状态栏代理客户端，支持三种连接协议：

| 协议 | 说明 |
|:----:|:----|
| SOCKS5 | SOCKS5 over TLS，连接服务端 8002 端口 |
| HTTP | HTTP 代理直连服务端 8001 端口 |
| 隧道 | 通过反向隧道（8003 端口）回连，支持 geosite/geoip 分流规则 |

客户端使用 Nuitka 编译为原生 macOS .app，绕过企业安全软件对 xray-core 等二进制的拦截。内置零依赖 protobuf 解析器读取 Xray/V2Ray 格式的 geoip.dat/geosite.dat。

## 更多文档

详见 [Useage.md](Useage.md) —— 服务端部署、HTTP/SOCKS5 代理配置、MITM 证书安装、拦截规则、macOS 客户端使用等完整用户手册。

## License

MIT
