# Android 客户端域名分流识别设计

**日期**: 2026-07-21
**状态**: 待审阅
**范围**: Android 客户端 TUN/tun2socks 正向上行流量分流

## 背景

Android 客户端已经支持：

```text
VpnService TUN
  -> tun2socks
  -> LocalSocksServer
  -> RoutingEngine
     -> DIRECT
     -> PROXY via Forward CONNECT tunnel
```

分流规则使用 Xray geosite 格式，本地 `geosite.dat` 已内置到 APK。用户期望访问 `weibo.cn`、`ip.cn`、`www.baidu.com` 等域名时，客户端先进入 VPN 链路，再用 `geosite:cn` 判断是否走隧道代理。

当前实测现象是：启用分流并把代理列表设置为 `geosite:cn` 后，访问这些站点没有服务端访问日志。客户端日志显示请求走 DIRECT。原因不是 geosite 文件或规则匹配逻辑错误，而是普通 Android App 通常先通过系统 DNS 解析域名，再发起到目标 IP 的 TCP 连接。VPN TUN 捕获的是 IP 包，tun2socks 转给 `LocalSocksServer` 的 SOCKS5 CONNECT 目标也通常是 IP，不是原始域名。

当前关键代码边界：

- `RoutingEngine.resolve(targetHost, domain)` 已支持优先使用 `domain`，否则使用 `targetHost`。
- `DomainMappingStore` 已预留 fake IP 到 domain 的映射接口。
- `BlockProxyVpnService.establishVpnInterface()` 当前没有设置本地 DNS，注释说明 DNS 使用系统默认路径。
- `SocksSession` 当前在路由判断前只能使用 SOCKS5 CONNECT 里的 host 或 `DomainMappingStore` 里的映射。

## 目标

- 让 `geosite:cn`、`domain:example.com` 这类域名规则能尽可能识别普通 Android 浏览器和 App 的 TCP 流量。
- 保持默认策略：分流未启用时不上行代理；分流启用后按“直连白名单 -> 代理白名单 -> 默认直连”执行。
- 不影响服务端经隧道发起到客户端的 reverse CONNECT 功能。
- 不修改服务端协议，除非后续确实需要额外元数据。
- 允许少量延迟和排队，但不能因为识别逻辑导致连接池打满、连接泄漏或隧道双向流中断。

## 非目标

- 不在第一阶段支持 UDP/QUIC 分流。
- 不在第一阶段实现完整 DNS 代理、DoH/DoT 解析或 DNS 缓存策略。
- 不做 MITM 解密。
- 不尝试从 TLS 加密内容里读取 HTTP Host。
- 不保证 ECH、无 SNI TLS、非 HTTP/TLS 协议能按 geosite 匹配。

## 根因分析

`geosite` 是域名规则。它需要输入 `weibo.cn` 这样的域名。

但 Android TUN 捕获的数据通常是：

```text
App DNS: weibo.cn -> 180.213.183.41
App TCP: connect 180.213.183.41:443
VPN TUN: dst=180.213.183.41:443
tun2socks SOCKS5: CONNECT 180.213.183.41:443
RoutingEngine: matchTarget = 180.213.183.41
geosite:cn: 不匹配 IP
fallback: DIRECT
```

所以“访问的是域名”与“VPN 层能看到域名”不是一回事。TUN 层只看到 IP 包。要让域名规则生效，客户端必须补回域名来源。

## 可选方案

### 方案 A: TCP 首包嗅探 SNI/HTTP Host

在 `LocalSocksServer` 处理 SOCKS5 CONNECT 时，如果目标是 IP 且端口常见为 443/80，先向 tun2socks 返回 SOCKS5 success，让 App 继续发送首包。客户端读取并短暂缓存首包：

- TLS ClientHello: 解析 SNI 得到域名。
- HTTP 明文请求: 解析 Host 头得到域名。
- 其他流量或解析失败: 无域名，按 IP 和默认策略处理。

然后用识别出的域名调用 `RoutingEngine`：

```text
IP-only CONNECT
  -> reply SOCKS success
  -> read first payload with small timeout
  -> sniff domain from TLS SNI / HTTP Host
  -> RoutingEngine.resolve(ip, sniffedDomain)
  -> DIRECT or PROXY
  -> replay buffered first payload
```

优点：

- 改动较小，不需要接管 DNS。
- 对主流 HTTPS/HTTP 网站有效，适合先验证 `geosite:cn` 的价值。
- 不触碰 tunnel 传输协议，也不影响 reverse CONNECT。

