"""合并设置窗口（settings_window.py）的静态与行为测试。

静态测试：Tab 栏三项（图标+文字）、面板尺寸、窗口标题。
行为测试：ui_state.json 跳转请求的 seq 语义、saveAll_ 合并写两块 config。
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import settings_window


# ---------------------------------------------------------------------------
# 静态：Tab 栏与面板规格
# ---------------------------------------------------------------------------


def test_tab_bar_has_four_tabs_with_icon_and_text():
    assert len(settings_window.TAB_SPECS) == 4
    tabs = [spec["tab"] for spec in settings_window.TAB_SPECS]
    assert tabs == list(settings_window.PANEL_TABS)

    for spec in settings_window.TAB_SPECS:
        assert spec["title"]
        assert spec["icon"].endswith(".png")
        assert spec["window_title"]


def test_tab_specs_map_to_the_four_panels():
    assert settings_window.TAB_SPECS[0]["tab"] == settings_window.PANEL_TAB_CONFIG
    assert settings_window.TAB_SPECS[0]["icon"] == "setting.png"
    assert settings_window.TAB_SPECS[0]["window_title"] == "节点配置"

    assert settings_window.TAB_SPECS[1]["tab"] == settings_window.PANEL_TAB_ROUTING
    assert settings_window.TAB_SPECS[1]["icon"] == "router.png"
    assert settings_window.TAB_SPECS[1]["window_title"] == "分流规则"

    assert settings_window.TAB_SPECS[2]["tab"] == settings_window.PANEL_TAB_SUPER_DNS
    assert settings_window.TAB_SPECS[2]["icon"] == "dns.png"
    assert settings_window.TAB_SPECS[2]["window_title"] == "Super DNS - 防止 DNS 污染的域名列表"

    assert settings_window.TAB_SPECS[3]["tab"] == settings_window.PANEL_TAB_REWRITE
    assert settings_window.TAB_SPECS[3]["icon"] == "rewrite.png"
    assert settings_window.TAB_SPECS[3]["title"] == "重定向"


def test_tab_icon_assets_exist():
    assets_dir = settings_window._assets_dir()
    for spec in settings_window.TAB_SPECS:
        assert os.path.exists(os.path.join(assets_dir, spec["icon"])), spec["icon"]


def test_window_width_covers_widest_panel():
    from config_panel import PANEL_WIDTH as CONFIG_W
    from routing_panel import PANEL_WIDTH as ROUTING_W
    from super_dns_panel import PANEL_WIDTH as SUPER_DNS_W
    from rewrite_panel import PANEL_WIDTH as REWRITE_W

    assert settings_window.WINDOW_WIDTH >= max(
        CONFIG_W, ROUTING_W, SUPER_DNS_W, REWRITE_W
    )


def test_tab_icon_uses_template_mode():
    """图标是深色线稿，必须 setTemplate_(True) 才能跟随浅/深色模式反白。"""
    source = os.path.join(os.path.dirname(__file__), "..", "settings_window.py")
    text = open(source).read()
    assert "image.setTemplate_(True)" in text


def test_tab_bar_uses_real_appkit_image_above_constant():
    """图标在上、文字在下必须用 AppKit 真正的 NSImageAbove。

    曾经把 NSImageAbove 硬编码成 3，而 AppKit 里 3 是 NSImageRight，
    图标因此被摆到按钮右边缘。常量必须从 AppKit 导入，不能自己写。
    """
    from AppKit import NSImageAbove, NSImageRight

    assert settings_window.NSImageAbove == NSImageAbove
    assert settings_window.NSImageAbove != NSImageRight

    source = os.path.join(os.path.dirname(__file__), "..", "settings_window.py")
    text = open(source).read()
    # 从 AppKit 导入，而不是模块内自己赋一个魔数
    assert "NSImageAbove," in text.split("from AppKit import (")[1].split(")")[0]
    assert "NSImageAbove = " not in text


# ---------------------------------------------------------------------------
# 行为：菜单跳转请求（ui_state.json 的 panel_request 键）
# ---------------------------------------------------------------------------


def test_request_panel_tab_writes_seq_and_tab(tmp_path):
    config_path = tmp_path / "config.json"
    config_path.write_text("{}")

    assert settings_window.request_panel_tab(str(config_path), settings_window.PANEL_TAB_ROUTING) is True

    data = json.loads((tmp_path / "ui_state.json").read_text())
    assert data["panel_request"]["tab"] == settings_window.PANEL_TAB_ROUTING
    assert isinstance(data["panel_request"]["seq"], int)


def test_request_panel_tab_increments_seq(tmp_path):
    config_path = tmp_path / "config.json"
    config_path.write_text("{}")

    settings_window.request_panel_tab(str(config_path), settings_window.PANEL_TAB_CONFIG)
    first = json.loads((tmp_path / "ui_state.json").read_text())["panel_request"]["seq"]

    settings_window.request_panel_tab(str(config_path), settings_window.PANEL_TAB_SUPER_DNS)
    second = json.loads((tmp_path / "ui_state.json").read_text())["panel_request"]["seq"]

    assert second > first


def test_request_panel_tab_rejects_unknown_tab(tmp_path):
    config_path = tmp_path / "config.json"
    config_path.write_text("{}")

    assert settings_window.request_panel_tab(str(config_path), "bogus") is False
    assert not (tmp_path / "ui_state.json").exists()


def test_request_panel_tab_keeps_other_ui_state_keys(tmp_path):
    config_path = tmp_path / "config.json"
    config_path.write_text("{}")
    (tmp_path / "ui_state.json").write_text('{"routing_tab": "proxy"}')

    settings_window.request_panel_tab(str(config_path), settings_window.PANEL_TAB_CONFIG)

    data = json.loads((tmp_path / "ui_state.json").read_text())
    assert data["routing_tab"] == "proxy"
    assert data["panel_request"]["tab"] == settings_window.PANEL_TAB_CONFIG


def test_select_tab_sets_window_frame_height_including_titlebar(tmp_path, monkeypatch):
    """setFrame_display_animate_ 收的是窗口 frame 高（含标题栏）；
    布局数学用的是内容区高，必须先换算，否则切 Tab 后内容区矮一个标题栏、
    Tab 栏浮到内容区顶部之上（2026-11-01 用户实测：切一次 Tab 顶部 Tab 上移）。"""
    from AppKit import NSWindow

    config_path = tmp_path / "config.json"
    config_path.write_text("{}")
    monkeypatch.setattr(settings_window, "NSApp", _fake_app())

    ctrl = settings_window.SettingsWindowController.__new__(
        settings_window.SettingsWindowController
    )
    ctrl._config_path = str(config_path)
    ctrl._current_tab = settings_window.PANEL_TAB_CONFIG
    ctrl._last_request_seq = None
    ctrl._panels = _fake_panels()
    ctrl._window = _FakeWindow()
    ctrl._tab_buttons = {}

    old_top = ctrl._window.frame().origin.y + ctrl._window.frame().size.height

    ctrl._select_tab(settings_window.PANEL_TAB_ROUTING)

    content_h = settings_window.TAB_BAR_HEIGHT + ctrl._panels[settings_window.PANEL_TAB_ROUTING].panelSize()[1]
    expected_frame_h = NSWindow.frameRectForContentRect_styleMask_(
        ((0, 0), (settings_window.WINDOW_WIDTH, content_h)),
        settings_window.WINDOW_STYLE,
    ).size.height
    assert expected_frame_h > content_h  # 标题栏确实占高度

    new_frame = ctrl._window.frame()
    assert new_frame.size.height == expected_frame_h
    # 顶边不动
    assert new_frame.origin.y + new_frame.size.height == old_top


# ---------------------------------------------------------------------------
# 行为：切 Tab 时窗口高度伸缩动画
# ---------------------------------------------------------------------------


def _make_ctrl(tmp_path, monkeypatch, panels=None, content_height=679, active=True):
    config_path = tmp_path / "config.json"
    config_path.write_text("{}")
    monkeypatch.setattr(settings_window, "NSApp", _fake_app(active))

    ctrl = settings_window.SettingsWindowController.__new__(
        settings_window.SettingsWindowController
    )
    ctrl._config_path = str(config_path)
    ctrl._current_tab = settings_window.PANEL_TAB_CONFIG
    ctrl._last_request_seq = None
    ctrl._panels = panels or _fake_panels_with_sizes()
    ctrl._window = _FakeWindow(content_height)
    ctrl._tab_buttons = {}
    return ctrl


def test_tab_switch_animation_duration_is_quarter_second():
    """用户选定的动画时长：0.25 秒。"""
    assert settings_window.TAB_SWITCH_ANIM_SEC == 0.25


def test_tab_switch_animates_window_frame_instead_of_jumping(tmp_path, monkeypatch):
    """切 Tab 走 NSAnimationContext 动画，不用 setFrame_display_animate_ 瞬变。

    2026-11-01 实测：setFrame_display_animate_(..., animate=True) 在本机根本不动画
    （高度直接跳到目标值，0ms），只有 animator().setFrame_display_() 会插值。"""
    ctx = _FakeAnimationContext()
    monkeypatch.setattr(settings_window, "NSAnimationContext", ctx)

    ctrl = _make_ctrl(tmp_path, monkeypatch)
    ctrl._select_tab(settings_window.PANEL_TAB_ROUTING)

    assert ctrl._window.instant_frames == [], "不应再用瞬变的 setFrame_display_animate_"
    assert len(ctrl._window.animated_frames) == 1, "应通过 animator() 动画改 frame"
    assert ctx.begins == 1 and ctx.ends == 1, "动画必须包在 begin/endGrouping 里"
    assert ctx.durations == [settings_window.TAB_SWITCH_ANIM_SEC]


def test_inactive_app_falls_back_to_instant_resize(tmp_path, monkeypatch):
    """app 不是 active 时必须瞬时改高度，不能交给 animator()。

    2026-11-01 实测：NSApp.isActive() 为假时 animator().setFrame_display_() 整个
    被丢弃 —— frame 不变、completionHandler 也不触发，窗口会停在旧高度。
    IPC 跳转（菜单点「分流规则」）时本进程常不是 active，所以必须兜底。"""
    ctx = _FakeAnimationContext()
    monkeypatch.setattr(settings_window, "NSAnimationContext", ctx)

    ctrl = _make_ctrl(tmp_path, monkeypatch, active=False)
    ctrl._select_tab(settings_window.PANEL_TAB_ROUTING)

    assert ctrl._window.animated_frames == [], "inactive 时 animator() 会被丢弃，不能用"
    assert len(ctrl._window.instant_frames) == 1, "inactive 时应瞬时改 frame"
    assert ctx.begins == 0 and ctx.ends == 0, "inactive 时不该开动画分组"

    # 两条路径的目标 frame 必须一致（只是有无动画的区别）
    animated_ctrl = _make_ctrl(tmp_path, monkeypatch, active=True)
    actx = _FakeAnimationContext()
    monkeypatch.setattr(settings_window, "NSAnimationContext", actx)
    animated_ctrl._select_tab(settings_window.PANEL_TAB_ROUTING)
    assert ctrl._window.instant_frames[0] == animated_ctrl._window.animated_frames[0]


def test_incoming_panel_is_glued_below_tab_bar_before_animating(tmp_path, monkeypatch):
    """动画开始前把新面板顶边粘到 Tab 栏正下方。

    2026-11-01 实测：面板若保持 y=0 贴底锚定，窗口变高时新面板会顶进 Tab 栏
    （最多重叠 129px）；单纯改成贴顶锚定又会在收缩时留出 141px 空白。
    两者都不可接受，必须按「旧内容区高」重定位一次再动画。"""
    ctx = _FakeAnimationContext()
    monkeypatch.setattr(settings_window, "NSAnimationContext", ctx)

    ctrl = _make_ctrl(tmp_path, monkeypatch, content_height=679)
    ctrl._select_tab(settings_window.PANEL_TAB_ROUTING)

    panel = ctrl._panels[settings_window.PANEL_TAB_ROUTING]
    assert panel.frames, "动画前必须重定位新面板"
    origin, size = panel.frames[0]
    _pw, ph = panel.panelSize()
    assert size == (_pw, ph)
    # 顶边 = 旧内容区高 - TAB_BAR_HEIGHT，即紧贴 Tab 栏下沿
    assert origin[1] + ph == 679 - settings_window.TAB_BAR_HEIGHT


def test_panels_anchor_to_top_so_they_follow_the_growing_window():
    """面板必须挂 NSViewMinYMargin（贴顶锚定），否则窗口变高时面板留在底部、
    与 Tab 栏之间裂开一道缝。锚定在 _build_window 里设（真实窗口下的行为
    由 tests/smoke_settings_window.py 验证）。"""
    source = os.path.join(os.path.dirname(__file__), "..", "settings_window.py")
    text = open(source).read()
    panel_block = text.split("for tab, panel in self._panels.items():")[1].split(
        "content.addSubview_(view)"
    )[0]
    assert "setAutoresizingMask_(NSViewMinYMargin)" in panel_block
    assert "setAutoresizingMask_(0)" not in panel_block


def test_select_tab_without_resize_skips_animation(tmp_path, monkeypatch):
    """初始化（resize=False）时不动画、不改 frame，直接按目标高度布局。"""
    ctx = _FakeAnimationContext()
    monkeypatch.setattr(settings_window, "NSAnimationContext", ctx)

    ctrl = _make_ctrl(tmp_path, monkeypatch)
    ctrl._select_tab(settings_window.PANEL_TAB_CONFIG, resize=False)

    assert ctrl._window.instant_frames == []
    assert ctrl._window.animated_frames == []
    assert ctx.begins == 0


def test_poll_switches_tab_on_new_seq(tmp_path, monkeypatch):
    """轮询到新 seq 的请求时切 Tab 并前置窗口。"""
    config_path = tmp_path / "config.json"
    config_path.write_text("{}")
    monkeypatch.setattr(settings_window, "NSApp", _fake_app())

    ctrl = settings_window.SettingsWindowController.__new__(
        settings_window.SettingsWindowController
    )
    ctrl._config_path = str(config_path)
    ctrl._current_tab = settings_window.PANEL_TAB_CONFIG
    ctrl._last_request_seq = None
    ctrl._panels = _fake_panels()
    ctrl._window = _FakeWindow()
    ctrl._tab_buttons = {}

    # 无请求：不动
    ctrl._pollPanelRequest_(None)
    assert ctrl._current_tab == settings_window.PANEL_TAB_CONFIG

    # 写入请求：切 Tab
    settings_window.request_panel_tab(str(config_path), settings_window.PANEL_TAB_ROUTING)
    ctrl._pollPanelRequest_(None)
    assert ctrl._current_tab == settings_window.PANEL_TAB_ROUTING
    assert ctrl._window.brought_to_front is True
    assert ctrl._window.title == "分流规则"

    # 同一 seq 再次轮询：不重复切换（幂等）
    ctrl._window.brought_to_front = False
    ctrl._pollPanelRequest_(None)
    assert ctrl._current_tab == settings_window.PANEL_TAB_ROUTING
    assert ctrl._window.brought_to_front is False


def test_poll_ignores_request_seen_at_startup(tmp_path, monkeypatch):
    """开窗时文件里已有的旧请求（seq 已见过）不应抢走 Tab。"""
    config_path = tmp_path / "config.json"
    config_path.write_text("{}")
    settings_window.request_panel_tab(str(config_path), settings_window.PANEL_TAB_SUPER_DNS)
    seen_seq = json.loads((tmp_path / "ui_state.json").read_text())["panel_request"]["seq"]
    monkeypatch.setattr(settings_window, "NSApp", _fake_app())

    ctrl = settings_window.SettingsWindowController.__new__(
        settings_window.SettingsWindowController
    )
    ctrl._config_path = str(config_path)
    ctrl._current_tab = settings_window.PANEL_TAB_CONFIG
    ctrl._last_request_seq = ctrl._read_request_seq()
    ctrl._panels = _fake_panels()
    ctrl._window = _FakeWindow()
    ctrl._tab_buttons = {}

    assert ctrl._last_request_seq == seen_seq
    ctrl._pollPanelRequest_(None)
    assert ctrl._current_tab == settings_window.PANEL_TAB_CONFIG


# ---------------------------------------------------------------------------
# 行为：saveAll_ 把节点配置 + 分流规则一起落盘
# ---------------------------------------------------------------------------


class _FakePanel:
    def __init__(self, size=(400, 300)):
        self._size = size
        self.frames = []
        self.masks = []
        self.hidden = None

    def panelSize(self):
        return self._size

    def view(self):
        return self

    def setHidden_(self, hidden):
        self.hidden = hidden

    def setFrame_(self, frame):
        self.frames.append(frame)

    def setAutoresizingMask_(self, mask):
        self.masks.append(mask)


def _fake_panels():
    return {
        settings_window.PANEL_TAB_CONFIG: _FakePanel(),
        settings_window.PANEL_TAB_ROUTING: _FakePanel(),
        settings_window.PANEL_TAB_SUPER_DNS: _FakePanel(),
        settings_window.PANEL_TAB_REWRITE: _FakePanel(),
    }


def _fake_panels_with_sizes():
    """四个高度不同的面板，用于验证伸缩动画的几何。尺寸与真实面板一致。"""
    return {
        settings_window.PANEL_TAB_CONFIG: _FakePanel((520, 518)),
        settings_window.PANEL_TAB_ROUTING: _FakePanel((520, 480)),
        settings_window.PANEL_TAB_SUPER_DNS: _FakePanel((520, 430)),
        settings_window.PANEL_TAB_REWRITE: _FakePanel((520, 330)),
    }


class _FakeAnimationContext:
    """记录 NSAnimationContext 的分组与时长设置。"""

    def __init__(self):
        self.begins = 0
        self.ends = 0
        self.durations = []

    def beginGrouping(self):
        self.begins += 1

    def endGrouping(self):
        self.ends += 1

    def currentContext(self):
        return self

    def setDuration_(self, duration):
        self.durations.append(duration)


def _fake_app(active=True):
    return type("App", (), {
        "stopModal": staticmethod(lambda: None),
        "activateIgnoringOtherApps_": staticmethod(lambda flag: None),
        "isActive": staticmethod(lambda: active),
    })


class _FakeWindow:
    def __init__(self, content_height=400):
        self.closed = False
        self.brought_to_front = False
        self.title = None
        self._frame = _FakeFrame()
        self._content = _FakeContentView(content_height)
        self.instant_frames = []
        self.animated_frames = []
        self._animator = _FakeAnimator(self)

    def frame(self):
        return self._frame

    def contentView(self):
        return self._content

    def animator(self):
        return self._animator

    def setFrame_display_animate_(self, frame, display, animate):
        self.instant_frames.append(frame)
        self._frame = _FakeFrame(frame)

    def setFrame_display_(self, frame, display):
        """inactive 兜底路径用的瞬时改 frame。"""
        self.instant_frames.append(frame)
        self._frame = _FakeFrame(frame)

    def _apply_animated_frame(self, frame):
        self.animated_frames.append(frame)
        self._frame = _FakeFrame(frame)

    def setTitle_(self, title):
        self.title = title

    def makeKeyAndOrderFront_(self, sender):
        self.brought_to_front = True

    def close(self):
        self.closed = True


class _FakeAnimator:
    def __init__(self, window):
        self._window = window

    def setFrame_display_(self, frame, display):
        self._window._apply_animated_frame(frame)


class _FakeContentView:
    def __init__(self, height):
        self._frame = _FakeFrame(((0, 0), (settings_window.WINDOW_WIDTH, height)))

    def frame(self):
        return self._frame


class _FakeFrame:
    def __init__(self, frame=None):
        frame = frame or ((0, 0), (560, 400))
        self.origin = _FakePoint(frame[0])
        self.size = _FakeSize(frame[1])


class _FakePoint:
    def __init__(self, point):
        self.x, self.y = point


class _FakeSize:
    def __init__(self, size):
        self.width, self.height = size


class _FakeConfigPanel:
    def __init__(self, address):
        self._address = address

    def apply_to(self, config):
        config.setdefault("server", {})
        config["server"]["address"] = self._address
        return config


class _FakeRoutingPanel:
    def __init__(self, enabled):
        self._enabled = enabled

    def apply_to(self, config):
        config["routing"] = {
            "enabled": self._enabled,
            "direct_rules": ["domain:example.com"],
            "proxy_rules": [],
            "default": "proxy",
        }
        return config


class _FakeRewritePanel:
    def __init__(self, enabled=True, listen_port=996, target="https://abc.com:996"):
        self._enabled = enabled
        self._listen_port = listen_port
        self._target = target

    def apply_to(self, config):
        config["rewrite"] = {
            "enabled": self._enabled,
            "listen_port": self._listen_port,
            "target": self._target,
        }
        return config


def test_save_all_writes_all_config_blocks_and_closes(tmp_path, monkeypatch):
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({
        "server": {"address": "old.example.com"},
        "routing": {"enabled": False},
        "rewrite": {"enabled": False, "listen_port": 996, "target": ""},
    }))

    ctrl = settings_window.SettingsWindowController.__new__(
        settings_window.SettingsWindowController
    )
    ctrl._config_path = str(config_path)
    ctrl._app_path = None
    ctrl._config_panel = _FakeConfigPanel("new.example.com")
    ctrl._routing_panel = _FakeRoutingPanel(True)
    ctrl._rewrite_panel = _FakeRewritePanel()
    ctrl._window = _FakeWindow()
    ctrl._request_timer = None

    sync_calls = []
    monkeypatch.setitem(
        sys.modules, "autostart",
        type("A", (), {"sync": staticmethod(lambda *a: sync_calls.append(a))}),
    )
    monkeypatch.setattr(settings_window, "NSApp", _fake_app())

    ctrl.saveAll_(None)

    saved = json.loads(config_path.read_text())
    assert saved["server"]["address"] == "new.example.com"
    assert saved["routing"]["enabled"] is True
    assert saved["routing"]["direct_rules"] == ["domain:example.com"]
    assert saved["rewrite"]["enabled"] is True
    assert saved["rewrite"]["target"] == "https://abc.com:996"
    assert ctrl._window.closed is True
    assert len(sync_calls) == 1


def test_save_all_reads_latest_disk_config_before_applying(tmp_path, monkeypatch):
    """先读盘再 apply：面板打开期间被主进程改过的键（如 certPin）不会被覆盖。"""
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({
        "server": {"address": "old.example.com", "certPin": "fresh-pin"},
        "routing": {"enabled": False},
        "rewrite": {"enabled": False, "listen_port": 996, "target": ""},
    }))

    ctrl = settings_window.SettingsWindowController.__new__(
        settings_window.SettingsWindowController
    )
    ctrl._config_path = str(config_path)
    ctrl._app_path = None
    ctrl._config_panel = _FakeConfigPanel("new.example.com")
    ctrl._routing_panel = _FakeRoutingPanel(False)
    ctrl._rewrite_panel = _FakeRewritePanel(enabled=False, target="")
    ctrl._window = _FakeWindow()
    ctrl._request_timer = None

    monkeypatch.setitem(sys.modules, "autostart", type("A", (), {"sync": staticmethod(lambda *a: None)}))
    monkeypatch.setattr(settings_window, "NSApp", _fake_app())

    ctrl.saveAll_(None)

    saved = json.loads(config_path.read_text())
    assert saved["server"]["certPin"] == "fresh-pin"
    assert saved["server"]["address"] == "new.example.com"


def test_cancel_all_closes_window_without_writing(tmp_path, monkeypatch):
    """取消：什么都不写，直接关窗；面板里改脏的值不落盘。"""
    config_path = tmp_path / "config.json"
    original = {
        "server": {"address": "old.example.com"},
        "routing": {"enabled": False},
        "rewrite": {"enabled": False, "listen_port": 996, "target": ""},
    }
    config_path.write_text(json.dumps(original))

    ctrl = settings_window.SettingsWindowController.__new__(
        settings_window.SettingsWindowController
    )
    ctrl._config_path = str(config_path)
    ctrl._app_path = None
    # 面板里改脏了地址，但取消不应该写盘
    ctrl._config_panel = _FakeConfigPanel("SHOULD-NOT-BE-SAVED.example.com")
    ctrl._routing_panel = _FakeRoutingPanel(True)
    ctrl._rewrite_panel = _FakeRewritePanel(target="https://SHOULD-NOT-BE-SAVED:996")
    ctrl._window = _FakeWindow()
    ctrl._request_timer = None

    sync_calls = []
    monkeypatch.setitem(
        sys.modules, "autostart",
        type("A", (), {"sync": staticmethod(lambda *a: sync_calls.append(a))}),
    )
    monkeypatch.setattr(settings_window, "NSApp", _fake_app())

    ctrl.cancelAll_(None)

    assert ctrl._window.closed is True, "取消必须关窗"
    assert json.loads(config_path.read_text()) == original, "取消不能改 config"
    assert sync_calls == [], "取消不能触发 autostart.sync"


def test_super_dns_save_stays_panel_local():
    """Super DNS 的「保存」仍只写域名文件、不关窗（不经过 saveAll_）。"""
    source = os.path.join(os.path.dirname(__file__), "..", "super_dns_panel.py")
    text = open(source).read()

    assert "def saveDomains_(self, sender):" in text
    assert "write_domains_file(self._domains_text.string())" in text
    assert "saveAll_" not in text
    assert "NSApp.stopModal()" not in text
