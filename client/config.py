import json
import os
import copy

DEFAULT_CONFIG = {
    "server": {
        "protocol": "socks5",
        "address": "",
        "port": 8002,
        "username": "",
        "password": "",
        "tls": True,
        "allowInsecure": True,
    },
    "local": {
        "socks_port": 1080,
        "http_port": 1087,
        "udp": True,
    },
    "mode": "global",
    "routing": {
        "enabled": False,
        "direct_rules": [],
        "proxy_rules": [],
        "default": "proxy",
    },
    "tunnel": {
        "enabled": False,
        "server_address": "",
        "server_port": 8003,
    },
}

DEFAULT_CONFIG_DIR = os.path.expanduser(
    "~/Library/Application Support/BlockProxyClient"
)


class Config:
    def __init__(self, config_path=None):
        if config_path is None:
            config_path = os.path.join(DEFAULT_CONFIG_DIR, "config.json")
        self.config_path = config_path
        self.data = None

    def load(self):
        if os.path.exists(self.config_path):
            with open(self.config_path, "r") as f:
                self.data = json.load(f)
            self._fill_defaults()
        else:
            self.data = copy.deepcopy(DEFAULT_CONFIG)
            self.save()
        return self.data

    def _fill_defaults(self):
        """Recursively fill missing fields (including sub-fields)"""
        for key, value in DEFAULT_CONFIG.items():
            if key not in self.data:
                self.data[key] = copy.deepcopy(value)
            elif isinstance(value, dict):
                for sub_key, sub_value in value.items():
                    if sub_key not in self.data[key]:
                        self.data[key][sub_key] = copy.deepcopy(sub_value)

    def save(self):
        os.makedirs(os.path.dirname(self.config_path), exist_ok=True)
        with open(self.config_path, "w") as f:
            json.dump(self.data, f, indent=2)

    def is_configured(self):
        return bool(self.data and self.data["server"]["address"])
