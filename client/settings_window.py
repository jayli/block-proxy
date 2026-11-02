"""
BlockProxyClient 设置窗口：节点配置 / 分流规则 / Super DNS 三个面板合一。
Pure PyObjC implementation (no tkinter dependency).
Launched as a subprocess from the main status bar app.

窗口顶部是一排大 Tab（图标在上、文字在下），下面承载对应面板。
面板自身不建窗口、不写盘；「保存」由本窗口统一编排：
节点配置 + 分流规则两块 config 编辑当一个事务一起落盘再关窗，
Super DNS 的「保存」仍只写域名文件、不关窗（与合并前一致）。
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
import warnings

from Foundation import NSObject, NSRunLoop, NSTimer
from AppKit import (
    NSApplication,
    NSApplicationActivationPolicyAccessory,
    NSAnimationContext,
    NSWindow,
    NSFloatingWindowLevel,
    NSWindowStyleMaskTitled,
    NSWindowStyleMaskClosable,
    NSWindowStyleMaskMiniaturizable,
    NSBackingStoreBuffered,
    NSButton,
    NSColor,
    NSFont,
    NSImage,
    NSImageAbove,
    NSMenu,
    NSMenuItem,
    NSScreen,
    NSApp,
)

from config import read_ui_state, write_ui_state, read_proxy_state
from config_panel import ConfigPanel
from routing_panel import RoutingPanel
from super_dns_panel import SuperDnsPanel


WINDOW_STYLE = (
    NSWindowStyleMaskTitled
    | NSWindowStyleMaskClosable
    | NSWindowStyleMaskMiniaturizable
)

# 三个面板的稳定标识（菜单跳转、--tab、ui_state.json 都用它）
PANEL_TAB_CONFIG = "config"
PANEL_TAB_ROUTING = "routing"
PANEL_TAB_SUPER_DNS = "super_dns"
PANEL_TABS = (PANEL_TAB_CONFIG, PANEL_TAB_ROUTING, PANEL_TAB_SUPER_DNS)
DEFAULT_PANEL_TAB = PANEL_TAB_CONFIG

# 主进程投递跳转请求用的 ui_state.json 键
PANEL_REQUEST_KEY = "panel_request"
PANEL_REQUEST_POLL_SEC = 0.3

# 大 Tab 栏：图标在上、文字在下
TAB_BAR_HEIGHT = 64
TAB_ICON_SIZE = 26
TAB_BAR_MARGIN_X = 12
TAB_BAR_GAP = 8
TAB_BAR_INSET_Y = 6
TAB_FONT_SIZE = 13

# 切 Tab 时窗口高度伸缩动画的时长（秒）。
# 必须走 NSAnimationContext + animator()：实测 setFrame_display_animate_(..., True, True)
# 在本机不会插值，高度直接跳到目标值。
TAB_SWITCH_ANIM_SEC = 0.25

# 窗口宽度固定（最宽面板 520 + 左右边距），高度随 Tab 自适应
WINDOW_WIDTH = 560

# NSAutoresizingMaskOptions
NSViewMinYMargin = 8

# 每个 Tab 的图标 / 文字 / 窗口标题，沿用合并前三个独立窗口的标题
TAB_SPECS = (
    {
        "tab": PANEL_TAB_CONFIG,
        "title": "节点配置",
        "icon": "setting.png",
        "window_title": "节点配置",
    },
    {
        "tab": PANEL_TAB_ROUTING,
        "title": "分流规则",
        "icon": "router.png",
        "window_title": "分流规则",
    },
    {
        "tab": PANEL_TAB_SUPER_DNS,
        "title": "Super DNS",
        "icon": "dns.png",
        "window_title": "Super DNS - 防止 DNS 污染的域名列表",
    },
)


def _resource_dir():
    """编译后资源与可执行文件同级，开发态在源码目录。"""
    if "__compiled__" in globals() or getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def _assets_dir():
    return os.path.join(_resource_dir(), "assets")


def _tab_icon(filename):
    """加载 Tab 图标；缺失时返回 None（降级为纯文字，不崩）。"""
    path = os.path.join(_assets_dir(), filename)
    if not os.path.exists(path):
        return None
    image = NSImage.alloc().initByReferencingFile_(path)
    if image is None:
        return None
    image.setSize_((TAB_ICON_SIZE, TAB_ICON_SIZE))
    # 模板图：系统按浅/深色模式自动反白，与状态栏图标一致
    image.setTemplate_(True)
    return image


def _center_on_mouse_screen(w, h):
    if platform.system() == "Darwin":
        try:
            from AppKit import NSEvent
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


class SettingsWindowController(NSObject):

    def initWithConfigPath_tab_appPath_(self, config_path, tab, app_path):
        self = objc.super(SettingsWindowController, self).init()
        if self is None:
            return None
        self._config_path = config_path
        self._app_path = app_path
        self._current_tab = tab if tab in PANEL_TABS else DEFAULT_PANEL_TAB
        self._tab_buttons = {}
        self._panels = {}
        self._request_timer = None
        # 启动时把文件里已有的 seq 记为「已见过」，避免上一轮的陈旧请求
        # 在开窗瞬间把 Tab 抢走（手动运行本脚本时也走这条路）
        self._last_request_seq = self._read_request_seq()
        # 主进程连接状态的已见 seq（同样防陈旧状态抢开关）
        self._last_state_seq = None
        with open(config_path, "r") as f:
            config = json.load(f)
        self._build_panels(config)
        self._build_window()
        self._select_tab(self._current_tab, resize=False)
        return self

    # ------------------------------------------------------------------
    # Panels
    # ------------------------------------------------------------------

    def _build_panels(self, config):
        config_panel = ConfigPanel.alloc().initWithConfig_(config)
        config_panel.setSaveTarget_(self)
        # 开关请求写同目录的 IPC 文件；初始开关位置读主进程最近发布的状态
        config_panel.setConfigPath_(self._config_path)
        routing_panel = RoutingPanel.alloc().initWithConfig_configPath_(
            config, self._config_path
        )
        routing_panel.setSaveTarget_(self)
        super_dns_panel = SuperDnsPanel.alloc().init()

        self._panels = {
            PANEL_TAB_CONFIG: config_panel,
            PANEL_TAB_ROUTING: routing_panel,
            PANEL_TAB_SUPER_DNS: super_dns_panel,
        }
        self._config_panel = config_panel
        self._routing_panel = routing_panel

        # 开窗即按主进程真实连接状态摆开关（主进程在开窗时会发布一次
        # 当前状态，这里读到的可能是上一轮的，轮询会很快纠正）
        state = read_proxy_state(self._config_path)
        if state is not None:
            self._last_state_seq = state.get("seq")
            config_panel.setProxyState_(state)

    # ------------------------------------------------------------------
    # Window / tab bar
    # ------------------------------------------------------------------

    def _content_height(self, tab):
        _pw, ph = self._panels[tab].panelSize()
        return TAB_BAR_HEIGHT + ph

    def _build_window(self):
        h = self._content_height(self._current_tab)
        pos = _center_on_mouse_screen(WINDOW_WIDTH, h)
        if pos is None:
            x = int((NSScreen.mainScreen().frame().size.width - WINDOW_WIDTH) / 2)
            y = int((NSScreen.mainScreen().frame().size.height - h) / 2)
        else:
            x, y = pos

        win = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            ((x, y), (WINDOW_WIDTH, h)), WINDOW_STYLE, NSBackingStoreBuffered, False
        )
        win.setLevel_(NSFloatingWindowLevel)
        win.setDelegate_(self)

        content = win.contentView()

        # 面板容器：水平居中，顶边贴着 Tab 栏下沿。切 Tab 时窗口高度会动画伸缩，
        # 面板挂 NSViewMinYMargin（贴顶锚定）才能跟着内容区顶边走，
        # 否则窗口变高时面板留在底部、与 Tab 栏之间裂开一道缝。
        for tab, panel in self._panels.items():
            pw, ph = panel.panelSize()
            view = panel.view()
            view.setFrame_((((WINDOW_WIDTH - pw) / 2, 0), (pw, ph)))
            view.setAutoresizingMask_(NSViewMinYMargin)
            view.setHidden_(True)
            content.addSubview_(view)

        # 大 Tab 栏：三个等宽按钮，图标在上文字在下，选中项高亮
        btn_w = (WINDOW_WIDTH - 2 * TAB_BAR_MARGIN_X - 2 * TAB_BAR_GAP) / 3
        for idx, spec in enumerate(TAB_SPECS):
            bx = TAB_BAR_MARGIN_X + idx * (btn_w + TAB_BAR_GAP)
            btn = NSButton.alloc().initWithFrame_(((bx, 0), (btn_w, 1)))
            btn.setBordered_(False)
            btn.setTitle_(spec["title"])
            btn.setImagePosition_(NSImageAbove)
            btn.setImage_(None)
            icon = _tab_icon(spec["icon"])
            if icon is not None:
                btn.setImage_(icon)
            btn.setWantsLayer_(True)
            btn.layer().setCornerRadius_(8)
            btn.setAutoresizingMask_(NSViewMinYMargin)
            btn.setTarget_(self)
            btn.setAction_("onTabClick:")
            btn.setIdentifier_(spec["tab"])
            content.addSubview_(btn)
            self._tab_buttons[spec["tab"]] = btn

        self._window = win

    def _layout_tab_bar(self, content_h):
        """把 Tab 栏摆到内容区顶部（窗口改高后需要重算）。"""
        btn_h = TAB_BAR_HEIGHT - 2 * TAB_BAR_INSET_Y
        by = content_h - TAB_BAR_HEIGHT + TAB_BAR_INSET_Y
        for btn in self._tab_buttons.values():
            frame = btn.frame()
            btn.setFrame_(((frame.origin.x, by), (frame.size.width, btn_h)))

    def _apply_tab_styles(self):
        selected_color = NSColor.controlAccentColor().colorWithAlphaComponent_(0.18)
        with warnings.catch_warnings():
            # CGColor() 返回裸指针，PyObjC 会告警；这是 CALayer 背景色的标准用法
            warnings.simplefilter("ignore", objc.ObjCPointerWarning)
            selected_cg = selected_color.CGColor()
            clear_cg = NSColor.clearColor().CGColor()
        for tab, btn in self._tab_buttons.items():
            is_current = tab == self._current_tab
            btn.layer().setBackgroundColor_(selected_cg if is_current else clear_cg)
            btn.setFont_(
                NSFont.boldSystemFontOfSize_(TAB_FONT_SIZE)
                if is_current
                else NSFont.systemFontOfSize_(TAB_FONT_SIZE)
            )

    def onTabClick_(self, sender):
        tab = str(sender.identifier())
        if tab in PANEL_TABS and tab != self._current_tab:
            self._select_tab(tab)

    def _select_tab(self, tab, resize=True):
        """切到指定面板；resize=True 时窗口顶边不动、底边平滑伸缩到新高度。

        动画期间不能重排 Tab 栏：按钮和面板都挂了 NSViewMinYMargin（贴顶锚定），
        会自己跟着内容区顶边走；此时按目标高度调 _layout_tab_bar 反而会把按钮
        摆到旧高度下不存在的位置。
        """
        if tab not in PANEL_TABS:
            return
        # 先取动画前的内容区高：面板要按它定位，取晚了就是目标高
        old_content_h = self._window.contentView().frame().size.height
        self._current_tab = tab

        incoming = self._panels[tab]
        pw, ph = incoming.panelSize()
        if resize:
            # 把新面板顶边粘到 Tab 栏正下方。不粘的话：贴底锚定时窗口变高会把
            # 面板顶进 Tab 栏（实测重叠 129px），单纯贴顶锚定时窗口变矮又会
            # 在两者之间留白（实测 141px）。粘好后动画全程间距恒定，
            # 且动画结束时面板恰好落回 y=0 的静止位置。
            incoming.view().setFrame_(
                (((WINDOW_WIDTH - pw) / 2, old_content_h - TAB_BAR_HEIGHT - ph), (pw, ph))
            )

        for other, panel in self._panels.items():
            panel.view().setHidden_(other != tab)

        spec = next(s for s in TAB_SPECS if s["tab"] == tab)
        self._window.setTitle_(spec["window_title"])
        self._apply_tab_styles()

        content_h = self._content_height(tab)
        if not resize:
            self._layout_tab_bar(content_h)
            return

        frame = self._window.frame()
        # setFrame_ 收的是窗口 frame 高（含标题栏），而布局数学用的是
        # 内容区高；不换算会让内容区矮一个标题栏，Tab 栏浮到内容区顶部之上
        frame_h = NSWindow.frameRectForContentRect_styleMask_(
            ((0, 0), (WINDOW_WIDTH, content_h)), WINDOW_STYLE
        ).size.height
        # 顶边不动：新 origin.y = 旧 origin.y + 旧高 - 新高
        new_y = frame.origin.y + frame.size.height - frame_h
        target = ((frame.origin.x, new_y), (WINDOW_WIDTH, frame_h))

        # animator() 只在 app 处于 active 时才真正驱动动画；inactive 时整个
        # 动画被丢弃（连 completionHandler 都不触发），窗口会停在旧高度。
        # IPC 跳转（_pollPanelRequest_）切 Tab 时本进程常不是 active（用户在
        # 主应用里点的菜单），所以 inactive 时退化为瞬时改高度，保证落位正确；
        # active 时才走动画。
        if NSApp.isActive():
            NSAnimationContext.beginGrouping()
            NSAnimationContext.currentContext().setDuration_(TAB_SWITCH_ANIM_SEC)
            self._window.animator().setFrame_display_(target, True)
            NSAnimationContext.endGrouping()
        else:
            self._window.setFrame_display_(target, True)

    def show(self):
        self._window.makeKeyAndOrderFront_(None)
        NSApp.activateIgnoringOtherApps_(True)
        self._start_request_polling()

    # ------------------------------------------------------------------
    # 菜单跳转：主进程写 ui_state.json，本窗口轮询后切 Tab 并前置
    # ------------------------------------------------------------------

    def _read_request(self):
        request = read_ui_state(self._config_path).get(PANEL_REQUEST_KEY)
        return request if isinstance(request, dict) else None

    def _read_request_seq(self):
        request = self._read_request()
        if request is None:
            return None
        return request.get("seq")

    def _start_request_polling(self):
        timer = NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            PANEL_REQUEST_POLL_SEC, self, "_pollPanelRequest:", None, True
        )
        # 模态循环下也要触发，必须挂到 common modes
        NSRunLoop.currentRunLoop().addTimer_forMode_(timer, "kCFRunLoopCommonModes")
        self._request_timer = timer

    def _stop_request_polling(self):
        if self._request_timer is not None:
            self._request_timer.invalidate()
            self._request_timer = None

    def _pollPanelRequest_(self, _timer):
        self._poll_proxy_state()
        request = self._read_request()
        if request is None:
            return
        seq = request.get("seq")
        if seq == self._last_request_seq:
            return
        self._last_request_seq = seq
        tab = request.get("tab")
        if tab not in PANEL_TABS:
            return
        if tab != self._current_tab:
            self._select_tab(tab)
        self._window.makeKeyAndOrderFront_(None)
        NSApp.activateIgnoringOtherApps_(True)

    def _poll_proxy_state(self):
        """复用同一个 0.3s 轮询：主进程发布了新连接状态就推给面板。

        按 seq 去重，状态没变就不碰控件（避免每 0.3s 重写一次 label）。
        """
        state = read_proxy_state(self._config_path)
        if state is None:
            return
        seq = state.get("seq")
        if seq == self._last_state_seq:
            return
        self._last_state_seq = seq
        self._config_panel.setProxyState_(state)

    # ------------------------------------------------------------------
    # Save
    # ------------------------------------------------------------------

    def saveAll_(self, sender):
        """节点配置 + 分流规则一起落盘再关窗（一个事务，不丢另一块的编辑）。"""
        with open(self._config_path, "r") as f:
            config = json.load(f)

        self._config_panel.apply_to(config)
        self._routing_panel.apply_to(config)

        with open(self._config_path, "w") as f:
            json.dump(config, f, indent=2)

        from autostart import sync
        sync(self._app_path, config.get("autostart", False))

        self._stop_request_polling()
        self._window.close()
        NSApp.stopModal()

    def cancelAll_(self, sender):
        """取消：什么都不写，直接关窗。

        关窗会触发 windowWillClose_（本控制器就是 delegate），
        由它停轮询并结束模态循环，所以这里不需要重复做。
        """
        self._window.close()

    def windowWillClose_(self, notification):
        self._stop_request_polling()
        NSApp.stopModal()


# 主进程侧：写跳转请求（seq 递增，窗口轮询到就切 Tab）
_request_seq = 0


def request_panel_tab(config_path, tab):
    """把「跳到某个 Tab」的请求写进 ui_state.json。返回是否写入成功。"""
    global _request_seq
    if tab not in PANEL_TABS:
        return False
    _request_seq += 1
    return write_ui_state(
        config_path, {PANEL_REQUEST_KEY: {"tab": tab, "seq": _request_seq}}
    )


def show_settings_window(config_path, tab=DEFAULT_PANEL_TAB, app_path=None):
    ctrl = SettingsWindowController.alloc().initWithConfigPath_tab_appPath_(
        config_path, tab, app_path
    )
    if ctrl is None:
        return
    ctrl.show()
    NSApp.runModalForWindow_(ctrl._window)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("config_path")
    parser.add_argument("--tab", default=DEFAULT_PANEL_TAB, choices=PANEL_TABS)
    parser.add_argument("--app-path", default=None)
    args = parser.parse_args()

    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
    _setup_minimal_menu()
    show_settings_window(args.config_path, args.tab, args.app_path)
