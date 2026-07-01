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

    def titleOfSelectedItem(self):
        return self._value


class FakeCheckbox:
    def __init__(self, value):
        self._value = value

    def state(self):
        return 1 if self._value else 0


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
        "autostart": False,
    }
    config_path.write_text(json.dumps(original))

    ctrl = config_window.ConfigWindowController.__new__(
        config_window.ConfigWindowController
    )
    ctrl._config_path = str(config_path)
    ctrl._config = json.loads(config_path.read_text())
    ctrl._protocol_popup = FakePopup("http")
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
