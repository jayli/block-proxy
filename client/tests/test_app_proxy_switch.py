"""面板代理开关的主进程侧行为回归测试。

设置窗口是独立子进程，开关请求经 proxy_switch.json 投递给主进程，
主进程经 proxy_state.json 回写连接状态。app.py 依赖 PyObjC，测试里
不能直接 import，沿用同目录既有做法：从源码 AST 取出目标方法，拼成
探针类再 exec，用替身对象驱动真实逻辑。
"""

import ast
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import config as config_mod

_APP = os.path.join(os.path.dirname(__file__), "..", "app.py")


def _app_tree():
    with open(_APP, encoding="utf-8") as f:
        return ast.parse(f.read(), filename=_APP)


def _class_node(tree, name):
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == name:
            return node
    raise AssertionError(f"class {name} not found")


def _method(class_node, name):
    for node in class_node.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"method {name} not found")


def _probe_controller(*method_names):
    """把 AppController 的若干方法装进探针类，绕过 PyObjC 依赖。"""
    controller = _class_node(_app_tree(), "AppController")
    methods = [_method(controller, name) for name in method_names]
    kwargs = dict(
        name="Probe", bases=[], keywords=[], body=methods, decorator_list=[]
    )
    if sys.version_info >= (3, 12):
        kwargs["type_params"] = []
    probe_cls = ast.ClassDef(**kwargs)
    ast.copy_location(probe_cls, methods[0])
    module = ast.Module(body=[probe_cls], type_ignores=[])
    ast.fix_missing_locations(module)
    namespace = {"__name__": "app_probe", "read_proxy_switch": config_mod.read_proxy_switch,
                 "write_proxy_state": config_mod.write_proxy_state}
    exec(compile(module, _APP, "exec"), namespace)
    return namespace["Probe"]()


def _make_probe(tmp_path, *, connected=False, connecting=False, disconnecting=False):
    """构造一个带替身依赖的探针，记录 _connect/_disconnect_async 调用。"""
    probe = _probe_controller(
        "_publish_proxy_state",
        "_pollProxySwitch_",
        "_seed_switch_seq",
    )
    cfg_path = str(tmp_path / "config.json")
    calls = {"connect": 0, "disconnect": 0}
    probe.config = SimpleNamespace(
        config_path=cfg_path,
        is_configured=lambda: True,
    )
    probe.connected = connected
    probe._connecting = connecting
    probe._disconnecting = disconnecting
    probe._last_switch_seq = None
    probe._state_seq = 0
    probe._last_published_state = None
    probe._switch_poll_timer = None
    probe._connect = lambda: calls.__setitem__("connect", calls["connect"] + 1)
    probe._disconnect_async = lambda: calls.__setitem__(
        "disconnect", calls["disconnect"] + 1
    )
    # _start_switch_polling 里会建 NSTimer，测试替身掉
    probe._stop_switch_polling = lambda: None
    return probe, cfg_path, calls


def test_switch_on_triggers_connect(tmp_path):
    probe, cfg_path, calls = _make_probe(tmp_path, connected=False)
    config_mod.write_proxy_switch(cfg_path, True, 1)
    probe._pollProxySwitch_(None)
    assert calls["connect"] == 1
    assert calls["disconnect"] == 0


def test_switch_off_triggers_disconnect(tmp_path):
    probe, cfg_path, calls = _make_probe(tmp_path, connected=True)
    config_mod.write_proxy_switch(cfg_path, False, 2)
    probe._pollProxySwitch_(None)
    assert calls["disconnect"] == 1
    assert calls["connect"] == 0


def test_same_seq_not_reprocessed(tmp_path):
    """seq 未变不重复处理：轮询每 0.3s 跑一次，不能每次都连/断。"""
    probe, cfg_path, calls = _make_probe(tmp_path, connected=False)
    config_mod.write_proxy_switch(cfg_path, True, 1)
    probe._pollProxySwitch_(None)
    probe._pollProxySwitch_(None)
    probe._pollProxySwitch_(None)
    assert calls["connect"] == 1


def test_switch_on_when_already_connected_is_noop(tmp_path):
    probe, cfg_path, calls = _make_probe(tmp_path, connected=True)
    config_mod.write_proxy_switch(cfg_path, True, 1)
    probe._pollProxySwitch_(None)
    assert calls["connect"] == 0
    assert calls["disconnect"] == 0


def test_switch_off_when_already_disconnected_is_noop(tmp_path):
    probe, cfg_path, calls = _make_probe(tmp_path, connected=False)
    config_mod.write_proxy_switch(cfg_path, False, 1)
    probe._pollProxySwitch_(None)
    assert calls["disconnect"] == 0


def test_request_ignored_while_busy(tmp_path):
    """正在连接/断开时忽略请求（面板此时也禁用了开关）。"""
    probe, cfg_path, calls = _make_probe(tmp_path, connected=False, connecting=True)
    config_mod.write_proxy_switch(cfg_path, True, 1)
    probe._pollProxySwitch_(None)
    assert calls["connect"] == 0


def test_unconfigured_shows_message_instead_of_alert(tmp_path):
    """未配置节点时不弹 NSAlert（会卡住轮询），改发布提示文案。"""
    probe, cfg_path, calls = _make_probe(tmp_path, connected=False)
    probe.config.is_configured = lambda: False
    config_mod.write_proxy_switch(cfg_path, True, 1)
    probe._pollProxySwitch_(None)
    assert calls["connect"] == 0
    state = config_mod.read_proxy_state(cfg_path)
    assert state is not None
    assert state["message"] == "请先配置节点"
    assert state["connected"] is False


def test_no_switch_file_is_noop(tmp_path):
    probe, cfg_path, calls = _make_probe(tmp_path, connected=False)
    probe._pollProxySwitch_(None)
    assert calls["connect"] == 0
    assert calls["disconnect"] == 0


