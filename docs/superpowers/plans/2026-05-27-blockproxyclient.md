# BlockProxyClient Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a macOS status bar application that connects to a block-proxy SOCKS5 over TLS server via xray-core, providing local SOCKS5 and HTTP proxy ports with optional system-wide proxy configuration.

**Architecture:** Python rumps app manages UI (status bar menu + tkinter config window). It generates xray-core JSON config from user settings and manages the xray-core subprocess. system_proxy module wraps macOS `networksetup` commands to toggle global proxy on/off.

**Tech Stack:** Python 3.11+, rumps (macOS status bar), tkinter (config window), xray-core (binary, subprocess), py2app (packaging)

---

## File Structure

```
client/
├── main.py              # Entry point, launches rumps app
├── app.py               # BlockProxyClient rumps.App subclass, menu logic
├── config.py            # Config read/write to ~/Library/Application Support/BlockProxyClient/config.json
├── xray_manager.py      # Generate xray config JSON, start/stop subprocess, health monitoring
├── system_proxy.py      # Detect active interfaces, set/clear macOS system proxy via networksetup
├── resources/
│   ├── icon.png         # Status bar icon (connected) - 22x22 template image
│   ├── icon_off.png     # Status bar icon (disconnected) - 22x22 template image
│   └── xray-core        # xray-core binary (downloaded separately)
├── tests/
│   ├── test_config.py
│   ├── test_xray_manager.py
│   └── test_system_proxy.py
├── requirements.txt
└── setup.py             # py2app packaging
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `client/requirements.txt`
- Create: `client/resources/.gitkeep`
- Create: `client/tests/__init__.py`

- [ ] **Step 1: Create directory structure**

```bash
cd /Users/bachi/jaylli/block-proxy
mkdir -p client/resources client/tests
```

- [ ] **Step 2: Create requirements.txt**

Create `client/requirements.txt`:
```
rumps>=0.4.0
py2app>=0.28
pytest>=7.0
```

- [ ] **Step 3: Create virtual environment and install dependencies**

```bash
cd /Users/bachi/jaylli/block-proxy/client
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

- [ ] **Step 4: Create placeholder files**

Create `client/resources/.gitkeep` (empty file).
Create `client/tests/__init__.py` (empty file).

- [ ] **Step 5: Commit**

```bash
git add client/
git commit -m "feat(client): scaffold BlockProxyClient project structure"
```

---

### Task 2: Configuration Module

**Files:**
- Create: `client/tests/test_config.py`
- Create: `client/config.py`

- [ ] **Step 1: Write failing tests for config module**

Create `client/tests/test_config.py`:
```python
import json
import os
import tempfile
import pytest
from config import Config, DEFAULT_CONFIG


class TestConfig:
    def setup_method(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.config_path = os.path.join(self.tmp_dir, "config.json")
        self.config = Config(config_path=self.config_path)

    def test_default_config_created_on_first_load(self):
        data = self.config.load()
        assert data["server"]["port"] == 8002
        assert data["server"]["tls"] is True
        assert data["server"]["allowInsecure"] is True
        assert data["local"]["socks_port"] == 1080
        assert data["local"]["http_port"] == 1087
        assert data["local"]["udp"] is True
        assert data["mode"] == "global"
        assert os.path.exists(self.config_path)

    def test_save_and_load_roundtrip(self):
        self.config.load()
        self.config.data["server"]["address"] = "10.0.0.1"
        self.config.data["server"]["port"] = 9002
        self.config.data["server"]["username"] = "user1"
        self.config.data["server"]["password"] = "pass1"
        self.config.save()

        config2 = Config(config_path=self.config_path)
        data = config2.load()
        assert data["server"]["address"] == "10.0.0.1"
        assert data["server"]["port"] == 9002
        assert data["server"]["username"] == "user1"
        assert data["server"]["password"] == "pass1"

    def test_load_existing_config(self):
        existing = {
            "server": {
                "address": "example.com",
                "port": 443,
                "username": "abc",
                "password": "def",
                "tls": False,
                "allowInsecure": False,
            },
            "local": {"socks_port": 2080, "http_port": 2087, "udp": False},
            "mode": "manual",
        }
        with open(self.config_path, "w") as f:
            json.dump(existing, f)

        data = self.config.load()
        assert data["server"]["address"] == "example.com"
        assert data["server"]["tls"] is False
        assert data["local"]["socks_port"] == 2080
        assert data["mode"] == "manual"

    def test_is_configured_false_when_no_address(self):
        self.config.load()
        assert self.config.is_configured() is False

    def test_is_configured_true_when_address_set(self):
        self.config.load()
        self.config.data["server"]["address"] = "10.0.0.1"
        assert self.config.is_configured() is True
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/bachi/jaylli/block-proxy/client
source .venv/bin/activate
python -m pytest tests/test_config.py -v
```
Expected: FAIL with `ModuleNotFoundError: No module named 'config'`

