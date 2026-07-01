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
    app_controller = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "AppController"
    )
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


def test_tunnel_window_uses_packaged_resource_dir_and_python_interpreter():
    source = Path(__file__).parents[1].joinpath("app.py").read_text()
    tree = ast.parse(source)
    app_controller = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "AppController"
    )
    body = _method_body(app_controller, "openTunnelWindow_")

    assert any(_calls_name(node, "_bundle_resource_dir") for node in body)
    assert any(_calls_self_method(node, "_find_python") for node in body)
    assert any(_popen_first_arg_name(node) == "python_path" for node in body)
