"""
BlockProxyClient configuration window.
Pure PyObjC implementation (no tkinter dependency).
Launched as a subprocess from the main status bar app.
"""

import os
import sys

if __name__ == "__main__":
    _script_dir = os.path.dirname(os.path.abspath(__file__))
    while _script_dir in sys.path:
        sys.path.remove(_script_dir)
    sys.path.append(_script_dir)

import json
import objc
import platform

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
    NSFont,
    NSMenu,
    NSMenuItem,
    NSPopUpButton,
    NSBox,
    NSColor,
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

def _setup_minimal_menu():
    """Create a minimal main menu with Edit items so Cmd+C/V/X/A/Z work."""
    main_menu = NSMenu.alloc().initWithTitle_("MainMenu")

    app_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("", "", "")
    main_menu.addItem_(app_item)
    app_menu = NSMenu.alloc().initWithTitle_("")
    app_item.setSubmenu_(app_menu)

    edit_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("Edit", "", "")
    main_menu.addItem_(edit_item)
    edit_menu = NSMenu.alloc().initWithTitle_("Edit")
    edit_item.setSubmenu_(edit_menu)

    edit_menu.addItemWithTitle_action_keyEquivalent_("Undo", "undo:", "z")
    edit_menu.addItemWithTitle_action_keyEquivalent_("Redo", "redo:", "Z")
    edit_menu.addItem_(NSMenuItem.separatorItem())
    edit_menu.addItemWithTitle_action_keyEquivalent_("Cut", "cut:", "x")
    edit_menu.addItemWithTitle_action_keyEquivalent_("Copy", "copy:", "c")
    edit_menu.addItemWithTitle_action_keyEquivalent_("Paste", "paste:", "v")
    edit_menu.addItemWithTitle_action_keyEquivalent_("Select All", "selectAll:", "a")

    NSApp.setMainMenu_(main_menu)


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
        self._tunnel_port_value = str(tunnel_cfg.get("server_port", 8003))
        self._cert_pin = server_cfg.get("certPin", "") or ""
        self._cert_pin_mismatch = bool(server_cfg.get("certPinMismatch", False))
        self._cert_pin_touched = False
        self._initial_server_identity = (
            server_cfg.get("address", ""),
            int(server_cfg.get("port", 8002)),
            protocol,
            bool(server_cfg.get("tls", True)),
        )

        w, h = 420, 615
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

        # Left column width, control offsets, field width
        LX, CX, FW = 12, 130, 270
        CHECK_X = 76
        HINT_X = 102
        UI_FONT_SIZE = 13
        CERT_BIND_OFFSET_Y = 5
        LOWER_CONTROLS_OFFSET_Y = 15
        FOOTER_CONTROLS_OFFSET_Y = 5
        ui_font = NSFont.systemFontOfSize_(UI_FONT_SIZE)
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

        def checkbox(y, title, default, width=None):
            cb = NSButton.alloc().initWithFrame_(
                ((CHECK_X, y), (width or (w - CHECK_X - 16), 26))
            )
            cb.setButtonType_(NSButtonTypeSwitch)
            cb.setTitle_(title)
            cb.setFont_(ui_font)
            cb.setState_(NSOnState if default else NSOffState)
            content.addSubview_(cb)
            return cb

        def hint_label(y, text, height=20):
            lbl = NSTextField.labelWithString_(text)
            lbl.setFrame_(((HINT_X, y), (w - HINT_X - 16, height)))
            lbl.setFont_(ui_font)
            content.addSubview_(lbl)
            return lbl

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
        self._tls_cb.setTarget_(self)
        self._tls_cb.setAction_("onTlsChange:")
        y_pos -= row_h + 4

        self._insecure_cb = checkbox(y_pos, "允许不安全连接（跳过证书验证）", server_cfg.get("allowInsecure", True))
        self._insecure_cb.setTarget_(self)
        self._insecure_cb.setAction_("onAllowInsecureChange:")
        y_pos -= 20

        self._insecure_hint_label = hint_label(y_pos, "")
        y_pos -= 20

        cert_bind_y = y_pos - CERT_BIND_OFFSET_Y
        self._cert_bind_cb = checkbox(
            cert_bind_y, "绑定服务器证书", server_cfg.get("certBindEnabled", False)
        )
        self._cert_bind_cb.setTarget_(self)
        self._cert_bind_cb.setAction_("onCertBindChange:")
        y_pos -= 20

        cert_bind_label_y = y_pos - CERT_BIND_OFFSET_Y
        self._cert_bind_label = hint_label(cert_bind_label_y, "")
        y_pos -= 22

        self._cert_pin_error_label = hint_label(
            y_pos, "证书指纹不匹配（中间人攻击 or 服务端证书已更新）", height=28
        )
        self._cert_pin_error_label.setTextColor_(NSColor.systemRedColor())

        self._reset_pin_btn = NSButton.alloc().initWithFrame_(
            ((HINT_X + 190, y_pos + 39), (70, 22))
        )
        self._reset_pin_btn.setTitle_("重置")
        self._reset_pin_btn.setBezelStyle_(BEZEL_ROUNDED)
        self._reset_pin_btn.setFont_(ui_font)
        self._reset_pin_btn.setTarget_(self)
        self._reset_pin_btn.setAction_("resetCertPin:")
        self._reset_pin_btn.setHidden_(True)
        content.addSubview_(self._reset_pin_btn)
        y_pos -= 28

        y_pos += LOWER_CONTROLS_OFFSET_Y
        self._udp_cb = checkbox(y_pos, "启用 UDP", config.get("local", {}).get("udp", True))
        y_pos -= row_h + 4

        self._proxy_private_cb = checkbox(
            y_pos, "代理私有地址段（192.168.x / 172.16.x / 10.x）",
            config.get("local", {}).get("proxy_private", False),
        )
        y_pos -= row_h + 4

        if is_tunnel:
            self._set_tunnel_mode(True)
        self._refresh_insecure_hint()
        self._refresh_cert_bind_ui()

        separator(y_pos)
        y_pos -= 32

        y_pos += FOOTER_CONTROLS_OFFSET_Y
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
        self._refresh_insecure_hint()
        self._refresh_cert_bind_ui()

    def _selected_protocol(self):
        idx = self._protocol_popup.indexOfSelectedItem()
        return PROTOCOLS[idx][0]

    def _tls_enabled(self):
        return bool(self._tls_cb.state())

    def _refresh_insecure_hint(self):
        if not hasattr(self, "_insecure_hint_label"):
            return
        insecure_supported = self._selected_protocol() != "tunnel" and self._tls_enabled()
        self._insecure_cb.setEnabled_(insecure_supported)
        if bool(self._insecure_cb.state()):
            self._insecure_hint_label.setStringValue_("允许自签证书")
        else:
            self._insecure_hint_label.setStringValue_("只接受信任的 CA 签发的证书")
        if insecure_supported:
            self._insecure_hint_label.setTextColor_(NSColor.labelColor())
        else:
            self._insecure_hint_label.setTextColor_(NSColor.disabledControlTextColor())

    def _refresh_cert_bind_ui(self):
        if not hasattr(self, "_cert_bind_cb"):
            return
        supported = self._selected_protocol() == "socks5" and self._tls_enabled()
        self._cert_bind_cb.setHidden_(False)
        self._cert_bind_label.setHidden_(False)
        self._cert_bind_cb.setEnabled_(supported)

        enabled = bool(self._cert_bind_cb.state())
        has_pin = bool(self._cert_pin)
        if not enabled:
            self._cert_bind_label.setStringValue_("勾选后首次连接时自动绑定证书指纹")
        elif self._cert_pin_mismatch:
            self._cert_bind_label.setStringValue_("证书指纹不匹配（中间人攻击 or 服务端证书已更新）")
        elif has_pin:
            self._cert_bind_label.setStringValue_(
                f"证书指纹：{self._cert_pin[:24]}..."
            )
        else:
            self._cert_bind_label.setStringValue_("首次连接时将自动绑定证书指纹")

        if supported and enabled and self._cert_pin_mismatch:
            self._cert_bind_label.setTextColor_(NSColor.systemRedColor())
        elif supported:
            self._cert_bind_label.setTextColor_(NSColor.labelColor())
        else:
            self._cert_bind_label.setTextColor_(NSColor.disabledControlTextColor())

        self._reset_pin_btn.setHidden_(not (supported and enabled and has_pin))
        self._cert_pin_error_label.setHidden_(True)

    def onAllowInsecureChange_(self, sender):
        self._refresh_insecure_hint()

    def onTlsChange_(self, sender):
        self._refresh_insecure_hint()
        self._refresh_cert_bind_ui()

    def onCertBindChange_(self, sender):
        self._cert_pin_touched = True
        if not bool(self._cert_bind_cb.state()):
            self._cert_pin = ""
            self._cert_pin_mismatch = False
        self._refresh_cert_bind_ui()

    def resetCertPin_(self, sender):
        self._cert_pin = ""
        self._cert_pin_mismatch = False
        self._cert_pin_touched = True
        if hasattr(self, "_cert_bind_cb"):
            self._cert_bind_cb.setState_(NSOnState)
        self._refresh_cert_bind_ui()

    def onProtocolChange_(self, sender):
        key = self._selected_protocol()
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
        self._refresh_cert_bind_ui()

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
        with open(self._config_path, "r") as f:
            config = json.load(f)
        config.setdefault("server", {})
        config.setdefault("local", {})

        protocol = self._selected_protocol()
        is_tunnel = protocol == "tunnel"

        config["server"]["protocol"] = protocol
        config["server"]["address"] = self._fields["address"].stringValue()

        port_str = self._fields["port"].stringValue()
        port = int(port_str) if port_str else (8003 if is_tunnel else 8002)

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

        cert_bind_enabled = bool(
            self._cert_bind_cb.state()
        ) if hasattr(self, "_cert_bind_cb") else bool(
            config["server"].get("certBindEnabled", False)
        )
        current_identity = (
            config["server"].get("address", ""),
            int(config["server"].get("port", 8002)),
            protocol,
            bool(config["server"].get("tls", True)),
        )
        identity_changed = current_identity != getattr(
            self, "_initial_server_identity", current_identity
        )

        config["server"]["certBindEnabled"] = cert_bind_enabled
        if not cert_bind_enabled or identity_changed:
            config["server"]["certPin"] = ""
            config["server"]["certPinMismatch"] = False
        elif getattr(self, "_cert_pin_touched", False):
            config["server"]["certPin"] = getattr(self, "_cert_pin", "")
            config["server"]["certPinMismatch"] = bool(
                getattr(self, "_cert_pin_mismatch", False)
            )

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
    _setup_minimal_menu()
    show_config_window(args.config_path, args.app_path)