- [ ] **Step 3: Implement config.py**

Create `client/config.py`:
```python
import json
import os
import copy

DEFAULT_CONFIG = {
    "server": {
        "address": "",
        "port": 8002,
        "username": "",
        "password": "",
        "tls": True,
        "allowInsecure": True,
    },
    "local": {
        "socks_port": 1080,
        "http_port": 1087,
        "udp": True,
    },
    "mode": "global",
}

DEFAULT_CONFIG_DIR = os.path.expanduser(
    "~/Library/Application Support/BlockProxyClient"
)


class Config:
    def __init__(self, config_path=None):
        if config_path is None:
            config_path = os.path.join(DEFAULT_CONFIG_DIR, "config.json")
        self.config_path = config_path
        self.data = None

    def load(self):
        if os.path.exists(self.config_path):
            with open(self.config_path, "r") as f:
                self.data = json.load(f)
        else:
            self.data = copy.deepcopy(DEFAULT_CONFIG)
            self.save()
        return self.data

    def save(self):
        os.makedirs(os.path.dirname(self.config_path), exist_ok=True)
        with open(self.config_path, "w") as f:
            json.dump(self.data, f, indent=2)

    def is_configured(self):
        return bool(self.data and self.data["server"]["address"])
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/bachi/jaylli/block-proxy/client
source .venv/bin/activate
python -m pytest tests/test_config.py -v
```
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add client/config.py client/tests/test_config.py
git commit -m "feat(client): add configuration management module"
```

---

### Task 3: xray-core Manager Module

**Files:**
- Create: `client/tests/test_xray_manager.py`
- Create: `client/xray_manager.py`

- [ ] **Step 1: Write failing tests for xray_manager**

Create `client/tests/test_xray_manager.py`:
```python
import json
import os
import tempfile
import pytest
from unittest.mock import patch, MagicMock
from xray_manager import XrayManager


