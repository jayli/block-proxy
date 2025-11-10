# Block-Proxy

限制小朋友上网的代理，依赖 anyproxy，基于 Docker 安装，用在 openwrt 里。

### 开发和调试

代码 clone 下来后执行`pnpm i`，执行 `npm run dev` 运行本地服务。默认开启三个端口：

1. 8001: 代理端口
2. 8002: 监控端口
3. 8003: 配置端口

### Docker 构建和部署

准备工作，构建 docker 包，先启动本地 Docker：

- 本地打包：`npm run docker:build`
- 打arm包：`npm run docker:build_arm`
- 本地调试：`npm run dev`
- 导出tar包到本地：`docker save -o block-proxy.tar block-proxy`
- 安装包到openwrt：`docker load < block-proxy.tar`

拷贝 tar 到 openwrt后，启动容器：

  `docker run --init -d --restart=unless-stopped -e TZ=Asia/Shanghai --network=host --name block-proxy block-proxy`

为了方便获取子网机器ip和mac地址，docker 容器和宿主机共享同一个网络

访问代理服务器：`http://proxy-ip:8003`

<img src="https://github.com/user-attachments/assets/d8e65dd6-58b3-4093-9718-1011107f6e22" width=300 />

### Docker 文件下载

Download → <a herf="http://yui.cool:7001/public/downloads/block-proxy.tar" target=_blank>Block-proxy</a>
