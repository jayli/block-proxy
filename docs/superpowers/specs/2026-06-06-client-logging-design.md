# Client Logging Design

## Overview

macOS SocksClient 增加日志功能，解决闪退无法追踪和代理连接不可观测的问题。

## Requirements

1. **Access Log** — 记录每次代理连接的目标、状态、路由方式
2. **Crash Log** — 捕获所有层级的异常和致命信号
3. **性能无感知** — 使用标准库同步写入（OS 缓冲区级别）
4. **大小受控** — 单文件 3MB，保留 10 个轮转文件，总上限 30MB/类型
5. **日志查看** — 菜单中提供查看窗口，显示最近 100 条日志

## Architecture

### New Module: `client/logger.py`

初始化函数 `setup_logging()`，创建两个独立 logger：

- `access_logger` — INFO 级别，写入 `access.log`
- `crash_logger` — WARNING+ 级别，写入 `crash.log`

两者均使用 `RotatingFileHandler(maxBytes=3*1024*1024, backupCount=10)`。

### Log Directory

`~/Library/Application Support/SocksClient/logs/`

### Startup Sequence

```
main.py:
  acquire_lock()
  → setup_logging()
    → 创建日志目录
    → 配置 access_logger + RotatingFileHandler
    → 配置 crash_logger + RotatingFileHandler
    → faulthandler.enable(file=crash_file_handle)
    → sys.excepthook = _excepthook
    → threading.excepthook = _thread_excepthook
  → SocksClient().run()
```

## Access Log

### Format

```
2026-06-06 14:30:22 | CONNECT | google.com:443 | proxy | ok
2026-06-06 14:30:23 | CONNECT | 192.168.1.1:80 | direct | ok
2026-06-06 14:30:25 | CONNECT | api.example.com:443 | proxy | fail
```

Fields: `timestamp | method | host:port | direct/proxy | ok/fail`

### Recording Points (proxy_core.py)

1. `_do_handle_socks` — SOCKS5 CONNECT 建立后记录 ok，`_connect_target` 异常时记录 fail
2. `_do_handle_http` — HTTP CONNECT 和普通 HTTP 请求，同上
3. `_handle_udp_associate` — UDP 关联建立成功/失败

Only log at connection establishment, not during relay.

### Route Detection

`_should_direct(host)` 返回值决定 `direct` 或 `proxy`。

## Crash Log

### Three-Layer Capture

#### Layer 1: faulthandler (C-level fatal signals)

```python
import faulthandler
faulthandler.enable(file=crash_file_handle)
```

Captures SIGSEGV, SIGABRT etc. even when Python interpreter itself crashes.

#### Layer 2: sys.excepthook (uncaught Python exceptions)

```python
def _excepthook(exc_type, exc_value, exc_tb):
    crash_logger.critical("Uncaught exception", exc_info=(exc_type, exc_value, exc_tb))
    sys.__excepthook__(exc_type, exc_value, exc_tb)
```

#### Layer 3: threading.excepthook (thread crashes)

```python
def _thread_excepthook(args):
    crash_logger.critical(
        f"Thread '{args.thread.name}' crashed",
        exc_info=(args.exc_type, args.exc_value, args.exc_tb)
    )
```

#### Layer 4: Silent exceptions in proxy_core

Current `except Exception: pass` blocks in `_do_handle_socks` and `_do_handle_http` will log to crash_logger at WARNING level. Only unexpected exceptions are logged here — expected network errors (ConnectionResetError, BrokenPipeError, TimeoutError, OSError) are not written to crash log since connection failures are already tracked in access log as `fail`.

### Format

```
2026-06-06 14:30:22 | CRITICAL | Uncaught exception
Traceback (most recent call last):
  File "app.py", line 45, in ...
    ...
RuntimeError: something went wrong
```

## Log Viewer Window

### Menu Integration

New menu item "查看日志..." placed above "关于":

```
启动代理
Socks/HTTP 节点配置...
─────────────
全局代理（设置系统代理）
手动模式（关闭系统代理）
─────────────
查看日志...
关于
─────────────
退出
```

### Implementation: `client/log_window.py`

- Launched as independent subprocess via system Python (same pattern as `config_window.py`)
- Reads last 100 entries from each log file
- Two tabs: Access / Crash
- Reverse chronological order (newest first)
- Crash entries highlighted in red
- Read-only tkinter Text widget
- Window title: "SocksClient 日志"

### Window Layout

```
┌─ SocksClient 日志 ─────────────────────────┐
│ [Access] [Crash]        ← tab buttons       │
│┌──────────────────────────────────────────┐│
││ 2026-06-06 14:30:25 | CONNECT | api...  ││
││ 2026-06-06 14:30:23 | CONNECT | 192...  ││
││ ...                                      ││
│└──────────────────────────────────────────┘│
│                                   [关闭]   │
└────────────────────────────────────────────┘
```

## File Changes

| File | Change |
|------|--------|
| `client/logger.py` | New — logging setup, faulthandler, excepthooks |
| `client/main.py` | Add `setup_logging()` call after lock acquisition |
| `client/proxy_core.py` | Add access logging at connection points; replace silent except with crash logging |
| `client/log_window.py` | New — tkinter log viewer window |
| `client/app.py` | Add "查看日志..." menu item, launch log_window subprocess |
| `client/build.sh` | Include `log_window.py` in Nuitka build artifacts |

## Performance Considerations

- Logging only at connection establishment (not during relay)
- Standard library RotatingFileHandler writes to OS buffer (microsecond-level)
- No async queue needed — log frequency is low (one entry per connection)
- faulthandler writes directly to file descriptor (no Python overhead at crash time)

## Size Control

- Per file: 3MB max
- Backup count: 10 per type
- Total max: 2 types × 11 files × 3MB = 66MB worst case
- Rotation handled automatically by RotatingFileHandler
