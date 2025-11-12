# Block-Proxy

限制小朋友上网的代理，依赖 anyproxy，用在 openwrt 里。特性：

- 域名拦截
- Pathname 拦截
- 指定拦截Mac地址
- 设定日期和时间段
- 监控上网记录

### 开发和调试

代码 clone 下来后执行`pnpm i`，执行 `npm run dev` 运行本地服务。默认开启三个端口：

1. 8001: 代理端口
2. 8002: 监控端口
3. 8003: 配置端口

### Docker 构建和部署

准备工作，构建 docker 包，先启动本地 Docker：

- 服务启动：`npm run dev`，启动代理同时启动后台服务
- 只启动代理：`npm run proxy`（本地调试用）
- 本地打包：`npm run docker:build`
- 打arm包：`npm run docker:build_arm`
- 导出tar包到本地：`docker save -o block-proxy.tar block-proxy`
- 安装包到openwrt：`docker load < block-proxy.tar`

拷贝 tar 到 openwrt后，启动容器：

```
docker run --init -d --restart=unless-stopped \
           -e TZ=Asia/Shanghai --network=host \
           --name block-proxy block-proxy
```

为了方便获取子网机器ip和mac地址，docker 容器和宿主机共享同一个网络，同时指定时区。

### 配置

#### 后台配置

访问路径：`http://proxy-ip:8003`

路由表间隔两小时刷新一次。如果新加入网的设备没生效，刷新一下路由表。添加限制条件后，点击重启代理按钮。

<img src="https://github.com/user-attachments/assets/16f47d3f-1ef9-47a2-8640-c7e04ec64e1a" width=300 />


#### 设备配置

1. 代理设置：iPhone/iPad 为例：设置 → 无线局域网 → 点击当前网络 → HTTP代理/配置代理，设置服务器和端口。
2. 证书设置：打开anproxy监控地址（8002端口），扫码安装证书，在手机设置中安装该证书，同时配置完全信任：设置→通用→关于本机→证书信任设置→打开对AnyProxy的完全信任

#### 禁掉设备直连

防止小朋友修改网Wifi连接，只允许设备通过代理访问，把直连上网权限关掉。网关里配置防火墙规则：

```
iptables -I FORWARD -m mac --mac-source D2:9E:8D:1B:F1:4E  -j REJECT
ip6tables -I forwarding_rule -m mac --mac-source D2:9E:8D:1B:F1:4E -j REJECT
```

重启防火墙

### Docker 文件下载

Arm 架构 → <a href="http://yui.cool:7001/public/downloads/block-proxy.tar" target=_blank>block-proxy.tar</a>（右键另存为）

### 使用说明

#### 应用条件：

1. 拦截规则工作在第五层网络，涉及到 https 的解包，因此需要证书参与，设备必须安装代理的证书
2. 拦截规则不涉及二层网络，因此必须通过ip来反查mac地址，就需要代理服务工作在对子网有扫描权限的节点，最好是openwrt网关，通过arp命令得到Mac地址表。可以`arp -a`看下是否可以扫描完全。
3. 服务会自动更新路由表，每 2 个小时更新一次，对于新入网的设备，最好在后台手动刷新并重启代理，以免拦截规则不能立即生效。

#### 代理性能

在 http 报文拦截前增加了 https 隧道建连时的域名判断，不匹配的域名将直接在第四层网络转发，这类请求无须经过五层解包的动作，仅是字节流转发，速度是极快的，网速只受三个因素影响：

1. CPU 处理能力
2. Wifi 带宽速度
3. TCP 连接并发量

得益于 Node 的 流式 `pipe()` 机制，理论上高并发情况下内存几乎无增长，CPU 占用也等同于原生。实测千兆局域网内、5000 个 TCP 并发量，网络延迟在 10ms 以内，网速跑到了带宽上限（硬件：R4S）。但当命中代理规则时，速度会变慢，因为命中规则后代理返回为空，所以快慢无所谓。

#### AnyProxy bug 修复

1. `Content-length` 被吞掉的问题：这个是 AnyProxy 的设计缺陷，AnyProxy 定位为 Mock 工具，为了便于修改响应内容，因此AnyProxy 默认不设置 `Content-length`，其实 AnyProxy 应当让开发者自己处理`Content-length`，并给出最佳实践，而不是一刀切，为了规避重写响应后和源报文Length不一致的问题而直接删掉`Content-length`和`Connection`这两个重要字段。
2. `beforeSendRequest` 中无法获得源 IP。在经过 https 隧道后到达`beforeSendRequest`回调函数时，req 中携带的 socket 不是原始的 socket，得到的 remoteAddress 始终是 `127.0.0.1`。这是代理机制决定的，但 AnyProxy 作为工具箱应当把重要的最初创建隧道时的源 socket 保留下来，以便把关键的原始信息透传给规则回调函数，交给开发者去处理。

block-proxy 临时给这两个问题打了补丁。

### License

MIT
