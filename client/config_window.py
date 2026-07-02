"""
SocksClient configuration window.
Pure PyObjC implementation (no tkinter dependency).
Launched as a subprocess from the main status bar app.
"""

import json
import objc
import os
import platform
import sys

from Foundation import NSObject
from AppKit import (
    NSApplication,
    NSApplicationActivationPolicyAccessory,
    NSWindow,
    NSFloatingWindowLevel,
    NSWindowStyleMaskTitled,
    NSWindowStyleMaskClosable,
    NSWindowStyleMaskMiniaturizable,
    NSBackingStoreBuffered,
    NSTextField,
    NSSecureTextField,
    NSButton,
    NSButtonTypeSwitch,
    NSPopUpButton,
    NSBox,
    NSScreen,
    NSApp,
    NSOnState,
    NSOffState,
)


BEZEL_SQUARE = 1  # NSTextFieldSquareBezel
BEZEL_ROUNDED = 1  # NSRoundedBezelStyle
TEXT_RIGHT = 2  # NSRightTextAlignment
WINDOW_STYLE = (
    NSWindowStyleMaskTitled
    | NSWindowStyleMaskClosable
    | NSWindowStyleMaskMiniaturizable
)

PROTOCOLS = [("socks5", "socks5"), ("http", "http"), ("tunnel", "隧道(双向)")]


def _center_on_mouse_screen(w, h):
    if platform.system() == "Darwin":
        try:
            from AppKit import NSScreen, NSEvent
            mouse_loc = NSEvent.mouseLocation()
            primary_h = NSScreen.screens()[0].frame().size.height
            for screen in NSScreen.screens():
                sf = screen.frame()
                if (
                    sf.origin.x <= mouse_loc.x < sf.origin.x + sf.size.width
                    and sf.origin.y <= mouse_loc.y < sf.origin.y + sf.size.height
                ):
                    vf = screen.visibleFrame()
                    x = int(vf.origin.x + (vf.size.width - w) / 2)
                    y = int(
                        primary_h
                        - vf.origin.y
                        - vf.size.height
                        + (vf.size.height - h) / 2
                    )
                    return x, y
        except Exception:
            pass
    return None


class _ConfigWindowDelegate(NSObject):
    def windowWillClose_(self, notification):
        NSApp.stopModal()


