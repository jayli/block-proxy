import json
import os
import tempfile
import pytest
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from config import Config, DEFAULT_CONFIG


class TestConfig:
    def setup_method(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.config_path = os.path.join(self.tmp_dir, "config.json")
        self.config = Config(config_path=self.config_path)

    def test_default_config_created_on_first_load(self):
        data = self.config.load()
        assert data["server"]["port"] == 8002
        assert data["server"]["tls"] is True
        assert data["server"]["allowInsecure"] is True
        assert data["local"]["socks_port"] == 1080
        assert data["local"]["http_port"] == 1087
        assert data["local"]["udp"] is True
        assert data["mode"] == "global"
        assert os.path.exists(self.config_path)

    def test_save_and_load_roundtrip(self):
        self.config.load()
        self.config.data["server"]["address"] = "10.0.0.1"
        self.config.data["server"]["port"] = 9002
        self.config.data["server"]["username"] = "user1"
        self.config.data["server"]["password"] = "pass1"
        self.config.save()

        config2 = Config(config_path=self.config_path)
        data = config2.load()
        assert data["server"]["address"] == "10.0.0.1"
        assert data["server"]["port"] == 9002
        assert data["server"]["username"] == "user1"
        assert data["server"]["password"] == "pass1"

    def test_load_existing_config(self):
        existing = {
            "server": {
                "address": "example.com",
                "port": 443,
                "username": "abc",
                "password": "def",
                "tls": False,
                "allowInsecure": False,
            },
            "local": {"socks_port": 2080, "http_port": 2087, "udp": False},
            "mode": "manual",
        }
        with open(self.config_path, "w") as f:
            json.dump(existing, f)

        data = self.config.load()
        assert data["server"]["address"] == "example.com"
        assert data["server"]["tls"] is False
        assert data["local"]["socks_port"] == 2080
        assert data["mode"] == "manual"

    def test_is_configured_false_when_no_address(self):
        self.config.load()
        assert self.config.is_configured() is False

    def test_is_configured_true_when_address_set(self):
        self.config.load()
        self.config.data["server"]["address"] = "10.0.0.1"
        assert self.config.is_configured() is True

    def test_routing_defaults_in_new_config(self):
        data = self.config.load()
        assert "routing" in data
        assert data["routing"]["enabled"] is False
        assert data["routing"]["direct_rules"] == []
        assert data["routing"]["proxy_rules"] == []
        assert data["routing"]["default"] == "proxy"

    def test_tunnel_http_disguise_enabled_by_default(self):
        data = self.config.load()
        assert data["tunnel"]["http_disguise"] is True

    def test_old_tunnel_config_gets_http_disguise_default(self):
        old = {
            "server": {
                "protocol": "tunnel", "address": "example.com", "port": 8002,
                "username": "", "password": "", "tls": True, "allowInsecure": True,
            },
            "local": {"socks_port": 1080, "http_port": 1087, "udp": True},
            "mode": "global",
            "tunnel": {"enabled": True, "server_address": "example.com", "server_port": 8003},
        }
        with open(self.config_path, "w") as f:
            json.dump(old, f)
        data = self.config.load()
        assert data["tunnel"]["http_disguise"] is True

    def test_old_config_gets_routing_defaults(self):
        old = {
            "server": {
                "protocol": "socks5", "address": "example.com", "port": 8002,
                "username": "", "password": "", "tls": True, "allowInsecure": True,
            },
            "local": {"socks_port": 1080, "http_port": 1087, "udp": True},
            "mode": "global",
        }
        with open(self.config_path, "w") as f:
            json.dump(old, f)
        data = self.config.load()
        assert "routing" in data
        assert data["routing"]["enabled"] is False
        assert data["routing"]["default"] == "proxy"

    def test_partial_routing_gets_sub_defaults(self):
        """routing exists but missing sub-fields, auto-fill"""
        partial = {
            "server": {
                "protocol": "socks5", "address": "x.com", "port": 8002,
                "username": "", "password": "", "tls": True, "allowInsecure": True,
            },
            "local": {"socks_port": 1080, "http_port": 1087, "udp": True},
            "mode": "global",
            "routing": {"enabled": True},  # missing direct_rules, proxy_rules, default
        }
        with open(self.config_path, "w") as f:
            json.dump(partial, f)
        data = self.config.load()
        assert data["routing"]["enabled"] is True  # retain original value
        assert data["routing"]["direct_rules"] == []  # filled
        assert data["routing"]["proxy_rules"] == []
        assert data["routing"]["default"] == "proxy"
