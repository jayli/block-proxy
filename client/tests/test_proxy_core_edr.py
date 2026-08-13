"""EdrBlockDetector 测试：连续 reset 触发拦截告警，连接恢复后清除告警。

背景：检测器把连续 ConnectionResetError 当作 EDR/安全软件拦截的可疑信号。
但上游服务器故障（如 EMFILE）也会产生 reset，因此连接一旦成功恢复，
必须通知 UI 清除“请求被安全软件拦截”的 sticky 状态，避免误报持续整晚。
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from proxy_core import EdrBlockDetector


class CallbackRecorder:
    def __init__(self):
        self.calls = []

    def __call__(self, *args):
        self.calls.append(args)


def test_blocked_callback_fires_after_three_resets():
    on_blocked = CallbackRecorder()
    detector = EdrBlockDetector(on_blocked=on_blocked)

    detector.record_reset("example.com", 443)
    detector.record_reset("example.com", 443)
    detector.record_reset("example.com", 443)

    assert on_blocked.calls == [("example.com", 443)]


def test_success_clears_window_before_threshold():
    on_blocked = CallbackRecorder()
    detector = EdrBlockDetector(on_blocked=on_blocked)

    detector.record_reset("a.com", 443)
    detector.record_reset("a.com", 443)
    detector.record_success()
    detector.record_reset("a.com", 443)
    detector.record_reset("a.com", 443)

    assert on_blocked.calls == []


def test_recovery_callback_fires_after_success_when_notified():
    on_recovered = CallbackRecorder()
    detector = EdrBlockDetector(
        on_blocked=CallbackRecorder(),
        on_recovered=on_recovered,
    )

    detector.record_reset("a.com", 443)
    detector.record_reset("a.com", 443)
    detector.record_reset("a.com", 443)
    detector.record_success()

    assert on_recovered.calls == [()]


def test_recovery_callback_not_fired_without_prior_notification():
    on_recovered = CallbackRecorder()
    detector = EdrBlockDetector(
        on_blocked=CallbackRecorder(),
        on_recovered=on_recovered,
    )

    detector.record_success()

    assert on_recovered.calls == []
