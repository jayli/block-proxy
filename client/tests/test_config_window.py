import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import config_window


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


def test_save_commits_active_text_editing_before_reading_controls(tmp_path, monkeypatch):
    config_path = tmp_path / "config.json"
    original = {
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
        "tunnel": {
            "enabled": False,
            "server_address": "",
            "server_port": 8004,
        },
        "autostart": False,
    }
    config_path.write_text(json.dumps(original))

    ctrl = config_window.ConfigWindowController.__new__(
        config_window.ConfigWindowController
    )
    ctrl._config_path = str(config_path)
    ctrl._config = json.loads(config_path.read_text())
    # http protocol maps to PROTOCOLS[1] (index 1)
    ctrl._protocol_popup = FakePopup(1)
    ctrl._server_port_value = "8002"
    ctrl._tunnel_port_value = "8004"
    ctrl._fields = {
        "address": FakeField("old.example.com"),
        "port": FakeField("8002"),
        "username": FakeField("old-user"),
        "password": FakeField("old-pass"),
        "socks_port": FakeField("1080"),
        "http_port": FakeField("1087"),
    }
    ctrl._tls_cb = FakeCheckbox(True)
    ctrl._insecure_cb = FakeCheckbox(True)
    ctrl._udp_cb = FakeCheckbox(True)
    ctrl._proxy_private_cb = FakeCheckbox(False)
    ctrl._autostart_cb = FakeCheckbox(False)

    def commit_pending_edits():
        ctrl._fields["username"].commit("new-user")
        ctrl._fields["password"].commit("new-pass")

    ctrl._window = FakeWindow(commit_pending_edits)

    monkeypatch.setattr(config_window, "NSApp", type("App", (), {"stopModal": lambda: None}))
    monkeypatch.setitem(sys.modules, "autostart", type("A", (), {"sync": lambda *a: None}))

    ctrl.saveAndClose_(None)

    saved = json.loads(config_path.read_text())
    assert saved["server"]["protocol"] == "http"
    assert saved["server"]["username"] == "new-user"
    assert saved["server"]["password"] == "new-pass"
    assert ctrl._window.closed is True


def _make_controller_for_save(config_path, config, monkeypatch):
    ctrl = config_window.ConfigWindowController.__new__(
        config_window.ConfigWindowController
    )
    ctrl._config_path = str(config_path)
    ctrl._config = json.loads(json.dumps(config))
    ctrl._protocol_popup = FakePopup(0)
    ctrl._server_port_value = str(config["server"].get("port", 8002))
    ctrl._tunnel_port_value = str(config.get("tunnel", {}).get("server_port", 8004))
    ctrl._fields = {
        "address": FakeField(config["server"].get("address", "")),
        "port": FakeField(str(config["server"].get("port", 8002))),
        "username": FakeField(config["server"].get("username", "")),
        "password": FakeField(config["server"].get("password", "")),
        "socks_port": FakeField(str(config["local"].get("socks_port", 1080))),
        "http_port": FakeField(str(config["local"].get("http_port", 1087))),
    }
    ctrl._tls_cb = FakeCheckbox(config["server"].get("tls", True))
    ctrl._insecure_cb = FakeCheckbox(config["server"].get("allowInsecure", True))
    ctrl._udp_cb = FakeCheckbox(config["local"].get("udp", True))
    ctrl._proxy_private_cb = FakeCheckbox(config["local"].get("proxy_private", False))
    ctrl._autostart_cb = FakeCheckbox(config.get("autostart", False))
    ctrl._cert_bind_cb = FakeCheckbox(config["server"].get("certBindEnabled", False))
    ctrl._cert_pin = config["server"].get("certPin", "")
    ctrl._cert_pin_mismatch = config["server"].get("certPinMismatch", False)
    ctrl._cert_pin_touched = False
    ctrl._initial_server_identity = (
        config["server"].get("address", ""),
        int(config["server"].get("port", 8002)),
        config["server"].get("protocol", "socks5"),
        bool(config["server"].get("tls", True)),
    )
    ctrl._window = FakeWindow(lambda: None)

    monkeypatch.setattr(config_window, "NSApp", type("App", (), {"stopModal": lambda: None}))
    monkeypatch.setitem(sys.modules, "autostart", type("A", (), {"sync": lambda *a: None}))
    return ctrl


