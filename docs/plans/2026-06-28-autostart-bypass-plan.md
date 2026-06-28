# Autostart & System Proxy Bypass Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement LaunchAgent-based autostart and networksetup bypass domains for system proxy.

**Architecture:** New `autostart.py` module manages `~/Library/LaunchAgents/com.jaylli.socksclient.plist` creation/deletion. `system_proxy.py` gains a hardcoded bypass list applied via `networksetup -setproxybypassdomains` on enable and cleared on disable. `app.py` detects the .app bundle path and passes it to `config_window.py`, which syncs autostart state on save.

**Tech Stack:** Python 3, PyObjC, networksetup

---

### Task 1: New file `client/autostart.py`

**Files:**
- Create: `client/autostart.py`
- Test: `client/tests/test_autostart.py`

**Step 1: Write the implementation**

```python
import os
import plistlib
import logging

logger = logging.getLogger("autostart")

PLIST_DIR = os.path.expanduser("~/Library/LaunchAgents")
PLIST_PATH = os.path.join(PLIST_DIR, "com.jaylli.socksclient.plist")


def enable(app_path):
    """Create LaunchAgent plist to start app at login. No-op if app_path is None (dev mode)."""
    if not app_path or not os.path.exists(app_path):
        logger.warning("autostart: app_path not found, skipping: %s", app_path)
        return
    os.makedirs(PLIST_DIR, exist_ok=True)
    plist = {
        "Label": "com.jaylli.socksclient",
        "ProgramArguments": ["/usr/bin/open", "-a", app_path],
        "RunAtLoad": True,
        "KeepAlive": False,
    }
    with open(PLIST_PATH, "wb") as f:
        plistlib.dump(plist, f)
    logger.info("autostart: plist created at %s", PLIST_PATH)


def disable():
    """Remove LaunchAgent plist."""
    try:
        os.remove(PLIST_PATH)
        logger.info("autostart: plist removed")
    except FileNotFoundError:
        pass


def sync(app_path, enabled):
    """Enable or disable autostart based on boolean."""
    if enabled:
        enable(app_path)
    else:
        disable()
```

**Step 2: Write the test file**

```python
import os
import sys
import plistlib
import tempfile
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import autostart


class TestAutostart:
    def setup_method(self):
        self.tmp = tempfile.mkdtemp()
        autostart.PLIST_DIR = self.tmp
        autostart.PLIST_PATH = os.path.join(self.tmp, "com.jaylli.socksclient.plist")

    def teardown_method(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_enable_creates_plist(self):
        fake_app = os.path.join(self.tmp, "SocksClient.app")
        os.makedirs(fake_app)
        autostart.enable(fake_app)
        assert os.path.exists(autostart.PLIST_PATH)
        with open(autostart.PLIST_PATH, "rb") as f:
            data = plistlib.load(f)
        assert data["Label"] == "com.jaylli.socksclient"
        assert data["ProgramArguments"] == ["/usr/bin/open", "-a", fake_app]
        assert data["RunAtLoad"] is True
        assert data["KeepAlive"] is False

    def test_enable_noop_when_app_path_none(self):
        autostart.enable(None)
        assert not os.path.exists(autostart.PLIST_PATH)

    def test_enable_noop_when_app_path_not_exists(self):
        autostart.enable("/nonexistent/Foo.app")
        assert not os.path.exists(autostart.PLIST_PATH)

    def test_disable_removes_plist(self):
        fake_app = os.path.join(self.tmp, "SocksClient.app")
        os.makedirs(fake_app)
        autostart.enable(fake_app)
        autostart.disable()
        assert not os.path.exists(autostart.PLIST_PATH)

    def test_disable_noop_when_no_plist(self):
        autostart.disable()  # should not raise

    def test_sync_enable(self):
        fake_app = os.path.join(self.tmp, "SocksClient.app")
        os.makedirs(fake_app)
        autostart.sync(fake_app, True)
        assert os.path.exists(autostart.PLIST_PATH)

    def test_sync_disable(self):
        fake_app = os.path.join(self.tmp, "SocksClient.app")
        os.makedirs(fake_app)
        autostart.enable(fake_app)
        autostart.sync(fake_app, False)
        assert not os.path.exists(autostart.PLIST_PATH)
```

**Step 3: Run tests**

Run: `cd client && python -m pytest tests/test_autostart.py -v`
Expected: 7 PASS

---

### Task 2: Modify `client/system_proxy.py`

**Files:**
- Modify: `client/system_proxy.py`
- Test: `client/tests/test_system_proxy.py`

**Step 1: Add BYPASS_DOMAINS constant and modify enable/disable**

Add after the logger line (line ~11):

```python
BYPASS_DOMAINS = [
    "*.local",
    "169.254.0.0/16",
    "127.0.0.1",
    "localhost",
    "0.0.0.0",
    "::1",
    "192.168.0.0/16",
    "10.0.0.0/8",
    "172.16.0.0/12",
]
```

Modify `enable()` — add bypass tasks after the proxy-setting tasks (inside the `tasks.extend([...])` block, add a second block):

