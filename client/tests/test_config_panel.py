import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import config_panel


class FakeField:
    def __init__(self, value):
        self._value = value
        self.tooltip = None

    def stringValue(self):
        return self._value

    def commit(self, value):
        self._value = value

    def setToolTip_(self, tip):
        self.tooltip = tip


class FakePopup:
    def __init__(self, value):
        self._value = value

    def indexOfSelectedItem(self):
        return self._value

    def addItemWithTitle_(self, title):
        pass


class FakeCheckbox:
    def __init__(self, value):
        self._value = value

    def state(self):
        return 1 if self._value else 0

    def setState_(self, state):
        self._value = bool(state)

    def setEnabled_(self, enabled):
        pass


class FakeWindow:
    def __init__(self, commit):
        self._commit = commit
        self.closed = False

    def makeFirstResponder_(self, responder):
        if responder is None:
            self._commit()
        return True

    def close(self):
        self.closed = True


class FakeContainer:
    """面板容器 view 替身：只提供 window()。"""

    def __init__(self, window):
        self._window = window

    def window(self):
        return self._window


class FakeSwitch:
    """NSSwitch 替身：只记录 state/enabled，供 setProxyState_ 驱动。"""

    def __init__(self, state=0):
        self._state = state
        self.enabled = True

    def state(self):
        return self._state

    def setState_(self, state):
        self._state = state

    def setEnabled_(self, enabled):
        self.enabled = bool(enabled)


class FakeLabel:
    def __init__(self, text=""):
        self._text = text

    def stringValue(self):
        return self._text

    def setStringValue_(self, text):
        self._text = text


def _make_panel(config, commit=lambda: None):
    panel = config_panel.ConfigPanel.__new__(config_panel.ConfigPanel)
    panel._config = json.loads(json.dumps(config))
    # socks5 protocol maps to PROTOCOLS[0] (index 0)
    panel._protocol_popup = FakePopup(0)
    panel._server_port_value = str(config["server"].get("port", 8002))
    panel._tunnel_port_value = str(config.get("tunnel", {}).get("server_port", 8004))
    panel._fields = {
        "address": FakeField(config["server"].get("address", "")),
        "port": FakeField(str(config["server"].get("port", 8002))),
        "username": FakeField(config["server"].get("username", "")),
        "password": FakeField(config["server"].get("password", "")),
        "port_local": FakeField(str(config["local"].get("port", 1080))),
    }
    panel._tls_cb = FakeCheckbox(config["server"].get("tls", True))
    panel._ipv6_cb = FakeCheckbox(config["server"].get("ipv6Only", False))
    panel._insecure_cb = FakeCheckbox(config["server"].get("allowInsecure", True))
    panel._udp_cb = FakeCheckbox(config["local"].get("udp", True))
    panel._proxy_private_cb = FakeCheckbox(config["local"].get("proxy_private", False))
    panel._autostart_cb = FakeCheckbox(config.get("autostart", False))
    panel._cert_bind_cb = FakeCheckbox(config["server"].get("certBindEnabled", False))
    panel._cert_pin = config["server"].get("certPin", "")
    panel._cert_pin_mismatch = config["server"].get("certPinMismatch", False)
    panel._cert_pin_touched = False
    panel._initial_server_identity = (
        config["server"].get("address", ""),
        int(config["server"].get("port", 8002)),
        config["server"].get("protocol", "socks5"),
        bool(config["server"].get("tls", True)),
        bool(config["server"].get("ipv6Only", False)),
    )
    panel._window = FakeWindow(commit)
    panel._container = FakeContainer(panel._window)
    panel._proxy_switch = FakeSwitch(0)
    panel._proxy_state_label = FakeLabel("")
    panel._config_path = None
    panel._switch_seq = 0
    return panel


