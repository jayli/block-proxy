from pathlib import Path


def test_build_includes_config_window_runtime_dependencies():
    build_script = Path(__file__).parents[1].joinpath("build.sh").read_text()

    assert "--include-data-files=config_window.py=config_window.py" in build_script
    assert "--include-data-files=autostart.py=autostart.py" in build_script
    assert "--include-data-files=doh_resolver.py=doh_resolver.py" in build_script


def test_build_includes_all_subprocess_windows():
    build_script = Path(__file__).parents[1].joinpath("build.sh").read_text()

    for window_script in [
        "config_window.py",
        "log_window.py",
        "routing_window.py",
        "super_dns_window.py",
    ]:
        assert f"--include-data-files={window_script}={window_script}" in build_script


def test_build_includes_super_dns_control_helper():
    build_script = Path(__file__).parents[1].joinpath("build.sh").read_text()

    assert "--include-data-files=super_dns_control.py=super_dns_control.py" in build_script


def test_build_includes_every_runtime_module():
    """顶层 .py 必须逐个列入 include-data-files。

    编译后的窗口/子进程用系统 Python 读同级 .py 源码，漏列会在运行时
    才报 ModuleNotFoundError（如新增 node_connect.py 被漏掉那次）。
    main.py 是 Nuitka 入口，不作为数据文件。
    """
    client_dir = Path(__file__).parents[1]
    build_script = (client_dir / "build.sh").read_text()

    excluded = {"main.py", "setup.py"}
    missing = [
        path.name
        for path in sorted(client_dir.glob("*.py"))
        if path.name not in excluded
        and f"--include-data-files={path.name}={path.name}" not in build_script
    ]

    assert missing == [], f"build.sh 未打包这些模块: {missing}"


def test_build_reuses_existing_icns_unless_missing():
    build_script = Path(__file__).parents[1].joinpath("build.sh").read_text()

    assert 'if [ ! -f "$SCRIPT_DIR/icons/app.icns" ]; then' in build_script
    assert "app.icns exists, reusing" in build_script


def test_build_allows_nuitka_dependency_downloads_noninteractively():
    build_script = Path(__file__).parents[1].joinpath("build.sh").read_text()

    assert "--assume-yes-for-downloads" in build_script
