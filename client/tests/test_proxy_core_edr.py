"""EdrBlockDetector 测试：两种失败形状分开处理。

- ConnectionResetError 形状有歧义（EDR 注入 RST 或网络真的 RST），需要窗口内
  连续多次才怀疑；上游服务器故障（如 EMFILE）也会产生 reset，因此连接一旦
  成功恢复，必须通知 UI 清除“请求被安全软件拦截”的 sticky 状态，避免误报
  持续整晚。
- EBADF (errno 9) 是定性信号：网络故障作用在数据包上（超时/拒绝/DNS 失败），
  造不出“本地 fd 在 connect 半途失效”这个形状，只有本机网络过滤扩展能做到。
  因此单次即认定，且不被无关的成功连接清除（EDR 按进程间歇拦截时，直连成功
  与节点 EBADF 同时存在，用成功清判定正是把 EDR 拦截误报成“节点不通”的原因）。
"""

import errno
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import proxy_core
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


# --------------------------------------------------------------------------
# EBADF：定性信号，单次即认定
# --------------------------------------------------------------------------

def test_single_badfd_is_conclusive():
    on_blocked = CallbackRecorder()
    detector = EdrBlockDetector(on_blocked=on_blocked)

    detector.record_reset("node.example", 8002, errno_value=errno.EBADF)

    assert detector.blocked is True
    assert on_blocked.calls == [("node.example", 8002)]


def test_badfd_verdict_survives_unrelated_success():
    """回归：直连成功不得清除 EBADF 判定，否则 UI 会退回显示“节点不通”。"""
    detector = EdrBlockDetector(on_blocked=CallbackRecorder())

    detector.record_reset("node.example", 8002, errno_value=errno.EBADF)
    detector.record_success()  # 例如某个直连域名连上了

    assert detector.blocked is True


def test_badfd_does_not_fire_recovery_on_success():
    on_recovered = CallbackRecorder()
    detector = EdrBlockDetector(
        on_blocked=CallbackRecorder(),
        on_recovered=on_recovered,
    )

    detector.record_reset("node.example", 8002, errno_value=errno.EBADF)
    detector.record_success()

    assert on_recovered.calls == []


def test_recovery_fires_after_badfd_verdict_expires(monkeypatch):
    """EBADF 判定过期后，下一个成功连接要能清掉 UI 的 sticky 拦截提示。"""
    clock = {"now": 1000.0}
    monkeypatch.setattr(proxy_core.time, "monotonic", lambda: clock["now"])
    on_recovered = CallbackRecorder()
    detector = EdrBlockDetector(
        on_blocked=CallbackRecorder(),
        on_recovered=on_recovered,
    )

    detector.record_reset("node.example", 8002, errno_value=errno.EBADF)
    clock["now"] += EdrBlockDetector.EBADF_STICKY + 1
    detector.record_success()

    assert detector.blocked is False
    assert on_recovered.calls == [()]


def test_badfd_verdict_expires_after_sticky_window(monkeypatch):
    clock = {"now": 1000.0}
    monkeypatch.setattr(proxy_core.time, "monotonic", lambda: clock["now"])
    detector = EdrBlockDetector(on_blocked=CallbackRecorder())

    detector.record_reset("node.example", 8002, errno_value=errno.EBADF)
    assert detector.blocked is True

    clock["now"] += EdrBlockDetector.EBADF_STICKY + 1
    assert detector.blocked is False


def test_repeated_badfd_does_not_spam_blocked_callback(monkeypatch):
    clock = {"now": 1000.0}
    monkeypatch.setattr(proxy_core.time, "monotonic", lambda: clock["now"])
    on_blocked = CallbackRecorder()
    detector = EdrBlockDetector(on_blocked=on_blocked)

    for _ in range(5):
        detector.record_reset("node.example", 8002, errno_value=errno.EBADF)
        clock["now"] += 1

    assert len(on_blocked.calls) == 1


# --------------------------------------------------------------------------
# ConnectionResetError：歧义形状，仍走阈值 + 成功清除
# --------------------------------------------------------------------------

def test_reset_error_alone_is_not_conclusive():
    detector = EdrBlockDetector(on_blocked=CallbackRecorder())

    detector.record_reset("node.example", 8002)
    detector.record_reset("node.example", 8002)

    assert detector.blocked is False


def test_reset_error_threshold_sets_blocked():
    detector = EdrBlockDetector(on_blocked=CallbackRecorder())

    for _ in range(EdrBlockDetector.THRESHOLD):
        detector.record_reset("node.example", 8002)

    assert detector.blocked is True


def test_success_clears_reset_error_verdict():
    detector = EdrBlockDetector(on_blocked=CallbackRecorder())

    for _ in range(EdrBlockDetector.THRESHOLD):
        detector.record_reset("node.example", 8002)
    detector.record_success()

    assert detector.blocked is False


def test_other_errno_is_not_treated_as_conclusive():
    """ECONNREFUSED / 超时等真网络故障形状不得被当成 EDR 拦截。"""
    detector = EdrBlockDetector(on_blocked=CallbackRecorder())

    detector.record_reset("node.example", 8002, errno_value=errno.ECONNREFUSED)

    assert detector.blocked is False
