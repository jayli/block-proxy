"""状态栏「已连接」文案：勾选 TLS 时要标出 tls；状态项点击不再弹日志面板。

app.py 依赖 PyObjC，测试里不能直接 import，沿用同目录既有做法：
从源码 AST 取出目标方法，拼成一个探针类再 exec，断言真实输出字符串。
"""

import ast
import os
import sys
from types import SimpleNamespace

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
        name="Probe",
        bases=[],
        keywords=[],
        body=methods,
        decorator_list=[],
    )
    if sys.version_info >= (3, 12):
        kwargs["type_params"] = []
    probe_cls = ast.ClassDef(**kwargs)
    ast.copy_location(probe_cls, methods[0])
    module = ast.Module(body=[probe_cls], type_ignores=[])
    ast.fix_missing_locations(module)
    namespace = {"__name__": "app_probe"}
    exec(compile(module, _APP, "exec"), namespace)
    return namespace["Probe"]()


def _title(protocol, tls, detail=None):
    probe = _probe_controller("_status_protocol_name", "_status_title_connected")
    probe.config = SimpleNamespace(
        data={"server": {"protocol": protocol, "tls": tls}}
    )
    return probe._status_title_connected(detail)


def test_connected_title_marks_tls():
    assert _title("http", True, "33ms") == "https 已连接 - 33ms"
    assert _title("socks5", True, "44ms") == "socks5+tls 已连接 - 44ms"


def test_connected_title_without_tls_unchanged():
    assert _title("http", False, "33ms") == "http 已连接 - 33ms"
    assert _title("socks5", False, "44ms") == "socks 已连接 - 44ms"
    # 隧道模式的 tls 字段不代表传输层，不追加后缀
    assert _title("tunnel", True, "44ms") == "隧道已连接 - 44ms"


def test_status_item_click_does_nothing():
    """状态项仍可点击，但不再绑 action（点击不弹日志面板）。"""
    build = _method(_class_node(_app_tree(), "AppController"), "_build_menu")
    status_calls = [
        node
        for node in ast.walk(build)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "_add_menu_item"
        and len(node.args) >= 2
        and isinstance(node.args[1], ast.Call)
        and isinstance(node.args[1].func, ast.Attribute)
        and node.args[1].func.attr == "_status_title_connected"
    ]
    assert len(status_calls) == 1, "没找到状态项构造"
    action = status_calls[0].args[2] if len(status_calls[0].args) >= 3 else None
    assert isinstance(action, ast.Constant) and action.value is None, (
        "状态项仍绑定了点击动作：点一下会弹开日志面板"
    )
