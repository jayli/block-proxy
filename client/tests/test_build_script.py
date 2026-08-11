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


def test_build_reuses_existing_icns_unless_missing():
    build_script = Path(__file__).parents[1].joinpath("build.sh").read_text()

    assert 'if [ ! -f "$SCRIPT_DIR/icons/app.icns" ]; then' in build_script
    assert "app.icns exists, reusing" in build_script
