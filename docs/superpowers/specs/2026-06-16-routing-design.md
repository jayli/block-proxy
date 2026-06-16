# 客户端出站分流功能设计

**日期**: 2026-06-16
**状态**: 已批准
**范围**: macOS 客户端 (`/client/`)

## 概述

为 macOS 状态栏代理客户端增加出站分流功能。基于 Xray/V2Ray 兼容的 geodata 文件（geoip.dat / geosite.dat），按域名和 IP 地理位置决定流量走代理还是直连。

## 架构

### 新增模块

| 模块 | 职责 |
|---|---|
| `geodata_loader.py` | 解析 Xray protobuf 格式的 geodata 文件，构建内存中的匹配结构 |
| `routing.py` | 路由引擎，按规则匹配域名/IP，返回 `direct` 或 `proxy` |
| `routing_window.py` | tkinter 子进程窗口，管理分流规则配置 |

### 修改模块

| 模块 | 变更 |
|---|---|
| `app.py` | 在"查看日志"上方增加"分流规则..."菜单项 |
| `config.py` | `DEFAULT_CONFIG` 增加 `routing` 字段 |
| `proxy_core.py` | 建立上游连接前调用路由引擎判断走代理还是直连 |

### 数据流

```
目标域名/IP → routing.resolve()
  → 检查直连规则（geosite/geoip 匹配）→ 命中 → 直连目标（asyncio.open_connection）
  → 检查代理规则 → 命中 → 走上游 SOCKS5/HTTP 代理
  → 未命中 → 默认规则（proxy 或 direct）
```

## Geodata 解析

### Protobuf Schema（Xray 格式）

```protobuf
// geoip.dat
message CIDR {
  bytes ip = 1;
  uint32 prefix = 2;
}
message GeoIP {
  string country_code = 1;
  repeated CIDR cidr = 2;
}
message GeoIPList {
  repeated GeoIP entry = 1;
}

// geosite.dat
message Domain {
  enum Type { Plain = 0; Regex = 1; Domain = 2; Full = 3; }
  Type type = 1;
  string value = 2;
}
message GeoSite {
  string country_code = 1;
  repeated Domain domain = 2;
}
message GeoSiteList {
  repeated GeoSite entry = 1;
}
```

### 解析策略

- **懒加载**：首次路由匹配时解析，之后缓存到模块级变量
- **geosite** → `{tag: [DomainRule]}` 字典，key 为小写 country_code
- **geoip** → `{code: [IPv4Network/IPv6Network]}` 字典
- geodata 文件路径通过 `_bundle_resource_dir()` 定位（与 icons 相同的路径逻辑）
- 源文件位于 `client/geodata/`，构建时打包进 .app bundle

### geodata 文件来源

- 打包在 .app bundle 内（`build.sh` 使用 `--include-data-dir` 复制）
- 用户不可自定义路径

## 路由引擎

### 规则语法

```
geosite:cn       # 匹配中国域名（域名后缀匹配 geosite cn 列表）
geosite:!cn      # 匹配非中国域名（取反）
geoip:cn         # 匹配中国 IP（CIDR 匹配）
geoip:!cn        # 匹配非中国 IP（取反）
```

每行一条规则，空行和 `#` 开头的注释行被忽略。

### 匹配算法

```python
def resolve(host: str, is_domain: bool) -> str:
    # 1. 检查直连规则（优先级最高，覆盖代理）
    if _match_any(direct_rules, host, is_domain):
        return "direct"
    # 2. 检查代理规则
    if _match_any(proxy_rules, host, is_domain):
        return "proxy"
    # 3. 默认规则
    return default_action  # "proxy" 或 "direct"
```

### 域名匹配逻辑（geosite）

| Domain Type | 含义 | 匹配方式 |
|---|---|---|
| `Domain` (type=2) | 域名后缀 | `baidu.com` 匹配 `baidu.com`、`www.baidu.com`、`a.b.baidu.com` |
| `Full` (type=3) | 精确匹配 | `baidu.com` 只匹配 `baidu.com` |
| `Regex` (type=1) | 正则匹配 | 正则表达式匹配完整域名 |
| `Plain` (type=0) | 子串包含 | 域名中包含该子串 |

- 当 `is_domain=True` 时进行 geosite 匹配
- 当 `is_domain=False`（纯 IP 地址）时跳过 geosite 规则

### IP 匹配逻辑（geoip）

- 使用 `ipaddress` 模块
- 检查目标 IP 是否落在某个国家 code 的任何 CIDR 范围内
- 当 `is_domain=True` 时，不做 DNS 解析，跳过 geoip 规则（只匹配 geosite）
- 当 `is_domain=False` 时，进行 geoip 匹配

### 取反逻辑

`geosite:!cn` / `geoip:!cn` 表示对匹配结果取反：
- `geosite:!cn`：域名不在 cn 列表中 → 匹配
- `geoip:!cn`：IP 不在 cn CIDR 中 → 匹配

### proxy_core.py 集成

在以下位置插入路由判断：

