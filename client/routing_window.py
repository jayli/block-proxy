"""
SocksClient routing rules window.
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
    NSWindowStyleMaskResizable,
    NSBackingStoreBuffered,
    NSTextField,
    NSButton,
    NSButtonTypeSwitch,
    NSPopUpButton,
    NSTabView,
    NSTabViewItem,
    NSView,
    NSApp,
    NSScrollView,
    NSTextView,
    NSBezelBorder,
    NSFont,
    NSColor,
    NSMenu,
    NSMenuItem,
)


BEZEL_ROUNDED = 1
WINDOW_STYLE = (
    NSWindowStyleMaskTitled
    | NSWindowStyleMaskClosable
    | NSWindowStyleMaskMiniaturizable
    | NSWindowStyleMaskResizable
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


class _RoutingWindowDelegate(NSObject):
    def windowWillClose_(self, notification):
        NSApp.stopModal()


def _rules_to_text(rules):
    return "\n".join(rules)


def _parse_rules_text(text):
    lines = []
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped:
            lines.append(stripped)
    return lines


class RoutingWindowController(NSObject):

    def initWithConfigPath_(self, config_path):
        self = objc.super(RoutingWindowController, self).init()
        if self is None:
            return None
        self._config_path = config_path
        with open(config_path, "r") as f:
            self._config = json.load(f)
        self._routing = self._config.get("routing", {
            "enabled": False,
            "direct_rules": [],
            "proxy_rules": [],
            "default": "proxy",
        })
        self._build_window()
        return self

    def _build_window(self):
        routing = self._routing
        w, h = 460, 480
        pos = _center_on_mouse_screen(w, h)
        if pos is None:
            from AppKit import NSScreen
            x = int((NSScreen.mainScreen().frame().size.width - w) / 2)
            y = int((NSScreen.mainScreen().frame().size.height - h) / 2)
        else:
            x, y = pos

        origin = ((x, y), (w, h))
        win = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            origin, WINDOW_STYLE, NSBackingStoreBuffered, False
        )
        win.setTitle_("分流规则")
        win.setDelegate_(self._delegate())

        content = win.contentView()
        p = 15

        # ---- bottom bar (114px): default | 6px | checkbox | 8px | save+hint ----
        bar_h = 114

        default_lbl = NSTextField.labelWithString_("默认规则:")
        default_lbl.setFrame_(((p, 92), (58, 17)))
        content.addSubview_(default_lbl)

        default_popup = NSPopUpButton.alloc().initWithFrame_(
            ((p + 60, 88), (80, 22))
        )
        default_popup.addItemsWithTitles_(["proxy", "direct"])
        default_popup.selectItemWithTitle_(routing.get("default", "proxy"))
        content.addSubview_(default_popup)
        self._default_popup = default_popup

        enabled_cb = NSButton.alloc().initWithFrame_(
            ((p, 60), (w - 2 * p, 22))
        )
        enabled_cb.setButtonType_(NSButtonTypeSwitch)
        enabled_cb.setTitle_("启用分流规则")
        enabled_cb.setState_(1 if routing.get("enabled", False) else 0)
        content.addSubview_(enabled_cb)
        self._enabled_cb = enabled_cb

        btn = NSButton.alloc().initWithFrame_(((w - 110, 27), (100, 28)))
        btn.setTitle_("保存")
        btn.setBezelStyle_(BEZEL_ROUNDED)
        btn.setTarget_(self)
        btn.setAction_("saveAndClose:")
        content.addSubview_(btn)

        hint = NSTextField.labelWithString_(
            "domain:example.com  geosite:cn  geoip:!cn     # 开头为注释"
        )
        hint.setFont_(NSFont.systemFontOfSize_(10))
        hint.setTextColor_(NSColor.disabledControlTextColor())
        hint.setFrame_(((p, 32), (w - 130, 14)))
        content.addSubview_(hint)

        # ---- tab view: fills space above bottom bar ----
        tab_bottom = bar_h + 8
        tab_top = h - 12
        tab_h = tab_top - tab_bottom

        tab = NSTabView.alloc().initWithFrame_(
            ((p, tab_bottom), (w - 2 * p, tab_h))
        )
        content.addSubview_(tab)

        self._direct_text = self._add_tab(tab, "直连规则", routing.get("direct_rules", []))
        self._proxy_text = self._add_tab(tab, "代理规则", routing.get("proxy_rules", []))

        self._window = win

    def _add_tab(self, tab_view, title, rules):
        # Use the tab view's content rect — this already excludes the tab bar
        cr = tab_view.contentRect()
        item_view = NSView.alloc().initWithFrame_(cr)
        item_view.setAutoresizingMask_(18)  # NSViewWidthSizable | NSViewHeightSizable

        # ScrollView fills the item view with small margin
        scroll_margin = 4
        scroll_frame = (
            (scroll_margin, scroll_margin),
            (cr.size.width - 2 * scroll_margin, cr.size.height - 2 * scroll_margin),
        )
        scroll = NSScrollView.alloc().initWithFrame_(scroll_frame)
        scroll.setHasVerticalScroller_(True)
        scroll.setHasHorizontalScroller_(False)
        scroll.setBorderType_(NSBezelBorder)
        scroll.setAutoresizingMask_(18)

        # Text view — set as document view the correct way
        text_view = NSTextView.alloc().initWithFrame_(
            ((0, 0), (scroll.contentSize().width, scroll.contentSize().height))
        )
        text_view.setMinSize_((0, scroll.contentSize().height))
        text_view.setMaxSize_((float("inf"), float("inf")))
        text_view.setVerticallyResizable_(True)
        text_view.setHorizontallyResizable_(False)
        text_view.setAutoresizingMask_(2)  # NSViewWidthSizable
        text_view.setString_(_rules_to_text(rules))
        text_view.setFont_(NSFont.userFixedPitchFontOfSize_(12))
        text_view.setRichText_(False)

        scroll.setDocumentView_(text_view)
        item_view.addSubview_(scroll)

        # Scroll to top so first line is visible
        text_view.scrollRangeToVisible_((0, 0))

        tab_item = NSTabViewItem.alloc().initWithIdentifier_(title)
        tab_item.setLabel_(title)
        tab_item.setView_(item_view)
        tab_view.addTabViewItem_(tab_item)

        return text_view

    def _delegate(self):
        delegate = _RoutingWindowDelegate.alloc().init()
        self._delegate_ref = delegate
        return delegate

    def show(self):
        self._window.center()
        self._window.makeKeyAndOrderFront_(None)
        NSApp.activateIgnoringOtherApps_(True)

    def saveAndClose_(self, sender):
        config = self._config
        config["routing"] = {
            "enabled": bool(self._enabled_cb.state()),
            "direct_rules": _parse_rules_text(self._direct_text.string()),
            "proxy_rules": _parse_rules_text(self._proxy_text.string()),
            "default": self._default_popup.titleOfSelectedItem(),
        }

        with open(self._config_path, "w") as f:
            json.dump(config, f, indent=2)

        self._window.close()
        NSApp.stopModal()


def show_routing_window(config_path):
    ctrl = RoutingWindowController.alloc().initWithConfigPath_(config_path)
    if ctrl is None:
        return
    ctrl.show()
    NSApp.runModalForWindow_(ctrl._window)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python routing_window.py <config_path>")
        sys.exit(1)

    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
    _setup_minimal_menu()
    show_routing_window(sys.argv[1])
