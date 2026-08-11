"""
BlockProxyClient Super DNS domains window.
Launched as a subprocess from the main status bar app.
"""

import objc

from Foundation import NSObject, NSURL, NSMutableAttributedString
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
    NSScrollView,
    NSTextView,
    NSBezelBorder,
    NSFont,
    NSColor,
    NSMenu,
    NSMenuItem,
    NSAlert,
    NSApp,
    NSWorkspace,
    NSForegroundColorAttributeName,
)

from super_dns_control import (
    read_domains_file,
    write_domains_file,
    run_super_dns,
    super_dns_pid,
)


BEZEL_ROUNDED = 1
SUPER_DNS_DOCS_URL = "https://www.npmjs.com/package/super-dns"
WINDOW_STYLE = (
    NSWindowStyleMaskTitled
    | NSWindowStyleMaskClosable
    | NSWindowStyleMaskMiniaturizable
)


def _setup_minimal_menu():
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


class _SuperDnsWindowDelegate(NSObject):
    def windowWillClose_(self, notification):
        NSApp.stopModal()


class SuperDnsWindowController(NSObject):

    def init(self):
        self = objc.super(SuperDnsWindowController, self).init()
        if self is None:
            return None
        self._running_pid = None
        self._build_window()
        self._load_domains()
        self._refresh_status()
        return self

    def _build_window(self):
        w, h = 520, 430
        origin = ((0, 0), (w, h))
        win = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            origin, WINDOW_STYLE, NSBackingStoreBuffered, False
        )
        win.setTitle_("Super DNS - 防止 DNS 污染的域名列表")
        win.setLevel_(NSFloatingWindowLevel)
        win.setDelegate_(self._delegate())

        content = win.contentView()
        p = 15

        dot = NSTextField.labelWithString_("●")
        dot.setFrame_(((p, h - 38), (14, 20)))
        dot.setTextColor_(NSColor.systemOrangeColor())
        content.addSubview_(dot)
        self._status_dot = dot

        status = NSTextField.labelWithString_("状态: 检测中...")
        status.setFrame_(((p + 16, h - 38), (w - 2 * p - 16, 20)))
        status.setTextColor_(NSColor.labelColor())
        content.addSubview_(status)
        self._status_label = status

        bottom_h = 58
        scroll = NSScrollView.alloc().initWithFrame_(
            ((p, bottom_h), (w - 2 * p, h - bottom_h - 48))
        )
        scroll.setHasVerticalScroller_(True)
        scroll.setHasHorizontalScroller_(False)
        scroll.setBorderType_(NSBezelBorder)
        scroll.setAutoresizingMask_(18)

        text_view = NSTextView.alloc().initWithFrame_(
            ((0, 0), (scroll.contentSize().width, scroll.contentSize().height))
        )
        text_view.setMinSize_((0, scroll.contentSize().height))
        text_view.setMaxSize_((float("inf"), float("inf")))
        text_view.setVerticallyResizable_(True)
        text_view.setHorizontallyResizable_(False)
        text_view.setAutoresizingMask_(2)
        text_view.setFont_(NSFont.userFixedPitchFontOfSize_(12))
        text_view.setRichText_(False)
        scroll.setDocumentView_(text_view)
        content.addSubview_(scroll)
        self._domains_text = text_view

        docs_btn = NSButton.alloc().initWithFrame_(((p, 18), (130, 28)))
        docs_btn.setTitle_("Super DNS 文档")
        docs_btn.setBordered_(False)
        docs_btn.setTarget_(self)
        docs_btn.setAction_("openDocs:")
        docs_title = NSMutableAttributedString.alloc().initWithString_attributes_(
            "Super DNS 文档",
            {NSForegroundColorAttributeName: NSColor.systemBlueColor()},
        )
        docs_btn.setAttributedTitle_(docs_title)
        content.addSubview_(docs_btn)
        self._docs_btn = docs_btn

        save_btn = NSButton.alloc().initWithFrame_(((w - 315, 18), (90, 28)))
        save_btn.setTitle_("保存")
        save_btn.setBezelStyle_(BEZEL_ROUNDED)
        save_btn.setTarget_(self)
        save_btn.setAction_("saveDomains:")
        content.addSubview_(save_btn)
        self._save_btn = save_btn

        start_btn = NSButton.alloc().initWithFrame_(((w - 215, 18), (90, 28)))
        start_btn.setTitle_("启动")
        start_btn.setBezelStyle_(BEZEL_ROUNDED)
        start_btn.setTarget_(self)
        start_btn.setAction_("startOrRestart:")
        content.addSubview_(start_btn)
        self._start_btn = start_btn

        stop_btn = NSButton.alloc().initWithFrame_(((w - 115, 18), (90, 28)))
        stop_btn.setTitle_("停止")
        stop_btn.setBezelStyle_(BEZEL_ROUNDED)
        stop_btn.setTarget_(self)
        stop_btn.setAction_("stopSuperDns:")
        content.addSubview_(stop_btn)
        self._stop_btn = stop_btn

        self._window = win

    def _delegate(self):
        delegate = _SuperDnsWindowDelegate.alloc().init()
        self._delegate_ref = delegate
        return delegate

    def _load_domains(self):
        self._domains_text.setString_(read_domains_file())
        self._domains_text.scrollRangeToVisible_((0, 0))

    def _refresh_status(self):
        pid = super_dns_pid()
        self._running_pid = pid
        if pid:
            self._status_dot.setTextColor_(NSColor.systemGreenColor())
            self._status_label.setStringValue_(f"状态: npx super-dns 正在运行 (PID {pid})")
            self._start_btn.setTitle_("重启")
            self._stop_btn.setEnabled_(True)
        else:
            self._status_dot.setTextColor_(NSColor.systemOrangeColor())
            self._status_label.setStringValue_("状态: npx super-dns 未运行")
            self._start_btn.setTitle_("启动")
            self._stop_btn.setEnabled_(False)
        self._start_btn.setEnabled_(True)
        self._save_btn.setEnabled_(True)

    def _set_busy(self, text):
        self._status_label.setStringValue_(text)
        self._save_btn.setEnabled_(False)
        self._start_btn.setEnabled_(False)
        self._stop_btn.setEnabled_(False)

    def _show_alert(self, title, message, style=0):
        alert = NSAlert.alloc().init()
        alert.setMessageText_(title)
        if message:
            alert.setInformativeText_(message)
        alert.setAlertStyle_(style)
        alert.addButtonWithTitle_("确定")
        alert.runModal()

    def show(self):
        self._window.center()
        self._window.makeKeyAndOrderFront_(None)
        NSApp.activateIgnoringOtherApps_(True)

    def saveDomains_(self, sender):
        try:
            write_domains_file(self._domains_text.string())
            self._show_alert("保存成功", "~/.config/super-dns/domains 已更新。")
        except Exception as e:
            self._show_alert("保存失败", str(e), style=2)

    def openDocs_(self, sender):
        url = NSURL.URLWithString_(SUPER_DNS_DOCS_URL)
        NSWorkspace.sharedWorkspace().openURL_(url)

    def startOrRestart_(self, sender):
        action = "restart" if self._running_pid else "start"
        self._set_busy("状态: 正在执行 super-dns " + action + "...")
        self._run_action(action)

    def stopSuperDns_(self, sender):
        if not self._running_pid:
            return
        self._set_busy("状态: 正在执行 super-dns stop...")
        self._run_action("stop")

    def _run_action(self, action):
        def _worker():
            result = run_super_dns(action)
            self._last_action = action
            self._last_result = result
            self.performSelectorOnMainThread_withObject_waitUntilDone_(
                "_finishAction:", None, False
            )

        import threading

        threading.Thread(target=_worker, daemon=True).start()

    def _finishAction_(self, _obj):
        action = self._last_action
        result = self._last_result
        self._refresh_status()
        if result.returncode == 0:
            title = {
                "start": "启动成功",
                "restart": "重启成功",
                "stop": "停止成功",
            }.get(action, "执行成功")
            self._show_alert(title, "")
            return

        detail = (result.stderr or result.stdout or "").strip()
        self._show_alert("执行失败", detail or f"super-dns {action} 返回失败", style=2)


def show_super_dns_window():
    controller = SuperDnsWindowController.alloc().init()
    controller.show()
    NSApp.runModalForWindow_(controller._window)


if __name__ == "__main__":
    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
    _setup_minimal_menu()
    show_super_dns_window()
