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


def _assigns_self_attr(node, attr_name):
    for child in ast.walk(node):
        if (
            isinstance(child, ast.Assign)
            and any(
                isinstance(target, ast.Attribute)
                and target.attr == attr_name
                and isinstance(target.value, ast.Name)
                and target.value.id == "self"
                for target in child.targets
            )
        ):
            return True
    return False


def _calls_attr_on_self_attr(node, object_attr, method_name):
    for child in ast.walk(node):
        if (
            isinstance(child, ast.Call)
            and isinstance(child.func, ast.Attribute)
            and child.func.attr == method_name
            and isinstance(child.func.value, ast.Attribute)
            and child.func.value.attr == object_attr
            and isinstance(child.func.value.value, ast.Name)
            and child.func.value.value.id == "self"
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


def test_app_registers_proxy_pin_callback_and_pending_state():
    source = Path(__file__).parents[1].joinpath("app.py").read_text()
    tree = ast.parse(source)
    app_controller = _class_node(tree, "AppController")
    init_body = _method_body(app_controller, "init")

    assert any(_assigns_self_attr(node, "_pin_mismatch_pending") for node in init_body)
    assert any(_assigns_self_attr(node, "_last_pin_mismatch") for node in init_body)
    assert any(
        _calls_attr_on_self_attr(node, "proxy", "set_pin_callback")
        for node in init_body
    )


def test_app_has_pin_state_merge_save_helper():
    source_path = Path(__file__).parents[1].joinpath("app.py")
    source = source_path.read_text()
    tree = ast.parse(source)
    app_controller = _class_node(tree, "AppController")
    body = _method_body(app_controller, "_save_server_pin_state")

    assert "certPinMismatch" in source
    assert "certBindEnabled" in source
    assert any(_calls_name(node, "Config") for node in body)
    assert any(_calls_self_method(node, "config") is False for node in body)


def test_app_pin_mismatch_alert_updates_pin_or_persists_error_state():
    source_path = Path(__file__).parents[1].joinpath("app.py")
    source = source_path.read_text()
    tree = ast.parse(source)
    app_controller = _class_node(tree, "AppController")
    callback_body = _method_body(app_controller, "_on_pin_callback")
    alert_body = _method_body(app_controller, "_show_pin_mismatch_alert")

    assert "更新绑定指纹" in source
    assert "证书指纹不匹配" in source
    assert "SHA256:" in source
    assert any(_calls_self_method(node, "_show_pin_mismatch_alert") for node in callback_body)
    assert any(_calls_self_method(node, "_save_server_pin_state") for node in alert_body)
    assert any(_calls_self_method(node, "_reconnect") for node in alert_body)


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


def test_system_wake_starts_reconnect_worker_thread():
    source = Path(__file__).parents[1].joinpath("app.py").read_text()
    tree = ast.parse(source)
    app_controller = _class_node(tree, "AppController")
    body = _method_body(app_controller, "onSystemDidWake_")

    assert any(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "Thread"
        and any(
            kw.arg == "target"
            and isinstance(kw.value, ast.Name)
            and kw.value.id == "_do_reconnect"
            for kw in node.keywords
        )
        for node in ast.walk(ast.Module(body=body, type_ignores=[]))
    )


def test_screens_did_wake_registers_observer_and_recycles():
    """屏幕点亮事件：注册 NSWorkspaceScreensDidWakeNotification 观察者，
    回调中静默重启本地 SOCKS/HTTP listener（类似 recycle 机制，
    清空 EDR 审查的旧连接会话），不触碰 tunnel 与完整代理状态。"""
    source = Path(__file__).parents[1].joinpath("app.py").read_text()
    tree = ast.parse(source)
    app_controller = _class_node(tree, "AppController")

    # 观察者注册（_observe_system_events 或 init 区域）
    assert "NSWorkspaceScreensDidWakeNotification" in source
    assert '"onScreensDidWake:"' in source

    def _calls_proxy_recycle(body_nodes):
        """匹配 self.proxy.recycle_local_proxy() 调用（全树遍历，含嵌套函数）。"""
        for node in ast.walk(ast.Module(body=body_nodes, type_ignores=[])):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "recycle_local_proxy"
                and isinstance(node.func.value, ast.Attribute)
                and node.func.value.attr == "proxy"
                and isinstance(node.func.value.value, ast.Name)
                and node.func.value.value.id == "self"
            ):
                return True
        return False

    body = _method_body(app_controller, "onScreensDidWake_")
    assert _calls_proxy_recycle(body)
    assert any(_calls_threading_thread(node) for node in body)
    # 轻量 recycle，不应触发完整重启或 tunnel 处理
    assert not any(_calls_self_method(node, "_restart_local_proxy_only") for node in body)
    assert not any(_calls_self_method(node, "_ensure_tunnel_after_wake") for node in body)


