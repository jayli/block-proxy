import json
import os
import copy
import ipaddress
import re

# 节点服务端用自签证书（SAN 只有 localhost/127.0.0.1，见 cert/generator.js），
# 主机名校验必然失败；且实际身份校验由 certBindEnabled 的证书指纹（TOFU）
# 承担。因此 allowInsecure 钉死为 True：面板置灰不可改，旧配置里的
# False 也会在加载时被纠正，避免升级后被一个连不上的开关锁死。
ALLOW_INSECURE_FORCED = True

DEFAULT_CONFIG = {
    "server": {
        "protocol": "socks5",
        "address": "",
        "port": 8002,
        "username": "",
        "password": "",
        "tls": True,
        "allowInsecure": ALLOW_INSECURE_FORCED,
        # 只用域名解析出的 AAAA 地址（IPv6）连节点。默认关闭：多数网络只有
        # IPv4，强制 IPv6 会直接连不上。
        "ipv6Only": False,
        "certBindEnabled": False,
        "certPin": "",
    },
    "local": {
        "port": 1080,
        "udp": True,
    },
    "mode": "global",
    "routing": {
        "enabled": False,
        "direct_rules": [],
        "proxy_rules": [],
        "default": "proxy",
    },
    "tunnel": {
        "enabled": False,
        "server_address": "",
        "server_port": 8003,
        "ws_path": "/websocket",
        "http_disguise": True,
    },
}

DEFAULT_CONFIG_DIR = os.path.expanduser(
    "~/Library/Application Support/BlockProxyClient"
)

# 界面状态文件（与 config.json 同级）。刻意与运行配置分开：记住选中 tab、
# 主进程向已打开的设置窗口投递跳转请求，都不该写 config.json 触发客户端重连。
UI_STATE_FILENAME = "ui_state.json"


def ui_state_path(config_path):
    return os.path.join(os.path.dirname(os.path.abspath(config_path)), UI_STATE_FILENAME)


def read_ui_state(config_path):
    """读界面状态；文件缺失/损坏/不是 dict 时返回空 dict。"""
    try:
        with open(ui_state_path(config_path), "r") as f:
            data = json.load(f)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def write_ui_state(config_path, updates):
    """合并写入若干键（保留其它窗口的状态）。返回是否写入成功。"""
    if not isinstance(updates, dict) or not updates:
        return False
    path = ui_state_path(config_path)
    data = read_ui_state(config_path)
    if all(data.get(k) == v for k, v in updates.items()):
        return True
    data.update(updates)
    try:
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
    except Exception:
        return False
    return True


# 代理连接开关的跨进程 IPC（设置窗口是独立子进程）：
# 两个单写者文件，各自只有一个写入方，不做 read-modify-write 合并，
# 避免 ui_state.json 多写者并发丢更新的问题。
#   proxy_switch.json  面板写 → 主进程读（{on, seq}）
#   proxy_state.json   主进程写 → 面板读（{connected, busy, message, seq}）
PROXY_SWITCH_FILENAME = "proxy_switch.json"
PROXY_STATE_FILENAME = "proxy_state.json"


def _state_file_path(config_path, filename):
    return os.path.join(os.path.dirname(os.path.abspath(config_path)), filename)


def _read_state_file(config_path, filename):
    try:
        with open(_state_file_path(config_path, filename), "r") as f:
            data = json.load(f)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _write_state_file(config_path, filename, payload):
    """整体原子写（单写者文件，不合并旧内容）。"""
    path = _state_file_path(config_path, filename)
    try:
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(payload, f)
        os.replace(tmp, path)
    except Exception:
        return False
    return True


def read_proxy_switch(config_path):
    """读面板拨动的开关请求；缺失/损坏返回 None。"""
    data = _read_state_file(config_path, PROXY_SWITCH_FILENAME)
    if "on" not in data or "seq" not in data:
        return None
    return {"on": bool(data["on"]), "seq": data["seq"]}


def write_proxy_switch(config_path, on, seq):
    """面板写开关请求（seq 递增，主进程按 seq 去重）。"""
    return _write_state_file(
        config_path, PROXY_SWITCH_FILENAME, {"on": bool(on), "seq": seq}
    )


def read_proxy_state(config_path):
    """读主进程发布的连接状态；缺失/损坏返回 None。"""
    data = _read_state_file(config_path, PROXY_STATE_FILENAME)
    if "seq" not in data:
        return None
    return {
        "connected": bool(data.get("connected", False)),
        "busy": bool(data.get("busy", False)),
        "message": data.get("message", "") or "",
        "seq": data["seq"],
    }


def write_proxy_state(config_path, connected, busy, message, seq):
    """主进程写连接状态（seq 递增，面板按 seq 去重）。"""
    return _write_state_file(
        config_path,
        PROXY_STATE_FILENAME,
        {
            "connected": bool(connected),
            "busy": bool(busy),
            "message": message or "",
            "seq": seq,
        },
    )


