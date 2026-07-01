"""
Reverse tunnel configuration window.
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
    NSButton,
    NSButtonTypeSwitch,
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


class _TunnelWindowDelegate(NSObject):
    def windowWillClose_(self, notification):
        NSApp.stopModal()


class TunnelWindowController(NSObject):

    def initWithConfigPath_(self, config_path):
        self = objc.super(TunnelWindowController, self).init()
        if self is None:
            return None
        self._config_path = config_path
        with open(config_path, "r") as f:
            self._config = json.load(f)
        self._build_window()
        return self

    def _build_window(self):
        config = self._config
        tunnel_cfg = config.get("tunnel", {})
        w, h = 380, 260
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
        win.setTitle_("反向隧道")
        win.setLevel_(NSFloatingWindowLevel)
        win.setDelegate_(self._delegate())

        content = win.contentView()

        LX, CX, FW = 12, 130, 230
        row_h = 28
        y_pos = h - 40

        def label(text, y):
            lbl = NSTextField.labelWithString_(text)
            lbl.setFrame_(((LX, y), (110, 22)))
            lbl.setAlignment_(TEXT_RIGHT)
            content.addSubview_(lbl)

        def text_field(y, default, placeholder=""):
            fld = NSTextField.alloc().initWithFrame_(((CX, y), (FW, 24)))
            fld.setBezeled_(True)
            fld.setBezelStyle_(BEZEL_SQUARE)
            fld.setStringValue_(default)
            if placeholder:
                fld.setPlaceholderString_(placeholder)
            content.addSubview_(fld)
            return fld

        def checkbox(y, title, default):
            cb = NSButton.alloc().initWithFrame_(((CX, y), (FW, 26)))
            cb.setButtonType_(NSButtonTypeSwitch)
            cb.setTitle_(title)
            cb.setState_(1 if default else 0)
            content.addSubview_(cb)
            return cb

        # Enable tunnel toggle
        self._enabled_cb = checkbox(y_pos, "启用反向隧道", tunnel_cfg.get("enabled", False))
        y_pos -= row_h + 12

        # Server address
        label("服务器地址:", y_pos)
        self._address_field = text_field(
            y_pos,
            tunnel_cfg.get("server_address", ""),
            placeholder="留空使用代理服务器地址",
        )
        y_pos -= row_h + 4

        # Server port
        label("服务器端口:", y_pos)
        self._port_field = text_field(
            y_pos,
            str(tunnel_cfg.get("server_port", 8004)),
        )
        y_pos -= row_h + 20

        # Apply button
        btn = NSButton.alloc().initWithFrame_(((w // 2 - 50, y_pos), (100, 28)))
        btn.setTitle_("应用并重启代理")
        btn.setBezelStyle_(BEZEL_ROUNDED)
        btn.setTarget_(self)
        btn.setAction_("saveAndClose:")
        content.addSubview_(btn)

        self._window = win

    def _delegate(self):
        delegate = _TunnelWindowDelegate.alloc().init()
        self._delegate_ref = delegate  # keep alive
        return delegate

    def show(self):
        self._window.center()
        self._window.makeKeyAndOrderFront_(None)
        NSApp.activateIgnoringOtherApps_(True)

    def saveAndClose_(self, sender):
        config = self._config

        if "tunnel" not in config:
            config["tunnel"] = {}

        config["tunnel"]["enabled"] = bool(self._enabled_cb.state())
        config["tunnel"]["server_address"] = self._address_field.stringValue()

        port_str = self._port_field.stringValue()
        try:
            config["tunnel"]["server_port"] = int(port_str)
        except ValueError:
            config["tunnel"]["server_port"] = 8004

        with open(self._config_path, "w") as f:
            json.dump(config, f, indent=2)

        self._window.close()
        NSApp.stopModal()


def show_tunnel_window(config_path):
    ctrl = TunnelWindowController.alloc().initWithConfigPath_(config_path)
    if ctrl is None:
        return
    ctrl.show()
    NSApp.runModalForWindow_(ctrl._window)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("config_path")
    args = parser.parse_args()

    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
    show_tunnel_window(args.config_path)
