"""重定向面板（rewrite_panel.py）测试。

面板是 PyObjC 控件，这里只测不依赖真实窗口的方法：apply_to 写 config、
validate_before_save 的校验分支、开关与主代理解耦的语义。
控件几何由 tests/smoke_settings_window.py 在真实 GUI 会话下验证。
"""

import os
import socket
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import rewrite_panel
from rewrite_panel import RewritePanel, PANEL_WIDTH, PANEL_HEIGHT, HINT_LINES


class FakeField:
    def __init__(self, value):
        self._value = value
        self.tooltip = None
        self.color = None

    def stringValue(self):
        return self._value

    def setStringValue(self, value):
        self._value = value

    # PyObjC 风格 setter
    def setStringValue_(self, value):
        self._value = value

    def setTextColor_(self, color):
        self.color = color

    def setToolTip_(self, tip):
        self.tooltip = tip


class FakeSwitch:
    def __init__(self, state=0):
        self._state = state

    def state(self):
        return self._state

    def setState_(self, state):
        self._state = state


class FakeContainer:
    def window(self):
        return None


class FakeNotification:
    """controlTextDidEndEditing_ 收到的通知替身：object() 返回触发的控件。"""

    def __init__(self, obj):
        self._obj = obj

    def object(self):
        return self._obj


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _make_panel(enabled=False, port="996", target="https://abc.com:996",
                saved_rewrite=None):
    panel = RewritePanel.__new__(RewritePanel)
    panel._save_target = None
    panel._container = FakeContainer()
    panel._enabled_switch = FakeSwitch(1 if enabled else 0)
    panel._port_field = FakeField(port)
    panel._target_field = FakeField(target)
    panel._port_status_label = FakeField("")
    panel._rewrite = saved_rewrite if saved_rewrite is not None else {}
    return panel


# ---------------------------------------------------------------------------
# 面板规格
# ---------------------------------------------------------------------------


def test_panel_width_matches_other_panels():
    from config_panel import PANEL_WIDTH as CONFIG_W
    from routing_panel import PANEL_WIDTH as ROUTING_W
    from super_dns_panel import PANEL_WIDTH as SUPER_DNS_W

    assert PANEL_WIDTH == CONFIG_W == ROUTING_W == SUPER_DNS_W


def test_panel_has_reasonable_height():
    assert 200 < PANEL_HEIGHT < 520


# ---------------------------------------------------------------------------
# apply_to
# ---------------------------------------------------------------------------


def test_apply_to_writes_enabled_port_and_target():
    panel = _make_panel(enabled=True, port="996", target="https://abc.com:996")
    config = {}
    panel.apply_to(config)

    assert config["rewrite"] == {
        "enabled": True, "listen_port": 996, "target": "https://abc.com:996",
    }


def test_apply_to_switch_off_writes_disabled():
    panel = _make_panel(enabled=False, target="https://abc.com:996")
    config = {"rewrite": {"enabled": True, "listen_port": 996,
                          "target": "https://abc.com:996"}}
    panel.apply_to(config)

    assert config["rewrite"]["enabled"] is False
    # 关掉开关也保留端口与目标，下次打开不用重填
    assert config["rewrite"]["listen_port"] == 996
    assert config["rewrite"]["target"] == "https://abc.com:996"


def test_apply_to_strips_target_whitespace():
    panel = _make_panel(target="  https://abc.com:996  ")
    config = {}
    panel.apply_to(config)
    assert config["rewrite"]["target"] == "https://abc.com:996"


def test_apply_to_keeps_existing_port_when_input_invalid():
    """端口非法时保留原值：运行侧 start() 会对无效配置报错并拒绝启动。"""
    panel = _make_panel(port="abc")
    config = {"rewrite": {"enabled": False, "listen_port": 8080, "target": ""}}
    panel.apply_to(config)

    assert config["rewrite"]["listen_port"] == 8080


def test_apply_to_preserves_other_config_blocks():
    panel = _make_panel(enabled=True)
    config = {"server": {"address": "x"}, "routing": {"enabled": True}}
    panel.apply_to(config)

    assert config["server"] == {"address": "x"}
    assert config["routing"] == {"enabled": True}
    assert config["rewrite"]["enabled"] is True


# ---------------------------------------------------------------------------
# validate_before_save
# ---------------------------------------------------------------------------


def test_validate_accepts_valid_input():
    panel = _make_panel(port="996", target="https://abc.com:996")
    assert panel.validate_before_save() == []


