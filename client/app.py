"""
SocksClient — macOS status bar proxy client.
Pure PyObjC implementation (no rumps dependency).
"""

import objc
import os
import sys
import platform
import subprocess
import threading

from Foundation import (
    NSObject,
    NSUserNotification,
    NSUserNotificationCenter,
    NSURL,
)
from AppKit import (
    NSApplication,
    NSApplicationActivationPolicyAccessory,
    NSStatusBar,
    NSVariableStatusItemLength,
    NSMenu,
    NSMenuItem,
    NSSize,
    NSImage,
    NSApp,
    NSAlert,
    NSCommandKeyMask,
    NSWorkspace,
)

from config import Config
from proxy_core import ProxyCore
from system_proxy import SystemProxy


def _is_tahoe_or_newer():
    try:
        ver = tuple(map(int, platform.mac_ver()[0].split(".")))
        return ver >= (26, 0)
    except Exception:
        return False


def _is_compiled():
    return "__compiled__" in globals() or getattr(sys, "frozen", False)


def _bundle_resource_dir():
    if _is_compiled():
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def _icon_dir():
    return os.path.join(_bundle_resource_dir(), "icons")


class _MenuDelegate(NSObject):
    """Menu delegate — fires latency check when menu is opened."""

    def menuWillOpen_(self, menu):
        cb = getattr(self, "_on_open", None)
        if cb:
            cb()


