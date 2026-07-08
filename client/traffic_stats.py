"""
Traffic statistics shared module.
Written by proxy_core (writer process), read by log_window (reader process).

Tracks bytes in 4 quadrants: route (proxy/direct) x direction (outbound/inbound).
"""

import json
import os
import time

DEFAULT_STATS_DIR = os.path.expanduser(
    "~/Library/Application Support/BlockProxyClient/logs"
)


def stats_file_path(stats_dir=None):
    if stats_dir is None:
        stats_dir = DEFAULT_STATS_DIR
    os.makedirs(stats_dir, exist_ok=True)
    return os.path.join(stats_dir, "traffic_stats.json")


# ---------- writer side (proxy_core) ----------

_proxy_out = 0
_proxy_in = 0
_direct_out = 0
_direct_in = 0
_stats_path = None


def init_writer(stats_dir=None):
    global _stats_path
    _stats_path = stats_file_path(stats_dir)
    reset_counters()
    flush()


def reset_counters():
    global _proxy_out, _proxy_in, _direct_out, _direct_in
    _proxy_out = _proxy_in = _direct_out = _direct_in = 0


def add_bytes(count, route, direction):
    """direction: 'outbound' (client→remote) or 'inbound' (remote→client)"""
    global _proxy_out, _proxy_in, _direct_out, _direct_in
    if route == "proxy":
        if direction == "outbound":
            _proxy_out += count
        else:
            _proxy_in += count
    else:
        if direction == "outbound":
            _direct_out += count
        else:
            _direct_in += count


def flush():
    if not _stats_path:
        return
    try:
        data = {
            "proxy_out": _proxy_out,
            "proxy_in": _proxy_in,
            "direct_out": _direct_out,
            "direct_in": _direct_in,
            "proxy_bytes": _proxy_out + _proxy_in,
            "direct_bytes": _direct_out + _direct_in,
            "timestamp": time.time(),
        }
        tmp = _stats_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, _stats_path)
    except Exception:
        pass


# ---------- reader side (log_window / traffic_view) ----------


def read_stats(stats_dir=None):
    try:
        with open(stats_file_path(stats_dir), "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, IOError):
        return None
