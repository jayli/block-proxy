# Autostart & System Proxy Bypass Design

2026-06-28

## 1. Autostart (LaunchAgent)

### Plist path

`~/Library/LaunchAgents/com.jaylli.socksclient.plist`

### Plist content

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.jaylli.socksclient</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/open</string>
        <string>-a</string>
        <string>/path/to/SocksClient.app</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>
```

### New file: `client/autostart.py`

- `PLIST_PATH = ~/Library/LaunchAgents/com.jaylli.socksclient.plist`
- `enable(app_path)` — writes plist with `open -a <app_path>` as ProgramArguments; no-op when `app_path` is None (dev mode)
- `disable()` — removes plist if exists
- `sync(app_path, enabled)` — convenience: calls enable or disable based on bool

### Modifications: `client/app.py`

- `_show_config_window()`: pass `--app-path <bundle_path>` to config_window subprocess
- `applicationWillTerminate_`: if autostart is disabled in config, call `autostart.disable()` to clean up
- Helper `_bundle_path()`: in compiled mode, `os.path.dirname(os.path.dirname(os.path.dirname(sys.executable)))`; in dev mode, `None`

### Modifications: `client/config_window.py`

- Accept `--app-path` argument (optional, after `--config-path`)
- On save: call `autostart.sync(app_path, autostart_state)`

---

## 2. System Proxy Bypass List

### Built-in bypass list (hardcoded)

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

### Modifications: `client/system_proxy.py`

- `enable()`: after setting proxy states, run `networksetup -setproxybypassdomains <iface> <domains...>` for each interface (parallelized in ThreadPoolExecutor)
- `disable()`: run `networksetup -setproxybypassdomains <iface> Empty` for each interface to clear bypass list

### networksetup command

```
networksetup -setproxybypassdomains <networkservice> <domain1> [domain2] ...
```

No `-setproxybypassdomainsstate` needed — setting the domains is sufficient.