def test_validate_rejects_bad_port():
    panel = _make_panel(port="abc", target="https://abc.com:996")
    errors = panel.validate_before_save()
    assert len(errors) == 1
    assert "本地监听端口" in errors[0]


def test_validate_rejects_bad_target():
    panel = _make_panel(port="996", target="ftp://abc.com")
    errors = panel.validate_before_save()
    assert len(errors) == 1
    assert "https://" in errors[0]


def test_validate_rejects_empty_target():
    panel = _make_panel(port="996", target="")
    errors = panel.validate_before_save()
    assert errors == ["目标地址不能为空"]


def test_validate_reports_both_errors():
    panel = _make_panel(port="0", target="ftp://abc.com")
    errors = panel.validate_before_save()
    assert len(errors) == 2


def test_validate_marks_invalid_fields_red():
    panel = _make_panel(port="abc", target="https://abc.com:996")
    panel.validate_before_save()

    assert panel._port_field.tooltip is not None
    assert panel._target_field.tooltip is None


def test_validate_clears_tooltip_on_valid_field():
    panel = _make_panel(port="996", target="https://abc.com:996")
    panel._port_field.tooltip = "stale error"
    panel.validate_before_save()
    assert panel._port_field.tooltip is None


# ---------------------------------------------------------------------------
# 说明文案：必须讲清用途与解耦语义
# ---------------------------------------------------------------------------


def test_hint_mentions_transparent_forwarding():
    text = "\n".join(HINT_LINES)
    assert "透明转发" in text
    assert "proxy_pass" in text


def test_hint_mentions_direct_connection_and_no_cert_check():
    """用户明确要求：说明里写清目标直连、不经节点、不校验证书。"""
    text = "\n".join(HINT_LINES)
    assert "直连" in text
    assert "不经过代理节点" in text
    assert "不校验" in text and "TLS 证书" in text


def test_hint_mentions_claude_code_use_case():
    """用户明确要求：说明这个功能是解决 Claude Code 桌面版接三方 API 的。"""
    text = "\n".join(HINT_LINES)
    assert "Claude Code" in text
    assert "三方 API" in text
    assert "baseURL" in text


def test_hint_mentions_decoupling_from_main_proxy():
    """用户明确要求：开关与主代理完全解耦，代理没开也能独立生效。"""
    text = "\n".join(HINT_LINES)
    assert "与主代理完全独立" in text
    assert "代理未连接时也可单独启用" in text


# ---------------------------------------------------------------------------
# 保存 / 取消转发给宿主
# ---------------------------------------------------------------------------


class FakeHost:
    def __init__(self):
        self.saved = 0
        self.cancelled = 0

    def saveAll_(self, sender):
        self.saved += 1

    def cancelAll_(self, sender):
        self.cancelled += 1


def test_save_click_forwards_to_host_when_valid():
    panel = _make_panel(port="996", target="https://abc.com:996")
    host = FakeHost()
    panel.setSaveTarget_(host)
    panel.saveClicked_(None)
    assert host.saved == 1


def test_save_click_blocked_when_invalid():
    """校验不过时不转发保存（不关窗、不写盘）。"""
    panel = _make_panel(port="abc", target="https://abc.com:996")
    host = FakeHost()
    panel.setSaveTarget_(host)

    alerts = []
    panel._show_validation_alert = lambda errors: alerts.append(errors)
    # 直接打桩 NSAlert 路径：saveClicked_ 内部会弹窗，这里验证没转发即可
    import rewrite_panel as mod

    class FakeAlert:
        def alloc(self):
            return self

        def init(self):
            return self

        def setMessageText_(self, t):
            pass

        def setInformativeText_(self, t):
            pass

        def addButtonWithTitle_(self, t):
            pass

        def runModal(self):
            return 1000

    original = mod.NSAlert
    mod.NSAlert = FakeAlert()
    try:
        panel.saveClicked_(None)
    finally:
        mod.NSAlert = original

    assert host.saved == 0


def test_cancel_click_forwards_to_host():
    panel = _make_panel()
    host = FakeHost()
    panel.setSaveTarget_(host)
    panel.cancelClicked_(None)
    assert host.cancelled == 1
    assert host.saved == 0


# ---------------------------------------------------------------------------
# 端口可绑定性探测：打开开关 / 端口失焦 / 保存前
# ---------------------------------------------------------------------------