缺点：

- 必须在没有真实上游连接时先给 tun2socks 返回 SOCKS success；如果后续真实连接失败，只能关闭 TCP 流，不能再返回 SOCKS 失败码。
- 只覆盖 TCP。QUIC/UDP 不覆盖。
- ECH、无 SNI、非 TLS/HTTP 流量无法识别。
- 如果使用 SNI 域名做代理 CONNECT，服务端解析到的 IP 可能和手机本地 DNS 得到的 IP 不完全一致。大多数网站可接受，但严格 IP 绑定或特殊 CDN 场景可能有差异。
- HTTP/2 明文升级、代理协议、私有协议需要按“不识别”处理。

### 方案 B: DNS 捕获 + fake DNS

VPN 配置本地 DNS，客户端实现本地 DNS 服务。App 查询真实域名时，本地 DNS 返回 fake IP，并写入：

```text
fake IP -> domain
```

后续 App 连接 fake IP，tun2socks 生成 CONNECT fake IP，`DomainMappingStore` 还原成 domain，`RoutingEngine` 用 domain 判断。真正连接目标时使用还原后的 domain，而不是 fake IP。

数据流：

```text
App DNS: weibo.cn -> local DNS
Local DNS: allocate 198.18.x.y, store 198.18.x.y -> weibo.cn
App TCP: connect 198.18.x.y:443
VPN TUN -> tun2socks -> LocalSocksServer
ResolvedEndpoint: 198.18.x.y -> weibo.cn
RoutingEngine: geosite:cn matches weibo.cn
DIRECT/PROXY: connect weibo.cn:443
```

优点：

- 是 TUN 透明代理下恢复域名语义的完整方案。
- 不依赖 TLS SNI，HTTP/TLS/私有 TCP 协议都可按 DNS 域名分流。
- 规则命中稳定，和 Xray 透明代理/fakeDNS 思路一致。

缺点：

- 工程复杂度明显更高。
- 需要处理 DNS UDP/TCP、缓存 TTL、fake IP 池、映射过期、IPv6/AAAA、并发、DNS 失败降级。
- 必须确保客户端自身 tunnel DNS 和 tunnel 连接不进入 VPN，避免循环。
- DNS 行为变更可能影响少数 App 的连接策略。

### 方案 C: 只做 GeoIP/IP 规则

新增 `geoip:cn` 或 CIDR 规则，对 IP 直接匹配。

优点：

- 实现最简单。
- 不需要域名恢复。

缺点：

- 无法解决 `geosite:cn`，只能换规则类型。
- IP 库大、更新频率高，CDN 归属和域名意图不一定一致。
- 用户已经明确使用 Xray geosite 域名规则，这不是主解。

## 推荐方案

推荐采用两阶段设计：

### 第一阶段: TCP 域名嗅探

先实现方案 A，作为最小可用增强：

- 如果 SOCKS5 CONNECT 本身是 `ATYP_DOMAIN`，保持现有逻辑，直接按域名分流。
- 如果 CONNECT 是 IP：
  - 对 `:443` 尝试解析 TLS ClientHello SNI。
  - 对 `:80` 尝试解析 HTTP Host。
  - 嗅探超时时间建议 300-800ms，可配置常量，默认 500ms。
  - 首包最大缓存建议 16KB，超过则停止嗅探并按无域名处理。
  - 识别失败不报错、不阻断，按默认直连。
- 代理命中时，Forward CONNECT 使用识别出的域名作为目标 host。
- 直连命中时，优先使用识别出的域名连接；如果出现明显连接失败，可在后续版本评估 fallback 到原始 IP。

第一阶段适合验证：

- `geosite:cn` 是否能让 HTTPS/HTTP 网站进入 PROXY 路径。
- 当前背压限流是否能承受浏览器发起的多连接访问。
- UI 和日志是否足够解释“为什么这条流量命中/未命中”。

### 第二阶段: fake DNS

当第一阶段确认需求成立，且用户需要更完整的透明代理行为时，再实现方案 B：

- 在 VPN 中接管 DNS。
- 实现本地 DNS server 和 fake IP 池。
- 把 `DomainMappingStore` 从预留组件变成 DNS 组件写入、SOCKS 组件读取的共享映射。
- 保留第一阶段的 SNI/HTTP Host 作为兜底或诊断来源。

## 第一阶段详细设计

