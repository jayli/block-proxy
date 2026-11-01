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


def test_tab_bar_has_three_tabs_with_icon_and_text():
    assert len(settings_window.TAB_SPECS) == 3
    tabs = [spec["tab"] for spec in settings_window.TAB_SPECS]
    assert tabs == list(settings_window.PANEL_TABS)

    for spec in settings_window.TAB_SPECS:
        assert spec["title"]
        assert spec["icon"].endswith(".png")
        assert spec["window_title"]


def test_tab_specs_map_to_the_three_panels():
    assert settings_window.TAB_SPECS[0]["tab"] == settings_window.PANEL_TAB_CONFIG
    assert settings_window.TAB_SPECS[0]["icon"] == "setting.png"
    assert settings_window.TAB_SPECS[0]["window_title"] == "节点配置"

    assert settings_window.TAB_SPECS[1]["tab"] == settings_window.PANEL_TAB_ROUTING
    assert settings_window.TAB_SPECS[1]["icon"] == "router.png"
    assert settings_window.TAB_SPECS[1]["window_title"] == "分流规则"

    assert settings_window.TAB_SPECS[2]["tab"] == settings_window.PANEL_TAB_SUPER_DNS
    assert settings_window.TAB_SPECS[2]["icon"] == "dns.png"
    assert settings_window.TAB_SPECS[2]["window_title"] == "Super DNS - 防止 DNS 污染的域名列表"


def test_tab_icon_assets_exist():
    assets_dir = settings_window._assets_dir()
    for spec in settings_window.TAB_SPECS:
        assert os.path.exists(os.path.join(assets_dir, spec["icon"])), spec["icon"]


def test_window_width_covers_widest_panel():
    from config_panel import PANEL_WIDTH as CONFIG_W
    from routing_panel import PANEL_WIDTH as ROUTING_W
    from super_dns_panel import PANEL_WIDTH as SUPER_DNS_W

    assert settings_window.WINDOW_WIDTH >= max(CONFIG_W, ROUTING_W, SUPER_DNS_W)


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
    def panelSize(self):
        return (400, 300)

    def view(self):
        return self

    def setHidden_(self, hidden):
        self.hidden = hidden

    def setFrame_(self, frame):
        pass

    def setAutoresizingMask_(self, mask):
        pass


def _fake_panels():
    return {
        settings_window.PANEL_TAB_CONFIG: _FakePanel(),
        settings_window.PANEL_TAB_ROUTING: _FakePanel(),
        settings_window.PANEL_TAB_SUPER_DNS: _FakePanel(),
    }


def _fake_app():
    return type("App", (), {
        "stopModal": staticmethod(lambda: None),
        "activateIgnoringOtherApps_": staticmethod(lambda flag: None),
    })


class _FakeWindow:
    def __init__(self):
        self.closed = False
        self.brought_to_front = False
        self.title = None
        self._frame = _FakeFrame()

    def frame(self):
        return self._frame

    def setFrame_display_animate_(self, frame, display, animate):
        self._frame = _FakeFrame(frame)

    def setTitle_(self, title):
        self.title = title

    def makeKeyAndOrderFront_(self, sender):
        self.brought_to_front = True

    def close(self):
        self.closed = True


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


def test_save_all_writes_both_config_blocks_and_closes(tmp_path, monkeypatch):
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({
        "server": {"address": "old.example.com"},
        "routing": {"enabled": False},
    }))

    ctrl = settings_window.SettingsWindowController.__new__(
        settings_window.SettingsWindowController
    )
    ctrl._config_path = str(config_path)
    ctrl._app_path = None
    ctrl._config_panel = _FakeConfigPanel("new.example.com")
    ctrl._routing_panel = _FakeRoutingPanel(True)
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
    assert ctrl._window.closed is True
    assert len(sync_calls) == 1


def test_save_all_reads_latest_disk_config_before_applying(tmp_path, monkeypatch):
    """先读盘再 apply：面板打开期间被主进程改过的键（如 certPin）不会被覆盖。"""
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({
        "server": {"address": "old.example.com", "certPin": "fresh-pin"},
        "routing": {"enabled": False},
    }))

    ctrl = settings_window.SettingsWindowController.__new__(
        settings_window.SettingsWindowController
    )
    ctrl._config_path = str(config_path)
    ctrl._app_path = None
    ctrl._config_panel = _FakeConfigPanel("new.example.com")
    ctrl._routing_panel = _FakeRoutingPanel(False)
    ctrl._window = _FakeWindow()
    ctrl._request_timer = None

    monkeypatch.setitem(sys.modules, "autostart", type("A", (), {"sync": staticmethod(lambda *a: None)}))
    monkeypatch.setattr(settings_window, "NSApp", _fake_app())

    ctrl.saveAll_(None)

    saved = json.loads(config_path.read_text())
    assert saved["server"]["certPin"] == "fresh-pin"
    assert saved["server"]["address"] == "new.example.com"


def test_super_dns_save_stays_panel_local():
    """Super DNS 的「保存」仍只写域名文件、不关窗（不经过 saveAll_）。"""
    source = os.path.join(os.path.dirname(__file__), "..", "super_dns_panel.py")
    text = open(source).read()

    assert "def saveDomains_(self, sender):" in text
    assert "write_domains_file(self._domains_text.string())" in text
    assert "saveAll_" not in text
    assert "NSApp.stopModal()" not in text