def test_publish_state_connected_message(tmp_path):
    probe, cfg_path, _ = _make_probe(tmp_path, connected=True)
    probe._publish_proxy_state()
    state = config_mod.read_proxy_state(cfg_path)
    assert state == {
        "connected": True,
        "busy": False,
        "message": "（已连接）",
        "seq": 1,
    }


def test_publish_state_connecting_is_busy(tmp_path):
    probe, cfg_path, _ = _make_probe(tmp_path, connected=False, connecting=True)
    probe._publish_proxy_state()
    state = config_mod.read_proxy_state(cfg_path)
    assert state["busy"] is True
    assert state["message"] == "连接中..."


def test_publish_state_dedupes_unchanged(tmp_path):
    """状态没变不重复写盘（seq 不递增），避免每 0.3s 无谓 IO。"""
    probe, cfg_path, _ = _make_probe(tmp_path, connected=True)
    probe._publish_proxy_state()
    first = config_mod.read_proxy_state(cfg_path)
    probe._publish_proxy_state()
    second = config_mod.read_proxy_state(cfg_path)
    assert first["seq"] == second["seq"] == 1


def test_publish_state_seq_increments_on_change(tmp_path):
    probe, cfg_path, _ = _make_probe(tmp_path, connected=True)
    probe._publish_proxy_state()
    assert config_mod.read_proxy_state(cfg_path)["seq"] == 1
    probe.connected = False
    probe._publish_proxy_state()
    assert config_mod.read_proxy_state(cfg_path)["seq"] == 2
    assert config_mod.read_proxy_state(cfg_path)["connected"] is False


def test_explicit_message_overrides_default(tmp_path):
    """连接失败分支用显式 message 覆盖默认文案。"""
    probe, cfg_path, _ = _make_probe(tmp_path, connected=False)
    probe._publish_proxy_state(message="连接失败")
    state = config_mod.read_proxy_state(cfg_path)
    assert state["message"] == "连接失败"
    assert state["connected"] is False


# ── 静态结构检查：发布点与 timer 生命周期不能漏 ────────────────────


def _calls_self_method(node, method_name):
    for child in ast.walk(node):
        if (
            isinstance(child, ast.Call)
            and isinstance(child.func, ast.Attribute)
            and child.func.attr == method_name
            and isinstance(child.func.value, ast.Name)
            and child.func.value.id == "self"
        ):
            return True
    return False


def test_state_published_at_all_transition_points():
    """四个状态转换点都必须发布，否则面板开关会停在旧位置。"""
    controller = _class_node(_app_tree(), "AppController")
    for name in (
        "_begin_connecting",
        "_on_connected",
        "_on_disconnected",
        "_disconnect_async",
    ):
        assert _calls_self_method(_method(controller, name), "_publish_proxy_state"), (
            f"{name} 没有发布连接状态：面板开关与文案会停在旧状态"
        )


def test_connect_failure_publishes_failure_message():
    """启动失败分支要发布「连接失败」，不能只留空文案。"""
    controller = _class_node(_app_tree(), "AppController")
    connect = _method(controller, "_connect")
    found = False
    for node in ast.walk(connect):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "_publish_proxy_state"
        ):
            for kw in node.keywords:
                if (
                    kw.arg == "message"
                    and isinstance(kw.value, ast.Constant)
                    and kw.value.value == "连接失败"
                ):
                    found = True
    assert found, "_connect 失败分支没有发布「连接失败」文案"


def test_switch_polling_tied_to_settings_window_lifetime():
    """轮询只在设置窗口子进程存活期间跑，窗口退出必须停。"""
    controller = _class_node(_app_tree(), "AppController")
    show = _method(controller, "_show_settings_window")
    assert _calls_self_method(show, "_start_switch_polling"), (
        "打开设置窗口后没有启动开关轮询：拨开关不会生效"
    )
    # 子进程退出后在主线程停轮询
    source = open(_APP, encoding="utf-8").read()
    assert "self._run_on_main(self._stop_switch_polling)" in source, (
        "设置窗口退出后没有停轮询：主进程会永久带着一个 0.3s timer"
    )


def test_poll_timer_added_to_common_modes():
    """菜单跟踪模式下也要触发，必须挂到 common modes。"""
    controller = _class_node(_app_tree(), "AppController")
    start = _method(controller, "_start_switch_polling")
    found = False
    for node in ast.walk(start):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "addTimer_forMode_"
        ):
            found = True
    assert found, "开关轮询 timer 没挂到 common modes，菜单开着时不会触发"


def test_stale_switch_request_not_replayed_on_window_open(tmp_path):
    """开窗时把文件里已有的 seq 记为已见过：上一轮的陈旧请求不能重放。

    否则用户上次拨过开关，下次一开设置窗口就会意外连/断一次代理。
    """
    probe, cfg_path, calls = _make_probe(tmp_path, connected=False)
    config_mod.write_proxy_switch(cfg_path, True, 99)

    probe._seed_switch_seq()
    assert probe._last_switch_seq == 99

    probe._pollProxySwitch_(None)
    assert calls["connect"] == 0, "陈旧开关请求被重放了"

    # 播种之后新拨的请求仍然要生效
    config_mod.write_proxy_switch(cfg_path, True, 100)
    probe._pollProxySwitch_(None)
    assert calls["connect"] == 1


def test_seed_switch_seq_without_file(tmp_path):
    """没有 IPC 文件时播种为 None，不能抛异常。"""
    probe, cfg_path, calls = _make_probe(tmp_path, connected=False)
    probe._seed_switch_seq()
    assert probe._last_switch_seq is None
    probe._pollProxySwitch_(None)
    assert calls["connect"] == 0
