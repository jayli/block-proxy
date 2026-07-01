from pathlib import Path


def test_build_includes_config_window_runtime_dependencies():
    build_script = Path(__file__).parents[1].joinpath("build.sh").read_text()

    assert "--include-data-files=config_window.py=config_window.py" in build_script
    assert "--include-data-files=autostart.py=autostart.py" in build_script


def test_build_includes_all_subprocess_windows():
    build_script = Path(__file__).parents[1].joinpath("build.sh").read_text()

    for window_script in [
        "config_window.py",
        "log_window.py",
        "routing_window.py",
        "tunnel_window.py",
    ]:
        assert f"--include-data-files={window_script}={window_script}" in build_script
