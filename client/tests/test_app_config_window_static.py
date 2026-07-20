import ast
from pathlib import Path


def _method_body(class_node, method_name):
    for node in class_node.body:
        if isinstance(node, ast.FunctionDef) and node.name == method_name:
            return node.body
    raise AssertionError(f"{method_name} not found")


def _is_config_call(node, method_name):
    if not isinstance(node, ast.Expr):
        return False
    call = node.value
    return (
        isinstance(call, ast.Call)
        and isinstance(call.func, ast.Attribute)
        and call.func.attr == method_name
        and isinstance(call.func.value, ast.Attribute)
        and call.func.value.attr == "config"
        and isinstance(call.func.value.value, ast.Name)
        and call.func.value.value.id == "self"
    )


def _calls_name(node, name):
    for child in ast.walk(node):
        if (
            isinstance(child, ast.Call)
            and isinstance(child.func, ast.Name)
            and child.func.id == name
        ):
            return True
    return False


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


def _calls_threading_thread(node):
    for child in ast.walk(node):
        if (
            isinstance(child, ast.Call)
            and isinstance(child.func, ast.Attribute)
            and child.func.attr == "Thread"
            and isinstance(child.func.value, ast.Name)
            and child.func.value.id == "threading"
        ):
            return True
    return False


def _class_node(tree, class_name):
    return next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == class_name
    )


def _popen_first_arg_name(node):
    for child in ast.walk(node):
        if (
            isinstance(child, ast.Call)
            and isinstance(child.func, ast.Attribute)
            and child.func.attr == "Popen"
            and child.args
            and isinstance(child.args[0], ast.List)
            and child.args[0].elts
            and isinstance(child.args[0].elts[0], ast.Name)
        ):
            return child.args[0].elts[0].id
    return None


def test_show_config_window_reloads_disk_config_before_saving():
    source = Path(__file__).parents[1].joinpath("app.py").read_text()
    tree = ast.parse(source)
    app_controller = _class_node(tree, "AppController")
    body = _method_body(app_controller, "_show_config_window")

    load_index = next(
        (i for i, node in enumerate(body) if _is_config_call(node, "load")),
        None,
    )
    save_index = next(
        (i for i, node in enumerate(body) if _is_config_call(node, "save")),
        None,
    )

    assert load_index is not None
    assert save_index is not None
    assert load_index < save_index


def test_wake_handler_checks_local_proxy_without_full_disconnect():
    source = Path(__file__).parents[1].joinpath("app.py").read_text()
    tree = ast.parse(source)
    app_controller = _class_node(tree, "AppController")
    body = _method_body(app_controller, "onSystemDidWake_")

    assert any(
        _calls_self_method(node, "_ensure_local_proxy_after_wake")
        for node in body
    )
    assert not any(_calls_self_method(node, "_disconnect") for node in body)


def test_toggle_proxy_disconnect_uses_background_shutdown():
    source = Path(__file__).parents[1].joinpath("app.py").read_text()
    tree = ast.parse(source)
    app_controller = _class_node(tree, "AppController")

    toggle_body = _method_body(app_controller, "toggleProxy_")
    assert any(
        _calls_self_method(node, "_disconnect_async")
        for node in toggle_body
    )

    disconnect_async_body = _method_body(app_controller, "_disconnect_async")
    assert any(_calls_threading_thread(node) for node in disconnect_async_body)


def test_connect_shows_disabled_connecting_state_until_terminal_state():
    source = Path(__file__).parents[1].joinpath("app.py").read_text()
    tree = ast.parse(source)
    app_controller = _class_node(tree, "AppController")

    connect_body = _method_body(app_controller, "_connect")
    assert any(_calls_self_method(node, "_begin_connecting") for node in connect_body)

    connected_body = _method_body(app_controller, "_on_connected")
    disconnected_body = _method_body(app_controller, "_on_disconnected")
    assert any(_calls_self_method(node, "_finish_connecting") for node in connected_body)
    assert any(_calls_self_method(node, "_finish_connecting") for node in disconnected_body)


def test_routing_menu_uses_title_state_instead_of_checkmark():
    source_path = Path(__file__).parents[1].joinpath("app.py")
    source = source_path.read_text()
    tree = ast.parse(source)
    app_controller = _class_node(tree, "AppController")
    body = _method_body(app_controller, "_update_routing_check")

    assert "分流规则（已开启）..." in source
    assert any(_calls_self_method(node, "_routing_menu_title") for node in body)
    assert not any(
        isinstance(child, ast.Call)
        and isinstance(child.func, ast.Attribute)
        and child.func.attr == "setState_"
        and isinstance(child.func.value, ast.Attribute)
        and child.func.value.attr == "routing_item"
        for node in body
        for child in ast.walk(node)
    )