class ConfigWindowController(NSObject):

    def initWithConfigPath_(self, config_path):
        self = objc.super(ConfigWindowController, self).init()
        if self is None:
            return None
        self._config_path = config_path
        with open(config_path, "r") as f:
            self._config = json.load(f)
        self._build_window()
        return self

    def _build_window(self):
        config = self._config
        server_cfg = config.get("server", {})
        tunnel_cfg = config.get("tunnel", {})
        protocol = server_cfg.get("protocol", "socks5")

        self._server_port_value = str(server_cfg.get("port", 8002))
        self._tunnel_port_value = str(tunnel_cfg.get("server_port", 8004))

        w, h = 420, 560
        pos = _center_on_mouse_screen(w, h)
        if pos is None:
            x = (NSScreen.mainScreen().frame().size.width - w) // 2
            y = (NSScreen.mainScreen().frame().size.height - h) // 2
        else:
            x, y = pos

        origin = ((x, y), (w, h))
        win = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            origin, WINDOW_STYLE, NSBackingStoreBuffered, False
        )
        win.setTitle_("节点配置")
        win.setLevel_(NSFloatingWindowLevel)
        win.setDelegate_(self._delegate())

        content = win.contentView()

        # Left column width, control offset, field width
        LX, CX, FW = 12, 130, 270
        row_h = 28
        y_pos = h - 40

        def label(text, y):
            lbl = NSTextField.labelWithString_(text)
            lbl.setFrame_(((LX, y), (110, 22)))
            lbl.setAlignment_(TEXT_RIGHT)
            content.addSubview_(lbl)

        def text_field(y, default, secure=False):
            cls = NSSecureTextField if secure else NSTextField
            fld = cls.alloc().initWithFrame_(((CX, y), (FW, 24)))
            fld.setBezeled_(True)
            fld.setBezelStyle_(BEZEL_SQUARE)
            fld.setStringValue_(default)
            content.addSubview_(fld)
            return fld

        def checkbox(y, title, default):
            cb = NSButton.alloc().initWithFrame_(((CX, y), (FW, 26)))
            cb.setButtonType_(NSButtonTypeSwitch)
            cb.setTitle_(title)
            cb.setState_(NSOnState if default else NSOffState)
            content.addSubview_(cb)
            return cb

        def separator(y):
            sep = NSBox.alloc().initWithFrame_(((12, y + 13), (w - 24, 2)))
            sep.setBoxType_(2)  # NSBoxSeparator
            content.addSubview_(sep)

        # Protocol row
        label("协议:", y_pos)
        self._protocol_popup = NSPopUpButton.alloc().initWithFrame_(
            ((CX, y_pos - 2), (100, 24))
        )
        self._protocol_popup.setTarget_(self)
        self._protocol_popup.setAction_("onProtocolChange:")

        # Build items; select by config value
        selected_idx = 0
        for idx, (key, title) in enumerate(PROTOCOLS):
            self._protocol_popup.addItemWithTitle_(title)
            if key == protocol:
                selected_idx = idx
        self._protocol_popup.selectItemAtIndex_(selected_idx)
        content.addSubview_(self._protocol_popup)
        y_pos -= row_h + 6

        # Server fields
        self._fields = {}
        for key, lbl_text in [
            ("address", "地址:"),
            ("port", "端口:"),
            ("username", "用户名:"),
            ("password", "密码:"),
        ]:
            label(lbl_text, y_pos)
            secure = key == "password"
            if key == "port":
                default = self._tunnel_port_value if protocol == "tunnel" else self._server_port_value
            else:
                default = str(server_cfg.get(key, ""))
            self._fields[key] = text_field(y_pos, default, secure=secure)
            y_pos -= row_h + 4

        y_pos -= 4
        separator(y_pos)
        y_pos -= 32

        # Local fields
        for key, lbl_text in [
            ("socks_port", "本地SOCKS端口:"),
            ("http_port", "本地HTTP端口:"),
        ]:
            label(lbl_text, y_pos)
            default = str(config.get("local", {}).get(key, ""))
            self._fields[key] = text_field(y_pos, default)
            y_pos -= row_h + 4

        y_pos -= 4
        separator(y_pos)
        y_pos -= 32

        # Checkboxes
        is_tunnel = protocol == "tunnel"
        tls_default = True if is_tunnel else server_cfg.get("tls", True)
        self._tls_cb = checkbox(y_pos, "启用 TLS（需节点服务器支持）", tls_default)
        y_pos -= row_h + 4

        self._insecure_cb = checkbox(y_pos, "允许不安全连接（跳过证书验证）", server_cfg.get("allowInsecure", True))
        y_pos -= row_h + 4

        self._udp_cb = checkbox(y_pos, "启用 UDP", config.get("local", {}).get("udp", True))
        y_pos -= row_h + 4

        self._proxy_private_cb = checkbox(
            y_pos, "代理私有地址段（192.168.x / 172.16.x / 10.x）",
            config.get("local", {}).get("proxy_private", False),
        )
        y_pos -= row_h + 4

        if is_tunnel:
            self._set_tunnel_mode(True)

        separator(y_pos)
        y_pos -= 32

        self._autostart_cb = checkbox(y_pos, "开机启动", config.get("autostart", False))
        y_pos -= row_h + 10

        # Save button
        btn = NSButton.alloc().initWithFrame_(((w // 2 - 50, y_pos), (100, 28)))
        btn.setTitle_("保存")
        btn.setBezelStyle_(BEZEL_ROUNDED)
        btn.setTarget_(self)
        btn.setAction_("saveAndClose:")
        content.addSubview_(btn)

        self._window = win

    # ------------------------------------------------------------------
    # Protocol change callback
    # ------------------------------------------------------------------

    def _set_tunnel_mode(self, enabled):
        """Enable/disable tunnel-only UI state."""
        if enabled:
            self._tls_cb.setState_(NSOnState)
            self._proxy_private_cb.setState_(NSOffState)
        self._tls_cb.setEnabled_(not enabled)
        self._insecure_cb.setEnabled_(not enabled)
        self._udp_cb.setEnabled_(not enabled)
        self._proxy_private_cb.setEnabled_(not enabled)

    def onProtocolChange_(self, sender):
        idx = self._protocol_popup.indexOfSelectedItem()
        key = PROTOCOLS[idx][0]
        is_tunnel = key == "tunnel"

        if is_tunnel:
            # Remember current port as server.port, switch to tunnel port
            self._server_port_value = self._fields["port"].stringValue()
            self._fields["port"].setStringValue_(self._tunnel_port_value)
        else:
            # Remember current port as tunnel port, restore server port
            self._tunnel_port_value = self._fields["port"].stringValue()
            self._fields["port"].setStringValue_(self._server_port_value)

        self._set_tunnel_mode(is_tunnel)

    # ------------------------------------------------------------------
    # Delegate / show / save
    # ------------------------------------------------------------------

    def _delegate(self):
        delegate = _ConfigWindowDelegate.alloc().init()
        self._delegate_ref = delegate  # keep alive
        return delegate

    def show(self):
        self._window.center()
        self._window.makeKeyAndOrderFront_(None)
        NSApp.activateIgnoringOtherApps_(True)

    def _commit_active_editing(self):
        if hasattr(self, "_window"):
            self._window.makeFirstResponder_(None)

    def saveAndClose_(self, sender):
        self._commit_active_editing()
        config = self._config

        idx = self._protocol_popup.indexOfSelectedItem()
        protocol = PROTOCOLS[idx][0]
        is_tunnel = protocol == "tunnel"

        config["server"]["protocol"] = protocol
        config["server"]["address"] = self._fields["address"].stringValue()

        port_str = self._fields["port"].stringValue()
        port = int(port_str) if port_str else (8004 if is_tunnel else 8002)

        if is_tunnel:
            config["server"]["port"] = int(self._server_port_value) if self._server_port_value else 8002
            if "tunnel" not in config:
                config["tunnel"] = {}
            config["tunnel"]["server_port"] = port
            config["tunnel"]["enabled"] = True
            # Tunnel always uses TLS
            config["server"]["tls"] = True
            config["server"]["allowInsecure"] = bool(self._insecure_cb.state())
        else:
            config["server"]["port"] = port
            if "tunnel" in config:
                config["tunnel"]["enabled"] = False
            config["server"]["tls"] = bool(self._tls_cb.state())
            config["server"]["allowInsecure"] = bool(self._insecure_cb.state())

        config["server"]["username"] = self._fields["username"].stringValue()
        config["server"]["password"] = self._fields["password"].stringValue()
        config["local"]["socks_port"] = int(self._fields["socks_port"].stringValue() or "1080")
        config["local"]["http_port"] = int(self._fields["http_port"].stringValue() or "1087")
        config["local"]["udp"] = bool(self._udp_cb.state())
        config["local"]["proxy_private"] = bool(self._proxy_private_cb.state())
        config["autostart"] = bool(self._autostart_cb.state())

        with open(self._config_path, "w") as f:
            json.dump(config, f, indent=2)

        from autostart import sync
        sync(getattr(self, "_app_path", None), config["autostart"])

        self._window.close()
        NSApp.stopModal()


def show_config_window(config_path, app_path=None):
    ctrl = ConfigWindowController.alloc().initWithConfigPath_(config_path)
    if ctrl is None:
        return
    ctrl._app_path = app_path
    ctrl.show()
    NSApp.runModalForWindow_(ctrl._window)


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
