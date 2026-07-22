"""
BlockProxyClient — macOS status bar proxy client.
Pure PyObjC implementation (no rumps dependency).
"""

import logging
import objc
import os
import sys
import platform
import socket
import subprocess
import threading

logger = logging.getLogger("app")

from Foundation import (
    NSObject,
    NSUserNotification,
    NSUserNotificationCenter,
    NSNotificationCenter,
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
from super_dns_control import is_super_dns_running
from system_proxy import SystemProxy
from tunnel_client import TunnelClient


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


def _bundle_path():
    """Return the .app bundle path in compiled mode, None in dev mode."""
    if _is_compiled():
        # sys.executable = .../BlockProxyClient.app/Contents/MacOS/BlockProxyClient
        return os.path.dirname(os.path.dirname(os.path.dirname(sys.executable)))
    return None


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
        self.tunnel_client = None
        self.sys_proxy = SystemProxy()
        self.connected = False
        self._config_proc = None
        self._routing_proc = None
        self._super_dns_proc = None
        self._log_proc = None
        self._measuring = False
        self._connecting = False
        self._reconnecting = False
        self._disconnecting = False
        self._was_connected = False  # state before sleep
        self._sleep_obs = None
        self._wake_obs = None

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
        menu.addItem_(NSMenuItem.separatorItem())

        config_item = self._add_menu_item(menu, "节点配置...", "openConfig:")
        config_item.setKeyEquivalent_("p")
        config_item.setKeyEquivalentModifierMask_(NSCommandKeyMask)

        self.routing_item = self._add_menu_item(menu, "分流规则...", "openRouting:")
        self.routing_item.setKeyEquivalent_("f")
        self.routing_item.setKeyEquivalentModifierMask_(NSCommandKeyMask)
        self._update_routing_check()

        self.super_dns_item = self._add_menu_item(menu, "Super DNS...", "openSuperDns:")
        self._update_super_dns_menu_title()
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
        log_image = NSImage.imageWithSystemSymbolName_accessibilityDescription_(
            "doc.text", None
        )
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

        # Observe system sleep/wake for tunnel reconnection
        nc = NSWorkspace.sharedWorkspace().notificationCenter()
        self._sleep_obs = nc.addObserver_selector_name_object_(
            self, "onSystemWillSleep:",
            "NSWorkspaceWillSleepNotification", None
        )
        self._wake_obs = nc.addObserver_selector_name_object_(
            self, "onSystemDidWake:",
            "NSWorkspaceDidWakeNotification", None
        )

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

    def _routing_menu_title(self, routing_enabled):
        return "分流规则（已开启）..." if routing_enabled else "分流规则..."

    def _update_routing_check(self):
        """Update routing menu item title based on routing enabled state."""
        routing_enabled = self.config.data.get("routing", {}).get("enabled", False)
        self.routing_item.setTitle_(self._routing_menu_title(routing_enabled))

    def _super_dns_menu_title(self, running):
        return "Super DNS（运行中）..." if running else "Super DNS（未运行）..."

    def _update_super_dns_menu_title(self):
        self.super_dns_item.setTitle_(self._super_dns_menu_title(is_super_dns_running()))

    # ------------------------------------------------------------------
    # Proxy toggle
    # ------------------------------------------------------------------

    def toggleProxy_(self, sender):
        if self._connecting or self._disconnecting:
            return
        if self.connected:
            self._disconnect_async()
        else:
            self._connect()

    def _connect(self):
        if self._connecting:
            return
        if not self.config.is_configured():
            alert = NSAlert.alloc().init()
            alert.setMessageText_("请先配置节点信息")
            alert.addButtonWithTitle_("好")
            alert.runModal()
            return

        self._begin_connecting()

        def _start():
            # 1. 启动本地代理服务器（端口绑定，这是用户代理的核心）
            try:
                self.proxy.start(self.config.data,
                                  config_dir=os.path.dirname(self.config.config_path))
            except OSError as e:
                message = (
                    "端口被占用，请检查端口是否已被其他程序使用"
                    if e.errno == 48 else str(e)
                )

                def _fail():
                    self._show_notification(
                        "BlockProxyClient", "启动失败", message
                    )
                    self._on_disconnected()

                self._run_on_main(_fail)
                return

            # 2. 设置系统代理（本地服务器已就绪）
            if self.config.data["mode"] == "global":
                try:
                    self.sys_proxy.enable(
                        socks_port=self.proxy.socks_port,
                        http_port=self.proxy.http_port,
                    )
                except Exception as e:
                    self._run_on_main(
                        lambda: self._show_notification(
                            "BlockProxyClient", "系统代理设置失败", str(e)
                        )
                    )

            # 3. 启动隧道客户端（独立于本地代理，失败不影响本地代理）
            if self._tunnel_enabled():
                self._start_tunnel()

            self._run_on_main(self._on_connected)

        threading.Thread(target=_start, daemon=True).start()

    def _begin_connecting(self):
        self._connecting = True
        self.toggle_item.setEnabled_(False)
        self.toggle_item.setTitle_("正在连接...")

    def _finish_connecting(self):
        if self._connecting:
            self._connecting = False
            self.toggle_item.setEnabled_(True)

    def _start_tunnel(self):
        """Start tunnel client. Called from _connect or health check.
        Failure is non-fatal — local proxy continues to work."""
        try:
            tc = TunnelClient(
                self.config.data,
                on_status_change=lambda status, detail="": None
            )
            tc.start()
            self.tunnel_client = tc
            self.proxy.set_tunnel_client(tc)
        except Exception as e:
            logger.warning(f"Failed to start tunnel client: {e}", exc_info=True)

    def _stop_tunnel(self):
        """Stop tunnel client only (local proxy keeps running)."""
        try:
            self.proxy.set_tunnel_client(None)
        except Exception as e:
            logger.warning(f"Failed to clear tunnel client reference: {e}")
        if self.tunnel_client:
            try:
                self.tunnel_client.stop()
            except Exception as e:
                logger.warning(f"Failed to stop tunnel client: {e}")
            self.tunnel_client = None

    def _on_connected(self):
        self._finish_connecting()
        self.connected = True
        self.toggle_item.setTitle_("关闭代理")
        self._update_icon()

    def _disconnect(self):
        self._disconnect_core()
        self._on_disconnected()

    def _disconnect_async(self):
        if self._disconnecting:
            return
        self._disconnecting = True
        self.toggle_item.setEnabled_(False)
        self.toggle_item.setTitle_("正在关闭代理...")

        def _stop():
            try:
                self._disconnect_core()
            finally:
                def _finish():
                    self._disconnecting = False
                    self.toggle_item.setEnabled_(True)
                    self._on_disconnected()

                self._run_on_main(_finish)

        threading.Thread(target=_stop, daemon=True).start()

    def _disconnect_core(self):
        try:
            self.sys_proxy.disable()
        except Exception as e:
            logger.warning(f"Failed to disable system proxy: {e}")

        self._stop_tunnel()

        try:
            self.proxy.stop()
        except Exception as e:
            logger.warning(f"Failed to stop proxy: {e}")

    def _on_disconnected(self):
        self._finish_connecting()
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

    def openSuperDns_(self, sender):
        if self._super_dns_proc and self._super_dns_proc.poll() is None:
            return
        self._show_super_dns_window()

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
        self.config.load()
        self.config.save()
        script_path = os.path.join(_bundle_resource_dir(), "config_window.py")
        python_path = self._find_python() if _is_compiled() else sys.executable
        args = [python_path, script_path, self.config.config_path]
        bundle_path = _bundle_path()
        if bundle_path:
            args.extend(["--app-path", bundle_path])
        self._config_proc = subprocess.Popen(args)

        def _reload_after():
            self._config_proc.wait()
            self._config_proc = None
            old_data = self.config.data.copy()
            self.config.load()
            self._run_on_main(self._update_routing_check)
            if self.connected and self.config.data != old_data:
                new_data = self.config.data.copy()
                # 如果只有 tunnel 配置变化，只重启隧道（本地代理保持运行）
                old_copy = old_data.copy()
                new_copy = new_data.copy()
                old_copy.pop('tunnel', None)
                new_copy.pop('tunnel', None)
                if old_copy == new_copy:
                    self._reconnect_tunnel_only()
                else:
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
            self._run_on_main(self._update_routing_check)
            if self.connected and new_routing != old_routing:
                self._run_on_main(self._reconnect)

        threading.Thread(target=_reload_after, daemon=True).start()

    def _show_super_dns_window(self):
        script_path = os.path.join(_bundle_resource_dir(), "super_dns_window.py")
        python_path = self._find_python() if _is_compiled() else sys.executable
        self._super_dns_proc = subprocess.Popen([python_path, script_path])

        def _clear_after():
            self._super_dns_proc.wait()
            self._super_dns_proc = None

        threading.Thread(target=_clear_after, daemon=True).start()

    def _reconnect(self):
        """Full reconnect: stop everything, restart everything."""
        self._disconnect()
        self._connect()

    def _reconnect_tunnel_only(self):
        """Restart only the tunnel client. Local proxy keeps running."""
        def _do():
            self._stop_tunnel()
            if self._tunnel_enabled():
                self._start_tunnel()
        threading.Thread(target=_do, daemon=True).start()

    def _tunnel_enabled(self):
        return (
            self.config.data.get('server', {}).get('protocol') == 'tunnel'
            or self.config.data.get('tunnel', {}).get('enabled')
        )

    def _local_port_is_listening(self, port):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except OSError:
            return False

    def _local_proxy_is_healthy(self):
        if not self.proxy.is_running():
            return False
        return (
            self._local_port_is_listening(self.proxy.socks_port)
            and self._local_port_is_listening(self.proxy.http_port)
        )

    def _sync_system_proxy_if_needed(self):
        if self.config.data.get("mode") != "global":
            return
        self.sys_proxy.enable(
            socks_port=self.proxy.socks_port,
            http_port=self.proxy.http_port,
        )

    def _restart_local_proxy_only(self):
        self.proxy.stop()
        self.proxy.start(
            self.config.data,
            config_dir=os.path.dirname(self.config.config_path),
        )
        self._sync_system_proxy_if_needed()

    def _ensure_local_proxy_after_wake(self):
        if not self.connected:
            return
        if self._local_proxy_is_healthy():
            try:
                self._sync_system_proxy_if_needed()
            except Exception as e:
                logger.warning(f"Failed to re-sync system proxy after wake: {e}")
            return
        logger.warning("Local proxy is not healthy after wake, restarting local proxy")
        import time
        max_retries = 3
        for attempt in range(max_retries):
            try:
                self._restart_local_proxy_only()
                # 验证重启是否成功
                time.sleep(0.5)
                if self._local_proxy_is_healthy():
                    logger.info("Local proxy recovered after wake (attempt %d)", attempt + 1)
                    return
                logger.warning("Local proxy restart did not restore ports (attempt %d/%d)",
                               attempt + 1, max_retries)
            except Exception as e:
                logger.warning("Failed to restart local proxy after wake (attempt %d/%d): %s",
                               attempt + 1, max_retries, e, exc_info=True)
                if attempt < max_retries - 1:
                    time.sleep(2)
        logger.error("Failed to recover local proxy after %d attempts", max_retries)
        self._run_on_main(
            lambda: self._show_notification(
                "BlockProxyClient",
                "本地代理恢复失败",
                f"尝试 {max_retries} 次后仍无法恢复，请手动重启代理",
            )
        )

    def _ensure_tunnel_after_wake(self):
        if not self.connected:
            return
        if not self._tunnel_enabled():
            return
        tc = self.tunnel_client
        if not tc:
            self._start_tunnel()
            return
        status = tc.get_status()
        if status in ('occupied', 'auth_failed'):
            logger.warning("Tunnel is in non-retryable state after wake: %s", status)
            return
        if not tc.is_thread_alive():
            logger.warning("Tunnel thread is not alive after wake, restarting tunnel")
            self._stop_tunnel()
            self._start_tunnel()
            return
        # Tunnel is alive — re-link to proxy (may have been cleared by proxy restart)
        self.proxy.set_tunnel_client(tc)

    # ------------------------------------------------------------------
    # About
    # ------------------------------------------------------------------

    def showAbout_(self, sender):
        NSApp.activateIgnoringOtherApps_(True)
        alert = NSAlert.alloc().init()
        alert.setMessageText_("关于 BlockProxyClient")
        alert.setInformativeText_(
            "项目：block-proxy\n"
            "作者：lijing00333\n"
            "地址：https://github.com/jayli/block-proxy\n"
            "版本：v0.1.5"
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
        # Remove sleep/wake observers
        nc = NSWorkspace.sharedWorkspace().notificationCenter()
        if self._sleep_obs:
            nc.removeObserver_(self._sleep_obs)
        if self._wake_obs:
            nc.removeObserver_(self._wake_obs)

        if self._config_proc and self._config_proc.poll() is None:
            self._config_proc.terminate()
        if self._routing_proc and self._routing_proc.poll() is None:
            self._routing_proc.terminate()
        if self._super_dns_proc and self._super_dns_proc.poll() is None:
            self._super_dns_proc.terminate()
        if self._log_proc and self._log_proc.poll() is None:
            self._log_proc.terminate()
        if self.connected:
            self._stop_tunnel()
            try:
                self.sys_proxy.disable()
            except Exception as e:
                logger.warning(f"Failed to disable system proxy on quit: {e}")
            try:
                self.proxy.stop()
            except Exception as e:
                logger.warning(f"Failed to stop proxy on quit: {e}")
        if not self.config.data.get("autostart", False):
            from autostart import disable
            disable()

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
                time.sleep(3)
                if not self.connected:
                    restart_count = 0
                    continue

                # 如果 wake handler 或手动重连正在处理，跳过本轮检查
                if self._reconnecting:
                    restart_count = 0
                    continue
                if self._connecting:
                    restart_count = 0
                    continue
                if self._disconnecting:
                    restart_count = 0
                    continue

                if self.proxy.is_running():
                    # 线程存活 — 检查端口是否仍在监听
                    if self._local_proxy_is_healthy():
                        restart_count = 0
                        # 检查隧道客户端线程是否存活
                        tc = self.tunnel_client  # snapshot to avoid race condition
                        if tc and tc.is_thread_alive():
                            # 检查隧道是否进入不可重试状态（不自动重启）
                            status = tc.get_status()
                            if status in ('occupied', 'auth_failed'):
                                crash_logger.warning(
                                    "Tunnel entered non-retryable state: %s", status
                                )
                        elif tc and not tc.is_thread_alive():
                            status = tc.get_status()
                            if status in ('occupied', 'auth_failed'):
                                crash_logger.warning(
                                    "Tunnel stopped in non-retryable state: %s", status
                                )
                                continue
                            crash_logger.warning("Tunnel client thread died, restarting")
                            try:
                                tc.stop()
                                new_tc = TunnelClient(
                                    self.config.data,
                                    on_status_change=lambda status, detail="": None
                                )
                                new_tc.start()
                                self.tunnel_client = new_tc
                                self.proxy.set_tunnel_client(new_tc)
                                crash_logger.warning("Tunnel client restarted")
                            except Exception as e:
                                crash_logger.warning(
                                    "Tunnel client restart failed: %s", e, exc_info=True
                                )
                        continue

                    # 线程存活但端口不可用（休眠唤醒或系统事件导致 socket 失效）
                    crash_logger.warning(
                        "Proxy thread alive but ports not listening, restarting local proxy"
                    )
                else:
                    crash_logger.warning("Proxy thread died")

                restart_count += 1
                crash_logger.warning(
                    "Proxy unhealthy, attempting restart (%d/%d)",
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
                    # 重启时同步重建隧道客户端
                    if self._tunnel_enabled():
                        old_tc = self.tunnel_client
                        if old_tc:
                            try:
                                old_tc.stop()
                            except Exception:
                                pass
                        self._start_tunnel()
                    # 重启后端口可能偏移，重新同步系统代理
                    if self.config.data.get("mode") == "global":
                        try:
                            self.sys_proxy.enable(
                                socks_port=self.proxy.socks_port,
                                http_port=self.proxy.http_port,
                            )
                        except Exception as e:
                            crash_logger.warning(
                                "System proxy re-sync failed after restart: %s", e,
                                exc_info=True,
                            )
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
        self._update_super_dns_menu_title()
        if not self.connected or self._measuring:
            return
        self._measuring = True

        def _check():
            try:
                result = self.proxy.measure_latency()

                def _update():
                    if not self.connected:
                        return
                    if result is None:
                        # 代理未运行，不更新标题
                        return
                    protocol_name, latency, failure_reason = result
                    # 中英文之间加空格，中文之间不加空格
                    if protocol_name.isascii():
                        proto_display = f"{protocol_name} 已连接"
                    else:
                        proto_display = f"{protocol_name}已连接"
                    if latency is not None:
                        self.toggle_item.setTitle_(
                            f"关闭代理（{proto_display} - {latency}ms）"
                        )
                    else:
                        reason_map = {
                            "auth_failed": "鉴权失败",
                            "unreachable": "节点不通",
                            "reconnecting": "重试中...",
                        }
                        suffix = reason_map.get(failure_reason)
                        if suffix:
                            if protocol_name.isascii():
                                self.toggle_item.setTitle_(
                                    f"关闭代理（{protocol_name} 已中断 - {suffix}）"
                                )
                            else:
                                self.toggle_item.setTitle_(
                                    f"关闭代理（{protocol_name}已中断 - {suffix}）"
                                )
                        else:
                            if protocol_name.isascii():
                                self.toggle_item.setTitle_(
                                    f"关闭代理（{protocol_name} 已中断）"
                                )
                            else:
                                self.toggle_item.setTitle_(
                                    f"关闭代理（{protocol_name}已中断）"
                                )

                self._run_on_main(_update)
            finally:
                self._measuring = False

        threading.Thread(target=_check, daemon=True).start()

    # ------------------------------------------------------------------
    # System sleep/wake handling
    # ------------------------------------------------------------------

    def onSystemWillSleep_(self, notification):
        """System is about to sleep. Save connection state for later reconnection."""
        if not self.connected:
            return
        self._was_connected = True
        # Check if tunnel mode is enabled
        tunnel_enabled = self.config.data.get('tunnel', {}).get('enabled', False)
        protocol = self.config.data.get('server', {}).get('protocol', 'socks5')
        if tunnel_enabled or protocol == 'tunnel':
            logger.info("System will sleep, marking for reconnection on wake")

    def onSystemDidWake_(self, notification):
        """System just woke up. Repair local proxy if it was lost during sleep."""
        if not self._was_connected:
            return
        self._was_connected = False

        if self._reconnecting:
            logger.info("Already reconnecting, skipping duplicate wake handler")
            return

        def _do_reconnect():
            try:
                self._reconnecting = True
                logger.info("System woke up, checking local proxy...")

                # Wait for network stack to stabilize (Wi-Fi reconnection can take 3-5s)
                import time
                time.sleep(3)

                self._ensure_local_proxy_after_wake()
                self._ensure_tunnel_after_wake()

            except Exception as e:
                logger.error(f"Failed to check proxy after wake: {e}", exc_info=True)
            finally:
                self._reconnecting = False

        # Run reconnection in background thread
        threading.Thread(target=_do_reconnect, daemon=True).start()

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


class BlockProxyClient:
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
