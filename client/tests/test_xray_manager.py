import json
import os
import tempfile
import pytest
import sys
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from xray_manager import XrayManager


class TestXrayConfigGeneration:
    def setup_method(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.manager = XrayManager(
            xray_path="/usr/local/bin/xray",
            config_dir=self.tmp_dir,
        )

    def test_generate_config_basic(self):
        user_config = {
            "server": {
                "address": "10.0.0.1",
                "port": 8002,
                "username": "user1",
                "password": "pass1",
                "tls": True,
                "allowInsecure": True,
            },
            "local": {
                "socks_port": 1080,
                "http_port": 1087,
                "udp": True,
            },
        }
        config_path = self.manager.generate_config(user_config)

        assert os.path.exists(config_path)
        with open(config_path) as f:
            xray_config = json.load(f)

        assert len(xray_config["inbounds"]) == 2

        socks_in = xray_config["inbounds"][0]
        assert socks_in["port"] == 1080
        assert socks_in["listen"] == "127.0.0.1"
        assert socks_in["protocol"] == "socks"
        assert socks_in["settings"]["udp"] is True

        http_in = xray_config["inbounds"][1]
        assert http_in["port"] == 1087
        assert http_in["listen"] == "127.0.0.1"
        assert http_in["protocol"] == "http"

        outbound = xray_config["outbounds"][0]
        assert outbound["protocol"] == "socks"
        server = outbound["settings"]["servers"][0]
        assert server["address"] == "10.0.0.1"
        assert server["port"] == 8002
        assert server["users"][0]["user"] == "user1"
        assert server["users"][0]["pass"] == "pass1"

        stream = outbound["streamSettings"]
        assert stream["security"] == "tls"
        assert stream["tlsSettings"]["allowInsecure"] is True
        assert stream["tlsSettings"]["serverName"] == "10.0.0.1"

    def test_generate_config_no_tls(self):
        user_config = {
            "server": {
                "address": "10.0.0.1",
                "port": 8002,
                "username": "user1",
                "password": "pass1",
                "tls": False,
                "allowInsecure": True,
            },
            "local": {
                "socks_port": 1080,
                "http_port": 1087,
                "udp": False,
            },
        }
        config_path = self.manager.generate_config(user_config)

        with open(config_path) as f:
            xray_config = json.load(f)

        socks_in = xray_config["inbounds"][0]
        assert socks_in["settings"]["udp"] is False

        outbound = xray_config["outbounds"][0]
        assert "streamSettings" not in outbound

    def test_generate_config_no_auth(self):
        user_config = {
            "server": {
                "address": "10.0.0.1",
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
        }
        config_path = self.manager.generate_config(user_config)

        with open(config_path) as f:
            xray_config = json.load(f)

        outbound = xray_config["outbounds"][0]
        server = outbound["settings"]["servers"][0]
        assert "users" not in server


class TestXrayProcessManagement:
    def setup_method(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.manager = XrayManager(
            xray_path="/usr/local/bin/xray",
            config_dir=self.tmp_dir,
        )

    @patch("xray_manager.subprocess.Popen")
    def test_start_launches_process(self, mock_popen):
        mock_process = MagicMock()
        mock_process.poll.return_value = None
        mock_popen.return_value = mock_process

        user_config = {
            "server": {
                "address": "10.0.0.1",
                "port": 8002,
                "username": "u",
                "password": "p",
                "tls": True,
                "allowInsecure": True,
            },
            "local": {"socks_port": 1080, "http_port": 1087, "udp": True},
        }

        self.manager.start(user_config)

        mock_popen.assert_called_once()
        args = mock_popen.call_args[0][0]
        assert args[0] == "/usr/local/bin/xray"
        assert args[1] == "run"
        assert args[2] == "-c"
        assert self.manager.is_running()

    @patch("xray_manager.subprocess.Popen")
    def test_stop_terminates_process(self, mock_popen):
        mock_process = MagicMock()
        mock_process.poll.return_value = None
        mock_popen.return_value = mock_process

        user_config = {
            "server": {
                "address": "10.0.0.1",
                "port": 8002,
                "username": "u",
                "password": "p",
                "tls": True,
                "allowInsecure": True,
            },
            "local": {"socks_port": 1080, "http_port": 1087, "udp": True},
        }

        self.manager.start(user_config)
        self.manager.stop()

        mock_process.terminate.assert_called_once()

    def test_is_running_false_initially(self):
        assert self.manager.is_running() is False
