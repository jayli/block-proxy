
<img width="287" alt="image" src="https://github.com/user-attachments/assets/2bb069d8-508a-41b9-9fee-94a1e31cc0cb" />

---------------------------

<a href="https://nodei.co/npm/block-proxy/"><img src="https://nodei.co/npm/block-proxy.svg?style=mini"></a>

> **Block-Proxy**

Socks5/http 代理工具，支持 MITM 和二次开发

用在家庭网关，限制小朋友上网用。特性：

- HTTP 代理 + Socks5 over TLS 代理
- 域名拦截、url 正则、Mac 地址拦截
- 设定日期和时间段、顺便过滤广告
- 提供服务端和客户端

### 1）服务端使用方法

#### ① 方式一：快速部署

安装：

```
npm install -g block-proxy
```

启动：

```
block-proxy
```

或者带配置文件启动

```
block-proxy -c rule.js
```

配置文件参照 [rule.js](example/rule.js)，可留空

#### ② 方式二，Docker 部署（推荐）

1. 拉取镜像（自动匹配架构）：

```
docker pull crpi-x1zji86f6jpcd7t1.cn-hangzhou.personal.cr.aliyuncs.com/lijing00333/block-proxy:latest
```

2. 启动：

```
docker run --init -d --restart=unless-stopped \
           -e TZ=Asia/Shanghai --network=host \
           --user=root \
           --log-driver local \
           --log-opt max-size=10m \
           --log-opt max-file=3 \
           --cpus="5" \
           --memory 400m \
           -v "$(pwd)/":/app/config \
           --name block-proxy crpi-x1zji86f6jpcd7t1.cn-hangzhou.personal.cr.aliyuncs.com/lijing00333/block-proxy:latest
```

其中挂载目录 `$(pws)/` 下的 `rule.js` 是需要额外挂载的配置文件，可留空。

> block-proxy 可以配置只启动 proxy 不启动后台面板，首次启动后访问 http://代理IP:8001 根据提示操作。

网关里为了方便获取子网机器 ip 和 mac 地址，docker 容器需要和宿主机共享同一个网络，同时指定时区。

如果是在 Window/Mac 中，需要手动指定端口绑定（不推荐）：

```
docker run --init -d --restart=unless-stopped --user=root \
           -v "$(pwd)/":/app/config \
           -e TZ=Asia/Shanghai -p 8001:8001 -p 8002:8002 -p 8003:8003 \
           --name block-proxy crpi-x1zji86f6jpcd7t1.cn-hangzhou.personal.cr.aliyuncs.com/lijing00333/block-proxy:latest
```

### 2）服务侧端口配置

