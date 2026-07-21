import os
import re
import shutil
import subprocess
from pathlib import Path

COMMON_NODE_PATHS = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
]


def domains_file_path(home=None):
    base_home = Path(home).expanduser() if home else Path.home()
    return base_home / ".config" / "super-dns" / "domains"


def ensure_domains_file(home=None):
    path = domains_file_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch(exist_ok=True)
    return path


def read_domains_file(home=None):
    path = ensure_domains_file(home)
    return path.read_text()


def write_domains_file(content, home=None):
    path = ensure_domains_file(home)
    path.write_text(content)
    return path


def find_root_daemon_pid(ps_output):
    for line in ps_output.splitlines():
        trimmed = line.strip()
        if not trimmed:
            continue
        match = re.match(r"^(\d+)\s+(\S+)\s+(.+)$", trimmed)
        if not match:
            continue
        pid = int(match.group(1))
        user = match.group(2)
        command = match.group(3)
        if user != "root":
            continue
        if "node" not in command:
            continue
        if "super-dns" in command and (
            "index.js" in command or "/super-dns" in command
        ):
            return pid
    return None


def super_dns_pid():
    try:
        result = subprocess.run(
            ["ps", "ax", "-o", "pid=", "-o", "user=", "-o", "command="],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    return find_root_daemon_pid(result.stdout)


def is_super_dns_running():
    return super_dns_pid() is not None


def find_npx(extra_paths=None):
    found = shutil.which("npx")
    if found:
        return found
    for directory in (extra_paths or []) + COMMON_NODE_PATHS:
        candidate = os.path.join(directory, "npx")
        if os.path.exists(candidate):
            return candidate
    return "npx"


def _nvm_node_bin_dirs(home=None):
    base_home = Path(home).expanduser() if home else Path.home()
    versions_dir = base_home / ".nvm" / "versions" / "node"
    if not versions_dir.exists():
        return []
    return [
        str(path)
        for path in sorted(versions_dir.glob("*/bin"), reverse=True)
        if (path / "node").exists()
    ]


def build_super_dns_env(npx_path=None):
    env = os.environ.copy()
    path_parts = []
    if npx_path and os.path.dirname(npx_path):
        path_parts.append(os.path.dirname(npx_path))
    path_parts.extend(_nvm_node_bin_dirs())
    path_parts.extend(COMMON_NODE_PATHS)
    path_parts.extend(env.get("PATH", "").split(os.pathsep))

    deduped = []
    seen = set()
    for path in path_parts:
        if not path or path in seen:
            continue
        seen.add(path)
        deduped.append(path)
    env["PATH"] = os.pathsep.join(deduped)
    return env


def super_dns_command(action):
    if action not in ("start", "stop", "restart"):
        raise ValueError(f"Unsupported super-dns action: {action}")
    return [find_npx(), "--yes", "super-dns", action]


def run_super_dns(action):
    command = super_dns_command(action)
    try:
        return subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
            env=build_super_dns_env(command[0]),
        )
    except subprocess.TimeoutExpired as e:
        return subprocess.CompletedProcess(
            command,
            124,
            stdout=e.stdout or "",
            stderr=f"super-dns {action} timed out after {e.timeout} seconds",
        )