def test_apply_to_commits_active_text_editing_before_reading_controls():
    config = {
        "server": {
            "protocol": "socks5",
            "address": "old.example.com",
            "port": 8002,
            "username": "old-user",
            "password": "old-pass",
            "tls": True,
            "allowInsecure": True,
        },
        "local": {
            "port": 1080,
            "udp": True,
            "proxy_private": False,
        },
        "tunnel": {"enabled": False, "server_address": "", "server_port": 8004},
        "autostart": False,
    }

    panel = _make_panel(config)

    def commit_pending_edits():
        panel._fields["username"].commit("new-user")
        panel._fields["password"].commit("new-pass")

    panel._window = FakeWindow(commit_pending_edits)
    panel._container = FakeContainer(panel._window)
    # 切到 http（PROTOCOLS[1]）
    panel._protocol_popup = FakePopup(1)

    result = panel.apply_to(json.loads(json.dumps(config)))

    assert result["server"]["protocol"] == "http"
    assert result["server"]["username"] == "new-user"
    assert result["server"]["password"] == "new-pass"


def test_apply_to_does_not_write_disk_or_close_window(tmp_path):
    """面板只改 dict：不落盘、不关窗（由宿主窗口统一编排）。"""
    config_path = tmp_path / "config.json"
    config = {
        "server": {
            "protocol": "socks5",
            "address": "node.example.com",
            "port": 8002,
            "username": "",
            "password": "",
            "tls": True,
            "allowInsecure": True,
        },
        "local": {"port": 1080, "udp": True},
        "tunnel": {"enabled": False, "server_port": 8004},
        "autostart": False,
    }
    config_path.write_text(json.dumps(config))

    panel = _make_panel(config)
    panel._fields["address"].commit("changed.example.com")
    panel.apply_to(config)

    # 磁盘上仍是原值，窗口没关
    assert json.loads(config_path.read_text())["server"]["address"] == "node.example.com"
    assert panel._window.closed is False


def test_apply_to_preserves_latest_disk_cert_pin_and_mismatch_when_pin_untouched():
    opened = {
        "server": {
            "protocol": "socks5",
            "address": "node.example.com",
            "port": 8002,
            "username": "",
            "password": "",
            "tls": True,
            "allowInsecure": True,
            "certBindEnabled": True,
            "certPin": "old-pin",
            "certPinMismatch": False,
        },
        "local": {"port": 1080, "udp": True},
        "tunnel": {"enabled": False, "server_port": 8004},
        "autostart": False,
    }
    latest = json.loads(json.dumps(opened))
    latest["server"]["certPin"] = "fresh-pin"
    latest["server"]["certPinMismatch"] = True

    panel = _make_panel(opened)
    saved = panel.apply_to(latest)

    assert saved["server"]["certPin"] == "fresh-pin"
    assert saved["server"]["certPinMismatch"] is True


def test_apply_to_clears_cert_pin_when_user_resets_pin():
    config = {
        "server": {
            "protocol": "socks5",
            "address": "node.example.com",
            "port": 8002,
            "username": "",
            "password": "",
            "tls": True,
            "allowInsecure": True,
            "certBindEnabled": True,
            "certPin": "old-pin",
            "certPinMismatch": True,
        },
        "local": {"port": 1080, "udp": True},
        "tunnel": {"enabled": False, "server_port": 8004},
        "autostart": False,
    }

    panel = _make_panel(config)
    panel._cert_pin = ""
    panel._cert_pin_mismatch = False
    panel._cert_pin_touched = True
    saved = panel.apply_to(json.loads(json.dumps(config)))

    assert saved["server"]["certBindEnabled"] is True
    assert saved["server"]["certPin"] == ""
    assert saved["server"]["certPinMismatch"] is False


def test_apply_to_clears_cert_pin_when_server_identity_changes():
    config = {
        "server": {
            "protocol": "socks5",
            "address": "old.example.com",
            "port": 8002,
            "username": "",
            "password": "",
            "tls": True,
            "allowInsecure": True,
            "certBindEnabled": True,
            "certPin": "old-pin",
            "certPinMismatch": True,
        },
        "local": {"port": 1080, "udp": True},
        "tunnel": {"enabled": False, "server_port": 8004},
        "autostart": False,
    }

    panel = _make_panel(config)
    panel._fields["address"].commit("new.example.com")
    saved = panel.apply_to(json.loads(json.dumps(config)))

    assert saved["server"]["address"] == "new.example.com"
    assert saved["server"]["certPin"] == ""
    assert saved["server"]["certPinMismatch"] is False