def test_screens_did_wake_does_not_reference_system_wake_local_worker():
    """屏幕点亮回调不应引用 onSystemDidWake_ 的局部 _do_reconnect。"""
    source = Path(__file__).parents[1].joinpath("app.py").read_text()
    tree = ast.parse(source)
    app_controller = _class_node(tree, "AppController")
    body = _method_body(app_controller, "onScreensDidWake_")

    for node in ast.walk(ast.Module(body=body, type_ignores=[])):
        assert not (
            isinstance(node, ast.Name)
            and node.id == "_do_reconnect"
        )


def test_wake_fd_recycle_branch_deduplicates_screen_wake_recycle():
    source = Path(__file__).parents[1].joinpath("app.py").read_text()
    tree = ast.parse(source)
    app_controller = _class_node(tree, "AppController")
    body = _method_body(app_controller, "_ensure_local_proxy_after_wake")

    assert "already recycled after screens wake" in source
    assert any(
        isinstance(node, ast.Attribute)
        and node.attr == "_last_proxy_reconnect_time"
        for node in ast.walk(ast.Module(body=body, type_ignores=[]))
    )


def test_application_terminate_removes_screen_wake_observer():
    source = Path(__file__).parents[1].joinpath("app.py").read_text()
    tree = ast.parse(source)
    app_controller = _class_node(tree, "AppController")
    body = _method_body(app_controller, "applicationWillTerminate_")

    assert any(
        isinstance(node, ast.Attribute)
        and node.attr == "_screen_wake_obs"
        for node in ast.walk(ast.Module(body=body, type_ignores=[]))
    )


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


def test_super_dns_menu_opens_dedicated_subprocess_window():
    source_path = Path(__file__).parents[1].joinpath("app.py")
    source = source_path.read_text()
    tree = ast.parse(source)
    app_controller = _class_node(tree, "AppController")

    init_body = _method_body(app_controller, "init")
    open_body = _method_body(app_controller, "openSuperDns_")
    show_body = _method_body(app_controller, "_show_super_dns_window")

    assert "Super DNS..." in source
    assert "super_dns_window.py" in source
    assert any(
        isinstance(child, ast.Attribute)
        and child.attr == "_super_dns_proc"
        for node in init_body
        for child in ast.walk(node)
    )
    assert any(_calls_self_method(node, "_show_super_dns_window") for node in open_body)
    assert _popen_first_arg_name(ast.Module(body=show_body, type_ignores=[])) == (
        "python_path"
    )


def test_super_dns_window_creates_nsapplication_before_menu_setup():
    source_path = Path(__file__).parents[1].joinpath("super_dns_window.py")
    source = source_path.read_text()
    main_block = source[source.index('if __name__ == "__main__":'):]

    shared_app_index = main_block.index("NSApplication.sharedApplication()")
    setup_menu_index = main_block.index("_setup_minimal_menu()")

    assert shared_app_index < setup_menu_index


def test_super_dns_window_has_docs_link_and_colored_status_dot():
    source_path = Path(__file__).parents[1].joinpath("super_dns_window.py")
    source = source_path.read_text()

    assert "https://www.npmjs.com/package/super-dns" in source
    assert "openDocs:" in source
    assert "_status_dot" in source
    assert "NSColor.systemGreenColor()" in source
    assert "NSColor.systemOrangeColor()" in source
    assert "NSColor.labelColor()" in source


def test_super_dns_menu_title_reflects_running_state():
    source_path = Path(__file__).parents[1].joinpath("app.py")
    source = source_path.read_text()
    tree = ast.parse(source)
    app_controller = _class_node(tree, "AppController")

    menu_open_body = _method_body(app_controller, "_on_menu_open")
    update_body = _method_body(app_controller, "_update_super_dns_menu_title")

    assert "Super DNS（运行中）..." in source
    assert "Super DNS（未运行）..." in source
    assert any(
        _calls_self_method(node, "_update_super_dns_menu_title")
        for node in menu_open_body
    )
    assert any(
        isinstance(child, ast.Attribute)
        and child.attr == "super_dns_item"
        for node in update_body
        for child in ast.walk(node)
    )


def test_super_dns_window_title_describes_domain_list():
    source_path = Path(__file__).parents[1].joinpath("super_dns_window.py")
    source = source_path.read_text()

    assert 'win.setTitle_("Super DNS - 防止 DNS 污染的域名列表")' in source