def test_switch_on_with_reserved_port_shows_error_next_to_port_field():
    """用户明确要求：打开开关就检测，失败提示显示在本地监听端口后面。"""
    panel = _make_panel(enabled=False, port="997")
    panel._enabled_switch.setState_(1)
    panel.onEnabledSwitchChanged_(None)

    assert panel._port_status_label.stringValue() == "启动失败，建议换成 1024 及以上的端口号"


def test_switch_on_with_valid_port_shows_no_error():
    panel = _make_panel(enabled=False, port=str(_free_port()))
    panel._enabled_switch.setState_(1)
    panel.onEnabledSwitchChanged_(None)

    assert panel._port_status_label.stringValue() == ""


def test_switch_off_clears_error():
    panel = _make_panel(enabled=True, port="997")
    panel._port_status_label.setStringValue_("启动失败，建议换成 1024 及以上的端口号")
    panel._enabled_switch.setState_(0)
    panel.onEnabledSwitchChanged_(None)

    assert panel._port_status_label.stringValue() == ""


def test_probe_treats_own_running_listener_as_available():
    """已保存配置 enabled 且端口未改：主进程 listener 正占着该端口是正常
    运行状态，不能报「已被占用」。"""
    port = _free_port()
    s = socket.socket()
    s.bind(("127.0.0.1", port))
    s.listen(1)
    try:
        panel = _make_panel(
            enabled=False, port=str(port),
            saved_rewrite={"enabled": True, "listen_port": port},
        )
        panel._enabled_switch.setState_(1)
        panel.onEnabledSwitchChanged_(None)
        assert panel._port_status_label.stringValue() == ""
    finally:
        s.close()


def test_probe_reports_foreign_process_holding_port():
    """端口被别的进程占着（且不是已保存的 rewrite 配置）要报错。"""
    port = _free_port()
    s = socket.socket()
    s.bind(("127.0.0.1", port))
    s.listen(1)
    try:
        panel = _make_panel(enabled=False, port=str(port))
        panel._enabled_switch.setState_(1)
        panel.onEnabledSwitchChanged_(None)
        assert "已被占用" in panel._port_status_label.stringValue()
    finally:
        s.close()


def test_port_field_blur_rechecks_bindability():
    """改完端口失焦就重新探测，不必等到点保存。"""
    panel = _make_panel(enabled=True, port="997")
    panel._port_field.setStringValue_("997")
    panel.controlTextDidEndEditing_(FakeNotification(panel._port_field))
    assert panel._port_status_label.stringValue() == "启动失败，建议换成 1024 及以上的端口号"

    panel._port_field.setStringValue_(str(_free_port()))
    panel.controlTextDidEndEditing_(FakeNotification(panel._port_field))
    assert panel._port_status_label.stringValue() == ""


def test_save_blocked_when_switch_on_and_port_unbindable():
    """开关打开 + 端口绑不上：保存被拦下，不写盘不关窗。"""
    panel = _make_panel(enabled=True, port="997", target="https://abc.com:996")
    host = FakeHost()
    panel.setSaveTarget_(host)

    errors = panel.validate_before_save()
    assert len(errors) == 1
    assert "1024" in errors[0]
    assert host.saved == 0


def test_save_allowed_when_switch_off_even_if_port_unbindable():
    """开关关着时不探测：保留端口供下次打开，不该拦住保存。"""
    panel = _make_panel(enabled=False, port="997", target="https://abc.com:996")
    host = FakeHost()
    panel.setSaveTarget_(host)

    assert panel.validate_before_save() == []
    panel.saveClicked_(None)
    assert host.saved == 1


def test_save_allowed_when_switch_on_and_port_valid():
    panel = _make_panel(enabled=True, port=str(_free_port()),
                        target="https://abc.com:996")
    host = FakeHost()
    panel.setSaveTarget_(host)

    assert panel.validate_before_save() == []
    panel.saveClicked_(None)
    assert host.saved == 1


def test_invalid_port_syntax_skips_probe():
    """端口不是数字时只报格式错，不叠加探测错。"""
    panel = _make_panel(enabled=True, port="abc", target="https://abc.com:996")
    errors = panel.validate_before_save()
    assert len(errors) == 1
    assert "必须是数字" in errors[0]
    assert panel._port_status_label.stringValue() == ""


def test_panel_does_not_write_disk_or_close_window_itself():
    """面板只建控件、不写盘不关窗（与 config_panel / routing_panel 一致）。"""
    source = os.path.join(os.path.dirname(__file__), "..", "rewrite_panel.py")
    text = open(source).read()

    assert "NSApp.stopModal()" not in text
    assert "json.dump" not in text
    assert "open(" not in text.replace("initWithFrame_", "")