# 节点地址与本地端口的失焦校验：只在离开输入框（或点保存）时跑一轮，
# 不在输入过程中干扰。地址只接受三种形式：IPv4 字面量、IPv6 字面量、域名。
_DOMAIN_LABEL_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")


def validate_node_address(value, ipv6_only=False):
    """校验节点地址，返回错误文案；合法返回 None。

    只判定“是不是 IPv4 / IPv6 / 域名”三者之一，不验证可达性。
    ipv6_only=True 时额外要求地址不能是 IPv4 字面量——那是连接时
    必然失败、只能在连接里才报的错误，放在失焦时提前告诉用户。

    域名的处理顺序：先试 IP 字面量（否则 `1.2.3.4` 会被当成域名通过），
    再按 DNS 规则校验长度、标签合法性、不能全是数字。
    """
    text = str(value or "").strip()
    if not text:
        return "地址不能为空"

    # IPv4 / IPv6 字面量（ipaddress 会拒绝 999.1.1.1、1.2.3 这类式子）
    try:
        addr = ipaddress.ip_address(text)
    except ValueError:
        addr = None
    if addr is not None:
        if ipv6_only and addr.version == 4:
            return "已启用 IPv6，但该地址是 IPv4；请填域名或 IPv6 地址"
        return None

    # 域名：长度上限 253，至少两段；标签只允许字母数字与连字符，
    # 首尾不能是连字符；末段不能全是数字（那是残缺的 IPv4）
    if len(text) > 253:
        return "地址过长"
    labels = text.split(".")
    if len(labels) < 2:
        return "请填写 IP 地址或完整域名（如 perf.qzz.io）"
    for label in labels:
        if not label or len(label) > 63:
            return "域名格式不正确"
        if not _DOMAIN_LABEL_RE.match(label):
            return "域名格式不正确"
    if labels[-1].isdigit():
        return "请填写 IP 地址或完整域名（如 perf.qzz.io）"
    return None


def validate_port(value, *, name="端口"):
    """校验端口号（1-65535 的纯数字），返回错误文案；合法返回 None。"""
    text = str(value or "").strip()
    if not text:
        return f"{name}不能为空"
    if not text.isdigit():
        return f"{name}必须是数字"
    port = int(text)
    if not 1 <= port <= 65535:
        return f"{name}必须在 1-65535 之间"
    return None


def _force_allow_insecure(data):
    server = data.get("server")
    if isinstance(server, dict) and server.get("allowInsecure") is not True:
        server["allowInsecure"] = ALLOW_INSECURE_FORCED


def _migrate_local_ports(data):
    """把旧的分端口配置（socks_port/http_port）合并为单一 port。

    旧版本本地 SOCKS5 与 HTTP 各听一个端口（默认 1080/1087）；现在
    合并为同一端口按首字节自适应。迁移以旧 socks_port 为准，迁移后
    删掉两个旧键，避免下次保存又把它们写回去。必须在 _fill_defaults
    之前调用：否则 defaults 会先补上 port=1080，用户自定义的旧端口
    就被默认值盖掉了。
    """
    local = data.get("local")
    if not isinstance(local, dict):
        return
    if "port" not in local:
        legacy = local.get("socks_port")
        if isinstance(legacy, int):
            local["port"] = legacy
    local.pop("socks_port", None)
    local.pop("http_port", None)


class Config:
    def __init__(self, config_path=None):
        if config_path is None:
            config_path = os.path.join(DEFAULT_CONFIG_DIR, "config.json")
        self.config_path = config_path
        self.data = None

    def load(self):
        if os.path.exists(self.config_path):
            with open(self.config_path, "r") as f:
                self.data = json.load(f)
            _migrate_local_ports(self.data)
            self._fill_defaults()
        else:
            self.data = copy.deepcopy(DEFAULT_CONFIG)
            self.save()
        _force_allow_insecure(self.data)
        _migrate_local_ports(self.data)
        return self.data

    def _fill_defaults(self):
        """Recursively fill missing fields (including sub-fields)"""
        for key, value in DEFAULT_CONFIG.items():
            if key not in self.data:
                self.data[key] = copy.deepcopy(value)
            elif isinstance(value, dict):
                for sub_key, sub_value in value.items():
                    if sub_key not in self.data[key]:
                        self.data[key][sub_key] = copy.deepcopy(sub_value)

    def save(self):
        os.makedirs(os.path.dirname(self.config_path), exist_ok=True)
        _force_allow_insecure(self.data)
        _migrate_local_ports(self.data)
        # 原子写：先写临时文件再 rename，避免写一半崩溃留下半截 JSON
        tmp = self.config_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.data, f, indent=2)
        os.replace(tmp, self.config_path)

    def is_configured(self):
        return bool(self.data and self.data["server"]["address"])
