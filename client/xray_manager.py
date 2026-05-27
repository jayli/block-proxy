from proxy_core import ProxyCore


class XrayManager:
    def __init__(self, **kwargs):
        self._core = ProxyCore()

    def start(self, user_config):
        self._core.start(user_config)

    def stop(self):
        self._core.stop()

    def is_running(self):
        return self._core.is_running()
