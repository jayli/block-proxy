"""app.py 里重定向（透明反向代理）接线的回归测试。

app.py 依赖 PyObjC，测试里不能直接 import，沿用同目录既有做法：
从源码 AST 取出目标方法，拼成探针类再 exec，用替身对象驱动真实逻辑。

核心约束：rewrite 与主代理**完全解耦**——代理没连接时也要能独立启停，
代理的连接/断开流程不能触碰它。
"""

import ast
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

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


def _probe_controller(*method_names, extra_globals=None):
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
    namespace = {"__name__": "app_probe"}
    namespace.update(extra_globals or {})
    exec(compile(module, _APP, "exec"), namespace)
    return namespace["Probe"]()


class FakeRewrite:
    """RewriteProxy 替身：记录 start/stop 调用与返回值。"""

    def __init__(self, running=False, start_result=(True, "ok")):
        self.running = running
        self.start_result = start_result
        self.start_calls = []
        self.stop_calls = 0

    def start(self, rewrite_config):
        self.start_calls.append(rewrite_config)
        ok, message = self.start_result
        self.running = ok
        return ok, message

    def stop(self):
        self.stop_calls += 1
        self.running = False

    def is_running(self):
        return self.running


class FakeConfig:
    def __init__(self, data):
        self.data = data


class FakeLogger:
    def __init__(self):
        self.infos = []
        self.warnings = []

    def info(self, msg, *args):
        self.infos.append(msg % args if args else msg)

    def warning(self, msg, *args):
        self.warnings.append(msg % args if args else msg)


def _make_probe(rewrite_config, *, running=False, start_result=(True, "ok")):
    log = FakeLogger()
    probe = _probe_controller(
        "_rewrite_identity", "_sync_rewrite", "_stop_rewrite",
        extra_globals={"logger": log},
    )
    probe.config = FakeConfig({"rewrite": rewrite_config})
    probe.rewrite = FakeRewrite(running=running, start_result=start_result)
    probe._rewrite_identity_cache = None
    return probe, log


# ---------------------------------------------------------------------------
# _sync_rewrite：按配置启停
# ---------------------------------------------------------------------------


def test_sync_starts_rewrite_when_enabled():
    probe, log = _make_probe({
        "enabled": True, "listen_port": 996, "target": "https://abc.com:996",
    })
    probe._sync_rewrite()

    assert len(probe.rewrite.start_calls) == 1
    assert probe.rewrite.start_calls[0]["listen_port"] == 996
    assert probe.rewrite.is_running() is True
    assert any("started" in m for m in log.infos)


def test_sync_does_not_start_when_disabled():
    probe, _log = _make_probe({
        "enabled": False, "listen_port": 996, "target": "https://abc.com:996",
    })
    probe._sync_rewrite()

    assert probe.rewrite.start_calls == []
    assert probe.rewrite.is_running() is False


def test_sync_stops_running_rewrite_when_disabled():
    """关掉开关：正在跑的 listener 必须停掉。"""
    probe, log = _make_probe(
        {"enabled": False, "listen_port": 996, "target": "https://abc.com:996"},
        running=True,
    )
    probe._sync_rewrite()

    assert probe.rewrite.stop_calls == 1
    assert probe.rewrite.is_running() is False
    assert any("stopped" in m for m in log.infos)


def test_sync_is_idempotent_when_config_unchanged():
    """配置没变就不重启 listener（幂等）。"""
    probe, _log = _make_probe({
        "enabled": True, "listen_port": 996, "target": "https://abc.com:996",
    })
    probe._sync_rewrite()
    probe._sync_rewrite()
    probe._sync_rewrite()

    assert len(probe.rewrite.start_calls) == 1


def test_sync_restarts_when_listen_port_changes():
    probe, _log = _make_probe({
        "enabled": True, "listen_port": 996, "target": "https://abc.com:996",
    })
    probe._sync_rewrite()
    assert len(probe.rewrite.start_calls) == 1

    probe.config.data["rewrite"]["listen_port"] = 997
    probe._sync_rewrite()
    assert len(probe.rewrite.start_calls) == 2
    assert probe.rewrite.start_calls[1]["listen_port"] == 997


def test_sync_restarts_when_target_changes():
    probe, _log = _make_probe({
        "enabled": True, "listen_port": 996, "target": "https://abc.com:996",
    })
    probe._sync_rewrite()

    probe.config.data["rewrite"]["target"] = "https://other.com:8443"
    probe._sync_rewrite()
    assert len(probe.rewrite.start_calls) == 2
    assert probe.rewrite.start_calls[1]["target"] == "https://other.com:8443"


def test_sync_restarts_when_toggled_on():
    probe, _log = _make_probe({
        "enabled": False, "listen_port": 996, "target": "https://abc.com:996",
    })
    probe._sync_rewrite()
    assert probe.rewrite.start_calls == []

    probe.config.data["rewrite"]["enabled"] = True
    probe._sync_rewrite()
    assert len(probe.rewrite.start_calls) == 1


def test_sync_logs_warning_when_start_fails():
    """启动失败（如端口被占）只记日志，不抛异常。"""
    probe, log = _make_probe(
        {"enabled": True, "listen_port": 996, "target": "https://abc.com:996"},
        start_result=(False, "监听 127.0.0.1:996 失败：address in use"),
    )
    probe._sync_rewrite()

    assert probe.rewrite.is_running() is False
    assert any("failed to start" in m for m in log.warnings)


