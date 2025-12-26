# Block-Proxy

基于 MITM 的上网过滤工具

主要是限制小朋友上网，依赖 anyproxy，用在 openwrt 里。特性：

- 域名拦截
- url 正则拦截
- 指定拦截Mac地址
- 设定日期和时间段
- 监控上网记录
- 顺便过滤广告

### 开发和调试

代码 clone 下来后执行`pnpm i`，执行 `npm run dev` 运行本地服务。默认开启三个端口：

0. 3000: 调试端口（仅开发调试用）
1. 8001: 代理端口
2. 8002: 监控端口
3. 8003: 配置端口

### Docker 构建和部署

准备工作，构建 docker 包，先启动本地 Docker：

- 开发调试：`npm run dev`，开发调试用3000端口
- 生产启动：`npm run start`，生产环境使用
- 只启动代理：`npm run proxy`，不启动配置后台，只启动代理
- 后台构建：`npm run build`
- 本地打包：`npm run docker:build`
- 打arm包：`npm run docker:build_arm`
- 导出tar包到本地：`docker save -o block-proxy.tar block-proxy`
- 安装包到openwrt：`docker load < block-proxy.tar`

> 要是打包 docker 空间不够就执行 `docker system prune -a --volumes`

拷贝 tar 到 openwrt 后，`mkdir block-proxy & cd block-proxy`，启动容器：

```
docker run --init -d --restart=unless-stopped \
           -e TZ=Asia/Shanghai --network=host \
           --user=root \
           --log-driver local \
           --log-opt max-size=10m \
           --log-opt max-file=3 \
           --cpus="4" \
           --memory 300m \
           --name block-proxy block-proxy
```

网关里为了方便获取子网机器ip和mac地址，docker 容器和宿主机共享同一个网络，同时指定时区。

如果是在 Window/Mac 中，需要手动指定端口绑定（不推荐）：

```
docker run --init -d --restart=unless-stopped --user=root \
           -e TZ=Asia/Shanghai -p 8001:8001 -p 8002:8002 -p 8003:8003 \
           --name block-proxy block-proxy
```


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

1. 基于 MITM，tls 拆包后才能做 url 的匹配、重写等动作，所以客户端设备必须要安装代理工具的证书
2. 服务需要根据 ip 反查 mac 地址，需要代理服务工作在对子网有扫描权限的节点，最好是部署在 openwrt 网关，可以`arp -a`看下是否可以扫描完全。
3. 服务会自动更新路由表，每 2 个小时更新一次，对于新入网的设备，最好在后台手动刷新并重启代理，以免拦截规则不能立即生效。

#### Youtube 去广告

一共六条拦截规则，四条 reject 规则直接配置在后台里：

- *youtube.com*：`^https?:\/\/(www|s)\.youtube\.com\/(pagead|ptracking)`
- *youtube.com*：`^https?:\/\/s\.youtube\.com\/api\/stats\/qoe\?adcontext`
- *youtube.com*：`^https?:\/\/(www|s)\.youtube\.com\/api\/stats\/ads`
- *googlevideo.com*：`^https?:\/\/[\w-]+\.googlevideo\.com\/(?!(dclk_video_ads|videoplayback\?)).+&oad`

另外两条规则在这里：<https://github.com/jayli/block-proxy/blob/main/proxy/mitm/rule.js>（手工添加上面四条规则就够了）

#### 代理性能

只有域名规则匹配时才会被代理，其他请求直接在第四层转发，无需再去做 https 解包，因此速度是极快的，最终速度受三个因素影响：

1. CPU 处理能力
2. Wifi 带宽速度
3. TCP 连接并发量

提示：

- 纯拦截：Node 的流式 `pipe()` 机制效率很高，吞吐量不用担心。仅需拦截的 url 命中规则时，直接返回空，避免了网络耗时，相比之下 tls 解包的耗时可以忽略了。千兆网基本能跑满。
- MITM：需要 MITM 的请求，网络耗时省不了，tls 解包就会增加 RT。因为 Node 的 tls 加解密基于系统的 OpenSSL 被 libuv 调度，耗时基本上取决于 CPU 能力了。Node 也无须以 cluster 运行。
- Openwrt 稳定性：为了避免瞬时的 CPU 打满，最好 docker 里加上 CPU 和内存的限制。实测内存 400M，CPU 50% 足够了。

**并发测试**：

|直连测试     |代理测试     |
|:---------:|:----------------:|
|<img height="500" alt="image" src="https://github.com/user-attachments/assets/8268bc5c-956f-4b67-89c1-cdd5725114b3" />  | <img height="500" alt="image" src="https://github.com/user-attachments/assets/abf4bfa1-c8b8-4907-ba0e-bcc76e8899fa" />|

**网速测试**：

<img width="544" alt="image" src="https://github.com/user-attachments/assets/67c61e34-67ae-4345-97ca-d266cd35ddf4" />

#### AnyProxy bugfix 记录

1. `Content-length` 被吞掉的问题：这个是 AnyProxy 的设计缺陷，AnyProxy 定位为 Mock 工具，为了便于修改响应内容，因此AnyProxy 默认不设置 `Content-length`，其实 AnyProxy 应当让开发者自己处理`Content-length`，并给出最佳实践，而不是一刀切，为了规避重写响应后和源报文Length不一致的问题而直接删掉`Content-length`和`Connection`这两个重要字段。
2. `beforeSendRequest` 中无法获得源 IP。在经过 https 隧道后到达`beforeSendRequest`回调函数时，req 中携带的 socket 不是原始的 socket，得到的 remoteAddress 始终是 `127.0.0.1`。这是代理机制决定的，但 AnyProxy 作为工具箱应当把重要的最初创建隧道时的源 socket 保留下来，以便把关键的原始信息透传给规则回调函数，交给开发者去处理。
3. `EPIPE 报错`，这个错误会导致程序崩溃，本来 EPIPE 只是一个小错误，是客户端在收到 AnyProxy 响应之前关闭了隧道，anyproxy 没有很好的处理，我打上了补丁。
4. `407 验证`：增加了代理的用户名和密码的验证。

### License

MIT
