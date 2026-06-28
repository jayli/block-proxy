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
)


BEZEL_SQUARE = 1  # NSTextFieldSquareBezel
BEZEL_ROUNDED = 1  # NSRoundedBezelStyle
TEXT_RIGHT = 2  # NSRightTextAlignment
WINDOW_STYLE = (
    NSWindowStyleMaskTitled
    | NSWindowStyleMaskClosable
    | NSWindowStyleMaskMiniaturizable
)


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
            cb.setState_(1 if default else 0)
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
        self._protocol_popup.addItemsWithTitles_(["socks5", "http"])
        self._protocol_popup.selectItemWithTitle_(
            config["server"].get("protocol", "socks5")
        )
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
            default = str(config["server"].get(key, ""))
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
            default = str(config["local"].get(key, ""))
            self._fields[key] = text_field(y_pos, default)
            y_pos -= row_h + 4

        y_pos -= 4
        separator(y_pos)
        y_pos -= 32

        # Checkboxes
        self._tls_cb = checkbox(y_pos, "启用 TLS（需节点服务器支持）", config["server"].get("tls", True))
        y_pos -= row_h + 4

        self._insecure_cb = checkbox(y_pos, "允许不安全连接（跳过证书验证）", config["server"].get("allowInsecure", True))
        y_pos -= row_h + 4

        self._udp_cb = checkbox(y_pos, "启用 UDP", config["local"].get("udp", True))
        y_pos -= row_h + 4

        self._proxy_private_cb = checkbox(
            y_pos, "代理私有地址段（192.168.x / 172.16.x / 10.x）",
            config["local"].get("proxy_private", False),
        )
        y_pos -= row_h + 4

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

    def _delegate(self):
        delegate = _ConfigWindowDelegate.alloc().init()
        self._delegate_ref = delegate  # keep alive
        return delegate

    def show(self):
        self._window.center()
        self._window.makeKeyAndOrderFront_(None)
        NSApp.activateIgnoringOtherApps_(True)

    def saveAndClose_(self, sender):
        config = self._config

        config["server"]["protocol"] = self._protocol_popup.titleOfSelectedItem()
        config["server"]["address"] = self._fields["address"].stringValue()
        config["server"]["port"] = int(self._fields["port"].stringValue())
        config["server"]["username"] = self._fields["username"].stringValue()
        config["server"]["password"] = self._fields["password"].stringValue()
        config["server"]["tls"] = bool(self._tls_cb.state())
        config["server"]["allowInsecure"] = bool(self._insecure_cb.state())
        config["local"]["socks_port"] = int(self._fields["socks_port"].stringValue())
        config["local"]["http_port"] = int(self._fields["http_port"].stringValue())
        config["local"]["udp"] = bool(self._udp_cb.state())
        config["local"]["proxy_private"] = bool(self._proxy_private_cb.state())
        config["autostart"] = bool(self._autostart_cb.state())

        from autostart import sync
        sync(getattr(self, "_app_path", None), config["autostart"])

        with open(self._config_path, "w") as f:
            json.dump(config, f, indent=2)

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
