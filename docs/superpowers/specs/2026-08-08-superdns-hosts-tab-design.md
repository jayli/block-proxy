# SuperDNS 窗口 Host 列表 Tab 设计

**日期**: 2026-08-08
**状态**: 已批准
**范围**: macOS 客户端 (`/client/`)

## 概述

在 `client/super_dns_window.py` 的 Super DNS 窗口中间区域增加 `NSTabView`：现有域名编辑区移入 Tab1「域名配置」，新增 Tab2「Host 列表」——读取 `/etc/hosts`，以表格（域名 / IP 两列）展示**域名精确匹配 Tab1 配置列表**的条目。通配符配置（`*.example.com`）不参与匹配。

## 架构

| 模块 | 变更 |
|---|---|
| `super_dns_control.py` | 新增 hosts 解析与过滤纯函数 |
| `super_dns_window.py` | 中间区域改为 NSTabView，新增表格 Tab |

数据流：

```
/etc/hosts
  → parse_hosts_file() → [(ip, domain), ...]
  → filter_hosts_entries(entries, configured_domains(编辑器文本))
  → NSTableView（域名 / IP 两列）
```

## 数据解析（super_dns_control.py）

### `parse_hosts_file(path) -> list[tuple[str, str]]`

- 逐行读取；跳过空行与 `#` 开头的注释行。
- 每行按空白拆分：第一个 token 为 IP，其余为域名。
- 一行多个域名拆成多条 `(ip, domain)`，域名保持原大小写展示。
- IPv4 / IPv6 均支持，不做 IP 合法性校验。
- 返回列表保持文件行序。

### `configured_domains(content) -> list[str]`

与 super-dns `loadDomains()` 同规则：

- 按 `#` 切掉行内注释；strip；转小写；过滤空行；去重。
- `*.` 开头的行视为通配符，**不加入**精确匹配集合。

### `filter_hosts_entries(entries, domains) -> list[tuple[str, str]]`

- 域名精确匹配（hosts 域名转小写后与配置域名比较）。
- 返回匹配的 `(ip, domain)` 记录，保持原顺序。

## UI（super_dns_window.py）

- 顶部状态栏（状态点 + 状态文字）与底部按钮（文档 / 保存 / 启动 / 停止）位置不变。
- 中间区域替换为 `NSTabView`（参照 `routing_window.py` 的 Tab 布局）：
  - Tab1「域名配置」：现有 `NSTextView` 编辑区原样移入。
  - Tab2「Host 列表」：
    - 顶部小工具栏：「刷新」按钮 + 条数提示（如 "共 12 条"）。
    - 表格：`NSTableView` 两列（域名 / IP），只读、斑马纹、列宽可拖；数据源 / 委托模式参照 `log_window.py` 的 `LogDataSource`。
- 刷新时机：窗口 `init` 时、切到 Tab2 时、`saveDomains_` 完成、启动 / 重启 / 停止动作完成（`_finishAction_`）后。
- 过滤依据：Tab1 编辑区**当前文本**（未保存的修改也参与过滤）。
- 每次刷新重建表格数据源并更新条数提示。

## 错误处理

- `/etc/hosts` 读取失败：Tab2 表格为空，顶部提示错误信息（如 "读取 /etc/hosts 失败: <原因>"），不弹窗。
- hosts 中无法解析的行（如只有 IP 没有域名）：静默跳过。

## 测试

在 `client/tests/test_super_dns_control.py` 新增：

- `parse_hosts_file`：注释 / 空行跳过；多域名行拆分；IPv6；保持顺序。
- `configured_domains`：行内注释、空行、去重、大小写归一、`*.` 通配符排除。
- `filter_hosts_entries`：精确匹配；大小写不敏感；通配符配置不命中 `sub.example.com`。
- 运行 `cd client && pytest tests/` 验证全部通过。

## 不做的事（YAGNI）

- 不做可排序列、编辑 hosts、区分 super-dns 管理区块。
- 通配符不做前缀匹配（用户明确选择精确匹配）。