class TestXrayConfigGeneration:
    def setup_method(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.manager = XrayManager(
            xray_path="/usr/local/bin/xray",
            config_dir=self.tmp_dir,
        )

    def test_generate_config_basic(self):
        user_config = {
            "server": {
                "address": "10.0.0.1",
                "port": 8002,
                "username": "user1",
                "password": "pass1",
                "tls": True,
                "allowInsecure": True,
            },
            "local": {
                "socks_port": 1080,
                "http_port": 1087,
                "udp": True,
            },
        }
        config_path = self.manager.generate_config(user_config)

        assert os.path.exists(config_path)
        with open(config_path) as f:
            xray_config = json.load(f)

        assert len(xray_config["inbounds"]) == 2

        socks_in = xray_config["inbounds"][0]
        assert socks_in["port"] == 1080
        assert socks_in["listen"] == "127.0.0.1"
        assert socks_in["protocol"] == "socks"
        assert socks_in["settings"]["udp"] is True

        http_in = xray_config["inbounds"][1]
        assert http_in["port"] == 1087
        assert http_in["listen"] == "127.0.0.1"
        assert http_in["protocol"] == "http"

        outbound = xray_config["outbounds"][0]
        assert outbound["protocol"] == "socks"
        server = outbound["settings"]["servers"][0]
        assert server["address"] == "10.0.0.1"
        assert server["port"] == 8002
        assert server["users"][0]["user"] == "user1"
        assert server["users"][0]["pass"] == "pass1"

        stream = outbound["streamSettings"]
        assert stream["security"] == "tls"
        assert stream["tlsSettings"]["allowInsecure"] is True
        assert stream["tlsSettings"]["serverName"] == "10.0.0.1"

    def test_generate_config_no_tls(self):
        user_config = {
            "server": {
                "address": "10.0.0.1",
                "port": 8002,
                "username": "user1",
                "password": "pass1",
                "tls": False,
                "allowInsecure": True,
            },
            "local": {
                "socks_port": 1080,
                "http_port": 1087,
                "udp": False,
            },
        }
        config_path = self.manager.generate_config(user_config)

        with open(config_path) as f:
            xray_config = json.load(f)

        socks_in = xray_config["inbounds"][0]
        assert socks_in["settings"]["udp"] is False

        outbound = xray_config["outbounds"][0]
        assert "streamSettings" not in outbound

    def test_generate_config_no_auth(self):
        user_config = {
            "server": {
                "address": "10.0.0.1",
                "port": 8002,
                "username": "",
                "password": "",
                "tls": True,
                "allowInsecure": True,
            },
            "local": {
                "socks_port": 1080,
                "http_port": 1087,
                "udp": True,
            },
        }
        config_path = self.manager.generate_config(user_config)

        with open(config_path) as f:
            xray_config = json.load(f)

        outbound = xray_config["outbounds"][0]
        server = outbound["settings"]["servers"][0]
        assert "users" not in server


class TestXrayProcessManagement:
    def setup_method(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.manager = XrayManager(
            xray_path="/usr/local/bin/xray",
            config_dir=self.tmp_dir,
        )

    @patch("subprocess.Popen")
    def test_start_launches_process(self, mock_popen):
        mock_process = MagicMock()
        mock_process.poll.return_value = None
        mock_popen.return_value = mock_process

        user_config = {
            "server": {
                "address": "10.0.0.1",
                "port": 8002,
                "username": "u",
                "password": "p",
                "tls": True,
                "allowInsecure": True,
            },
            "local": {"socks_port": 1080, "http_port": 1087, "udp": True},
        }

        self.manager.start(user_config)

        mock_popen.assert_called_once()
        args = mock_popen.call_args[0][0]
        assert args[0] == "/usr/local/bin/xray"
        assert args[1] == "run"
        assert args[2] == "-c"
        assert self.manager.is_running()

    @patch("subprocess.Popen")
    def test_stop_terminates_process(self, mock_popen):
        mock_process = MagicMock()
        mock_process.poll.return_value = None
        mock_popen.return_value = mock_process

        user_config = {
            "server": {
                "address": "10.0.0.1",
                "port": 8002,
                "username": "u",
                "password": "p",
                "tls": True,
                "allowInsecure": True,
            },
            "local": {"socks_port": 1080, "http_port": 1087, "udp": True},
        }

        self.manager.start(user_config)
        self.manager.stop()

        mock_process.terminate.assert_called_once()

    def test_is_running_false_initially(self):
        assert self.manager.is_running() is False
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/bachi/jaylli/block-proxy/client
source .venv/bin/activate
python -m pytest tests/test_xray_manager.py -v
```
Expected: FAIL with `ModuleNotFoundError: No module named 'xray_manager'`

- [ ] **Step 3: Implement xray_manager.py**

Create `client/xray_manager.py`:
```python
import json
import os
import subprocess
import shutil


class XrayManager:
    def __init__(self, xray_path=None, config_dir=None):
        if xray_path is None:
            xray_path = shutil.which("xray") or "/usr/local/bin/xray"
        if config_dir is None:
            config_dir = os.path.expanduser(
                "~/Library/Application Support/BlockProxyClient"
            )
        self.xray_path = xray_path
        self.config_dir = config_dir
        self.config_file = os.path.join(config_dir, "xray_config.json")
        self.process = None

    def generate_config(self, user_config):
        server = user_config["server"]
        local = user_config["local"]

        xray_config = {
            "inbounds": [
                {
                    "tag": "socks-in",
                    "port": local["socks_port"],
                    "listen": "127.0.0.1",
                    "protocol": "socks",
                    "settings": {"udp": local["udp"]},
                },
                {
                    "tag": "http-in",
                    "port": local["http_port"],
                    "listen": "127.0.0.1",
                    "protocol": "http",
                },
            ],
            "outbounds": [self._build_outbound(server)],
        }

        os.makedirs(self.config_dir, exist_ok=True)
        with open(self.config_file, "w") as f:
            json.dump(xray_config, f, indent=2)

        return self.config_file

    def _build_outbound(self, server):
        outbound = {
            "protocol": "socks",
            "settings": {
                "servers": [self._build_server(server)],
            },
        }

        if server["tls"]:
            outbound["streamSettings"] = {
                "network": "tcp",
                "security": "tls",
                "tlsSettings": {
                    "allowInsecure": server["allowInsecure"],
                    "serverName": server["address"],
                },
            }

        return outbound

    def _build_server(self, server):
        entry = {
            "address": server["address"],
            "port": server["port"],
        }
        if server["username"] and server["password"]:
            entry["users"] = [
                {"user": server["username"], "pass": server["password"]}
            ]
        return entry

    def start(self, user_config):
        if self.is_running():
            self.stop()

        config_path = self.generate_config(user_config)
        self.process = subprocess.Popen(
            [self.xray_path, "run", "-c", config_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def stop(self):
        if self.process is None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process = None

    def is_running(self):
        if self.process is None:
            return False
        return self.process.poll() is None
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/bachi/jaylli/block-proxy/client
source .venv/bin/activate
python -m pytest tests/test_xray_manager.py -v
```
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add client/xray_manager.py client/tests/test_xray_manager.py
git commit -m "feat(client): add xray-core process manager module"
```

---

### Task 4: System Proxy Module

**Files:**
- Create: `client/tests/test_system_proxy.py`
- Create: `client/system_proxy.py`

- [ ] **Step 1: Write failing tests for system_proxy**

Create `client/tests/test_system_proxy.py`:
```python
import pytest
from unittest.mock import patch, call
from system_proxy import SystemProxy


class TestSystemProxy:
    def setup_method(self):
        self.proxy = SystemProxy()

    @patch("system_proxy.SystemProxy._get_active_interfaces")
    @patch("subprocess.run")
    def test_enable_sets_all_proxy_types(self, mock_run, mock_interfaces):
        mock_interfaces.return_value = ["Wi-Fi"]
        mock_run.return_value = None

        self.proxy.enable(socks_port=1080, http_port=1087)

        expected_calls = [
            call(["networksetup", "-setsocksfirewallproxy", "Wi-Fi", "127.0.0.1", "1080"], check=True),
            call(["networksetup", "-setsocksfirewallproxystate", "Wi-Fi", "on"], check=True),
            call(["networksetup", "-setwebproxy", "Wi-Fi", "127.0.0.1", "1087"], check=True),
            call(["networksetup", "-setwebproxystate", "Wi-Fi", "on"], check=True),
            call(["networksetup", "-setsecurewebproxy", "Wi-Fi", "127.0.0.1", "1087"], check=True),
            call(["networksetup", "-setsecurewebproxystate", "Wi-Fi", "on"], check=True),
        ]
        mock_run.assert_has_calls(expected_calls)

    @patch("system_proxy.SystemProxy._get_active_interfaces")
    @patch("subprocess.run")
    def test_disable_clears_all_proxy_types(self, mock_run, mock_interfaces):
        mock_interfaces.return_value = ["Wi-Fi"]
        mock_run.return_value = None

        self.proxy.disable()

        expected_calls = [
            call(["networksetup", "-setsocksfirewallproxystate", "Wi-Fi", "off"], check=True),
            call(["networksetup", "-setwebproxystate", "Wi-Fi", "off"], check=True),
            call(["networksetup", "-setsecurewebproxystate", "Wi-Fi", "off"], check=True),
        ]
        mock_run.assert_has_calls(expected_calls)

    @patch("system_proxy.SystemProxy._get_active_interfaces")
    @patch("subprocess.run")
    def test_enable_multiple_interfaces(self, mock_run, mock_interfaces):
        mock_interfaces.return_value = ["Wi-Fi", "Ethernet"]
        mock_run.return_value = None

        self.proxy.enable(socks_port=1080, http_port=1087)

        # 6 calls per interface × 2 interfaces = 12 calls
        assert mock_run.call_count == 12

    @patch("subprocess.run")
    def test_get_active_interfaces(self, mock_run):
        mock_run.return_value = type("Result", (), {
            "stdout": "An asterisk (*) denotes that a network service is disabled.\nWi-Fi\n*Bluetooth PAN\nEthernet\n",
            "returncode": 0,
        })()

        interfaces = self.proxy._get_active_interfaces()

        assert "Wi-Fi" in interfaces
        assert "Ethernet" in interfaces
        assert "Bluetooth PAN" not in interfaces
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/bachi/jaylli/block-proxy/client
source .venv/bin/activate
python -m pytest tests/test_system_proxy.py -v
```
Expected: FAIL with `ModuleNotFoundError: No module named 'system_proxy'`

- [ ] **Step 3: Implement system_proxy.py**

Create `client/system_proxy.py`:
```python
import subprocess
import atexit
import signal


class SystemProxy:
    def __init__(self):
        self._enabled = False
        self._interfaces = []
        atexit.register(self._cleanup)
        signal.signal(signal.SIGTERM, self._signal_handler)

    def _signal_handler(self, signum, frame):
        self._cleanup()
        raise SystemExit(0)

    def _cleanup(self):
        if self._enabled:
            self.disable()

    def _get_active_interfaces(self):
        result = subprocess.run(
            ["networksetup", "-listallnetworkservices"],
            capture_output=True,
            text=True,
        )
        interfaces = []
        for line in result.stdout.strip().split("\n"):
            if line.startswith("*") or line.startswith("An asterisk"):
                continue
            if line.strip():
                interfaces.append(line.strip())
        return interfaces

    def enable(self, socks_port, http_port):
        self._interfaces = self._get_active_interfaces()
        for iface in self._interfaces:
            subprocess.run(
                ["networksetup", "-setsocksfirewallproxy", iface, "127.0.0.1", str(socks_port)],
                check=True,
            )
            subprocess.run(
                ["networksetup", "-setsocksfirewallproxystate", iface, "on"],
                check=True,
            )
            subprocess.run(
                ["networksetup", "-setwebproxy", iface, "127.0.0.1", str(http_port)],
                check=True,
            )
            subprocess.run(
                ["networksetup", "-setwebproxystate", iface, "on"],
                check=True,
            )
            subprocess.run(
                ["networksetup", "-setsecurewebproxy", iface, "127.0.0.1", str(http_port)],
                check=True,
            )
            subprocess.run(
                ["networksetup", "-setsecurewebproxystate", iface, "on"],
                check=True,
            )
        self._enabled = True

    def disable(self):
        interfaces = self._interfaces or self._get_active_interfaces()
        for iface in interfaces:
            subprocess.run(
                ["networksetup", "-setsocksfirewallproxystate", iface, "off"],
                check=True,
            )
            subprocess.run(
                ["networksetup", "-setwebproxystate", iface, "off"],
                check=True,
            )
            subprocess.run(
                ["networksetup", "-setsecurewebproxystate", iface, "off"],
                check=True,
            )
        self._enabled = False
        self._interfaces = []
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/bachi/jaylli/block-proxy/client
source .venv/bin/activate
python -m pytest tests/test_system_proxy.py -v
```
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add client/system_proxy.py client/tests/test_system_proxy.py
git commit -m "feat(client): add macOS system proxy management module"
```

---

### Task 5: Main Application (rumps status bar)

**Files:**
- Create: `client/app.py`
- Create: `client/main.py`

- [ ] **Step 1: Implement app.py**

Create `client/app.py`:
```python
import os
import threading
import rumps
from config import Config
from xray_manager import XrayManager
from system_proxy import SystemProxy


class BlockProxyClient(rumps.App):
    def __init__(self):
        super().__init__("BlockProxyClient", quit_button=None)

        self.config = Config()
        self.config.load()
        self.xray = XrayManager()
        self.sys_proxy = SystemProxy()
        self.connected = False

        self._build_menu()
        self._update_icon()
        self._start_health_check()

    def _build_menu(self):
        self.toggle_item = rumps.MenuItem("开启代理", callback=self.toggle_proxy)
        self.config_item = rumps.MenuItem("节点配置...", callback=self.open_config)

        self.global_item = rumps.MenuItem("全局代理", callback=self.set_global_mode)
        self.manual_item = rumps.MenuItem("手动模式", callback=self.set_manual_mode)

        self.quit_item = rumps.MenuItem("退出", callback=self.quit_app)

        self.menu = [
            self.toggle_item,
            self.config_item,
            None,
            self.global_item,
            self.manual_item,
            None,
            self.quit_item,
        ]

        self._update_mode_menu()

    def _update_mode_menu(self):
        is_global = self.config.data["mode"] == "global"
        self.global_item.state = 1 if is_global else 0
        self.manual_item.state = 1 if not is_global else 0

    def _update_icon(self):
        icon_name = "icon.png" if self.connected else "icon_off.png"
        icon_path = os.path.join(self._resource_dir(), icon_name)
        if os.path.exists(icon_path):
            self.icon = icon_path

    def _resource_dir(self):
        app_dir = os.path.dirname(os.path.abspath(__file__))
        return os.path.join(app_dir, "resources")

    def toggle_proxy(self, sender):
        if self.connected:
            self._disconnect()
        else:
            self._connect()

    def _connect(self):
        if not self.config.is_configured():
            rumps.alert("请先配置节点信息")
            return

        self.xray.start(self.config.data)
        if self.config.data["mode"] == "global":
            self.sys_proxy.enable(
                socks_port=self.config.data["local"]["socks_port"],
                http_port=self.config.data["local"]["http_port"],
            )
        self.connected = True
        self.toggle_item.title = "关闭代理"
        self._update_icon()

    def _disconnect(self):
        self.sys_proxy.disable()
        self.xray.stop()
        self.connected = False
        self.toggle_item.title = "开启代理"
        self._update_icon()

    def open_config(self, sender):
        self._show_config_window()

    def _show_config_window(self):
        import tkinter as tk
        from tkinter import ttk

        def save_and_close():
            self.config.data["server"]["address"] = entries["address"].get()
            self.config.data["server"]["port"] = int(entries["port"].get())
            self.config.data["server"]["username"] = entries["username"].get()
            self.config.data["server"]["password"] = entries["password"].get()
            self.config.data["server"]["tls"] = tls_var.get()
            self.config.data["server"]["allowInsecure"] = insecure_var.get() == "true"
            self.config.data["local"]["socks_port"] = int(entries["socks_port"].get())
            self.config.data["local"]["http_port"] = int(entries["http_port"].get())
            self.config.data["local"]["udp"] = udp_var.get()
            self.config.save()
            root.destroy()

        root = tk.Tk()
        root.title("节点配置")
        root.geometry("400x380")
        root.resizable(False, False)

        frame = ttk.Frame(root, padding=20)
        frame.pack(fill="both", expand=True)

        entries = {}
        fields = [
            ("address", "地址:", self.config.data["server"]["address"]),
            ("port", "端口:", str(self.config.data["server"]["port"])),
            ("username", "用户名:", self.config.data["server"]["username"]),
            ("password", "密码:", self.config.data["server"]["password"]),
            ("socks_port", "本地SOCKS端口:", str(self.config.data["local"]["socks_port"])),
            ("http_port", "本地HTTP端口:", str(self.config.data["local"]["http_port"])),
        ]

        for i, (key, label, default) in enumerate(fields):
            ttk.Label(frame, text=label).grid(row=i, column=0, sticky="w", pady=4)
            entry = ttk.Entry(frame, width=30)
            if key == "password":
                entry.config(show="*")
            entry.insert(0, default)
            entry.grid(row=i, column=1, sticky="w", pady=4)
            entries[key] = entry

        row = len(fields)

        tls_var = tk.BooleanVar(value=self.config.data["server"]["tls"])
        ttk.Checkbutton(frame, text="启用 TLS", variable=tls_var).grid(
            row=row, column=0, columnspan=2, sticky="w", pady=4
        )
        row += 1

        ttk.Label(frame, text="allowInsecure:").grid(row=row, column=0, sticky="w", pady=4)
        insecure_var = tk.StringVar(
            value="true" if self.config.data["server"]["allowInsecure"] else "false"
        )
        insecure_combo = ttk.Combobox(
            frame, textvariable=insecure_var, values=["true", "false"], state="readonly", width=10
        )
        insecure_combo.grid(row=row, column=1, sticky="w", pady=4)
        row += 1

        udp_var = tk.BooleanVar(value=self.config.data["local"]["udp"])
        ttk.Checkbutton(frame, text="启用 UDP", variable=udp_var).grid(
            row=row, column=0, columnspan=2, sticky="w", pady=4
        )
        row += 1

        ttk.Button(frame, text="保存", command=save_and_close).grid(
            row=row, column=0, columnspan=2, pady=15
        )

        root.lift()
        root.attributes("-topmost", True)
        root.mainloop()

    def set_global_mode(self, sender):
        self.config.data["mode"] = "global"
        self.config.save()
        self._update_mode_menu()
        if self.connected:
            self.sys_proxy.enable(
                socks_port=self.config.data["local"]["socks_port"],
                http_port=self.config.data["local"]["http_port"],
            )

    def set_manual_mode(self, sender):
        self.config.data["mode"] = "manual"
        self.config.save()
        self._update_mode_menu()
        if self.connected:
            self.sys_proxy.disable()

    def quit_app(self, sender):
        if self.connected:
            self._disconnect()
        rumps.quit_application()

    def _start_health_check(self):
        def check():
            while True:
                import time
                time.sleep(5)
                if self.connected and not self.xray.is_running():
                    self._disconnect()
                    rumps.notification(
                        "BlockProxyClient",
                        "代理已断开",
                        "xray-core 进程意外退出",
                    )

        t = threading.Thread(target=check, daemon=True)
        t.start()
```

- [ ] **Step 2: Implement main.py**

Create `client/main.py`:
```python
from app import BlockProxyClient


def main():
    client = BlockProxyClient()
    client.run()


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Manual test - verify app launches**

```bash
cd /Users/bachi/jaylli/block-proxy/client
source .venv/bin/activate
python main.py
```
Expected: Status bar icon appears, menu opens with all items, clicking "节点配置..." opens tkinter window.

Press "退出" to close.

- [ ] **Step 4: Commit**

```bash
git add client/app.py client/main.py
git commit -m "feat(client): add main application with status bar menu and config window"
```

---

### Task 6: Resource Files and Icons

**Files:**
- Create: `client/resources/icon.png`
- Create: `client/resources/icon_off.png`

- [ ] **Step 1: Generate placeholder icons**

```bash
cd /Users/bachi/jaylli/block-proxy/client
source .venv/bin/activate
pip install Pillow
python -c "
from PIL import Image, ImageDraw
# Connected icon - solid dark circle
img = Image.new('RGBA', (22, 22), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)
draw.ellipse([4, 4, 18, 18], fill=(0, 0, 0, 255))
img.save('resources/icon.png')

# Disconnected icon - hollow circle
img2 = Image.new('RGBA', (22, 22), (0, 0, 0, 0))
draw2 = ImageDraw.Draw(img2)
draw2.ellipse([4, 4, 18, 18], outline=(128, 128, 128, 255), width=2)
img2.save('resources/icon_off.png')
print('Icons created')
"
```

- [ ] **Step 2: Verify icons exist**

```bash
ls -la /Users/bachi/jaylli/block-proxy/client/resources/icon*.png
```
Expected: Both `icon.png` and `icon_off.png` exist, ~22x22 PNG files.

- [ ] **Step 3: Commit**

```bash
git add client/resources/icon.png client/resources/icon_off.png
git commit -m "feat(client): add status bar icons"
```

---

### Task 7: py2app Packaging Setup

**Files:**
- Create: `client/setup.py`

- [ ] **Step 1: Create setup.py**

Create `client/setup.py`:
```python
from setuptools import setup

APP = ["main.py"]
DATA_FILES = [
    ("resources", ["resources/icon.png", "resources/icon_off.png"]),
]
OPTIONS = {
    "argv_emulation": False,
    "iconfile": "resources/icon.png",
    "plist": {
        "LSUIElement": True,
        "CFBundleName": "BlockProxyClient",
        "CFBundleIdentifier": "com.jaylli.blockproxyclient",
        "CFBundleVersion": "1.0.0",
        "CFBundleShortVersionString": "1.0.0",
    },
    "packages": ["rumps"],
}

setup(
    name="BlockProxyClient",
    app=APP,
    data_files=DATA_FILES,
    options={"py2app": OPTIONS},
    setup_requires=["py2app"],
)
```

- [ ] **Step 2: Test build (development mode)**

```bash
cd /Users/bachi/jaylli/block-proxy/client
source .venv/bin/activate
python setup.py py2app -A
```
Expected: Creates `dist/BlockProxyClient.app` (alias mode, for development testing).

- [ ] **Step 3: Verify .app launches**

```bash
open dist/BlockProxyClient.app
```
Expected: Status bar icon appears. Close via menu "退出".

- [ ] **Step 4: Commit**

```bash
git add client/setup.py
git commit -m "feat(client): add py2app packaging configuration"
```

---

### Task 8: Download xray-core and Integration Test

**Files:**
- Create: `client/scripts/download_xray.sh`

- [ ] **Step 1: Create xray-core download script**

Create `client/scripts/download_xray.sh`:
```bash
#!/bin/bash
set -e

XRAY_VERSION="v25.5.16"
PLATFORM="macos"
ARCH=$(uname -m)

if [ "$ARCH" = "arm64" ]; then
    FILENAME="Xray-macos-arm64-v8a.zip"
elif [ "$ARCH" = "x86_64" ]; then
    FILENAME="Xray-macos-64.zip"
else
    echo "Unsupported architecture: $ARCH"
    exit 1
fi

URL="https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/${FILENAME}"
DEST_DIR="$(dirname "$0")/../resources"

echo "Downloading xray-core ${XRAY_VERSION} for ${ARCH}..."
curl -L -o /tmp/xray.zip "$URL"

echo "Extracting..."
unzip -o /tmp/xray.zip xray -d "$DEST_DIR"
chmod +x "$DEST_DIR/xray"
rm /tmp/xray.zip

echo "Done: $DEST_DIR/xray"
"$DEST_DIR/xray" version
```

- [ ] **Step 2: Download xray-core**

```bash
cd /Users/bachi/jaylli/block-proxy/client
mkdir -p scripts
chmod +x scripts/download_xray.sh
bash scripts/download_xray.sh
```
Expected: xray binary downloaded to `resources/xray` (or `resources/xray-core`), version printed.

- [ ] **Step 3: Add xray binary to .gitignore**

Append to `client/.gitignore`:
```
.venv/
dist/
build/
*.egg-info/
resources/xray
resources/xray-core
__pycache__/
```

- [ ] **Step 4: Integration test - connect to server**

Manually test:
1. Start the app: `python main.py`
2. Click "节点配置..." → fill in your server details → Save
3. Click "开启代理"
4. Verify: `curl --proxy socks5://127.0.0.1:1080 https://httpbin.org/ip`
5. Verify: `curl --proxy http://127.0.0.1:1087 https://httpbin.org/ip`
6. Click "关闭代理"

Expected: Both curl commands return your server's IP when proxy is on, and fail/return local IP when off.

- [ ] **Step 5: Commit**

```bash
git add client/scripts/download_xray.sh client/.gitignore
git commit -m "feat(client): add xray-core download script and gitignore"
```

---

### Task 9: Final Production Build

**Files:**
- Modify: `client/setup.py` (add xray-core to DATA_FILES)

- [ ] **Step 1: Update setup.py to include xray binary**

In `client/setup.py`, update DATA_FILES to:
```python
DATA_FILES = [
    ("resources", ["resources/icon.png", "resources/icon_off.png", "resources/xray"]),
]
```

- [ ] **Step 2: Build production .app**

```bash
cd /Users/bachi/jaylli/block-proxy/client
source .venv/bin/activate
rm -rf dist build
python setup.py py2app
```
Expected: Creates standalone `dist/BlockProxyClient.app` with all dependencies bundled.

- [ ] **Step 3: Update xray_manager to find bundled binary**

In `client/xray_manager.py`, update the `__init__` method's xray_path default detection:
```python
def __init__(self, xray_path=None, config_dir=None):
    if xray_path is None:
        # Check for bundled binary in .app Resources
        bundle_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "resources",
            "xray",
        )
        if os.path.exists(bundle_path):
            xray_path = bundle_path
        else:
            xray_path = shutil.which("xray") or "/usr/local/bin/xray"
    if config_dir is None:
        config_dir = os.path.expanduser(
            "~/Library/Application Support/BlockProxyClient"
        )
    self.xray_path = xray_path
    self.config_dir = config_dir
    self.config_file = os.path.join(config_dir, "xray_config.json")
    self.process = None
```

- [ ] **Step 4: Verify production build launches and connects**

```bash
open dist/BlockProxyClient.app
```
Expected: App runs from .app bundle, proxy connect/disconnect works.

- [ ] **Step 5: Run all unit tests one final time**

```bash
cd /Users/bachi/jaylli/block-proxy/client
source .venv/bin/activate
python -m pytest tests/ -v
```
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add client/setup.py client/xray_manager.py
git commit -m "feat(client): finalize production build with bundled xray-core"
```