def test_apply_to_keeps_tunnel_port_split_when_protocol_is_tunnel():
    config = {
        "server": {
            "protocol": "tunnel",
            "address": "node.example.com",
            "port": 8002,
            "username": "",
            "password": "",
            "tls": True,
            "allowInsecure": True,
        },
        "local": {"port": 1080, "udp": True},
        "tunnel": {"enabled": False, "server_port": 8003},
        "autostart": False,
    }

    panel = _make_panel(config)
    panel._protocol_popup = FakePopup(2)  # tunnel
    panel._server_port_value = "8002"
    panel._fields["port"] = FakeField("8003")
    saved = panel.apply_to(json.loads(json.dumps(config)))

    assert saved["server"]["port"] == 8002
    assert saved["tunnel"]["server_port"] == 8003
    assert saved["tunnel"]["enabled"] is True
    assert saved["server"]["tls"] is True


def test_config_panel_contains_cert_binding_ui_text():
    source = os.path.join(os.path.dirname(__file__), "..", "config_panel.py")
    text = open(source).read()

    assert "节点使用自签证书，已固定开启" in text
    assert "绑定服务器证书" in text
    assert "证书指纹不匹配（中间人攻击 or 服务端证书已更新）" in text
    assert "首次连接时将自动绑定证书指纹" in text


def test_config_panel_cert_binding_layout_uses_compact_checkbox_rows():
    source = os.path.join(os.path.dirname(__file__), "..", "config_panel.py")
    text = open(source).read()

    assert "CHECK_X = 76" in text
    assert "HINT_X = 102" in text
    assert "UI_FONT_SIZE = 13" in text
    assert "CERT_BIND_OFFSET_Y = 5" in text
    assert "LOWER_CONTROLS_OFFSET_Y = 15" in text
    assert "FOOTER_CONTROLS_OFFSET_Y = 5" in text
    # 面板尺寸：宽度与 Super DNS 一致（520），高度按两列网格重排后降低
    assert "PANEL_WIDTH = 520" in text
    assert "PANEL_HEIGHT = 518" in text
    assert "w, h = PANEL_WIDTH, PANEL_HEIGHT" in text
    # 两列网格：地址|端口、用户名|密码两两并排
    assert "GRID_MARGIN_X = 16" in text
    assert "GRID_GAP_X = 20" in text
    assert "GRID_COL_W = 234" in text
    assert "GRID_COL2_X = GRID_MARGIN_X + GRID_COL_W + GRID_GAP_X" in text
    assert "GRID_FULL_W = GRID_COL_W * 2 + GRID_GAP_X" in text
    # 栅格统一：地址与用户名等宽同列，端口与密码等宽同列（不做特例）
    assert "width=addr_w" not in text
    # 本地 SOCKS/HTTP 端口合并为单行：标签实测 166px，单独排版不进两列网格
    assert "LOCAL_PORT_LABEL_W = 202" in text
    assert "LOCAL_PORT_FIELD_W = 90" in text
    assert "本地SOCKS/HTTP代理端口:" in text
    assert "（仅监听本机流量）" in text
    assert '"port_local"' in text
    # 指纹完整显示：11pt 等宽 + 撑满栅格宽，不缩略
    assert "CERT_PIN_FONT_SIZE = 11" in text
    assert "f\"证书指纹：{self._cert_pin}\"" in text
    assert "[:24]" not in text
    # 「重置」按钮右缘对齐栅格右缘，左右留白对称
    assert "RESET_BTN_W = 70" in text
    assert "GRID_MARGIN_X + GRID_FULL_W - RESET_BTN_W" in text
    # 标签比输入框低 2px 才能视觉对齐（实测偏移扫描：-2 时文字墨迹中心差 0.00px）
    assert "LABEL_ALIGN_DY = 2" in text
    assert "label(text, y - LABEL_ALIGN_DY, x=col_x, lw=GRID_LABEL_W)" in text
    # 协议 popup 的标签偏移不同（实测最佳 offset=0），不能套 LABEL_ALIGN_DY
    assert 'label("协议:", y_pos - 2)' in text
    # 指纹/提示行下推 4px，下面的控件跟着下推同样多（保住间距）
    assert "CERT_BIND_LABEL_DROP_Y = 4" in text
    assert "y_pos -= 22 + 28 + CERT_BIND_LABEL_DROP_Y" in text
    assert "def checkbox(y, title, default, width=None):" in text
    assert "cb.setFont_(ui_font)" in text
    assert "lbl.setFont_(ui_font)" in text
    assert "cert_bind_y = y_pos - CERT_BIND_OFFSET_Y" in text
    assert "cert_bind_label_y = y_pos - CERT_BIND_OFFSET_Y" in text
    assert "y_pos += LOWER_CONTROLS_OFFSET_Y" in text
    assert "y_pos += FOOTER_CONTROLS_OFFSET_Y" in text
    assert "y_pos -= 20" in text
    assert "self._reset_pin_btn.setHidden_(True)" in text


