# Client Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add access logging and crash logging to the macOS SocksClient, with a log viewer window accessible from the menu bar.

**Architecture:** A new `logger.py` module initializes two independent loggers (access + crash) with `RotatingFileHandler`. Crash capture uses `faulthandler` + `sys.excepthook` + `threading.excepthook`. A tkinter-based `log_window.py` runs as a subprocess for viewing logs.

**Tech Stack:** Python standard library (`logging`, `logging.handlers`, `faulthandler`, `tkinter`), no new dependencies.

---

## File Structure

| File | Role |
|------|------|
| `client/logger.py` | New — initializes access_logger, crash_logger, faulthandler, excepthooks |
| `client/main.py` | Modify — call `setup_logging()` after lock |
| `client/proxy_core.py` | Modify — add access log at connection points, crash log for unexpected exceptions |
| `client/log_window.py` | New — tkinter log viewer window (subprocess) |
| `client/app.py` | Modify — add "查看日志..." menu item |
| `client/build.sh` | Modify — include `log_window.py` in Nuitka build |
| `client/tests/test_logger.py` | New — tests for logger module |

---

### Task 1: Create `logger.py` module

**Files:**
- Create: `client/logger.py`
- Test: `client/tests/test_logger.py`

- [ ] **Step 1: Write the failing test for setup_logging**

Create `client/tests/test_logger.py`:

```python
import os
import sys
import tempfile
import logging

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


class TestSetupLogging:
    def setup_method(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.log_dir = os.path.join(self.tmp_dir, "logs")

    def test_creates_log_directory(self):
        from logger import setup_logging
        setup_logging(log_dir=self.log_dir)
        assert os.path.isdir(self.log_dir)

    def test_creates_access_log_file(self):
        from logger import setup_logging
        setup_logging(log_dir=self.log_dir)
        from logger import access_logger
        access_logger.info("test")
        assert os.path.exists(os.path.join(self.log_dir, "access.log"))

    def test_creates_crash_log_file(self):
        from logger import setup_logging
        setup_logging(log_dir=self.log_dir)
        from logger import crash_logger
        crash_logger.critical("test crash")
        assert os.path.exists(os.path.join(self.log_dir, "crash.log"))

    def test_access_logger_format(self):
        from logger import setup_logging
        setup_logging(log_dir=self.log_dir)
        from logger import access_logger
        access_logger.info("CONNECT | google.com:443 | proxy | ok")
        log_path = os.path.join(self.log_dir, "access.log")
        with open(log_path) as f:
            line = f.readline()
        assert "CONNECT | google.com:443 | proxy | ok" in line
        # timestamp format: YYYY-MM-DD HH:MM:SS
        assert line[4] == "-" and line[10] == " " and line[13] == ":"

    def test_excepthook_installed(self):
        from logger import setup_logging
        setup_logging(log_dir=self.log_dir)
        assert sys.excepthook != sys.__excepthook__
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && pytest tests/test_logger.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'logger'` or `ImportError`

- [ ] **Step 3: Implement `logger.py`**

Create `client/logger.py`:

```python
import faulthandler
import logging
import logging.handlers
import os
import sys
import threading

DEFAULT_LOG_DIR = os.path.expanduser(
    "~/Library/Application Support/SocksClient/logs"
)

MAX_BYTES = 3 * 1024 * 1024  # 3MB
BACKUP_COUNT = 10

access_logger = logging.getLogger("socksclient.access")
crash_logger = logging.getLogger("socksclient.crash")

_crash_file = None


def setup_logging(log_dir=None):
    global _crash_file

    if log_dir is None:
        log_dir = DEFAULT_LOG_DIR
    os.makedirs(log_dir, exist_ok=True)

    # Access logger
    access_handler = logging.handlers.RotatingFileHandler(
        os.path.join(log_dir, "access.log"),
        maxBytes=MAX_BYTES,
        backupCount=BACKUP_COUNT,
        encoding="utf-8",
    )
    access_handler.setFormatter(
        logging.Formatter("%(asctime)s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    )
    access_logger.addHandler(access_handler)
    access_logger.setLevel(logging.INFO)

    # Crash logger
    crash_handler = logging.handlers.RotatingFileHandler(
        os.path.join(log_dir, "crash.log"),
        maxBytes=MAX_BYTES,
        backupCount=BACKUP_COUNT,
        encoding="utf-8",
    )
    crash_handler.setFormatter(
        logging.Formatter("%(asctime)s | %(levelname)s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    )
    crash_logger.addHandler(crash_handler)
    crash_logger.setLevel(logging.WARNING)

    # faulthandler — writes C-level tracebacks directly to crash.log fd
    crash_log_path = os.path.join(log_dir, "crash.log")
    _crash_file = open(crash_log_path, "a")
    faulthandler.enable(file=_crash_file)

    # sys.excepthook — uncaught Python exceptions
    def _excepthook(exc_type, exc_value, exc_tb):
        crash_logger.critical("Uncaught exception", exc_info=(exc_type, exc_value, exc_tb))
        sys.__excepthook__(exc_type, exc_value, exc_tb)

    sys.excepthook = _excepthook

    # threading.excepthook — uncaught exceptions in threads
    def _thread_excepthook(args):
        if args.exc_type is SystemExit:
            return
        thread_name = args.thread.name if args.thread else "unknown"
        crash_logger.critical(
            f"Thread '{thread_name}' crashed",
            exc_info=(args.exc_type, args.exc_value, args.exc_tb),
        )

    threading.excepthook = _thread_excepthook
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && pytest tests/test_logger.py -v`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add client/logger.py client/tests/test_logger.py
git commit -m "feat(client): add logger module with access and crash logging"
```

---

### Task 2: Integrate logging into `main.py`

**Files:**
- Modify: `client/main.py`

- [ ] **Step 1: Modify `main.py` to call `setup_logging()`**

Change `client/main.py` to:

```python
import os
import sys
import fcntl