```python
    def enable(self, socks_port, http_port):
        self._interfaces = self._get_active_interfaces()
        tasks = []
        for iface in self._interfaces:
            tasks.extend([
                ["networksetup", "-setsocksfirewallproxy", iface, "127.0.0.1", str(socks_port)],
                ["networksetup", "-setsocksfirewallproxystate", iface, "on"],
                ["networksetup", "-setwebproxy", iface, "127.0.0.1", str(http_port)],
                ["networksetup", "-setwebproxystate", iface, "on"],
                ["networksetup", "-setsecurewebproxy", iface, "127.0.0.1", str(http_port)],
                ["networksetup", "-setsecurewebproxystate", iface, "on"],
            ])
            tasks.append(
                ["networksetup", "-setproxybypassdomains", iface] + BYPASS_DOMAINS
            )
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(_run_networksetup, tasks))
        self._enabled = True
        self._verify(socks_port, http_port)
```

Modify `disable()` — add bypass cleanup:

```python
    def disable(self):
        interfaces = self._interfaces or self._get_active_interfaces()
        tasks = []
        for iface in interfaces:
            tasks.extend([
                ["networksetup", "-setsocksfirewallproxystate", iface, "off"],
                ["networksetup", "-setwebproxystate", iface, "off"],
                ["networksetup", "-setsecurewebproxystate", iface, "off"],
            ])
            tasks.append(
                ["networksetup", "-setproxybypassdomains", iface, "Empty"]
            )
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(_run_networksetup, tasks))
        self._enabled = False
        self._interfaces = []
```

**Step 2: Update existing test to verify bypass calls**

The existing `test_system_proxy.py` mocks `subprocess.run`. Update it to verify that `-setproxybypassdomains` is called on enable and disable. The exact changes depend on the current test code — read `client/tests/test_system_proxy.py` first, then update.

**Step 3: Run tests**

Run: `cd client && python -m pytest tests/test_system_proxy.py -v`
Expected: all tests PASS

---

### Task 3: Modify `client/app.py`

**Files:**
- Modify: `client/app.py`

**Step 1: Add `_bundle_path()` helper**

Add after `_bundle_resource_dir()` (line ~55):

```python
def _bundle_path():
    """Return the .app bundle path in compiled mode, None in dev mode."""
    if _is_compiled():
        # sys.executable = .../SocksClient.app/Contents/MacOS/SocksClient
        return os.path.dirname(os.path.dirname(os.path.dirname(sys.executable)))
    return None
```

**Step 2: Import autostart module**

Add import inside `applicationWillTerminate_`. Instead of importing at module level (to avoid dev-mode side effects), import locally in the method:

```python
    def applicationWillTerminate_(self, notification):
        if self._config_proc and self._config_proc.poll() is None:
            self._config_proc.terminate()
        if self._routing_proc and self._routing_proc.poll() is None:
            self._routing_proc.terminate()
        if self._log_proc and self._log_proc.poll() is None:
            self._log_proc.terminate()
        if self.connected:
            self.sys_proxy.disable()
            self.proxy.stop()
        # Clean up LaunchAgent if autostart is disabled
        if not self.config.data.get("autostart", False):
            from autostart import disable
            disable()
```

**Step 3: Pass `--app-path` to config_window subprocess**

In `_show_config_window()`, append `--app-path` and bundle_path to the subprocess args:

```python
    def _show_config_window(self):
        self.config.save()
        script_path = os.path.join(_bundle_resource_dir(), "config_window.py")
        python_path = self._find_python() if _is_compiled() else sys.executable
        args = [python_path, script_path, self.config.config_path]
        bundle_path = _bundle_path()
        if bundle_path:
            args.extend(["--app-path", bundle_path])
        self._config_proc = subprocess.Popen(args)
        # ... rest unchanged ...
```

---

### Task 4: Modify `client/config_window.py`

**Files:**
- Modify: `client/config_window.py`

**Step 1: Accept `--app-path` argument**

Modify `show_config_window` to accept an optional `app_path` parameter:

```python
def show_config_window(config_path, app_path=None):
    ctrl = ConfigWindowController.alloc().initWithConfigPath_(config_path)
    if ctrl is None:
        return
    ctrl._app_path = app_path
    ctrl.show()
    NSApp.runModalForWindow_(ctrl._window)
```

**Step 2: Parse `--app-path` from command line**

Modify `__main__`:

```python
if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("config_path")
    parser.add_argument("--app-path", default=None)
    args = parser.parse_args()

    from AppKit import NSScreen

    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
    show_config_window(args.config_path, args.app_path)
```

**Step 3: In `saveAndClose_`, sync autostart**

Add after `config["autostart"] = bool(self._autostart_cb.state())` (line ~238):

```python
        config["autostart"] = bool(self._autostart_cb.state())

        from autostart import sync
        sync(getattr(self, "_app_path", None), config["autostart"])
```

---

### Task 5: Run full test suite

**Step 1: Run all client tests**

Run: `cd client && python -m pytest tests/ -v`
Expected: all tests PASS (existing + new)

---

### Task 6: Commit

```bash
git add client/autostart.py client/tests/test_autostart.py \
        client/system_proxy.py client/tests/test_system_proxy.py \
        client/app.py client/config_window.py \
        docs/plans/2026-06-28-autostart-bypass-design.md \
        docs/plans/2026-06-28-autostart-bypass-plan.md
git commit -m "feat(client): add LaunchAgent autostart and system proxy bypass domains"
```
