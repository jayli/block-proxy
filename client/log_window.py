"""
BlockProxyClient log viewer window.
Pure PyObjC implementation with NSTableView and real-time file tailing.
Launched as a subprocess from the main status bar app.
"""

import objc
import os
import platform
import re
import sys

from Foundation import NSObject, NSRunLoop, NSTimer
from AppKit import (
    NSApplication,
    NSApplicationActivationPolicyAccessory,
    NSWindow,
    NSFloatingWindowLevel,
    NSWindowStyleMaskTitled,
    NSWindowStyleMaskClosable,
    NSWindowStyleMaskMiniaturizable,
    NSBackingStoreBuffered,
    NSButton,
    NSSegmentedControl,
    NSSegmentStyleTexturedRounded,
    NSTableView,
    NSTableColumn,
    NSScrollView,
    NSBezelBorder,
    NSApp,
    NSMenu,
    NSMenuItem,
    NSColor,
    NSScreen,
    NSEvent,
    NSLeftTextAlignment,
    NSCenterTextAlignment,
    NSTableColumnUserResizingMask,
    NSViewWidthSizable,
    NSViewHeightSizable,
)

from traffic_view import TrafficView


LOG_DIR = os.path.expanduser("~/Library/Application Support/BlockProxyClient/logs")
MAX_LINES = 5000
INITIAL_LINES = 500
POLL_SEC = 0.5
ROW_HEIGHT = 20.0

WINDOW_STYLE = (
    NSWindowStyleMaskTitled
    | NSWindowStyleMaskClosable
    | NSWindowStyleMaskMiniaturizable
)

# access.log: "2026-06-17 14:30:22 | CONNECT | host:443 | proxy [| error]"
_ACCESS_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s*\|\s*"
    r"(\w+)\s*\|\s*(.+?)\s*\|\s*(direct|proxy)"
    r"(?:\s*\|\s*(.+))?$"
)

# crash.log: "2026-06-17 14:30:22 | WARNING | message"
_CRASH_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*\|\s*"
    r"(\w+)\s*\|\s*(.*)$"
)

_ROUTE_LABEL = {"proxy": "代理", "direct": "直连"}


class LogDataSource(NSObject):
    """NSTableView data source and delegate."""

    def initWithEntries_controller_(self, entries, controller):
        self = objc.super(LogDataSource, self).init()
        if self is None:
            return None
        self._entries = entries
        self._controller = controller
        return self

    def numberOfRowsInTableView_(self, tv):
        return len(self._entries)

    def tableView_objectValueForTableColumn_row_(self, tv, col, row):
        if row >= len(self._entries):
            return ""
        entry = self._entries[row]
        ident = col.identifier()
        if ident == "route":
            return _ROUTE_LABEL.get(entry.get("route", ""), entry.get("route", ""))
        return entry.get(ident, "")

    def tableView_willDisplayCell_forTableColumn_row_(self, tv, cell, col, row):
        if row >= len(self._entries):
            return
        entry = self._entries[row]
        if entry.get("error"):
            cell.setTextColor_(NSColor.systemRedColor())
        elif entry.get("route") == "proxy":
            cell.setTextColor_(NSColor.systemGreenColor())
        else:
            cell.setTextColor_(NSColor.labelColor())


