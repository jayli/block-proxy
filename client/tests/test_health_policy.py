"""健康检查决策纯函数测试。

背景：健康检查每 3s 检查本地代理线程；若在“用户点关闭代理”或全量重连的
瞬间 tick，会误判线程死亡，sleep(2) 后把刚关闭的代理重新拉起（global 模式
还会重新开启系统代理）。决策逻辑抽成纯函数以便回归测试。
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from health_policy import health_check_skip_reason, health_check_restart_allowed


class TestHealthCheckSkipReason:
    def test_not_connected_skips_first(self):
        assert (
            health_check_skip_reason(False, True, True, True, True, True)
            == "not_connected"
        )

    def test_quitting_skips(self):
        assert (
            health_check_skip_reason(True, True, False, False, False, False)
            == "quitting"
        )

    def test_reconnecting_skips(self):
        assert (
            health_check_skip_reason(True, False, True, False, False, False)
            == "reconnecting"
        )

    def test_connecting_skips(self):
        assert (
            health_check_skip_reason(True, False, False, True, False, False)
            == "connecting"
        )

    def test_disconnecting_skips(self):
        assert (
            health_check_skip_reason(True, False, False, False, True, False)
            == "disconnecting"
        )

    def test_recycling_skips(self):
        assert (
            health_check_skip_reason(True, False, False, False, False, True)
            == "recycling"
        )

    def test_all_clear_returns_none(self):
        assert (
            health_check_skip_reason(True, False, False, False, False, False)
            is None
        )


class TestHealthCheckRestartAllowed:
    def test_allowed_when_connected_and_idle(self):
        assert health_check_restart_allowed(True, False, False) is True

    def test_denied_when_not_connected(self):
        assert health_check_restart_allowed(False, False, False) is False

    def test_denied_while_disconnecting(self):
        assert health_check_restart_allowed(True, True, False) is False

    def test_denied_while_connecting(self):
        assert health_check_restart_allowed(True, False, True) is False
