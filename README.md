# Block-Proxy

限制小朋友上网的代理，依赖 anyproxy，基于 Docker 安装，用在 openwrt 里。

### 开发和调试

代码 clone 下来后执行`pnpm i`，执行 `npm run dev` 运行本地服务。开启三个端口：

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

  `docker run --init -d --restart=unless-stopped -e TZ=Asia/Shanghai --publish 8001:8001 --publish 8002:8002 --publish 8003:8003 --name block-proxy block-proxy`



