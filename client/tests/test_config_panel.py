import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import config_panel


class FakeField:
    def __init__(self, value):
        self._value = value

    def stringValue(self):
        return self._value

    def commit(self, value):
        self._value = value


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
        "socks_port": FakeField(str(config["local"].get("socks_port", 1080))),
        "http_port": FakeField(str(config["local"].get("http_port", 1087))),
    }
    panel._tls_cb = FakeCheckbox(config["server"].get("tls", True))
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
    )
    panel._window = FakeWindow(commit)
    panel._container = FakeContainer(panel._window)
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
            "socks_port": 1080,
            "http_port": 1087,
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
        "local": {"socks_port": 1080, "http_port": 1087, "udp": True},
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
        "local": {"socks_port": 1080, "http_port": 1087, "udp": True},
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
        "local": {"socks_port": 1080, "http_port": 1087, "udp": True},
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
        "local": {"socks_port": 1080, "http_port": 1087, "udp": True},
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
        "local": {"socks_port": 1080, "http_port": 1087, "udp": True},
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
    # 面板尺寸与合并前独立窗口一致（像素级不变）
    assert "PANEL_WIDTH = 420" in text
    assert "PANEL_HEIGHT = 615" in text
    assert "w, h = PANEL_WIDTH, PANEL_HEIGHT" in text
    assert "def checkbox(y, title, default, width=None):" in text
    assert "cb.setFont_(ui_font)" in text
    assert "lbl.setFont_(ui_font)" in text
    assert "cert_bind_y = y_pos - CERT_BIND_OFFSET_Y" in text
    assert "cert_bind_label_y = y_pos - CERT_BIND_OFFSET_Y" in text
    assert "y_pos += LOWER_CONTROLS_OFFSET_Y" in text
    assert "y_pos += FOOTER_CONTROLS_OFFSET_Y" in text
    assert "HINT_X + 190, y_pos + 39" in text
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
    assert "self._cert_pin_error_label.setHidden_(True)" in text


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
