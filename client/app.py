import os
import sys
import subprocess
import threading
import platform
import rumps
from AppKit import NSImage, NSSize
from PyObjCTools import AppHelper
from Foundation import NSObject
from config import Config
from proxy_core import ProxyCore
from system_proxy import SystemProxy


def _is_tahoe_or_newer():
    try:
        ver = tuple(map(int, platform.mac_ver()[0].split(".")))
        return ver >= (26, 0)
    except Exception:
        return False


class _MenuOpenDelegate(NSObject):
    def menuWillOpen_(self, menu):
        cb = getattr(self, "_on_open", None)
        if cb:
            cb()


class SocksClient(rumps.App):
    def __init__(self):
        super().__init__("SocksClient", quit_button=None)
        self.template = _is_tahoe_or_newer()

        self.config = Config()
        self.config.load()
        self.proxy = ProxyCore()
        self.sys_proxy = SystemProxy()
        self.connected = False

        self._measuring = False
        self._build_menu()
        self._setup_menu_delegate()
        self._update_icon()
        self._start_health_check()

    def run(self, **options):
        if not _is_tahoe_or_newer():
            def _fix_highlight():
                try:
                    self._nsapp.nsstatusitem.setHighlightMode_(False)
                except Exception:
                    pass
            AppHelper.callAfter(_fix_highlight)
        super().run(**options)

    def _build_menu(self):
        self.toggle_item = rumps.MenuItem("启动代理", callback=self.toggle_proxy)
        self.config_item = rumps.MenuItem("Socks 节点配置...", callback=self.open_config)

        self.global_item = rumps.MenuItem("全局代理（设置系统代理）", callback=self.set_global_mode)
        self.manual_item = rumps.MenuItem("手动模式（关闭系统代理）", callback=self.set_manual_mode)

        self.about_item = rumps.MenuItem("关于", callback=self.show_about)
        self.quit_item = rumps.MenuItem("退出", callback=self.quit_app)

        self.menu = [
            self.toggle_item,
            self.config_item,
            None,
            self.global_item,
            self.manual_item,
            None,
            self.about_item,
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
            icon_name = "socks_on_G_bar.png" if self.config.data["mode"] == "global" else "socks_on_M_bar.png"
        else:
            icon_name = "christmas-sock_light_bar_off.png"
        icon_path = os.path.join(self._icon_dir(), icon_name)
        if os.path.exists(icon_path):
            image = NSImage.alloc().initByReferencingFile_(icon_path)
            image.setSize_(NSSize(22, 22))
            if self._template is not None:
                image.setTemplate_(self._template)
            self._icon = icon_path
            self._icon_nsimage = image
            try:
                self._nsapp.setStatusBarIcon()
            except AttributeError:
                pass
        self.title = None

    def _is_compiled(self):
        return "__compiled__" in globals() or getattr(sys, "frozen", False)

    def _bundle_resource_dir(self):
        if self._is_compiled():
            return os.path.dirname(sys.executable)
        return os.path.dirname(os.path.abspath(__file__))

    def _icon_dir(self):
        return os.path.join(self._bundle_resource_dir(), "icons")

    def toggle_proxy(self, sender):
        if self.connected:
            self._disconnect()
        else:
            self._connect()

    def _connect(self):
        if not self.config.is_configured():
            rumps.alert("请先配置节点信息")
            return

        def _start():
            try:
                self.proxy.start(self.config.data)
            except OSError as e:
                if e.errno == 48:
                    rumps.notification(
                        "SocksClient", "启动失败",
                        f"端口被占用，请检查端口是否已被其他程序使用",
                    )
                else:
                    rumps.notification(
                        "SocksClient", "启动失败", str(e),
                    )
                return
            if self.config.data["mode"] == "global":
                try:
                    self.sys_proxy.enable(
                        socks_port=self.config.data["local"]["socks_port"],
                        http_port=self.config.data["local"]["http_port"],
                    )
                except Exception as e:
                    rumps.notification(
                        "SocksClient", "系统代理设置失败", str(e),
                    )

            def _update_ui():
                self.connected = True
                self.toggle_item.title = "关闭代理"
                self._update_icon()

            AppHelper.callAfter(_update_ui)

        threading.Thread(target=_start, daemon=True).start()

    def _disconnect(self):
        self.sys_proxy.disable()
        self.proxy.stop()
        self.connected = False
        self.toggle_item.title = "启动代理"
        self._update_icon()

    def open_config(self, sender):
        self._show_config_window()

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
        script_path = os.path.join(self._bundle_resource_dir(), "config_window.py")
        python_path = self._find_python() if self._is_compiled() else sys.executable
        proc = subprocess.Popen([python_path, script_path, self.config.config_path])

        def _reload_after_window():
            proc.wait()
            old_data = self.config.data.copy()
            self.config.load()
            if self.connected and self.config.data != old_data:
                self._disconnect()
                self._connect()

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

    def show_about(self, sender):
        try:
            from AppKit import (
                NSAlert, NSTextField, NSMutableAttributedString,
                NSAttributedString, NSFont, NSColor, NSMakeRect,
                NSApp,
            )
            from Foundation import NSURL, NSRange

            NSApp.activateIgnoringOtherApps_(True)
            alert = NSAlert.alloc().init()
            alert.setMessageText_("关于 SocksClient")
            alert.addButtonWithTitle_("好")

            url = "https://github.com/jayli/block-proxy"
            text = f"项目：block-proxy\n作者：lijing00333\n地址：{url}\n版本：v0.1.0"

            attr_str = NSMutableAttributedString.alloc().initWithString_(text)
            full_range = NSRange(0, len(text))
            font = NSFont.systemFontOfSize_(13)
            attr_str.addAttribute_value_range_("NSFont", font, full_range)

            link_start = text.index(url)
            link_range = NSRange(link_start, len(url))
            attr_str.addAttribute_value_range_("NSLink", NSURL.URLWithString_(url), link_range)
            attr_str.addAttribute_value_range_("NSColor", NSColor.linkColor(), link_range)

            text_field = NSTextField.wrappingLabelWithString_("")
            text_field.setAttributedStringValue_(attr_str)
            text_field.setAllowsEditingTextAttributes_(True)
            text_field.setSelectable_(True)
            text_field.setFrame_(NSMakeRect(0, 0, 300, 80))

            alert.setAccessoryView_(text_field)
            alert.runModal()
        except Exception:
            rumps.alert(
                title="关于 SocksClient",
                message=(
                    "项目：block-proxy\n"
                    "作者：lijing00333\n"
                    "地址：https://github.com/jayli/block-proxy\n"
                    "版本：v0.1.0"
                ),
            )

    def quit_app(self, sender):
        if self.connected:
            self.sys_proxy.disable()
            threading.Thread(target=self.proxy.stop, daemon=True).start()
        rumps.quit_application()

    def _setup_menu_delegate(self):
        try:
            delegate = _MenuOpenDelegate.alloc().init()
            delegate._on_open = self._on_menu_open
            self._menu._menu.setDelegate_(delegate)
            self._menu_delegate = delegate
        except Exception:
            pass

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
                    if latency is not None:
                        self.toggle_item.title = f"关闭代理（{latency}ms）"
                    else:
                        self.toggle_item.title = "关闭代理（超时）"

                AppHelper.callAfter(_update)
            finally:
                self._measuring = False

        threading.Thread(target=_check, daemon=True).start()

    def _start_health_check(self):
        def check():
            while True:
                import time
                time.sleep(5)
                if self.connected and not self.proxy.is_running():
                    self._disconnect()
                    rumps.notification(
                        "SocksClient",
                        "代理已断开",
                        "代理进程意外退出",
                    )

        t = threading.Thread(target=check, daemon=True)
        t.start()