class AppController(NSObject):

    def init(self):
        self = objc.super(AppController, self).init()
        if self is None:
            return None

        self._template = _is_tahoe_or_newer()
        self.config = Config()
        self.config.load()
        self.proxy = ProxyCore()
        self.sys_proxy = SystemProxy()
        self.connected = False
        self._config_proc = None
        self._routing_proc = None
        self._log_proc = None
        self._measuring = False

        self._build_status_item()
        self._build_menu()
        self._update_icon()
        self._start_health_check()

        return self

    # ------------------------------------------------------------------
    # Status bar item
    # ------------------------------------------------------------------

    def _build_status_item(self):
        self._status_item = NSStatusBar.systemStatusBar().statusItemWithLength_(
            NSVariableStatusItemLength
        )

    def _update_icon(self):
        if self.connected:
            icon_name = (
                "socks_on_G_bar.png"
                if self.config.data["mode"] == "global"
                else "socks_on_M_bar.png"
            )
        else:
            icon_name = "christmas-sock_light_bar_off.png"

        icon_path = os.path.join(_icon_dir(), icon_name)
        if not os.path.exists(icon_path):
            return

        image = NSImage.alloc().initByReferencingFile_(icon_path)
        if image is None:
            return
        image.setSize_(NSSize(22, 22))
        if self._template is not None:
            image.setTemplate_(self._template)
        self._status_item.button().setImage_(image)

    # ------------------------------------------------------------------
    # Menu
    # ------------------------------------------------------------------

    def _build_menu(self):
        menu = NSMenu.alloc().init()
        menu.setAutoenablesItems_(False)

        self.toggle_item = self._add_menu_item(
            menu, "启动代理", "toggleProxy:"
        )
        self._add_menu_item(menu, "Socks/HTTP 节点配置...", "openConfig:")
        self._add_menu_item(menu, "分流规则...", "openRouting:")
        menu.addItem_(NSMenuItem.separatorItem())

        self.global_item = self._add_menu_item(
            menu, "全局代理（设置系统代理）", "setGlobalMode:"
        )
        self.manual_item = self._add_menu_item(
            menu, "手动模式（关闭系统代理）", "setManualMode:"
        )
        self._update_mode_menu()
        menu.addItem_(NSMenuItem.separatorItem())

        log_item = self._add_menu_item(menu, "查看日志...", "openLog:")
        from AppKit import NSImage
        log_image = NSImage.imageWithSystemSymbolName_accessibilityDescription_("doc.text", None)
        if log_image:
            log_item.setImage_(log_image)
        self._add_menu_item(menu, "关于", "showAbout:")
        self._add_menu_item(menu, "帮助", "showHelp:")
        menu.addItem_(NSMenuItem.separatorItem())

        quit_item = self._add_menu_item(menu, "退出", "quitApp:")
        quit_item.setKeyEquivalent_("q")
        quit_item.setKeyEquivalentModifierMask_(NSCommandKeyMask)

        # Delegate for latency measurement on menu-open
        delegate = _MenuDelegate.alloc().init()
        delegate._on_open = self._on_menu_open
        menu.setDelegate_(delegate)
        self._menu_delegate = delegate  # keep alive

        self._status_item.setValue_forKey_(menu, "menu")
        self._menu = menu

    def _add_menu_item(self, menu, title, action):
        item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(title, action, "")
        item.setTarget_(self)
        item.setEnabled_(True)
        menu.addItem_(item)
        return item

    def _update_mode_menu(self):
        is_global = self.config.data["mode"] == "global"
        self.global_item.setState_(1 if is_global else 0)
        self.manual_item.setState_(1 if not is_global else 0)

    # ------------------------------------------------------------------
    # Proxy toggle
    # ------------------------------------------------------------------

    def toggleProxy_(self, sender):
        if self.connected:
            self._disconnect()
        else:
            self._connect()

    def _connect(self):
        if not self.config.is_configured():
            alert = NSAlert.alloc().init()
            alert.setMessageText_("请先配置节点信息")
            alert.addButtonWithTitle_("好")
            alert.runModal()
            return

        def _start():
            try:
                self.proxy.start(self.config.data,
                                  config_dir=os.path.dirname(self.config.config_path))
            except OSError as e:
                self._run_on_main(
                    lambda: self._show_notification(
                        "SocksClient", "启动失败",
                        "端口被占用，请检查端口是否已被其他程序使用"
                        if e.errno == 48 else str(e),
                    )
                )
                return

            if (
                self.proxy.socks_port != self.config.data["local"]["socks_port"]
                or self.proxy.http_port != self.config.data["local"]["http_port"]
            ):
                self.config.data["local"]["socks_port"] = self.proxy.socks_port
                self.config.data["local"]["http_port"] = self.proxy.http_port
                self.config.save()

            if self.config.data["mode"] == "global":
                try:
                    self.sys_proxy.enable(
                        socks_port=self.proxy.socks_port,
                        http_port=self.proxy.http_port,
                    )
                except Exception as e:
                    self._run_on_main(
                        lambda: self._show_notification(
                            "SocksClient", "系统代理设置失败", str(e)
                        )
                    )

            self._run_on_main(self._on_connected)

        threading.Thread(target=_start, daemon=True).start()

    def _on_connected(self):
        self.connected = True
        self.toggle_item.setTitle_("关闭代理")
        self._update_icon()

    def _disconnect(self):
        self.sys_proxy.disable()
        self.proxy.stop()
        self.connected = False
        self.toggle_item.setTitle_("启动代理")
        self._update_icon()

    # ------------------------------------------------------------------
    # Mode switching
    # ------------------------------------------------------------------

    def setGlobalMode_(self, sender):
        self.config.data["mode"] = "global"
        self.config.save()
        self._update_mode_menu()
        self._update_icon()
        if self.connected:
            self.sys_proxy.enable(
                socks_port=self.proxy.socks_port,
                http_port=self.proxy.http_port,
            )

    def setManualMode_(self, sender):
        self.config.data["mode"] = "manual"
        self.config.save()
        self._update_mode_menu()
        self._update_icon()
        if self.connected:
            self.sys_proxy.disable()

    # ------------------------------------------------------------------
    # Subprocess windows
    # ------------------------------------------------------------------

    def openConfig_(self, sender):
        if self._config_proc and self._config_proc.poll() is None:
            return
        self._show_config_window()

    def openRouting_(self, sender):
        if self._routing_proc and self._routing_proc.poll() is None:
            return
        self._show_routing_window()

    def openLog_(self, sender):
        if self._log_proc and self._log_proc.poll() is None:
            return
        script_path = os.path.join(_bundle_resource_dir(), "log_window.py")
        python_path = self._find_python() if _is_compiled() else sys.executable
        self._log_proc = subprocess.Popen([python_path, script_path])

    def _find_python(self):
        for p in [
            "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3",
            "/usr/local/bin/python3",
            "/usr/bin/python3",
        ]:
            if os.path.exists(p):
                return p
        return "python3"

    def _show_config_window(self):
        self.config.save()
        script_path = os.path.join(_bundle_resource_dir(), "config_window.py")
        python_path = self._find_python() if _is_compiled() else sys.executable
        self._config_proc = subprocess.Popen(
            [python_path, script_path, self.config.config_path]
        )

        def _reload_after():
            self._config_proc.wait()
            self._config_proc = None
            old_data = self.config.data.copy()
            self.config.load()
            if self.connected and self.config.data != old_data:
                self._run_on_main(self._reconnect)

        threading.Thread(target=_reload_after, daemon=True).start()

    def _show_routing_window(self):
        self.config.save()
        script_path = os.path.join(_bundle_resource_dir(), "routing_window.py")
        python_path = self._find_python() if _is_compiled() else sys.executable
        self._routing_proc = subprocess.Popen(
            [python_path, script_path, self.config.config_path]
        )

        def _reload_after():
            self._routing_proc.wait()
            self._routing_proc = None
            old_routing = self.config.data.get("routing", {})
            self.config.load()
            new_routing = self.config.data.get("routing", {})
            if self.connected and new_routing != old_routing:
                self._run_on_main(self._reconnect)

        threading.Thread(target=_reload_after, daemon=True).start()

    def _reconnect(self):
        self._disconnect()
        self._connect()

    # ------------------------------------------------------------------
    # About
    # ------------------------------------------------------------------

    def showAbout_(self, sender):
        NSApp.activateIgnoringOtherApps_(True)
        alert = NSAlert.alloc().init()
        alert.setMessageText_("关于 SocksClient")
        alert.setInformativeText_(
            "项目：block-proxy\n"
            "作者：lijing00333\n"
            "地址：https://github.com/jayli/block-proxy\n"
            "版本：v0.1.1"
        )
        alert.addButtonWithTitle_("好")
        alert.runModal()

    def showHelp_(self, sender):
        url = NSURL.URLWithString_("https://github.com/jayli/block-proxy/blob/main/Useage.md")
        NSWorkspace.sharedWorkspace().openURL_(url)

    # ------------------------------------------------------------------
    # Quit
    # ------------------------------------------------------------------

    def quitApp_(self, sender):
        NSApp.terminate_(self)

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

    # ------------------------------------------------------------------
    # Health check
    # ------------------------------------------------------------------

    def _start_health_check(self):
        MAX_RESTARTS = 3
        RESTART_DELAY = 2

        def _loop():
            import time
            from logger import crash_logger

            restart_count = 0
            while True:
                time.sleep(5)
                if not self.connected:
                    restart_count = 0
                    continue
                if self.proxy.is_running():
                    restart_count = 0
                    continue

                restart_count += 1
                crash_logger.warning(
                    "Proxy thread died, attempting restart (%d/%d)",
                    restart_count, MAX_RESTARTS,
                )

                if restart_count > MAX_RESTARTS:
                    self._run_on_main(
                        lambda: self._on_health_failed(MAX_RESTARTS)
                    )
                    restart_count = 0
                    continue

                time.sleep(RESTART_DELAY)
                try:
                    self.proxy.stop()
                    self.proxy.start(self.config.data,
                                  config_dir=os.path.dirname(self.config.config_path))
                    restart_count = 0
                    crash_logger.warning("Proxy restarted successfully")
                except Exception as e:
                    crash_logger.warning(
                        "Proxy restart failed: %s", e, exc_info=True
                    )

        threading.Thread(target=_loop, daemon=True).start()

    def _on_health_failed(self, max_restarts):
        self._disconnect()
        alert = NSAlert.alloc().init()
        alert.setMessageText_("代理已断开")
        alert.setInformativeText_(
            f"代理连续 {max_restarts} 次重启失败，已停止"
        )
        alert.addButtonWithTitle_("好")
        alert.runModal()

    # ------------------------------------------------------------------
    # Menu-open latency check
    # ------------------------------------------------------------------

    def _on_menu_open(self):
        if not self.connected or self._measuring:
            return
        self._measuring = True

        def _check():
            try:
                latency = self.proxy.measure_latency()

                def _update():
                    if not self.connected:
                        return
                    self.toggle_item.setTitle_(
                        f"关闭代理（{latency}ms）"
                        if latency is not None
                        else "关闭代理（超时）"
                    )

                self._run_on_main(_update)
            finally:
                self._measuring = False

        threading.Thread(target=_check, daemon=True).start()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _run_on_main(self, fn):
        self.performSelectorOnMainThread_withObject_waitUntilDone_(
            "_executeCallback:", fn, False
        )

    def _executeCallback_(self, fn):
        fn()

    def _show_notification(self, title, subtitle, message):
        try:
            notif = NSUserNotification.alloc().init()
            notif.setTitle_(title)
            notif.setSubtitle_(subtitle)
            notif.setInformativeText_(message)
            NSUserNotificationCenter.defaultUserNotificationCenter().deliverNotification_(
                notif
            )
        except Exception:
            pass


class SocksClient:
    """Compatibility wrapper — same API as the old rumps-based class."""

    def run(self):
        app = NSApplication.sharedApplication()
        app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)

        ctrl = AppController.alloc().init()
        if ctrl is None:
            raise RuntimeError("Failed to initialize AppController")
        self._ctrl = ctrl  # keep alive
        app.setDelegate_(ctrl)
        app.run()
