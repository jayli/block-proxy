# BlockProxyClient macOS 桌面客户端设计

## 概述

BlockProxyClient 是一个 macOS 状态栏应用，用于连接 block-proxy 服务端的 SOCKS5 over TLS 代理服务。通过 xray-core 作为本地转发核心，提供本地 SOCKS5 和 HTTP 代理端口，并可选自动设置系统全局代理。

## 技术选型

| 层次 | 技术 | 理由 |
|------|------|------|
| UI 框架 | Python + rumps | 极简 macOS 状态栏库，几十行代码即可实现菜单+窗口 |
| 转发核心 | xray-core | 成熟稳定，原生支持 SOCKS5 over TLS、本地 SOCKS/HTTP inbound、UDP |
| 系统代理 | networksetup CLI | macOS 原生命令，无需额外依赖 |
| 配置窗口 | tkinter | 多字段表单需要完整窗口控件（rumps.Window 仅支持单行输入） |
| 打包 | py2app | 打包为 .app，内嵌 xray-core 二进制 |

## 目录结构

```
client/
├── main.py              # 入口，启动 rumps 状态栏应用
├── app.py               # BlockProxyClient 主类（rumps.App 子类）
├── config.py            # 节点配置管理（读写 JSON）
├── xray_manager.py      # xray-core 进程管理（启动/停止/生成配置）
├── system_proxy.py      # macOS 系统代理设置（networksetup 封装）
├── resources/
│   ├── icon.png         # 状态栏图标（已连接）
│   ├── icon_off.png     # 状态栏图标（未连接）
│   └── xray-core        # 内嵌的 xray-core 二进制（开发阶段可从 PATH 获取）
├── requirements.txt     # rumps, py2app
└── setup.py             # py2app 打包配置
```

## UI 设计

### 状态栏菜单

```
[图标] BlockProxyClient
├── ● 开启代理  /  ○ 关闭代理    （点击切换状态）
├── 节点配置...                   （打开配置窗口）
├── ─────────────
├── ◉ 全局代理                    （自动设置系统 SOCKS/HTTP 代理）
├── ○ 手动模式                    （仅启动本地监听，不修改系统设置）
├── ─────────────
└── 退出
```

### 状态栏图标

- 未连接：灰色图标
- 已连接：黑色/彩色图标

### 节点配置窗口

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| 地址 | 文本输入 | 空 | 服务器 IP 或域名 |
| 端口 | 数字输入 | 8002 | 服务端 SOCKS5 over TLS 端口 |
| 用户名 | 文本输入 | 空 | SOCKS5 认证用户名 |
| 密码 | 密码输入 | 空 | SOCKS5 认证密码 |
| 启用 TLS | 复选框 | 开启 | 是否使用 TLS 加密连接 |
| allowInsecure | 下拉 | true | 是否允许不安全证书（自签证书需设为 true） |
| 本地 SOCKS 监听端口 | 数字输入 | 1080 | 本地 SOCKS5 代理端口 |
| 本地 HTTP 监听端口 | 数字输入 | 1087 | 本地 HTTP 代理端口 |
| 启用 UDP | 复选框 | 开启 | 是否启用 UDP 转发 |

## 核心模块设计

### config.py - 配置管理

配置文件位置：`~/Library/Application Support/BlockProxyClient/config.json`

```json
{
  "server": {
    "address": "",
    "port": 8002,
    "username": "",
    "password": "",
    "tls": true,
    "allowInsecure": true
  },
  "local": {
    "socks_port": 1080,
    "http_port": 1087,
    "udp": true
  },
  "mode": "global"
}
```

功能：
- 读取/保存配置到 JSON 文件
- 配置变更后通知其他模块（用于重启 xray）
- 首次运行创建默认配置

### xray_manager.py - xray-core 进程管理

职责：
1. 根据用户配置生成 xray JSON 配置文件
2. 启动/停止 xray-core 子进程
3. 监控进程状态（意外退出时通知 UI）

生成的 xray 配置结构：

```json
{
  "inbounds": [
    {
      "tag": "socks-in",
      "port": "<local.socks_port>",
      "listen": "127.0.0.1",
      "protocol": "socks",
      "settings": { "udp": "<local.udp>" }
    },
    {
      "tag": "http-in",
      "port": "<local.http_port>",
      "listen": "127.0.0.1",
      "protocol": "http"
    }
  ],
  "outbounds": [
    {
      "protocol": "socks",
      "settings": {
        "servers": [{
          "address": "<server.address>",
          "port": "<server.port>",
          "users": [{ "user": "<server.username>", "pass": "<server.password>" }]
        }]
      },
      "streamSettings": {
        "network": "tcp",
        "security": "<tls|none>",
        "tlsSettings": {
          "allowInsecure": "<server.allowInsecure>",
          "serverName": "<server.address>"
        }
      }
    }
  ]
}
```