1. 服务端配置：配置面板 <http://server-ip:8004>，关闭、启用配置面板：<http://server-ip:8001>
2. 客户端配置：http 代理直接在 iphone wifi 详情里手动配置，socks5 代理只支持 socks5 over TLS，用小火箭配置。配置信息参照[配置面板](http://localhost:8004)

### 3）服务侧代码的开发和调试

代码 clone 下来后执行`pnpm i`，执行 `npm run dev` 运行本地服务。默认开启 5 个端口：

|端口   |说明     |可否关闭|
|:----:|:------:|:------:|
|3000  |调试端口（仅开发调试配置面板用）| 生产环境不启用|
|8001  |HTTP 代理端口 | 不可禁用 |
|8002  |Socks5（Over TLS）代理端口 | 可禁用 |
|8003  |AnyProxy 监控页面| 可禁用  |
|8004  |后台配置页端口  | 可禁用 |


### 4）Block-Proxy 的 Docker 构建说明

准备工作，构建 docker 包，先启动本地 Docker：

- 开发调试：`npm run dev`，开发调试用3000端口
- 生产启动：`npm run start`，生产环境使用
- 只启动代理：`npm run proxy`，不启动配置后台，只启动代理
- 后台构建：`npm run build`
- 本地构建 amd64：`npm run docker:build`
- 本地构建 arm64：`npm run docker:build:arm`
- 推送 amd64 + arm64 双架构到 ACR：`npm run docker:push`
- 仅推送 amd64：`npm run docker:push:amd64`
- 仅推送 arm64：`npm run docker:push:arm64`

> 首次使用 `docker:push` 前需要先 ACR 登录：
> ```
> docker login --username=hi50078584@aliyun.com crpi-x1zji86f6jpcd7t1.cn-hangzhou.personal.cr.aliyuncs.com
> ```
> 要是打包 docker 空间不够就执行 `docker system prune -a --volumes`

拷贝 tar 到 openwrt 后启动容器：参照上文 Docker部署。

### 5）客户端配置说明

#### ① 代理端口

- 8001：HTTP 代理
- 8002：socks5 over TLS

⚠️ Socks5 代理不支持对 Mac 地址的定向拦截，Mac 地址的拦截只对局域网内的 HTTP 代理绑定生效。建议局域网绑定 http 代理，公网绑定 Socks5 代理。

⚠️ 使用小火箭的 Socks5 over TLS 代理，TLS 选项里勾选“允许不安全”

#### ② 后台配置

访问路径：`http://proxy-ip:8004`

路由表间隔两小时刷新一次。如果新加入网的设备没生效，刷新一下路由表。添加限制条件后，点击重启代理按钮。

<img src="https://github.com/user-attachments/assets/16f47d3f-1ef9-47a2-8640-c7e04ec64e1a" width=300 />


#### ③ 设备配置

1. 证书设置：进入后台配置，扫码安装证书，在手机设置中安装该证书，同时配置完全信任：设置→通用→关于本机→证书信任设置→打开对AnyProxy的完全信任
2. 代理设置：iPhone/iPad 为例：设置 → 无线局域网 → 点击当前网络 → HTTP代理/配置代理，设置服务器和端口。

如果要通过 mac 地址拦截小朋友上网，小朋友的设备里把 Mac 固定下来：

<img width="350" alt="image" src="https://github.com/user-attachments/assets/f9bfab89-7194-4a72-b1ae-5cca27911bc9" />

#### ④ 禁掉设备直连

防止小朋友修改网Wifi连接，只允许设备通过代理访问，把直连上网权限关掉。网关里配置防火墙规则：

```
iptables -I FORWARD -m mac --mac-source D2:9E:8D:1B:F1:4E  -j REJECT
ip6tables -I forwarding_rule -m mac --mac-source D2:9E:8D:1B:F1:4E -j REJECT
```

然后重启防火墙


### 6）关于 MITM

#### 应用条件：

1. MITM 基于 AnyProxy 的规则实现，客户端设备必须要安装 AnyProxy 的证书。
2. 服务需要根据 ip 反查 mac 地址，需要代理服务工作在对子网有扫描权限的节点，最好是部署在 openwrt 网关，可以`arp -a`看下是否可以扫描完全。
3. 服务会自动更新路由表，每 2 个小时更新一次，对于新入网的设备，最好在后台手动刷新并重启代理，以免拦截规则不能立即生效。
4. 所有规则都在 HTTP 代理中生效，Socks5 on tls 是指向 AnyProxy 的反向代理，内网 Mac 地址的拦截只对直接绑定 HTTP 代理的情况生效。

#### Youtube 去广告

一共六条拦截规则，这几条 reject 规则直接配置在后台里：

- *youtube.com*：`^https?:\/\/(www|s)\.youtube\.com\/(pagead|ptracking)`
- *youtube.com*：`^https?:\/\/s\.youtube\.com\/api\/stats\/qoe\?adcontext`
- *youtube.com*：`^https?:\/\/(www|s)\.youtube\.com\/api\/stats\/ads`
- *googlevideo.com*：`^https?:\/\/[\w-]+\.googlevideo\.com\/(?!(dclk_video_ads|videoplayback\?)).+&oad`

另外两条规则在这里：<https://github.com/jayli/block-proxy/blob/main/proxy/mitm/rule.js>（手工添加上面四条规则就够了）

#### 有道词典会员

done！

#### 代理性能

**并发测试**：

|直连测试     |代理测试     |
|:---------:|:----------------:|
|<img height="500" alt="image" src="https://github.com/user-attachments/assets/8268bc5c-956f-4b67-89c1-cdd5725114b3" />  | <img height="500" alt="image" src="https://github.com/user-attachments/assets/abf4bfa1-c8b8-4907-ba0e-bcc76e8899fa" />|

**网速测试**：

<img width="544" alt="image" src="https://github.com/user-attachments/assets/67c61e34-67ae-4345-97ca-d266cd35ddf4" />

> ⚠️ 提示：如果把 block-proxy 部署在 openwrt 网关上，代理地址和网关地址一致，iOS Safari 有一个默认安全限制，不支持带认证的代理和网关 IP 一致，两个解决办法：
>
>1. 不要填代理认证用户名和密码
>2. 给 openwrt lan 口再绑定一个 IP，ios 设备在局域网内绑定这个 IP
>
><img width="300" alt="image" src="https://github.com/user-attachments/assets/0f46d6b4-00b1-44aa-9be7-fa23a09bb199" />

### 7）客户端软件

提供了客户端桌面端连接代理工具 SocksClient.app，支持 MacOS（M系列），直接运行 `client/dist/SocksClient.app`。

### License

MIT