def test_config_panel_cert_binding_available_for_tls_socks5_and_http():
    source = os.path.join(os.path.dirname(__file__), "..", "config_panel.py")
    text = open(source).read()

    assert 'supported = self._selected_protocol() in ("socks5", "http") and self._tls_enabled()' in text
    assert "self._cert_bind_cb.setHidden_(False)" in text
    assert "self._cert_bind_label.setHidden_(False)" in text
    assert "self._cert_bind_cb.setEnabled_(supported)" in text
    assert "NSColor.disabledControlTextColor()" in text


def test_config_panel_cert_pin_mismatch_replaces_fingerprint_label():
    source = os.path.join(os.path.dirname(__file__), "..", "config_panel.py")
    text = open(source).read()

    assert "elif self._cert_pin_mismatch:" in text
    assert 'self._cert_bind_label.setStringValue_("证书指纹不匹配（中间人攻击 or 服务端证书已更新）")' in text
    assert "self._cert_bind_label.setTextColor_(NSColor.systemRedColor())" in text
    # 指纹不匹配提示统一由 _cert_bind_label 展示；独立的 _cert_pin_error_label
    # 一直 setHidden_(True)、文案与 _cert_bind_label 重复，已删除
    # （注释里还会提到这个名字，所以只断言不再使用这个属性）
    assert "self._cert_pin_error_label" not in text


def test_config_panel_allow_insecure_is_pinned_true_and_disabled():
    """allowInsecure 钉死为 True（节点自签证书，身份校验靠证书指纹）。"""
    source = os.path.join(os.path.dirname(__file__), "..", "config_panel.py")
    text = open(source).read()

    # 复选框默认勾选且置灰
    assert 'self._insecure_cb = checkbox(y_pos, "允许不安全连接（跳过证书验证）", True)' in text
    assert 'self._insecure_cb.setState_(NSOnState)' in text
    assert 'self._insecure_cb.setEnabled_(False)' in text
    # 不再支持用户切换，回调与动态启用逻辑已移除
    assert "onAllowInsecureChange_" not in text
    assert 'insecure_supported = self._selected_protocol()' not in text
    # 保存时恒为 True，不读取复选框状态
    assert text.count('config["server"]["allowInsecure"] = ALLOW_INSECURE_FORCED') == 2
    assert 'config["server"]["allowInsecure"] = bool(self._insecure_cb.state())' not in text


def test_config_panel_save_button_forwards_to_host_window():
    """面板的「保存」不自己写盘，转发给宿主窗口的 saveAll_。"""
    source = os.path.join(os.path.dirname(__file__), "..", "config_panel.py")
    text = open(source).read()

    assert 'btn.setAction_("saveClicked:")' in text
    assert "def saveClicked_(self, sender):" in text
    assert "self._save_target.saveAll_(sender)" in text
    # 面板内不再有直接写盘/关窗的代码
    assert "def saveAndClose_" not in text
    assert "NSApp.stopModal()" not in text


