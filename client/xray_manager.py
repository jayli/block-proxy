import json
import os
import subprocess
import shutil


class XrayManager:
    def __init__(self, xray_path=None, config_dir=None):
        if xray_path is None:
            bundle_path = os.path.join(
                os.path.dirname(os.path.abspath(__file__)),
                "resources",
                "xray",
            )
            if os.path.exists(bundle_path):
                xray_path = bundle_path
            else:
                xray_path = shutil.which("xray") or "/usr/local/bin/xray"
        if config_dir is None:
            config_dir = os.path.expanduser(
                "~/Library/Application Support/BlockProxyClient"
            )
        self.xray_path = xray_path
        self.config_dir = config_dir
        self.config_file = os.path.join(config_dir, "xray_config.json")
        self.process = None

    def generate_config(self, user_config):
        server = user_config["server"]
        local = user_config["local"]

        xray_config = {
            "inbounds": [
                {
                    "tag": "socks-in",
                    "port": local["socks_port"],
                    "listen": "127.0.0.1",
                    "protocol": "socks",
                    "settings": {"udp": local["udp"]},
                },
                {
                    "tag": "http-in",
                    "port": local["http_port"],
                    "listen": "127.0.0.1",
                    "protocol": "http",
                },
            ],
            "outbounds": [self._build_outbound(server)],
        }

        os.makedirs(self.config_dir, exist_ok=True)
        with open(self.config_file, "w") as f:
            json.dump(xray_config, f, indent=2)

        return self.config_file

    def _build_outbound(self, server):
        outbound = {
            "protocol": "socks",
            "settings": {
                "servers": [self._build_server(server)],
            },
        }

        if server["tls"]:
            outbound["streamSettings"] = {
                "network": "tcp",
                "security": "tls",
                "tlsSettings": {
                    "allowInsecure": server["allowInsecure"],
                    "serverName": server["address"],
                },
            }

        return outbound

    def _build_server(self, server):
        entry = {
            "address": server["address"],
            "port": server["port"],
        }
        if server["username"] and server["password"]:
            entry["users"] = [
                {"user": server["username"], "pass": server["password"]}
            ]
        return entry

    def start(self, user_config):
        if self.is_running():
            self.stop()

        config_path = self.generate_config(user_config)
        self.process = subprocess.Popen(
            [self.xray_path, "run", "-c", config_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def stop(self):
        if self.process is None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process = None

    def is_running(self):
        if self.process is None:
            return False
        return self.process.poll() is None
