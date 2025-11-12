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

### 配置

#### 配置后台

配置后台：`http://proxy-ip:8003`

<img src="https://github.com/user-attachments/assets/16f47d3f-1ef9-47a2-8640-c7e04ec64e1a" width=300 />

路由表间隔两小时刷新一次。如果新加入网的设备没生效，刷新一下路由表。

#### 禁掉设备直连

最好在网关禁止设备直连，只允许通过代理访问。配置规则：

  iptables -I FORWARD -m mac --mac-source D2:9E:8D:1B:F1:4E  -j REJECT
  ip6tables -I forwarding_rule -m mac --mac-source D2:9E:8D:1B:F1:4E -j REJECT

重启防火墙

### Docker 文件下载

Arm 架构 → <a href="http://yui.cool:7001/public/downloads/block-proxy.tar" target=_blank>block-proxy.tar</a>（右键另存为）