### 新增组件

#### `TrafficSniffer`

职责：从客户端 TCP 流首包识别域名，同时返回被读取的原始字节，供后续 replay。

建议接口：

```kotlin
data class SniffResult(
    val domain: String?,
    val bufferedBytes: ByteArray,
    val source: SniffSource,
)

enum class SniffSource {
    TLS_SNI,
    HTTP_HOST,
    NONE,
    TIMEOUT,
    TOO_LARGE,
    UNSUPPORTED,
}

class TrafficSniffer(
    private val timeoutMs: Long = 500,
    private val maxBytes: Int = 16 * 1024,
) {
    suspend fun sniff(
        endpoint: ResolvedEndpoint,
        clientIn: InputStream,
    ): SniffResult
}
```

约束：

- 只读必要字节，不消费后丢弃。
- 任何异常都返回 `source=NONE` 或 `UNSUPPORTED`，不抛出到会话主流程。
- 不做 DNS 解析。
- 不修改 payload。
- 只解析明文 ClientHello，不涉及解密。

#### `TlsClientHelloParser`

职责：从 TLS ClientHello 中解析 SNI。

支持范围：

- TLS record content type `0x16`。
- handshake type `0x01`。
- extensions 里解析 server_name extension `0x0000`。
- 只接受合法 ASCII/IDNA hostname 字符，拒绝 IP 字符串作为 SNI。

不支持范围：

- ECH 内部真实域名。
- 分片跨多次 TCP 读取且超过缓存上限的 ClientHello。
- 非 TLS 或损坏 TLS。

#### `HttpHostParser`

职责：从 HTTP/1.x 明文请求头中解析 Host。

支持范围：

- `GET / HTTP/1.1`、`POST` 等 HTTP/1.x 请求。
- 大小写不敏感的 `Host:`。
- `host:port` 中剥离 port。

不支持范围：

- HTTPS 加密后的 Host。
- HTTP/2 prior knowledge 二进制帧。

### 修改 `SocksSession`

当前流程：

```text
parse CONNECT
-> ResolvedEndpoint
-> RoutingEngine
-> connect direct/proxy
-> reply SOCKS success
-> relay
```

第一阶段对 IP-only 请求改为：

```text
parse CONNECT
-> ResolvedEndpoint
-> if endpoint.domain == null and port in sniffable ports:
     reply SOCKS success
     sniff first payload
     route using sniffedDomain
     connect direct/proxy
     replay buffered payload
     relay remaining data
   else:
     existing flow
```

注意：

- `ATYP_DOMAIN` 请求不需要嗅探。
- 已经有 `DomainMappingStore` 映射的请求不需要嗅探。
- 只有 IP-only 且 80/443 默认进入嗅探。
- SOCKS success 提前返回后，后续 connect 失败时只能关闭连接并记录日志。
- 需要避免 relay 再次读取已缓存首包；relay 入口应支持 `initialClientBytes`。

### 路由日志

建议增加结构化日志，便于真机验证：

```text
SocksSession ROUTE original=180.213.183.41:443 domain=weibo.cn source=TLS_SNI rule=geosite:cn decision=PROXY
SocksSession ROUTE original=59.82.133.79:80 domain=ip.cn source=HTTP_HOST rule=geosite:cn decision=PROXY
SocksSession ROUTE original=1.2.3.4:443 domain=null source=TIMEOUT decision=DIRECT
```

当前 `RoutingEngine` 只返回 `RouteDecision`，不返回命中规则。为了日志清楚，第一阶段可以新增可选诊断类型：

```kotlin
data class RouteResult(
    val decision: RouteDecision,
    val matchedRule: String?,
    val matchedTarget: String,
)
```

为减少改动，也可以先保持 `RouteDecision`，日志只记录 domain/source/decision；命中规则诊断放到后续。

### 对 reverse CONNECT 的影响

第一阶段不应该影响 reverse CONNECT：

- 不改 `FrameCodec`。
- 不改服务端协议。
- 不改 `ReverseConnectHandler`。
- 不改 server-originated reqid 范围。
- 嗅探只发生在 `LocalSocksServer` 处理 Android 本机上行 TCP 的路径。

需要回归：

- 服务端通过隧道 CONNECT 到客户端内网目标仍正常。
- 客户端上行 PROXY 流量和服务端下行 reverse 流量同时存在时，`XhttpUploadScheduler` 控制/反向优先级不被破坏。

## 第二阶段详细设计

