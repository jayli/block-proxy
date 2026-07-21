from pathlib import Path

from super_dns_control import (
    build_super_dns_env,
    domains_file_path,
    ensure_domains_file,
    find_root_daemon_pid,
    find_npx,
    run_super_dns,
    super_dns_command,
)
import subprocess


def test_domains_file_is_created_under_user_config_dir(tmp_path):
    domains_path = ensure_domains_file(home=str(tmp_path))

    assert domains_path == tmp_path / ".config" / "super-dns" / "domains"
    assert domains_path.exists()
    assert domains_path.read_text() == ""


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
