import subprocess
import atexit
import signal


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
            self.disable()

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
            subprocess.run(
                ["networksetup", "-setsocksfirewallproxy", iface, "127.0.0.1", str(socks_port)],
                check=True,
            )
            subprocess.run(
                ["networksetup", "-setsocksfirewallproxystate", iface, "on"],
                check=True,
            )
            subprocess.run(
                ["networksetup", "-setwebproxy", iface, "127.0.0.1", str(http_port)],
                check=True,
            )
            subprocess.run(
                ["networksetup", "-setwebproxystate", iface, "on"],
                check=True,
            )
            subprocess.run(
                ["networksetup", "-setsecurewebproxy", iface, "127.0.0.1", str(http_port)],
                check=True,
            )
            subprocess.run(
                ["networksetup", "-setsecurewebproxystate", iface, "on"],
                check=True,
            )
        self._enabled = True

    def disable(self):
        interfaces = self._interfaces or self._get_active_interfaces()
        for iface in interfaces:
            subprocess.run(
                ["networksetup", "-setsocksfirewallproxystate", iface, "off"],
                check=True,
            )
            subprocess.run(
                ["networksetup", "-setwebproxystate", iface, "off"],
                check=True,
            )
            subprocess.run(
                ["networksetup", "-setsecurewebproxystate", iface, "off"],
                check=True,
            )
        self._enabled = False
        self._interfaces = []
