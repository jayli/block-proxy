import os
from pathlib import Path

import pytest

from super_dns_control import (
    build_super_dns_env,
    domains_file_path,
    ensure_domains_file,
    find_root_daemon_pid,
    find_npx,
    read_domains_file,
    run_super_dns,
    super_dns_command,
    write_domains_file,
)
import subprocess


def test_domains_file_is_created_under_user_config_dir(tmp_path):
    domains_path = ensure_domains_file(home=str(tmp_path))

    assert domains_path == tmp_path / ".config" / "super-dns" / "domains"
    assert domains_path.exists()
    assert domains_path.read_text() == ""


def test_read_domains_file_does_not_touch_existing_file(tmp_path, monkeypatch):
    """已存在的文件不应被 touch：touch 会以写方式打开，对非属主（如 root 属主
    的 domains 文件）会 EACCES 导致读取失败。"""
    domains_path = ensure_domains_file(home=str(tmp_path))
    domains_path.write_text("example.com\n")

    def fail_touch(*_args, **_kwargs):
        raise AssertionError("read_domains_file 不应调用 touch()")

    monkeypatch.setattr(Path, "touch", fail_touch)

    assert read_domains_file(home=str(tmp_path)) == "example.com\n"


def test_read_domains_file_still_creates_missing_file(tmp_path):
    """回归：文件不存在时读取仍会自动创建空文件。"""
    assert not domains_file_path(home=str(tmp_path)).exists()

    assert read_domains_file(home=str(tmp_path)) == ""
    assert domains_file_path(home=str(tmp_path)).exists()


def test_ensure_domains_file_does_not_touch_existing_file(tmp_path, monkeypatch):
    """ensure 对已存在文件只做存在性检查，不写文件。"""
    domains_path = ensure_domains_file(home=str(tmp_path))
    before = os.stat(domains_path).st_mtime_ns

    def fail_touch(*_args, **_kwargs):
        raise AssertionError("ensure_domains_file 不应 touch 已存在的文件")

    monkeypatch.setattr(Path, "touch", fail_touch)

    assert ensure_domains_file(home=str(tmp_path)) == domains_path
    assert os.stat(domains_path).st_mtime_ns == before


def test_write_domains_file_reports_permission_error_readably(tmp_path, monkeypatch):
    """不可写时的报错应包含路径的可读提示，而非裸 errno 文本。"""
    domains_path = ensure_domains_file(home=str(tmp_path))

    def fail_write(*_args, **_kwargs):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(Path, "write_text", fail_write)

    with pytest.raises(PermissionError) as excinfo:
        write_domains_file("x.com\n", home=str(tmp_path))

    assert str(domains_path) in str(excinfo.value)

def test_find_root_daemon_pid_matches_only_root_node_super_dns_index():
    ps_output = """
      123 bachi node /Users/bachi/jaylli/super-dns/index.js
      456 root node /Users/bachi/jaylli/super-dns/index.js
      789 root npx super-dns start
    """

    assert find_root_daemon_pid(ps_output) == 456


def test_find_root_daemon_pid_accepts_installed_super_dns_bin():
    ps_output = """
      321 root node /usr/local/bin/super-dns
      654 root node /tmp/other.js
    """

    assert find_root_daemon_pid(ps_output) == 321


def test_super_dns_command_uses_npx_without_prompt():
    command = super_dns_command("restart")

    assert Path(command[0]).name == "npx"
    assert command[1:] == ["--yes", "super-dns", "restart"]


def test_run_super_dns_uses_timeout(monkeypatch):
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return object()

    monkeypatch.setattr("super_dns_control.subprocess.run", fake_run)

    run_super_dns("start")

    assert calls[0][1]["timeout"] == 60
    assert "env" in calls[0][1]


def test_build_super_dns_env_adds_npx_and_nvm_node_dirs(monkeypatch, tmp_path):
    npx_dir = tmp_path / "npm-bin"
    node_dir = tmp_path / ".nvm" / "versions" / "node" / "v20.0.0" / "bin"
    npx_dir.mkdir()
    node_dir.mkdir(parents=True)
    (node_dir / "node").write_text("")
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setenv("HOME", str(tmp_path))

    env = build_super_dns_env(npx_path=str(npx_dir / "npx"))
    paths = env["PATH"].split(":")

    assert str(npx_dir) in paths
    assert str(node_dir) in paths


def test_run_super_dns_returns_failure_on_timeout(monkeypatch):
    def fake_run(_command, **_kwargs):
        raise subprocess.TimeoutExpired(["npx"], timeout=60)

    monkeypatch.setattr("super_dns_control.subprocess.run", fake_run)

    result = run_super_dns("start")

    assert result.returncode == 124
    assert "timed out after 60 seconds" in result.stderr


def test_find_npx_falls_back_to_common_gui_paths(monkeypatch, tmp_path):
    npx = tmp_path / "npx"
    npx.write_text("")
    monkeypatch.setenv("PATH", "")

    assert find_npx(extra_paths=[str(tmp_path)]) == str(npx)


def test_domains_file_path_expands_home():
    assert domains_file_path("/Users/example") == Path(
        "/Users/example/.config/super-dns/domains"
    )