def test_save_preserves_latest_disk_cert_pin_and_mismatch_when_pin_untouched(tmp_path, monkeypatch):
    config_path = tmp_path / "config.json"
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
    config_path.write_text(json.dumps(latest))

    ctrl = _make_controller_for_save(config_path, opened, monkeypatch)
    ctrl.saveAndClose_(None)

    saved = json.loads(config_path.read_text())
    assert saved["server"]["certPin"] == "fresh-pin"
    assert saved["server"]["certPinMismatch"] is True


def test_save_clears_cert_pin_when_user_resets_pin(tmp_path, monkeypatch):
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
            "certBindEnabled": True,
            "certPin": "old-pin",
            "certPinMismatch": True,
        },
        "local": {"socks_port": 1080, "http_port": 1087, "udp": True},
        "tunnel": {"enabled": False, "server_port": 8004},
        "autostart": False,
    }
    config_path.write_text(json.dumps(config))

    ctrl = _make_controller_for_save(config_path, config, monkeypatch)
    ctrl._cert_pin = ""
    ctrl._cert_pin_mismatch = False
    ctrl._cert_pin_touched = True
    ctrl.saveAndClose_(None)

    saved = json.loads(config_path.read_text())
    assert saved["server"]["certBindEnabled"] is True
    assert saved["server"]["certPin"] == ""
    assert saved["server"]["certPinMismatch"] is False


def test_save_clears_cert_pin_when_server_identity_changes(tmp_path, monkeypatch):
    config_path = tmp_path / "config.json"
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
    config_path.write_text(json.dumps(config))

    ctrl = _make_controller_for_save(config_path, config, monkeypatch)
    ctrl._fields["address"].commit("new.example.com")
    ctrl.saveAndClose_(None)

    saved = json.loads(config_path.read_text())
    assert saved["server"]["address"] == "new.example.com"
    assert saved["server"]["certPin"] == ""
    assert saved["server"]["certPinMismatch"] is False


def test_config_window_contains_cert_binding_ui_text():
    source = os.path.join(os.path.dirname(__file__), "..", "config_window.py")
    text = open(source).read()

    assert "允许自签证书" in text
    assert "只接受信任的 CA 签发的证书" in text
    assert "绑定服务器证书" in text
    assert "证书指纹不匹配（中间人攻击 or 服务端证书已更新）" in text
    assert "首次连接时将自动绑定证书指纹" in text


def test_config_window_cert_binding_layout_uses_compact_checkbox_rows():
    source = os.path.join(os.path.dirname(__file__), "..", "config_window.py")
    text = open(source).read()

    assert "CHECK_X = 76" in text
    assert "HINT_X = 102" in text
    assert "UI_FONT_SIZE = 13" in text
    assert "CERT_BIND_OFFSET_Y = 5" in text
    assert "LOWER_CONTROLS_OFFSET_Y = 15" in text
    assert "FOOTER_CONTROLS_OFFSET_Y = 5" in text
    assert "w, h = 420, 615" in text
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


def test_config_window_cert_binding_stays_visible_but_disabled_for_http():
    source = os.path.join(os.path.dirname(__file__), "..", "config_window.py")
    text = open(source).read()

    assert 'supported = self._selected_protocol() == "socks5" and self._tls_enabled()' in text
    assert "self._cert_bind_cb.setHidden_(False)" in text
    assert "self._cert_bind_label.setHidden_(False)" in text
    assert "self._cert_bind_cb.setEnabled_(supported)" in text
    assert "NSColor.disabledControlTextColor()" in text


def test_config_window_cert_pin_mismatch_replaces_fingerprint_label():
    source = os.path.join(os.path.dirname(__file__), "..", "config_window.py")
    text = open(source).read()

    assert "elif self._cert_pin_mismatch:" in text
    assert 'self._cert_bind_label.setStringValue_("证书指纹不匹配（中间人攻击 or 服务端证书已更新）")' in text
    assert "self._cert_bind_label.setTextColor_(NSColor.systemRedColor())" in text
    assert "self._cert_pin_error_label.setHidden_(True)" in text


def test_config_window_allow_insecure_disables_when_tls_is_off():
    source = os.path.join(os.path.dirname(__file__), "..", "config_window.py")
    text = open(source).read()

    assert 'insecure_supported = self._selected_protocol() != "tunnel" and self._tls_enabled()' in text
    assert "self._insecure_cb.setEnabled_(insecure_supported)" in text
    assert "self._insecure_hint_label.setTextColor_(NSColor.disabledControlTextColor())" in text
    assert "self._insecure_hint_label.setTextColor_(NSColor.labelColor())" in text
    assert "self._refresh_insecure_hint()" in text[
        text.index("def onTlsChange_") : text.index("def onCertBindChange_")
    ]