def test_config_panel_cancel_button_forwards_to_host_window():
    """「取消」与「保存」一样只转发给宿主窗口，面板自己不关窗不写盘。"""
    source = os.path.join(os.path.dirname(__file__), "..", "config_panel.py")
    text = open(source).read()

    assert 'cancel_btn.setAction_("cancelClicked:")' in text
    assert "def cancelClicked_(self, sender):" in text
    assert "self._save_target.cancelAll_(sender)" in text
    assert 'cancel_btn.setTitle_("取消")' in text
    # 取消路径不能写盘、不能自己关窗（关窗由宿主 cancelAll_ 负责）
    cancel_body = text.split("def cancelClicked_(self, sender):")[1].split("\n    def ")[0]
    assert "close()" not in cancel_body
    assert "json.dump" not in cancel_body
    assert "apply_to" not in cancel_body


# ── 代理连接开关 ────────────────────────────────────────────────


def _base_config():
    return {
        "server": {
            "protocol": "socks5",
            "address": "node.example.com",
            "port": 8002,
            "username": "",
            "password": "",
            "tls": True,
            "allowInsecure": True,
        },
        "local": {"port": 1080, "udp": True},
        "tunnel": {"enabled": False, "server_port": 8004},
        "autostart": False,
    }


def test_switch_change_writes_request_with_incrementing_seq(tmp_path):
    """拨动开关：写 IPC 请求，seq 每次递增（主进程按 seq 去重）。"""
    from config import read_proxy_switch

    panel = _make_panel(_base_config())
    cfg_path = str(tmp_path / "config.json")
    panel.setConfigPath_(cfg_path)

    panel._proxy_switch.setState_(1)
    panel.onProxySwitchChange_(panel._proxy_switch)
    assert read_proxy_switch(cfg_path) == {"on": True, "seq": 1}

    panel._proxy_switch.setState_(0)
    panel.onProxySwitchChange_(panel._proxy_switch)
    assert read_proxy_switch(cfg_path) == {"on": False, "seq": 2}


def test_switch_change_without_config_path_is_noop(tmp_path):
    """宿主没注入 config_path（如手动构造面板）时拨开关不写盘不抛。"""
    panel = _make_panel(_base_config())
    panel._proxy_switch.setState_(1)
    panel.onProxySwitchChange_(panel._proxy_switch)  # 不抛异常
    assert panel._switch_seq == 0


def test_set_proxy_state_connected_sets_switch_on_and_message():
    """已连接：开关置开、文案「（已连接）」、开关可用。"""
    panel = _make_panel(_base_config())
    panel.setProxyState_(
        {"connected": True, "busy": False, "message": "（已连接）", "seq": 1}
    )
    assert panel._proxy_switch.state() == 1
    assert panel._proxy_state_label.stringValue() == "（已连接）"
    assert panel._proxy_switch.enabled is True


def test_set_proxy_state_disconnected_sets_switch_off_and_clears_message():
    panel = _make_panel(_base_config())
    panel.setProxyState_({"connected": False, "busy": False, "message": "", "seq": 2})
    assert panel._proxy_switch.state() == 0
    assert panel._proxy_state_label.stringValue() == ""


def test_set_proxy_state_busy_disables_switch_and_keeps_position():
    """busy（连接中）：开关禁用防连点，且不按 connected 改位置。"""
    panel = _make_panel(_base_config())
    panel._proxy_switch.setState_(1)
    panel.setProxyState_(
        {"connected": False, "busy": True, "message": "连接中...", "seq": 3}
    )
    assert panel._proxy_switch.enabled is False
    assert panel._proxy_switch.state() == 1, "busy 时不该按 connected 改开关位置"
    assert panel._proxy_state_label.stringValue() == "连接中..."


def test_set_proxy_state_ignores_non_dict():
    panel = _make_panel(_base_config())
    panel.setProxyState_(None)
    panel.setProxyState_("garbage")
    assert panel._proxy_state_label.stringValue() == ""