进程管理：
- 启动：`subprocess.Popen([xray_path, "run", "-c", config_path], stdout=PIPE, stderr=PIPE)`
- 停止：`process.terminate()` → 等待 3 秒 → `process.kill()`
- xray-core 路径：开发时从 PATH 查找，打包后从 .app bundle Resources 目录读取
- 健康检查：后台线程定期 poll 进程状态

### system_proxy.py - macOS 系统代理

通过 `networksetup` 命令操作：

开启全局代理：
```bash
# 自动检测活跃网络接口（Wi-Fi / Ethernet / etc.）
networksetup -setsocksfirewallproxy "<interface>" 127.0.0.1 <socks_port>
networksetup -setsocksfirewallproxystate "<interface>" on
networksetup -setwebproxy "<interface>" 127.0.0.1 <http_port>
networksetup -setwebproxystate "<interface>" on
networksetup -setsecurewebproxy "<interface>" 127.0.0.1 <http_port>
networksetup -setsecurewebproxystate "<interface>" on
```

关闭全局代理：
```bash
networksetup -setsocksfirewallproxystate "<interface>" off
networksetup -setwebproxystate "<interface>" off
networksetup -setsecurewebproxystate "<interface>" off
```

安全机制：
- `atexit` 注册清除代理的回调，防止程序崩溃后代理残留
- 信号处理（SIGTERM, SIGINT）也清除代理

网络接口检测：
- 通过 `networksetup -listallnetworkservices` 获取所有接口
- 通过 `networksetup -getinfo <interface>` 判断哪些接口活跃
- 对所有活跃接口设置代理

### app.py - 主应用

rumps.App 子类，负责：
1. 状态栏菜单渲染和事件处理
2. 协调 config / xray_manager / system_proxy 三个模块
3. 维护全局状态（是否已连接、当前模式）

状态机：
```
初始 → [用户点击开启] → 读取配置 → 生成 xray config → 启动 xray → (全局代理模式?) → 设置系统代理 → 已连接
已连接 → [用户点击关闭] → 清除系统代理 → 停止 xray → 未连接
已连接 → [切换模式] → 设置/清除系统代理（xray 不重启）
已连接 → [xray 意外退出] → 清除系统代理 → 更新 UI 为未连接
```

## 打包与分发

### py2app 配置

```python
# setup.py
from setuptools import setup

APP = ['main.py']
DATA_FILES = [('resources', ['resources/xray-core', 'resources/icon.png', 'resources/icon_off.png'])]
OPTIONS = {
    'argv_emulation': False,
    'iconfile': 'resources/app_icon.icns',
    'plist': {
        'LSUIElement': True,
        'CFBundleName': 'BlockProxyClient',
        'CFBundleIdentifier': 'com.jaylli.blockproxyclient',
    },
    'packages': ['rumps'],
}

setup(
    app=APP,
    data_files=DATA_FILES,
    options={'py2app': OPTIONS},
    setup_requires=['py2app'],
)
```

- `LSUIElement: True`：无 Dock 图标，仅状态栏显示
- xray-core 二进制内嵌在 .app/Contents/Resources/ 中
- 构建命令：`python setup.py py2app`

### xray-core 获取

开发阶段：
- 从 xray-core GitHub Releases 下载对应平台二进制
- 放入 `client/resources/xray-core`
- 确保有执行权限

## 依赖清单

```
# requirements.txt
rumps>=0.4.0
py2app>=0.28
```

运行时无其他 Python 依赖（xray-core 是独立二进制）。

## 与服务端的协议兼容性

客户端通过 xray-core 的 SOCKS outbound + TLS streamSettings 连接服务端，协议流程：

```
本地应用 → 本地 SOCKS5/HTTP (xray inbound)
         → xray outbound: TLS 握手 → SOCKS5 认证 (username/password)
         → SOCKS5 CONNECT/UDP ASSOCIATE
         → 服务端 (socks5/server.js) → 下游 HTTP 代理 → 目标
```

兼容性要点：
- 服务端使用自签证书 → 客户端 `allowInsecure: true`
- 服务端认证方式：SOCKS5 username/password (RFC 1929)
- 服务端支持 TCP CONNECT 和 UDP ASSOCIATE
- TLS 最低版本：TLSv1.2（服务端设定）
