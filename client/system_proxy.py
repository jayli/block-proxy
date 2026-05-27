import logging
import subprocess
import atexit
import signal

logger = logging.getLogger("system_proxy")


def _run_networksetup(args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        logger.warning("networksetup failed: %s -> %s", " ".join(args), result.stderr.strip())
    return result.returncode == 0


class SystemProxy:
    def __init__(self):
        self._enabled = False
        self._interfaces = []
        atexit.register(self._cleanup)
        signal.signal(signal.SIGTERM, self._signal_handler)

    def _signal_handler(self, signum, frame):
        self._cleanup()
        raise SystemExit(0)

    def _cleanup(self):
        if self._enabled:
            try:
                self.disable()
            except Exception:
                pass

    def _get_active_interfaces(self):
        result = subprocess.run(
            ["networksetup", "-listallnetworkservices"],
            capture_output=True,
            text=True,
        )
        interfaces = []
        for line in result.stdout.strip().split("\n"):
            if line.startswith("*") or line.startswith("An asterisk"):
                continue
            if line.strip():
                interfaces.append(line.strip())
        return interfaces

    def enable(self, socks_port, http_port):
        self._interfaces = self._get_active_interfaces()
        for iface in self._interfaces:
            _run_networksetup(
                ["networksetup", "-setsocksfirewallproxy", iface, "127.0.0.1", str(socks_port)]
            )
            _run_networksetup(
                ["networksetup", "-setsocksfirewallproxystate", iface, "on"]
            )
            _run_networksetup(
                ["networksetup", "-setwebproxy", iface, "127.0.0.1", str(http_port)]
            )
            _run_networksetup(
                ["networksetup", "-setwebproxystate", iface, "on"]
            )
            _run_networksetup(
                ["networksetup", "-setsecurewebproxy", iface, "127.0.0.1", str(http_port)]
            )
            _run_networksetup(
                ["networksetup", "-setsecurewebproxystate", iface, "on"]
            )
        self._enabled = True
        self._verify(socks_port, http_port)

    def _verify(self, socks_port, http_port):
        checks = [
            ("-getsocksfirewallproxy", "-setsocksfirewallproxystate"),
            ("-getwebproxy", "-setwebproxystate"),
            ("-getsecurewebproxy", "-setsecurewebproxystate"),
        ]
        for iface in self._interfaces:
            for get_cmd, set_cmd in checks:
                result = subprocess.run(
                    ["networksetup", get_cmd, iface],
                    capture_output=True, text=True,
                )
                if "Enabled: No" in result.stdout:
                    logger.warning("proxy not enabled after setting: %s %s, retrying", get_cmd, iface)
                    _run_networksetup(["networksetup", set_cmd, iface, "on"])

    def disable(self):
        interfaces = self._interfaces or self._get_active_interfaces()
        for iface in interfaces:
            _run_networksetup(
                ["networksetup", "-setsocksfirewallproxystate", iface, "off"]
            )
            _run_networksetup(
                ["networksetup", "-setwebproxystate", iface, "off"]
            )
            _run_networksetup(
                ["networksetup", "-setsecurewebproxystate", iface, "off"]
            )
        self._enabled = False
        self._interfaces = []