class LogWindowController(NSObject):

    def init(self):
        self = objc.super(LogWindowController, self).init()
        if self is None:
            return None

        self._entries = []
        self._current_tab = "access"

        # File tail state
        self._file_path = os.path.join(LOG_DIR, "access.log")
        self._file_inode = None
        self._file_offset = 0
        self._timer = None
        self._auto_scroll = True
        self._scroll_guard = False

        self._build_window()
        self._traffic_view.start()  # start stats collection immediately
        self._initial_load()
        self._start_tail()
        return self

    # ------------------------------------------------------------------
    # Window
    # ------------------------------------------------------------------

    def _build_window(self):
        w, h = 800, 500
        pos = _center_on_mouse_screen(w, h)
        if pos is None:
            x = (NSScreen.mainScreen().frame().size.width - w) // 2
            y = (NSScreen.mainScreen().frame().size.height - h) // 2
        else:
            x, y = pos

        win = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            ((x, y), (w, h)), WINDOW_STYLE, NSBackingStoreBuffered, False
        )
        win.setTitle_("BlockProxyClient 日志")
        win.setLevel_(NSFloatingWindowLevel)
        win.setDelegate_(self)

        content = win.contentView()
        p = 12

        # -- toolbar: segmented toggle + buttons --
        toggle = NSSegmentedControl.alloc().initWithFrame_(
            ((p, h - 42), (220, 26))
        )
        toggle.setSegmentCount_(3)
        toggle.setLabel_forSegment_("Access", 0)
        toggle.setLabel_forSegment_("Crash", 1)
        toggle.setLabel_forSegment_("流量统计", 2)
        toggle.setSelectedSegment_(0)
        toggle.setSegmentStyle_(NSSegmentStyleTexturedRounded)
        toggle.setTarget_(self)
        toggle.setAction_("onTabSwitch:")
        content.addSubview_(toggle)
        self._toggle = toggle

        btn_x = w - p
        for title, action, bw in [
            ("关闭", "onClose:", 60),
            ("清空", "onClear:", 60),
        ]:
            btn_x -= bw
            btn = NSButton.alloc().initWithFrame_(((btn_x, h - 44), (bw, 28)))
            btn.setTitle_(title)
            btn.setBezelStyle_(1)
            btn.setTarget_(self)
            btn.setAction_(action)
            content.addSubview_(btn)
            btn_x -= 8

        # -- table view --
        ds = LogDataSource.alloc().initWithEntries_controller_(
            self._entries, self
        )
        self._ds = ds

        tv = NSTableView.alloc().initWithFrame_(
            ((0, 0), (w - 2 * p, h - 70))
        )

        for ident, header, cw, align in [
            ("date",      "日期",      90,  NSLeftTextAlignment),
            ("time",      "时间",      70,  NSLeftTextAlignment),
            ("host_port", "域名:端口", 260, NSLeftTextAlignment),
            ("route",     "路由",      60,  NSCenterTextAlignment),
            ("error",     "错误",      200, NSLeftTextAlignment),
        ]:
            col = NSTableColumn.alloc().initWithIdentifier_(ident)
            col.headerCell().setStringValue_(header)
            col.setWidth_(cw)
            col.setResizingMask_(NSTableColumnUserResizingMask)
            col.dataCell().setAlignment_(align)
            tv.addTableColumn_(col)

        tv.setUsesAlternatingRowBackgroundColors_(True)
        tv.setRowHeight_(ROW_HEIGHT)
        tv.setDataSource_(ds)
        tv.setDelegate_(ds)
        tv.setAllowsColumnSelection_(False)
        self._tv = tv

        sv = NSScrollView.alloc().initWithFrame_(
            ((p, 10), (w - 2 * p, h - 64))
        )
        sv.setDocumentView_(tv)
        sv.setBorderType_(NSBezelBorder)
        sv.setHasVerticalScroller_(True)
        sv.setHasHorizontalScroller_(False)
        sv.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable)
        content.addSubview_(sv)
        self._sv = sv

        # -- traffic stats view (third tab) --
        tv_frame = ((p, 10), (w - 2 * p, h - 64))
        self._traffic_view = TrafficView.alloc().initWithFrame_(tv_frame)
        self._traffic_view.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable)
        self._traffic_view.setHidden_(True)
        content.addSubview_(self._traffic_view)

        from Foundation import NSNotificationCenter
        NSNotificationCenter.defaultCenter().addObserver_selector_name_object_(
            self, "_onScroll:", "NSViewBoundsDidChangeNotification",
            sv.contentView(),
        )

        self._window = win

    # ------------------------------------------------------------------
    # File tail
    # ------------------------------------------------------------------

    def _start_tail(self):
        timer = NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            POLL_SEC, self, "_poll:", None, True
        )
        NSRunLoop.currentRunLoop().addTimer_forMode_(
            timer, "kCFRunLoopCommonModes"
        )
        self._timer = timer

    def _stop_tail(self):
        if self._timer:
            self._timer.invalidate()
            self._timer = None

    def _poll_(self, timer):
        path = self._file_path
        try:
            stat = os.stat(path)
        except FileNotFoundError:
            if self._file_inode is not None:
                self._file_inode = None
                self._file_offset = 0
            return

        if self._file_inode is None:
            # New file — read initial batch
            self._file_inode = stat.st_ino
            self._file_offset = stat.st_size
            lines = self._read_last(INITIAL_LINES)
            if lines:
                self._add_entries(lines)
            return

        if stat.st_ino != self._file_inode or stat.st_size < self._file_offset:
            # Rotated or truncated
            self._file_inode = stat.st_ino
            self._file_offset = 0

        if stat.st_size > self._file_offset:
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    f.seek(self._file_offset)
                    new = f.read()
                self._file_offset = stat.st_size
                lines = [l for l in new.split("\n") if l.strip()]
                if lines:
                    self._add_entries(lines)
            except (IOError, OSError):
                pass

    def _read_last(self, n):
        try:
            with open(self._file_path, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
            return lines[-n:]
        except (FileNotFoundError, IOError):
            return []

    def _initial_load(self):
        lines = self._read_last(INITIAL_LINES)
        if lines:
            self._file_offset = os.path.getsize(self._file_path)
            self._file_inode = os.stat(self._file_path).st_ino
            self._add_entries(lines)

    # ------------------------------------------------------------------
    # Parsing
    # ------------------------------------------------------------------

    def _parse_lines(self, lines):
        entries = []
        is_access = self._current_tab == "access"
        for line in lines:
            line = line.rstrip("\n\r")
            if not line:
                continue
            if is_access:
                m = _ACCESS_RE.match(line)
                if m:
                    entries.append({
                        "date": m.group(1),
                        "time": m.group(2),
                        "host_port": m.group(4).strip(),
                        "route": m.group(5).strip(),
                        "error": (m.group(6) or "").strip(),
                    })
            else:
                m = _CRASH_RE.match(line)
                if m:
                    dt = m.group(1)
                    entries.append({
                        "date": dt[:10],
                        "time": dt[11:].strip(),
                        "host_port": m.group(2).strip(),
                        "route": "",
                        "error": m.group(3).strip(),
                    })
        return entries

    def _add_entries(self, lines):
        parsed = self._parse_lines(lines)
        if not parsed:
            return
        self._entries.extend(parsed)
        excess = len(self._entries) - MAX_LINES
        if excess > 0:
            del self._entries[:excess]
        self._reload_table()
        if self._auto_scroll and self._entries:
            self._scroll_guard = True
            self._tv.scrollRowToVisible_(len(self._entries) - 1)
            self._scroll_guard = False

    def _reload_table(self):
        self._tv.noteNumberOfRowsChanged()
        self._tv.reloadData()

    def _is_near_bottom(self):
        try:
            cv = self._sv.contentView()
            doc_h = self._tv.frame().size.height
            vis_h = cv.bounds().size.height
            scroll_y = cv.bounds().origin.y
            return (doc_h - scroll_y - vis_h) < (ROW_HEIGHT * 3)
        except Exception:
            return True

    # ------------------------------------------------------------------
    # Delegate (window close)
    # ------------------------------------------------------------------

    def show(self):
        self._window.makeKeyAndOrderFront_(None)
        NSApp.activateIgnoringOtherApps_(True)

    def windowWillClose_(self, notification):
        self._stop_tail()
        self._traffic_view.stop()
        NSApp.terminate_(None)

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    def onTabSwitch_(self, sender):
        seg = sender.selectedSegment()
        if seg == 2:
            # Traffic stats tab
            self._stop_tail()
            self._sv.setHidden_(True)
            self._traffic_view.setHidden_(False)
            self._traffic_view.resume_anim()
            return
        # Access or Crash tab
        self._sv.setHidden_(False)
        self._traffic_view.setHidden_(True)
        self._traffic_view.pause_anim()
        self._stop_tail()
        self._file_inode = None
        self._file_offset = 0
        self._current_tab = "access" if seg == 0 else "crash"
        self._file_path = os.path.join(
            LOG_DIR, "access.log" if self._current_tab == "access" else "crash.log"
        )
        self._entries.clear()
        self._reload_table()
        self._initial_load()
        self._start_tail()

    def onClear_(self, sender):
        self._entries.clear()
        try:
            with open(self._file_path, "w") as f:
                f.truncate(0)
        except (FileNotFoundError, IOError):
            pass
        self._file_offset = 0
        self._file_inode = None
        self._reload_table()

    def onClose_(self, sender):
        self._window.close()

    def _onScroll_(self, notification):
        if self._scroll_guard:
            return
        self._auto_scroll = self._is_near_bottom()


def _center_on_mouse_screen(w, h):
    if platform.system() == "Darwin":
        try:
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


def _setup_menu():
    """Minimal menu so Cmd+W / Cmd+Q work."""
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


if __name__ == "__main__":
    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
    _setup_menu()

    ctrl = LogWindowController.alloc().init()
    if ctrl is None:
        sys.exit(1)
    ctrl.show()
    app.run()
