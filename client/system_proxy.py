import logging
import subprocess
import atexit
import signal
import re
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger("system_proxy")

BYPASS_DOMAINS = [
    "*.local",
    "169.254.0.0/16",
    "127.0.0.1",
    "localhost",
    "0.0.0.0",
    "::1",
    "192.168.0.0/16",
    "10.0.0.0/8",
    "172.16.0.0/12",
]


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

    def _get_default_route_devices(self):
        result = subprocess.run(
            ["route", "-n", "get", "default"],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            return []
        devices = []
        for line in result.stdout.splitlines():
            stripped = line.strip()
            if stripped.startswith("interface:"):
                device = stripped.split(":", 1)[1].strip()
                if device:
                    devices.append(device)
        return devices

    def _get_ordered_services_by_device(self):
        result = subprocess.run(
            ["networksetup", "-listnetworkserviceorder"],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            return {}
        services = {}
        current_service = None
        for line in result.stdout.splitlines():
            service_match = re.match(r"^\(\d+\)\s+(.+)$", line.strip())
            if service_match:
                current_service = service_match.group(1).strip()
                continue
            device_match = re.search(r"Device:\s*([^)]+)\)", line)
            if current_service and device_match:
                services[device_match.group(1).strip()] = current_service
                current_service = None
        return services

    def _get_target_interfaces(self):
        devices = self._get_default_route_devices()
        services_by_device = self._get_ordered_services_by_device() if devices else {}
        interfaces = []
        for device in devices:
            service = services_by_device.get(device)
            if service and service not in interfaces:
                interfaces.append(service)
        return interfaces or self._get_active_interfaces()

    def enable(self, socks_port, http_port):
        self._interfaces = self._get_target_interfaces()
        tasks = []
        for iface in self._interfaces:
            tasks.extend([
                ["networksetup", "-setsocksfirewallproxy", iface, "127.0.0.1", str(socks_port)],
                ["networksetup", "-setsocksfirewallproxystate", iface, "on"],
                ["networksetup", "-setwebproxy", iface, "127.0.0.1", str(http_port)],
                ["networksetup", "-setwebproxystate", iface, "on"],
                ["networksetup", "-setsecurewebproxy", iface, "127.0.0.1", str(http_port)],
                ["networksetup", "-setsecurewebproxystate", iface, "on"],
            ])
            tasks.append(
                ["networksetup", "-setproxybypassdomains", iface] + BYPASS_DOMAINS
            )
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(_run_networksetup, tasks))
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
        tasks = []
        for iface in interfaces:
            tasks.extend([
                ["networksetup", "-setsocksfirewallproxystate", iface, "off"],
                ["networksetup", "-setwebproxystate", iface, "off"],
                ["networksetup", "-setsecurewebproxystate", iface, "off"],
            ])
            tasks.append(
                ["networksetup", "-setproxybypassdomains", iface, "Empty"]
            )
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(_run_networksetup, tasks))
        self._enabled = False
        self._interfaces = []