def test_proxy_switch_layout_constants():
    """开关 x 与「端口」输入框左缘对齐（端口 input 的正上方）。"""
    expected_x = (
        config_panel.GRID_COL2_X
        + config_panel.GRID_LABEL_W
        + config_panel.GRID_LABEL_GAP
    )
    assert config_panel.PROXY_SWITCH_X == expected_x == 354
    # 状态文案可用宽足够放下实测最长文案（77.4px）
    assert config_panel.PROXY_SWITCH_TEXT_W >= 100


# ── 启用 IPv6（仅 AAAA） ────────────────────────────────────────


def test_apply_to_persists_ipv6_only_flag():
    config = _base_config()
    panel = _make_panel(config)
    panel._ipv6_cb.setState_(1)

    saved = panel.apply_to(json.loads(json.dumps(config)))

    assert saved["server"]["ipv6Only"] is True


def test_apply_to_keeps_ipv6_only_checked_in_tunnel_mode():
    """隧道模式置灰但保留勾选（与 local.udp 一致）；隧道本身不读这个开关。"""
    config = _base_config()
    config["server"]["protocol"] = "tunnel"
    panel = _make_panel(config)
    panel._protocol_popup = FakePopup(2)  # tunnel
    panel._server_port_value = "8002"
    panel._fields["port"] = FakeField("8003")
    panel._ipv6_cb.setState_(1)

    saved = panel.apply_to(json.loads(json.dumps(config)))

    assert saved["server"]["ipv6Only"] is True


def test_apply_to_clears_cert_pin_when_address_family_changes():
    """从 IPv4 切到强制 IPv6 会换掉实际连的 IP，指纹绑定必须失效。"""
    config = _base_config()
    config["server"]["certBindEnabled"] = True
    config["server"]["certPin"] = "old-pin"
    config["server"]["ipv6Only"] = False
    panel = _make_panel(config)
    panel._ipv6_cb.setState_(1)

    saved = panel.apply_to(json.loads(json.dumps(config)))

    assert saved["server"]["ipv6Only"] is True
    assert saved["server"]["certPin"] == ""
    assert saved["server"]["certPinMismatch"] is False


def test_config_panel_ipv6_checkbox_sits_right_of_tls_on_same_row():
    """复选框在 TLS 右侧同一行，且与 TLS 之间留出明显间隙（用户要求右移）。"""
    assert config_panel.IPV6_CHECK_TITLE == "启用 IPv6"
    # TLS 标题实测 172.1px、墨迹从 frame.x+2 起，右缘 250.1；
    # IPv6 从 302 起 → 间隙 51.9px（原始位置 276 时是 25.9px，右移了两个汉字）
    tls_ink_right = 76 + 2 + 172.1
    assert abs((config_panel.IPV6_CHECK_X - tls_ink_right) - 51.9) < 0.5
    # 右缘对齐栅格右边距，不越界
    assert (
        config_panel.IPV6_CHECK_X + config_panel.IPV6_CHECK_W
        == config_panel.GRID_MARGIN_X + config_panel.GRID_FULL_W
    )
    # 标题放得下（「启用 IPv6」实测 56.3px）
    assert config_panel.IPV6_CHECK_W >= 20 + 56.3


def test_config_panel_ipv6_checkbox_disabled_in_tunnel_mode():
    source = os.path.join(os.path.dirname(__file__), "..", "config_panel.py")
    text = open(source).read()

    assert "self._ipv6_cb.setEnabled_(not enabled)" in text
    # 隧道（8003）暂不支持强制 IPv6
    assert 'server_cfg.get("ipv6Only", False)' in text


def test_address_field_hover_tooltip_tracks_full_value():
    """地址框 150px 放不下完整 IPv6 字面量（需 272.5px），靠悬停提示看全值。"""
    source = os.path.join(os.path.dirname(__file__), "..", "config_panel.py")
    text = open(source).read()

    assert 'self._fields["address"].setToolTip_(' in text
    assert "def _sync_address_tooltip(self):" in text
    assert 'self._fields["address"].setDelegate_(self)' in text
    assert "def controlTextDidEndEditing_(self, notification):" in text


