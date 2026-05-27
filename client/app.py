import os
import sys
import subprocess
import threading
import rumps
from config import Config
from xray_manager import XrayManager
from system_proxy import SystemProxy


class BlockProxyClient(rumps.App):
    def __init__(self):
        super().__init__("BlockProxyClient", quit_button=None)
        self.template = True

        self.config = Config()
        self.config.load()
        self.xray = XrayManager()
        self.sys_proxy = SystemProxy()
        self.connected = False

        self._build_menu()
        self._update_icon()
        self._start_health_check()

    def _build_menu(self):
        self.toggle_item = rumps.MenuItem("启动代理", callback=self.toggle_proxy)
        self.config_item = rumps.MenuItem("Socks 节点配置...", callback=self.open_config)

        self.global_item = rumps.MenuItem("全局代理(设置系统代理)", callback=self.set_global_mode)
        self.manual_item = rumps.MenuItem("手动模式(关闭系统代理)", callback=self.set_manual_mode)

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

        try:
            from AppKit import NSCommandKeyMask
            self.quit_item._menuitem.setKeyEquivalent_("q")
            self.quit_item._menuitem.setKeyEquivalentModifierMask_(NSCommandKeyMask)
        except Exception:
            pass

        self._update_mode_menu()

    def _update_mode_menu(self):
        is_global = self.config.data["mode"] == "global"
        self.global_item.state = 1 if is_global else 0
        self.manual_item.state = 1 if not is_global else 0

    def _update_icon(self):
        if self.connected:
            icon_name = "socks_on_G.png" if self.config.data["mode"] == "global" else "socks_on_M.png"
        else:
            icon_name = "christmas-sock_light.png"
        icon_path = os.path.join(self._icon_dir(), icon_name)
        if os.path.exists(icon_path):
            self.icon = icon_path
        self.title = None

    def _icon_dir(self):
        app_dir = os.path.dirname(os.path.abspath(__file__))
        return os.path.join(app_dir, "icons")

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
        self.toggle_item.title = "启动代理"
        self._update_icon()

    def open_config(self, sender):
        self._show_config_window()

    def _show_config_window(self):
        self.config.save()
        script_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "config_window.py"
        )
        python_path = sys.executable
        subprocess.Popen([python_path, script_path, self.config.config_path])

        def _reload_after_window():
            import time
            time.sleep(0.5)
            while True:
                result = subprocess.run(
                    ["pgrep", "-f", f"config_window.py {self.config.config_path}"],
                    capture_output=True,
                )
                if result.returncode != 0:
                    break
                time.sleep(0.5)
            self.config.load()

        threading.Thread(target=_reload_after_window, daemon=True).start()

    def set_global_mode(self, sender):
        self.config.data["mode"] = "global"
        self.config.save()
        self._update_mode_menu()
        self._update_icon()
        if self.connected:
            self.sys_proxy.enable(
                socks_port=self.config.data["local"]["socks_port"],
                http_port=self.config.data["local"]["http_port"],
            )

    def set_manual_mode(self, sender):
        self.config.data["mode"] = "manual"
        self.config.save()
        self._update_mode_menu()
        self._update_icon()
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
