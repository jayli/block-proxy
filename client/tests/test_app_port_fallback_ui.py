"""端口漂移必须在界面上可见（而不是静默改用 +1 端口）。

背景（2026-10-17 现场）：recycle 泄漏 listener 后 health check 的
stop+start 绑不上 1080/1087，静默漂移到 1081/1088；状态栏仍显示
「已连接」，系统代理也静默改成新端口，用户完全无从得知配置好的
1087 已经失效 —— litellm 网关写死 1087 后全部请求超时。
"""

import ast
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _app_tree():
    path = os.path.join(os.path.dirname(__file__), "..", "app.py")
    with open(path, encoding="utf-8") as f:
        return ast.parse(f.read(), filename=path)


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


def _calls_attr(nodes, attr):
    for root in nodes:
        for child in ast.walk(root):
            if isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute):
                if child.func.attr == attr:
                    return True
    return False


def _reads_attr(nodes, attr):
    """是否读取了某属性（`self.proxy.port_fallback` 是 Attribute 而非 Call）。"""
    for root in nodes:
        for child in ast.walk(root):
            if isinstance(child, ast.Attribute) and child.attr == attr:
                return True
    return False


def test_connect_surfaces_port_fallback():
    """_connect 里启动代理后必须检查漂移并提示用户。"""
    tree = _app_tree()
    connect = _method(_class_node(tree, "AppController"), "_connect")
    assert _calls_attr(connect.body, "port_fallback_message"), (
        "_connect 没有检查 port_fallback_message()：端口漂移对用户完全不可见"
    )


def test_on_connected_shows_fallback_in_status_title():
    """已连接状态标题要带上漂移端口，而不是只显示「已连接」。

    _on_connected 把标题绘制委派给 _refresh_status_title（重启路径也
    复用同一方法），因此要同时验证两个环节。
    """
    tree = _app_tree()
    controller = _class_node(tree, "AppController")

    on_connected = _method(controller, "_on_connected")
    assert _calls_attr(on_connected.body, "_refresh_status_title"), (
        "_on_connected 没有刷新状态标题"
    )

    refresh = _method(controller, "_refresh_status_title")
    assert _reads_attr(refresh.body, "port_fallback"), (
        "_refresh_status_title 没有读取 port_fallback：状态栏显示不出真实端口"
    )


def test_health_restart_shows_fallback_notification():
    """health check 重启后端口可能漂移，必须提示而不是默默改系统代理。"""
    source = open(
        os.path.join(os.path.dirname(__file__), "..", "app.py"), encoding="utf-8"
    ).read()
    marker = "Proxy restarted successfully"
    idx = source.index(marker)
    tail = source[idx : idx + 1500]
    assert "port_fallback_message" in tail, (
        "health check 重启成功后没有检查端口漂移"
    )
