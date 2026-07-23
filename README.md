<img width="270" alt="image" src="https://github.com/user-attachments/assets/e7c421a7-21d8-4d8e-a71e-7f409d6711ff" />


<a href="https://nodei.co/npm/block-proxy/"><img src="https://nodei.co/npm/block-proxy.svg?style=mini"></a>

> Socks5/HTTP 代理 + 反向隧道工具，支持 MITM 和二次开发。用于家庭网关限制小朋友上网，域名/地址/设备拦截，以及内网穿透场景。

- HTTP 代理 + Socks5（可开启 TLS）代理 + 隧道代理
- 域名拦截、URL 正则匹配、MAC 地址定向拦截
- 按时间段和星期拦截
- [macOS 客户端](https://github.com/jayli/block-proxy/releases)，支持 SOCKS5/HTTP/隧道三种协议，内置 geosite/geoip 分流引擎

## 快速开始

**方式一：npx 直接启动（无需安装）**

```bash
npx block-proxy
```

**方式二：全局安装后启动**

全局安装：

```bash
npm install -g block-proxy
```

启动：

```bash
block-proxy
```

带规则启动

编写 `rule.js`（参考 [example/rule.js](example/rule.js)），通过 `-c` 参数加载：

```bash
block-proxy -c rule.js
```

规则文件导出规则组对象，每个规则组包含一组拦截规则，支持 `beforeSendRequest` 和 `beforeSendResponse` 两种类型。

**方式三：pm2 启动**

先安装 `pnpm install -g block-proxy`

```
pm2 start block-proxy --interpreter bash
```

或者直接进项目目录：`pm2 start npm --name "block-proxy" -- run start`

首次启动后访问 `http://代理IP:8004` 进入后台配置面板。

## 端口说明

| 端口 | 说明 | 可否关闭 |
|:----:|:----|:------:|
| 8001 | HTTP 代理端口 | 不可 |
| 8002 | Socks5 over TLS 代理端口 | 可 |
| 8003 | 隧道代理端口（TLS） | 可 |
| 8004 | 后台配置面板 | 可 |

## 隧道代理

隧道代理是双向的，客户端通过隧道连服务端同样可以支持 MITM。

可以自定义隧道证书，通过两个参数配置

```
block-proxy --pubkey /path/to/fullchain.pem --privkey /path/to/privkey.pem
```

如果不传自定义证书，则会自生成证书，不影响功能

参数说明：
- `--pubkey`：TLS 公钥证书路径（完整证书链）
- `--privkey`：TLS 私钥路径

## 开发

```bash
pnpm i
npm run start     # 生产启动
npm run proxy     # 仅启动代理，不开后台面板
```

## macOS 客户端

纯 Python（PyObjC）实现的状态栏代理客户端，支持三种连接协议：

| 协议 | 说明 |
|:----:|:----|
| SOCKS5 | SOCKS5 over TLS，连接服务端 8002 端口 |
| HTTP | HTTP 代理直连服务端 8001 端口 |
| 隧道 | 隧道代理 |


## 更多文档

详见 [Useage.md](Useage.md) —— 服务端部署、HTTP/SOCKS5 代理配置、MITM 证书安装、拦截规则、macOS 客户端使用等完整用户手册。

## License

MIT