def test_sync_address_tooltip_writes_current_value():
    panel = _make_panel(_base_config())
    panel._fields["address"].commit("2408:8206:2420:12d7:d4b5:d4bc:7674:7bf3")

    panel._sync_address_tooltip()

    assert panel._fields["address"].tooltip == "2408:8206:2420:12d7:d4b5:d4bc:7674:7bf3"


def test_sync_address_tooltip_clears_when_empty():
    panel = _make_panel(_base_config())
    panel._fields["address"].commit("   ")

    panel._sync_address_tooltip()

    assert panel._fields["address"].tooltip is None


def test_apply_to_refreshes_address_tooltip():
    config = _base_config()
    panel = _make_panel(config)
    panel._fields["address"].commit("2001:db8::1")

    panel.apply_to(json.loads(json.dumps(config)))

    assert panel._fields["address"].tooltip == "2001:db8::1"


# ── 地址失焦校验 + 点击空白失焦 ────────────────────────────────


def test_validate_node_address_accepts_ipv4_ipv6_and_domain():
    from config import validate_node_address

    for value in (
        "1.2.3.4",
        "255.255.255.255",
        "2001:db8::1",
        "2408:8206:2420:12d7:d4b5:d4bc:7674:7bf3",
        "::1",
        "perf.qzz.io",
        "a-b.c-d.example.com",
    ):
        assert validate_node_address(value) is None, value


def test_validate_node_address_rejects_malformed():
    from config import validate_node_address

    for value in ("", "   ", "999.1.1.1", "1.2.3", "localhost",
                  "-bad.com", "bad-.com", "example.com.", "a" * 64 + ".com"):
        assert validate_node_address(value) is not None, value


def test_validate_node_address_rejects_ipv4_when_ipv6_only():
    from config import validate_node_address

    assert validate_node_address("1.2.3.4", ipv6_only=True) is not None
    assert validate_node_address("2001:db8::1", ipv6_only=True) is None
    assert validate_node_address("perf.qzz.io", ipv6_only=True) is None


def test_validate_port_range():
    from config import validate_port

    assert validate_port("8002") is None
    assert validate_port(" 80 ") is None
    assert validate_port("0") is not None
    assert validate_port("65536") is not None
    assert validate_port("abc") is not None
    assert validate_port("") is not None


def test_address_error_label_shows_short_text_only():
    """面板上只给一行小字「格式有误」，具体原因放悬停提示。"""
    source = os.path.join(os.path.dirname(__file__), "..", "config_panel.py")
    text = open(source).read()

    assert 'ADDRESS_ERROR_TEXT = "格式有误"' in text
    # 贴着地址输入框后面、与端口行同行，不额外占行高
    assert "ADDRESS_ERROR_X = 256" in text
    assert "ADDRESS_ERROR_FONT_SIZE = 11" in text
    assert "y_pos + (24 - ADDRESS_ERROR_H) / 2" in text
    # 具体原因走 tooltip
    assert 'field.setToolTip_(error or (str(field.stringValue() or "").strip() or None))' in text


def test_address_validation_runs_on_blur_not_while_typing():
    source = os.path.join(os.path.dirname(__file__), "..", "config_panel.py")
    text = open(source).read()

    # 输入过程中绝不校验：不得有实时变更回调
    assert "controlTextDidChange_" not in text
    # 只在编辑结束（失焦）时跑
    assert "def controlTextDidEndEditing_(self, notification):" in text
    assert "self._validate_address_field()" in text
    # 保存前再兜一轮
    assert "def validate_before_save(self):" in text


def test_panel_container_accepts_first_responder_for_click_to_blur():
    """点击面板空白处要能失焦：容器必须接受首响应，否则 field editor 一直留着。"""
    assert issubclass(config_panel.PanelContentView, config_panel.NSView)
    assert "def acceptsFirstResponder(self):" in open(
        os.path.join(os.path.dirname(__file__), "..", "config_panel.py")
    ).read()
    source = open(os.path.join(os.path.dirname(__file__), "..", "config_panel.py")).read()
    assert "def acceptsFirstResponderForTab(self):" in source
    assert "return False" in source
    assert "def mouseDown_(self, event):" in source
    assert "window.makeFirstResponder_(self)" in source