1. **SOCKS5 CONNECT**（`_do_handle_socks`）：解析目标地址后，调用 `routing.resolve(host, is_domain)`
   - `"direct"` → `asyncio.open_connection(host, port)` 直连目标
   - `"proxy"` → 走现有的 `connect_upstream_socks5()` / `connect_upstream_http()`

2. **HTTP CONNECT**（`_do_handle_http`）：同上，解析 CONNECT 目标地址后判断

3. **HTTP 普通请求**（GET/POST 等）：从 URL 中提取 host，判断后决定直连或转发

4. **routing 未启用时**（`routing.enabled == False`）：跳过路由判断，所有流量走代理（现有行为不变）

## 配置存储

### config.json 新增字段

```json
{
  "server": { ... },
  "local": { ... },
  "mode": "global",
  "routing": {
    "enabled": false,
    "direct_rules": ["geosite:cn", "geoip:cn"],
    "proxy_rules": [],
    "default": "proxy"
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `routing.enabled` | bool | 总开关，关闭时所有流量走代理 |
| `routing.direct_rules` | list[str] | 直连规则列表，优先级高于代理规则 |
| `routing.proxy_rules` | list[str] | 代理规则列表 |
| `routing.default` | str | 未命中时的默认动作：`"proxy"` 或 `"direct"` |

### Config 兼容性

- 旧配置（无 `routing` 字段）：`config.py` 加载时自动填充默认值
- `routing.enabled` 默认 `false`，确保升级后行为不变

## UI 设计

### routing_window.py

**窗口规格**：400×450 像素，不可调整大小

**布局**：
```
┌─────────────────────────────────┐
│  [直连规则] [代理规则]  ← ttk.Notebook Tab    │
│                                 │
│  ┌───────────────────────────┐  │
│  │ geosite:cn                │  │
│  │ geoip:cn                  │  │
│  │                           │  │
│  │  （tk.Text 多行文本框）     │  │
│  │                           │  │
│  └───────────────────────────┘  │
│                                 │
│  默认规则: [代理 ▼]  ← ttk.Combobox          │
│                                 │
│  ☐ 启用分流规则  ← ttk.Checkbutton            │
│                                 │
│          [保存]  ← ttk.Button   │
└─────────────────────────────────┘
```

**行为**：
- 启动方式：与 config_window.py 相同，作为独立子进程启动，传入 config_path
- 使用 `_bundle_resource_dir()` 定位自身路径
- 使用 `_find_python()` 查找系统 Python
- macOS `NSApplicationActivationPolicyAccessory` 隐藏 Dock 图标
- 窗口居中（鼠标所在屏幕）
- 保存时将规则写回 config.json 的 `routing` 字段，然后 `root.destroy()`
- 空行和 `#` 注释行在保存时过滤掉

### app.py 菜单变更

在 `_build_menu()` 中，"查看日志"上方增加"分流规则..."：

```
启动/关闭代理
Socks/HTTP 节点配置...
分流规则...        ← 新增
──────────
全局代理（设置系统代理）
手动模式（关闭系统代理）
──────────
查看日志...
关于
──────────
退出
```

**窗口生命周期**：
- 点击"分流规则..."：先 `config.save()`，启动 routing_window.py 子进程
- 后台线程等待子进程退出
- 重载 config，对比 `routing` 部分
- 如果 routing 配置变化且代理正在运行，disconnect + reconnect 使新规则生效

## 构建变更

### build.sh

添加 geodata 目录到 Nuitka 构建参数：
```bash
--include-data-dir=geodata=geodata
```

### requirements.txt

新增依赖：
```
protobuf>=4.0
```

## 测试策略

### geodata_loader 测试

- 使用小型测试用 .dat 文件（手工构造 protobuf）
- 验证 geosite 解析：tag → domain rules 映射正确
- 验证 geoip 解析：code → CIDR 列表正确
- 验证缓存机制：第二次调用不重新解析

### routing 测试

- 验证规则解析：`geosite:cn`、`geosite:!cn`、`geoip:cn`、`geoip:!cn`
- 验证域名匹配：后缀、精确、正则、子串
- 验证 IP 匹配：CIDR 范围
- 验证取反逻辑
- 验证优先级：直连 > 代理 > 默认
- 验证 routing 未启用时跳过匹配

### routing_window 测试

- 验证 config.json 读写：规则列表、enabled 状态、默认规则
- 验证空行和注释行过滤

### proxy_core 集成测试

- mock routing.resolve()，验证 "direct" 时直连目标、"proxy" 时走上游
- 验证 routing 未启用时行为不变

## 边界情况

- geodata 文件不存在：routing 自动禁用，所有流量走代理，日志记录警告
- 规则格式错误（如 `geosite:`、`geoip:`）：跳过该行，日志记录警告
- 纯 IP 目标（如 SOCKS5 连接 IP 地址）：跳过 geosite 规则，只做 geoip 匹配
- 纯域名目标：跳过 geoip 规则，只做 geosite 匹配（不做 DNS 解析）
- 规则为空列表：等价于只有默认规则生效