### 新增组件

#### `FakeDnsServer`

职责：

- 监听 VPN 配置的本地 DNS 地址。
- 解析 A/AAAA 查询。
- 为域名分配 fake IP。
- 写入 `DomainMappingStore`。
- 返回 DNS 响应。

建议 fake IP 范围：

- IPv4: `198.18.0.0/15`，常用于基准测试和 fake IP 场景。
- IPv6: 第二阶段初版可以先不启用 AAAA fake IP，或返回空 AAAA，避免 IPv6 复杂度扩散。

#### `FakeIpAllocator`

职责：

- 分配、复用、过期 fake IP。
- 同一域名在 TTL 内返回同一 fake IP。
- fake IP 池耗尽时回收最旧非活跃映射。

#### `DnsMessageCodec`

职责：

- 解析最小 DNS query。
- 编码 A/AAAA 响应、NXDOMAIN、SERVFAIL。
- 保留 transaction id。

### VPN 修改

第二阶段需要在 `BlockProxyVpnService.establishVpnInterface()` 中设置 DNS：

```kotlin
builder.addDnsServer("10.255.0.1")
```

同时确保：

- 本 App 自身仍 `addDisallowedApplication(packageName)`。
- tunnel OkHttp/Cronet/native upload socket 继续使用 `protect()`。
- Fake DNS server 自身如果需要上游真实 DNS 查询，socket 必须 `protect()`。

### DNS 策略

第一版 fake DNS 可以不递归查询真实 DNS，只返回 fake IP：

- 对 A 查询返回 fake IPv4。
- 对 AAAA 查询可返回空响应或后续支持 fake IPv6。
- 真正连接目标时由 direct socket 或服务端根据 domain 解析真实 IP。

这样能避免本地 DNS 代理的复杂递归逻辑，但会改变部分 App 对 IPv6/Happy Eyeballs 的行为。若实测兼容性不足，再增加真实 DNS 转发。

## 测试策略

第一阶段必须覆盖：

- TLS ClientHello SNI parser 单元测试。
- HTTP Host parser 单元测试。
- `TrafficSniffer` 缓存首包并返回 domain。
- IP-only HTTPS 请求通过 SNI 命中 `geosite:cn` 后走 PROXY。
- IP-only HTTP 请求通过 Host 命中 `domain:` 后走 PROXY。
- 嗅探失败/超时默认 DIRECT。
- `ATYP_DOMAIN` 请求保持现有路径。
- reverse CONNECT 回归测试。

第二阶段必须覆盖：

- DNS query/response 编解码。
- fake IP 分配、复用、过期、回收。
- `DomainMappingStore` fake IP 还原。
- fake IP CONNECT 不把 fake IP 传给 direct socket 或 Forward CONNECT。
- VPN DNS 配置不捕获客户端自身 tunnel 流量。

真机验证：

```bash
adb logcat -c
```

1. Android 开启隧道。
2. 开启分流。
3. 代理规则设置 `geosite:cn`。
4. 访问 `https://weibo.cn`、`https://www.baidu.com`、`http://ip.cn`。
5. 检查客户端日志是否出现 `decision=PROXY`。
6. 检查服务端是否出现对应 Forward CONNECT 访问日志。
7. 同时从服务端发起 reverse CONNECT 测试，确认双向隧道未受影响。

## 风险与边界

- SNI 嗅探会比 fake DNS 简单，但只能覆盖部分 TCP 场景。
- 提前返回 SOCKS success 会改变连接失败呈现方式：App 看到的是 TCP 关闭，而不是 SOCKS 失败。
- 使用 SNI 域名而不是原始 IP 建立代理连接，可能在少数 CDN 场景连接到不同边缘节点。
- fake DNS 是长期完整方案，但需要更多工程和真机兼容测试。
- 不应为了快速命中 geosite 而在服务端做域名猜测；服务端只能看到客户端发过来的 CONNECT 目标，客户端不传域名时服务端无法可靠恢复。

## 建议结论

先实现第一阶段 TCP 域名嗅探，作为低风险验证版本。它能解决大多数 HTTPS/HTTP 浏览器访问下 `geosite:cn` 不命中的问题，并且改动范围限制在 Android 客户端上行路径。

如果第一阶段验证后仍需要更完整的 Xray 透明代理体验，再进入第二阶段 fake DNS。当前代码已经有 `DomainMappingStore`，可以承接第二阶段，不需要推翻第一阶段。