def test_sync_tolerates_missing_rewrite_block():
    """老配置没有 rewrite 块也不能崩。"""
    log = FakeLogger()
    probe = _probe_controller(
        "_rewrite_identity", "_sync_rewrite", extra_globals={"logger": log}
    )
    probe.config = FakeConfig({})
    probe.rewrite = FakeRewrite()
    probe._rewrite_identity_cache = None

    probe._sync_rewrite()
    assert probe.rewrite.start_calls == []


def test_sync_tolerates_none_rewrite_block():
    log = FakeLogger()
    probe = _probe_controller(
        "_rewrite_identity", "_sync_rewrite", extra_globals={"logger": log}
    )
    probe.config = FakeConfig({"rewrite": None})
    probe.rewrite = FakeRewrite()
    probe._rewrite_identity_cache = None

    probe._sync_rewrite()
    assert probe.rewrite.start_calls == []


def test_stop_rewrite_swallows_errors():
    """退出清理路径：stop 抛异常也不能让退出流程中断。"""
    log = FakeLogger()
    probe = _probe_controller("_stop_rewrite", extra_globals={"logger": log})

    class BoomRewrite:
        def stop(self):
            raise RuntimeError("boom")

    probe.rewrite = BoomRewrite()
    probe._stop_rewrite()  # 不应抛
    assert any("Failed to stop rewrite" in m for m in log.warnings)


# ---------------------------------------------------------------------------
# 解耦：rewrite 不依赖主代理状态
# ---------------------------------------------------------------------------


def test_sync_rewrite_does_not_touch_main_proxy():
    """_sync_rewrite 不能读写 self.connected / self.proxy —— 这是解耦的硬约束。"""
    source = open(_APP, encoding="utf-8").read()
    tree = _app_tree()
    controller = _class_node(tree, "AppController")
    body = _method(controller, "_sync_rewrite")

    text = ast.get_source_segment(source, body)
    assert "self.connected" not in text
    assert "self.proxy" not in text
    assert "_connect" not in text
    assert "_disconnect" not in text


def test_rewrite_identity_ignores_main_proxy_config():
    """指纹只看 rewrite 三项：server/local 变化不该重启 rewrite listener。"""
    probe, _log = _make_probe({
        "enabled": True, "listen_port": 996, "target": "https://abc.com:996",
    })
    probe.config.data["server"] = {"address": "node.example.com", "port": 8002}
    probe.config.data["local"] = {"port": 1080}
    probe._sync_rewrite()
    assert len(probe.rewrite.start_calls) == 1

    # 改主代理配置：rewrite 不动
    probe.config.data["server"]["address"] = "other-node.example.com"
    probe.config.data["local"]["port"] = 1081
    probe._sync_rewrite()
    assert len(probe.rewrite.start_calls) == 1


# ---------------------------------------------------------------------------
# 静态接线：启动、配置重载、退出三条路径都要接上
# ---------------------------------------------------------------------------


def test_init_creates_rewrite_proxy_and_syncs_it():
    """app 启动时就按已保存配置拉起 rewrite（不等代理连接）。"""
    source = open(_APP, encoding="utf-8").read()
    tree = _app_tree()
    controller = _class_node(tree, "AppController")
    init_body = _method(controller, "init")
    init_text = ast.get_source_segment(source, init_body)

    assert "RewriteProxy()" in init_text
    assert "_sync_rewrite()" in init_text


def test_settings_reload_syncs_rewrite_regardless_of_proxy_state():
    """保存面板后同步 rewrite，且必须在 `if self.connected` 判断之外
    ——否则代理没连接时保存开关就不生效，违背解耦要求。"""
    source = open(_APP, encoding="utf-8").read()
    tree = _app_tree()
    controller = _class_node(tree, "AppController")
    body = _method(controller, "_show_settings_window")
    text = ast.get_source_segment(source, body)

    assert "_sync_rewrite()" in text
    sync_pos = text.index("self._sync_rewrite()")
    connected_pos = text.index("if self.connected and self.config.data != old_data")
    assert sync_pos < connected_pos, "_sync_rewrite 必须在 connected 判断之前"


def test_quit_cleanup_stops_rewrite():
    source = open(_APP, encoding="utf-8").read()
    tree = _app_tree()
    controller = _class_node(tree, "AppController")

    pre_quit = ast.get_source_segment(
        source, _method(controller, "_pre_quit_cleanup")
    )
    assert "_stop_rewrite()" in pre_quit

    will_terminate = ast.get_source_segment(
        source, _method(controller, "applicationWillTerminate_")
    )
    assert "_stop_rewrite()" in will_terminate


def test_quit_stops_rewrite_outside_connected_branch():
    """rewrite 与主代理独立：退出时无条件停，不能只在 connected 分支里停。"""
    source = open(_APP, encoding="utf-8").read()
    tree = _app_tree()
    controller = _class_node(tree, "AppController")
    text = ast.get_source_segment(
        source, _method(controller, "_pre_quit_cleanup")
    )

    stop_pos = text.index("self._stop_rewrite()")
    connected_pos = text.index("if self.connected:")
    assert stop_pos < connected_pos


def test_app_imports_rewrite_proxy():
    source = open(_APP, encoding="utf-8").read()
    assert "from rewrite_proxy import RewriteProxy" in source


def test_connect_disconnect_do_not_touch_rewrite():
    """主代理的连接/断开流程不得启停 rewrite（解耦的另一半）。"""
    source = open(_APP, encoding="utf-8").read()
    tree = _app_tree()
    controller = _class_node(tree, "AppController")

    for name in ("_connect", "_disconnect", "_disconnect_core", "_reconnect"):
        text = ast.get_source_segment(source, _method(controller, name))
        assert "rewrite" not in text.lower(), f"{name} 不应触碰 rewrite"
