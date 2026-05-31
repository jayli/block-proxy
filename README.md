<img width="287" alt="image" src="https://github.com/user-attachments/assets/2bb069d8-508a-41b9-9fee-94a1e31cc0cb" />

<a href="https://nodei.co/npm/block-proxy/"><img src="https://nodei.co/npm/block-proxy.svg?style=mini"></a>

> Socks5/HTTP 代理工具，支持 MITM 和二次开发。用于家庭网关限制小朋友上网。

- HTTP 代理 + Socks5 over TLS 代理
- 域名拦截、URL 正则匹配、MAC 地址定向拦截
- 按时间段和星期拦截，内置广告过滤
- [macOS 客户端](https://github.com/jayli/block-proxy/releases) 一键连接

## 快速开始

```bash
npm install -g block-proxy
block-proxy
```

或使用 Docker（推荐）：

```bash
docker run --init -d --restart=unless-stopped \
  -e TZ=Asia/Shanghai --network=host \
  -v "$(pwd)/":/app/config \
  --name block-proxy \
  crpi-x1zji86f6jpcd7t1.cn-hangzhou.personal.cr.aliyuncs.com/lijing00333/block-proxy:latest
```

首次启动后访问 `http://代理IP:8003` 进入后台配置面板。

## 端口说明

| 端口 | 说明 | 可否关闭 |
|:----:|:----|:------:|
| 8001 | HTTP 代理端口 | 不可 |
| 8002 | Socks5 over TLS 代理端口 | 可 |
| 8003 | 后台配置面板 | 可 |

## 开发

```bash
pnpm i
npm run dev       # 开发模式（含 React HMR，端口 3000）
npm run start     # 生产启动
npm run proxy     # 仅启动代理，不开后台面板
```

## 更多文档

详见 [wiki.md](wiki.md)

## License

MIT