LOCK_PATH = os.path.expanduser("~/Library/Application Support/SocksClient/.lock")


def acquire_lock():
    os.makedirs(os.path.dirname(LOCK_PATH), exist_ok=True)
    fp = open(LOCK_PATH, "w")
    try:
        fcntl.flock(fp, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.exit(0)
    fp.write(str(os.getpid()))
    fp.flush()
    return fp


def main():
    lock = acquire_lock()
    from logger import setup_logging
    setup_logging()
    from app import SocksClient
    client = SocksClient()
    client.run()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Verify manually that import works**

Run: `cd client && python -c "from logger import setup_logging; print('ok')"`
Expected: prints `ok`

- [ ] **Step 3: Commit**

```bash
git add client/main.py
git commit -m "feat(client): initialize logging on startup"
```

---

### Task 3: Add access logging to `proxy_core.py`

**Files:**
- Modify: `client/proxy_core.py`

- [ ] **Step 1: Add access log imports and helper at the top of `proxy_core.py`**

After the existing `logger = logging.getLogger("proxy_core")` line (line 9), add:

```python
from logger import access_logger, crash_logger


def _log_access(dest_addr, dest_port, method, direct, ok):
    route = "direct" if direct else "proxy"
    status = "ok" if ok else "fail"
    access_logger.info(f"{method} | {dest_addr}:{dest_port} | {route} | {status}")
```

- [ ] **Step 2: Add access logging to `_do_handle_socks`**

In `_do_handle_socks`, replace the block around `_connect_target` (lines 557-569):

```python
            direct = self._should_direct(dest_addr)
            try:
                remote_reader, remote_writer = await self._connect_target(
                    dest_addr, dest_port
                )
            except Exception as e:
                _log_access(dest_addr, dest_port, "CONNECT", direct, False)
                if not isinstance(e, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
                    crash_logger.warning(f"SOCKS5 connect failed: {dest_addr}:{dest_port}", exc_info=True)
                return

            _log_access(dest_addr, dest_port, "CONNECT", direct, True)

            client_writer.write(
                b"\x05\x00\x00\x01" + b"\x00" * 4 + b"\x00\x00"
            )
            await client_writer.drain()

            await asyncio.gather(
                relay(client_reader, remote_writer),
                relay(remote_reader, client_writer),
            )
```

Also update the outer `except Exception: pass` to log unexpected errors:

```python
        except Exception as e:
            if not isinstance(e, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
                crash_logger.warning("SOCKS5 handler unexpected error", exc_info=True)
```

- [ ] **Step 3: Add access logging to `_do_handle_http` (CONNECT)**

In `_do_handle_http`, for the `CONNECT` path (around lines 695-707):

```python
                direct = self._should_direct(host)
                try:
                    remote_reader, remote_writer = await self._connect_target(
                        host, port
                    )
                except Exception as e:
                    _log_access(host, port, "CONNECT", direct, False)
                    if not isinstance(e, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
                        crash_logger.warning(f"HTTP CONNECT failed: {host}:{port}", exc_info=True)
                    return

                _log_access(host, port, "CONNECT", direct, True)

                client_writer.write(
                    b"HTTP/1.1 200 Connection Established\r\n\r\n"
                )
                await client_writer.drain()

                await asyncio.gather(
                    relay(client_reader, remote_writer),
                    relay(remote_reader, client_writer),
                )
```

- [ ] **Step 4: Add access logging to `_do_handle_http` (plain HTTP)**

For the plain HTTP path (around lines 734-748):

```python
                    direct = self._should_direct(host)
                    try:
                        remote_reader, remote_writer = await self._connect_target(
                            host, port
                        )
                    except Exception as e:
                        _log_access(host, port, method, direct, False)
                        if not isinstance(e, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
                            crash_logger.warning(f"HTTP request failed: {host}:{port}", exc_info=True)
                        return

                    _log_access(host, port, method, direct, True)

                    request_line = f"{method} {path} {parts[2]}\r\n".encode()
                    remote_writer.write(request_line)
                    for h in headers:
                        remote_writer.write(h)
                    remote_writer.write(b"\r\n")
                    await remote_writer.drain()

                    await asyncio.gather(
                        relay(remote_reader, client_writer),
                        relay(client_reader, remote_writer),
                    )
```

Also update the outer except in `_do_handle_http`:

```python
        except Exception as e:
            if not isinstance(e, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
                crash_logger.warning("HTTP handler unexpected error", exc_info=True)
```

- [ ] **Step 5: Add access logging to `_handle_udp_associate`**

After the `connect_upstream_udp_associate` call (around line 602):

```python
        try:
            remote_reader, remote_writer = await connect_upstream_udp_associate(
                self._server_config, ssl_ctx=self._ssl_ctx
            )
            _log_access("UDP-ASSOCIATE", 0, "UDP", False, True)
        except Exception as e:
            _log_access("UDP-ASSOCIATE", 0, "UDP", False, False)
            if not isinstance(e, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
                crash_logger.warning("UDP associate failed", exc_info=True)
            client_writer.write(b"\x05\x05\x00\x01" + b"\x00" * 4 + b"\x00\x00")
            await client_writer.drain()
            client_writer.close()
            return
```

- [ ] **Step 6: Run existing tests to ensure no regression**

Run: `cd client && pytest tests/ -v`
Expected: All existing tests still pass

- [ ] **Step 7: Commit**

```bash
git add client/proxy_core.py
git commit -m "feat(client): add access and crash logging to proxy handlers"
```

---

### Task 4: Create `log_window.py`

**Files:**
- Create: `client/log_window.py`

- [ ] **Step 1: Implement `log_window.py`**

Create `client/log_window.py`:

```python
import os
import sys
import tkinter as tk
from tkinter import ttk

LOG_DIR = os.path.expanduser("~/Library/Application Support/SocksClient/logs")
LINES_TO_SHOW = 100


def read_last_lines(filepath, n):
    if not os.path.exists(filepath):
        return []
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        return lines[-n:][::-1]
    except Exception:
        return []


class LogWindow:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("SocksClient 日志")
        self.root.geometry("750x500")
        self.root.minsize(600, 400)

        btn_frame = tk.Frame(self.root)
        btn_frame.pack(fill=tk.X, padx=10, pady=(10, 5))

        self.access_btn = tk.Button(
            btn_frame, text="Access", command=self.show_access, width=10
        )
        self.access_btn.pack(side=tk.LEFT, padx=(0, 5))

        self.crash_btn = tk.Button(
            btn_frame, text="Crash", command=self.show_crash, width=10
        )
        self.crash_btn.pack(side=tk.LEFT, padx=(0, 5))

        refresh_btn = tk.Button(
            btn_frame, text="刷新", command=self.refresh, width=8
        )
        refresh_btn.pack(side=tk.LEFT, padx=(0, 5))

        close_btn = tk.Button(
            btn_frame, text="关闭", command=self.root.destroy, width=8
        )
        close_btn.pack(side=tk.RIGHT)

        text_frame = tk.Frame(self.root)
        text_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=(0, 10))

        scrollbar = tk.Scrollbar(text_frame)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        self.text = tk.Text(
            text_frame,
            wrap=tk.NONE,
            yscrollcommand=scrollbar.set,
            font=("Menlo", 11),
            state=tk.DISABLED,
        )
        self.text.pack(fill=tk.BOTH, expand=True)
        scrollbar.config(command=self.text.yview)

        h_scrollbar = tk.Scrollbar(text_frame, orient=tk.HORIZONTAL, command=self.text.xview)
        h_scrollbar.pack(side=tk.BOTTOM, fill=tk.X)
        self.text.config(xscrollcommand=h_scrollbar.set)

        self.text.tag_configure("crash", foreground="red")

        self.current_tab = "access"
        self.show_access()

    def show_access(self):
        self.current_tab = "access"
        self.access_btn.config(relief=tk.SUNKEN)
        self.crash_btn.config(relief=tk.RAISED)
        lines = read_last_lines(os.path.join(LOG_DIR, "access.log"), LINES_TO_SHOW)
        self._display(lines)

    def show_crash(self):
        self.current_tab = "crash"
        self.crash_btn.config(relief=tk.SUNKEN)
        self.access_btn.config(relief=tk.RAISED)
        lines = read_last_lines(os.path.join(LOG_DIR, "crash.log"), LINES_TO_SHOW)
        self._display(lines, tag="crash")

    def refresh(self):
        if self.current_tab == "access":
            self.show_access()
        else:
            self.show_crash()

    def _display(self, lines, tag=None):
        self.text.config(state=tk.NORMAL)
        self.text.delete("1.0", tk.END)
        if not lines:
            self.text.insert(tk.END, "(暂无日志)")
        else:
            for line in lines:
                if tag:
                    self.text.insert(tk.END, line, tag)
                else:
                    self.text.insert(tk.END, line)
        self.text.config(state=tk.DISABLED)

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    LogWindow().run()
```

- [ ] **Step 2: Verify the window launches**

Run: `cd client && python log_window.py`
Expected: A tkinter window opens with "Access" tab active, showing "(暂无日志)" if no logs exist. Close it manually.

- [ ] **Step 3: Commit**

```bash
git add client/log_window.py
git commit -m "feat(client): add tkinter log viewer window"
```

---

### Task 5: Add "查看日志..." menu item in `app.py`

**Files:**
- Modify: `client/app.py`

- [ ] **Step 1: Add `log_item` to `_build_menu`**

In `app.py`, in `_build_menu` method, add the log menu item after `self.about_item`:

```python
        self.log_item = rumps.MenuItem("查看日志...", callback=self.open_log)
```

And update `self.menu` to include it before `self.about_item`:

```python
        self.menu = [
            self.toggle_item,
            self.config_item,
            None,
            self.global_item,
            self.manual_item,
            None,
            self.log_item,
            self.about_item,
            None,
            self.quit_item,
        ]
```

- [ ] **Step 2: Add `open_log` method**

Add the method to `SocksClient` class:

```python
    def open_log(self, sender):
        script_path = os.path.join(self._bundle_resource_dir(), "log_window.py")
        python_path = self._find_python() if self._is_compiled() else sys.executable
        subprocess.Popen([python_path, script_path])
```

- [ ] **Step 3: Verify the menu item works**

Run: `cd client && python main.py`
Expected: Menu bar icon appears, click it, "查看日志..." is visible between the separator and "关于". Clicking it opens the log viewer window.

- [ ] **Step 4: Commit**

```bash
git add client/app.py
git commit -m "feat(client): add log viewer menu item"
```

---

### Task 6: Update `build.sh` to include `log_window.py`

**Files:**
- Modify: `client/build.sh`

- [ ] **Step 1: Add `log_window.py` to Nuitka include**

In `build.sh`, find the line:
```
    --include-data-files=config_window.py=config_window.py \
```

Add after it:
```
    --include-data-files=log_window.py=log_window.py \
```

- [ ] **Step 2: Commit**

```bash
git add client/build.sh
git commit -m "build(client): include log_window.py in Nuitka bundle"
```

---

### Task 7: End-to-end verification

- [ ] **Step 1: Run full test suite**

Run: `cd client && pytest tests/ -v`
Expected: All tests pass (including new test_logger.py tests)

- [ ] **Step 2: Manual integration test**

Run: `cd client && python main.py`

1. Click "启动代理" (with a configured server) or just verify the app starts without errors
2. Check that `~/Library/Application Support/SocksClient/logs/` directory is created
3. If proxy connects, check `access.log` has entries
4. Click "查看日志..." — log window opens showing access records
5. Switch to "Crash" tab — shows crash entries (or empty)
6. Quit the app

- [ ] **Step 3: Verify crash logging works**

Run: `cd client && python -c "
from logger import setup_logging
setup_logging()
raise RuntimeError('test crash capture')
"`

Check: `~/Library/Application Support/SocksClient/logs/crash.log` contains the traceback.

- [ ] **Step 4: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix(client): logging integration fixups"
```
