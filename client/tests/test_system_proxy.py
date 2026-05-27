import pytest
import sys
import os
from unittest.mock import patch, call, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from system_proxy import SystemProxy


class TestSystemProxy:
    def setup_method(self):
        self.proxy = SystemProxy()

    @patch("system_proxy.SystemProxy._get_active_interfaces")
    @patch("system_proxy.subprocess.run")
    def test_enable_sets_all_proxy_types(self, mock_run, mock_interfaces):
        mock_interfaces.return_value = ["Wi-Fi"]
        mock_run.return_value = MagicMock(returncode=0, stdout="Enabled: Yes\n", stderr="")

        self.proxy.enable(socks_port=1080, http_port=1087)

        expected_calls = [
            call(["networksetup", "-setsocksfirewallproxy", "Wi-Fi", "127.0.0.1", "1080"], capture_output=True, text=True),
            call(["networksetup", "-setsocksfirewallproxystate", "Wi-Fi", "on"], capture_output=True, text=True),
            call(["networksetup", "-setwebproxy", "Wi-Fi", "127.0.0.1", "1087"], capture_output=True, text=True),
            call(["networksetup", "-setwebproxystate", "Wi-Fi", "on"], capture_output=True, text=True),
            call(["networksetup", "-setsecurewebproxy", "Wi-Fi", "127.0.0.1", "1087"], capture_output=True, text=True),
            call(["networksetup", "-setsecurewebproxystate", "Wi-Fi", "on"], capture_output=True, text=True),
        ]
        mock_run.assert_has_calls(expected_calls, any_order=False)

    @patch("system_proxy.SystemProxy._get_active_interfaces")
    @patch("system_proxy.subprocess.run")
    def test_disable_clears_all_proxy_types(self, mock_run, mock_interfaces):
        mock_interfaces.return_value = ["Wi-Fi"]
        mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")

        self.proxy.disable()

        expected_calls = [
            call(["networksetup", "-setsocksfirewallproxystate", "Wi-Fi", "off"], capture_output=True, text=True),
            call(["networksetup", "-setwebproxystate", "Wi-Fi", "off"], capture_output=True, text=True),
            call(["networksetup", "-setsecurewebproxystate", "Wi-Fi", "off"], capture_output=True, text=True),
        ]
        mock_run.assert_has_calls(expected_calls)

    @patch("system_proxy.SystemProxy._get_active_interfaces")
    @patch("system_proxy.subprocess.run")
    def test_enable_multiple_interfaces(self, mock_run, mock_interfaces):
        mock_interfaces.return_value = ["Wi-Fi", "Ethernet"]
        mock_run.return_value = MagicMock(returncode=0, stdout="Enabled: Yes\n", stderr="")

        self.proxy.enable(socks_port=1080, http_port=1087)

        # 6 set calls per interface x 2 + 3 verify calls per interface x 2 = 18
        assert mock_run.call_count == 18

    @patch("system_proxy.subprocess.run")
    def test_get_active_interfaces(self, mock_run):
        mock_run.return_value = MagicMock(
            stdout="An asterisk (*) denotes that a network service is disabled.\nWi-Fi\n*Bluetooth PAN\nEthernet\n",
            returncode=0,
        )

        interfaces = self.proxy._get_active_interfaces()

        assert "Wi-Fi" in interfaces
        assert "Ethernet" in interfaces
        assert "Bluetooth PAN" not in interfaces
