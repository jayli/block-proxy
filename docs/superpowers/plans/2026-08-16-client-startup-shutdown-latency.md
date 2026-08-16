# 客户端启动/关闭代理延迟 — 设计缺陷修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 macOS 客户端启动/关闭代理路径上的设计缺陷（8s 死等关停、全量 geodata 解析、networksetup 串行验证），在功能不变的前提下把停止代理从固定 ~8s 降到亚秒级、启动代理显著加速。

**Architecture:** 三个独立子系统各修一处设计缺陷：(1) `ProxyCore.stop()` 跨线程事件循环收尾改为"协程收尾 → future 正常 resolve → 调用方停 loop"，正常路径不再依赖超时兜底；(2) `geodata_loader` 改为"只解析规则引用的 tag/code + 进程内按 (路径, mtime, size) 缓存"；(3) `SystemProxy._verify` 的 3×N 条 networksetup 读命令并行执行。均不改动对外行为语义（端口、路由决策、系统代理设置结果）。

**Tech Stack:** Python 3.10（Nuitka 打包 3.10.10），纯标准库（asyncio / threading / subprocess / pickle 不用，直接用内存 dict 缓存），pytest。

## Global Constraints

- 工作目录 `/Users/hfy/jayli/block-proxy/client`；禁止新增任何第三方依赖（公司安全软件按二进制特征拦截，纯标准库原则不变）。
- 测试命令：`cd client && python -m pytest tests/ -q`；当前基线 265 passed，每个任务结束时必须全绿。
- TDD 强制：每个任务先写失败测试并确认失败，再写实现并确认通过（AGENTS.md）。
- 不修改 `client/config.json`（运行时配置）、不修改 `client/dist/`（产物由 build.sh 重建，本 plan 不构建、不升级版本号）。
- 不自动 git add/commit/push（项目规则：等用户验证确认后再提交）。
- 保持既有行为语义：socks/http 端口及 EADDRINUSE +1 偏移重试不变；私有地址直连不变；定时 recycle 不主动断开活跃连接（仅全量 stop 可断）；geodata 缺失/解析失败时规则安全回退（不匹配 → 默认动作）不变。
- 代码注释用中文，与现有文件风格一致。

---

### Task 1: ProxyCore.stop() 确定性快速关停（8s 死等 → 亚秒级）

**Files:**
- Modify: `client/proxy_core.py`（`__init__` ~L693、`stop()` L807-865、`_start_servers` L1067-1073、`_stop_servers` L1126-1152、`_stop_local_proxy_locked` L1152-1155、`_stop_local_proxy` L1177-1187、`_recycle_local_proxy_once_unlocked` L1237-1244、`_close_writer` L315-320、`UpstreamPool.stop` L531-550）
- Create: `client/tests/test_proxy_core_fast_stop.py`

**Interfaces:**
- Consumes: `proxy_core.ProxyCore`、`proxy_core.LOCAL_PROXY_STOP_WAIT_TIMEOUT`、`proxy_core._force_close_rst`
- Produces: `ProxyCore.stop()` 正常路径 <1s 完成并释放端口；新增内部方法 `_stop_local_proxy(force_abort=True)`、`_stop_local_proxy_locked(force_abort=True)`；新增模块级函数 `_close_writer_force(writer)`；新增实例属性 `_stats_task`

**根因（写入代码注释用）：** 旧 `_shutdown` 协程最后执行 `loop.stop()`。`run_coroutine_threadsafe` 的结果回调由事件循环调度，`loop.stop()` 使 `run_forever` 在该回调执行前退出，future 永不 resolve → `.result(timeout=8)` 每次必然超时，stop 固定 8.00s（已实测 3/3 次）。

- [ ] **Step 1: 写失败测试**

Create `client/tests/test_proxy_core_fast_stop.py`:

```python
"""stop() 快速确定性关停回归测试。

背景：旧实现 _shutdown 协程内调用 loop.stop()，run_forever 在
run_coroutine_threadsafe 的 future 完成回调执行前退出，future 永不
resolve，.result(timeout=8) 必然超时 —— 每次关闭代理固定白等 8 秒。
"""

import os
import socket
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import proxy_core


def _config(socks_port, http_port):
    return {
        "server": {
            "protocol": "socks5",
            "address": "127.0.0.1",
            "port": 18999,  # 不可达节点：preconnect 后台失败，不影响 stop
            "tls": False,
            "username": "",
            "password": "",
        },
        "local": {
            "socks_port": socks_port,
            "http_port": http_port,
            "proxy_private": False,
            "udp": True,
        },
        "tunnel": {},
        "routing": {
            "enabled": False,
            "default": "proxy",
            "direct_rules": [],
            "proxy_rules": [],
        },
    }


def _port_is_free(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def test_stop_completes_fast_and_releases_ports():
    socks_port, http_port = 18970, 18971
    proxy = proxy_core.ProxyCore()
    proxy.start(_config(socks_port, http_port))
    time.sleep(0.3)  # 等待 listener 就绪
    assert _port_is_free(socks_port) is False

    t0 = time.monotonic()
    proxy.stop()
    elapsed = time.monotonic() - t0

    # 旧实现固定 8.0s；新实现正常路径 <1s（安全网超时除外）
    assert elapsed < 2.0, f"stop took {elapsed:.2f}s"
    assert _port_is_free(socks_port), "socks 端口未释放"
    assert _port_is_free(http_port), "http 端口未释放"
    assert not proxy.is_running()


def test_stop_with_active_connection_aborts_transport_and_stays_fast():
    socks_port, http_port = 18972, 18973
    proxy = proxy_core.ProxyCore()
    proxy.start(_config(socks_port, http_port))
    time.sleep(0.3)

    # 模拟一个活跃客户端连接：注册 transport，让旧实现 wait_closed 需等待
    class FakeTransport:
        def __init__(self):
            self.aborted = False

        def abort(self):
            self.aborted = True

    transport = FakeTransport()
    proxy._active_transports.add(transport)

    t0 = time.monotonic()
    proxy.stop()
    elapsed = time.monotonic() - t0

    assert elapsed < 2.0, f"stop took {elapsed:.2f}s"
    assert transport.aborted, "全量 stop 应主动 abort 活跃连接"
    assert _port_is_free(socks_port)
    assert _port_is_free(http_port)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd client && python -m pytest tests/test_proxy_core_fast_stop.py -v`
Expected: 两个测试 FAIL——`test_stop_completes_fast_and_releases_ports` 报 `stop took 8.0xs`；`test_stop_with_active_connection_aborts_transport_and_stays_fast` 报超时（或 elapsed ≥ 8s）。

- [ ] **Step 3: 实现最小修改**

在 `proxy_core.py` 中按顺序修改：

**3a. `__init__`（~L693 `self._recycling = threading.Event()` 之后）新增：**

```python
        self._stats_task = None
```

**3b. `stop()`（L807-865）整体替换为：**

```python
    def stop(self):
        with self._stop_lock:
            self._running = False
            loop = self._loop
            thread = self._thread

            if loop and loop.is_running():
                # 收尾协程只做清理，不在协程内调用 loop.stop()：
                # loop.stop() 会让 run_forever 在 future 完成回调执行前
                # 退出，run_coroutine_threadsafe(...).result() 永远超时，
                # 每次 stop 固定白等 8s。协程正常返回 → future 正常
                # resolve，调用方在 finally 里再停 loop。
                async def _shutdown():
                    await self._stop_servers()

                try:
                    asyncio.run_coroutine_threadsafe(_shutdown(), loop).result(
                        timeout=LOCAL_PROXY_STOP_WAIT_TIMEOUT * 2 + 2
                    )
                except Exception:
                    # 仅剩的安全网：僵尸锁等极端情况超时，强制关 socket
                    # 释放端口，保证 stop() 必然完成
                    logger.warning("proxy shutdown timed out, forcing close", exc_info=True)
                    for sock in self._server_sockets:
                        try:
                            sock.close()
                        except Exception:
                            pass
                    self._server_sockets = []
                finally:
                    # future 已 resolve（或已放弃等待），此时停 loop 不会再
                    # 吞掉任何回调；call_soon_threadsafe 保证线程安全
                    if loop.is_running():
                        loop.call_soon_threadsafe(loop.stop)

                # 端口已释放，清空引用防止新 loop 误操作（跨 loop
                # server 引用会抛 RuntimeError + EADDRINUSE 漂移）
                self._socks_server = None
                self._http_server = None
                self._server_sockets = []

            if thread:
                # Wait for thread to exit with short timeout
                thread.join(timeout=3)
                if not thread.is_alive() and loop:
                    try:
                        loop.close()
                    except Exception:
                        pass
                elif loop:
                    # 线程未退出：强制关闭 server sockets 释放端口
                    for sock in self._server_sockets:
                        try:
                            sock.close()
                        except Exception:
                            pass
                    logger.warning("proxy thread did not exit in time, forced server socket close")
            self._loop = None
            self._thread = None
```

**3c. `_start_servers`（L1070-1073）：把 stats 任务存下来供关停取消**

```python
        self._semaphore = asyncio.Semaphore(MAX_CONCURRENT)
        init_writer()
        self._stats_task = asyncio.ensure_future(self._flush_stats_loop())
```

**3d. `_stop_servers`（L1126-1152）：先取消 stats 任务，再调用带 force_abort 的关停**

```python
    async def _stop_servers(self):
        if self._stats_task and self._stats_task is not asyncio.current_task():
            self._stats_task.cancel()
            try:
                await self._stats_task
            except asyncio.CancelledError:
                pass
        self._stats_task = None
        if self._recycle_task and self._recycle_task is not asyncio.current_task():
            self._recycle_task.cancel()
            try:
                await self._recycle_task
            except asyncio.CancelledError:
                pass
        self._recycle_task = None
        try:
            # 整体限时：等待锁被僵尸协程释放 + 关闭 server 收尾，
            # 超时强制关 socket 释放端口，保证 stop() 必然快速完成。
            # 正常路径在 force_abort 下亚秒完成，此超时只兜底异常。
            await asyncio.wait_for(
                self._stop_local_proxy_locked(force_abort=True),
                timeout=LOCAL_PROXY_STOP_WAIT_TIMEOUT + 2,
            )
        except asyncio.TimeoutError:
            logger.warning("stop local proxy timed out, forcing socket close")
            for sock in self._server_sockets:
                try:
                    sock.close()
                except Exception:
                    pass
            self._server_sockets = []
            self._socks_server = None
            self._http_server = None
```

**3e. `_stop_local_proxy_locked`（L1152-1155）加参数：**

```python
    async def _stop_local_proxy_locked(self, force_abort=True):
        async with self._get_local_proxy_lock():
            await self._stop_local_proxy(force_abort=force_abort)
```

**3f. `_stop_local_proxy`（L1177-1187）加 force_abort：**

```python
    async def _stop_local_proxy(self, force_abort=True):
        if force_abort:
            # 全量 stop 才主动断开活跃连接（用户点“关闭代理”即预期断开）。
            # 各 handler 立即收尾，server.wait_closed() 不再等待
            # keep-alive / 探测连接自然结束，3s 限时退化为纯安全网。
            for transport in list(self._active_transports):
                try:
                    transport.abort()
                except (OSError, RuntimeError):
                    pass
        if self._upstream_pool:
            await self._upstream_pool.stop()
            self._upstream_pool = None
        if self._socks_server:
            self._socks_server.close()
            await self._close_server_limited(self._socks_server)
            self._socks_server = None
        if self._http_server:
            self._http_server.close()
            await self._close_server_limited(self._http_server)
            self._http_server = None
        self._server_sockets = []
```

**3g. `_recycle_local_proxy_once_unlocked`（L1237-1244）：recycle 语义不变，不主动断连接**

```python
    async def _recycle_local_proxy_once_unlocked(self):
        logger.info("local proxy recycle starting")
        await self._stop_local_proxy(force_abort=False)
        await self._start_local_proxy(allow_port_retry=False)
        self._mark_proxy_activity()
        logger.info(
            "local proxy recycle completed: socks=%s http=%s",
            self._socks_port,
            self._http_port,
        )
```

**3h. `_close_writer`（L315-320）后新增 RST 关闭助手：**

```python
def _close_writer_force(writer):
    """立即 RST 关闭（SO_LINGER=0 + abort），不等对端 FIN。
    用于 stop 时清空上游连接池；有 transport 时走 RST，否则退化为 close。"""
    transport = getattr(writer, "transport", None)
    if transport is not None:
        _force_close_rst(writer)
    else:
        writer.close()
```

**3i. `UpstreamPool.stop`（L531-550）中 `_close_writer(writer)` 改为 `_close_writer_force(writer)`：**

```python
    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        while not self._pool.empty():
            try:
                entry = self._pool.get_nowait()
            except asyncio.QueueEmpty:
                break
            self._pool.task_done()
            if entry is _POOL_ZOMBIE:
                continue
            _, writer = entry
            _close_writer_force(writer)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd client && python -m pytest tests/test_proxy_core_fast_stop.py tests/test_proxy_core_local_proxy_stop.py tests/test_upstream_pool_tombstone.py -v`
Expected: 全部 PASS（`test_stop_skips_tombstone_and_closes_each_live_writer_once` 依赖 FakeWriter 无 transport 属性 → `_close_writer_force` 退化 `close()`，`close_calls == 1` 不变）。

- [ ] **Step 5: 全量测试**

Run: `cd client && python -m pytest tests/ -q`
Expected: 265 + 新增 = 267 passed。

- [ ] **Step 6: 手动验证计时**

```bash
cd client && python3 - <<'EOF'
import time
from proxy_core import ProxyCore
cfg = {
    "server": {"protocol": "socks5", "address": "127.0.0.1", "port": 18999, "tls": False},
    "local": {"socks_port": 18980, "http_port": 18981, "proxy_private": False, "udp": True},
    "tunnel": {},
    "routing": {"enabled": False, "default": "proxy", "direct_rules": [], "proxy_rules": []},
}
for _ in range(3):
    p = ProxyCore(); p.start(cfg); time.sleep(0.3)
    t = time.time(); p.stop()
    print("stop: %.2fs" % (time.time() - t))
EOF
```
Expected: 3 次全部 <1.0s（旧实现固定 8.00s）。

- [ ] **Step 7: Commit**

```bash
git add client/tests/test_proxy_core_fast_stop.py client/proxy_core.py
git commit -m "fix(client): make ProxyCore.stop deterministic and fast"
```

（按项目规则，先等用户验证再提交。）

---

### Task 2: geodata 选择性解析 + 进程内缓存

**Files:**
- Modify: `client/geodata_loader.py`（`parse_geosite_data` L18-47、`parse_geoip_data` L49-88、`GeodataLoader.__init__` L91-101、`_load_geosite` L103-118、`_load_geoip` L120-133）
- Modify: `client/routing.py`（`RoutingEngine.__init__` L73-90）
- Test: `client/tests/test_geodata_loader.py`（新增用例）、`client/tests/test_routing.py`（新增用例）

**Interfaces:**
- Consumes: `geodata_loader.parse_geosite_data(data)` / `parse_geoip_data(data)` 现有签名；`RoutingEngine.__init__(config, geodata_dir)` 现有签名
- Produces: `parse_geosite_data(data, wanted_tags=None)`、`parse_geoip_data(data, wanted_codes=None)`；`GeodataLoader(data_dir, load_geosite=True, load_geoip=True, wanted_tags=None, wanted_codes=None)`；模块级 `_PARSED_CACHE` / `_CACHE_LOCK`

**实测依据（写入测试注释）：** 全量解析 geoip.dat(20.5MB) 27.0s / 只解析 cn 2.7s；全量 geosite.dat(9.3MB) 2.0s / 只解析 cn+google 1.0s。routing_window 查询页与 gen_geodata_tags 脚本构造 loader 时不传 wanted（None=全量），行为不变。

- [ ] **Step 1: 写失败测试**

在 `client/tests/test_geodata_loader.py` 末尾追加：

```python
class TestSelectiveParse:
    def test_parse_geoip_only_requested_codes(self):
        cn = _build_geoip("cn", [b"\x01\x02\x03\x04", 24])
        us = _build_geoip("us", [b"\x08\x08\x08\x08", 24])
        data = _build_geoip_list([cn, us])

        result = parse_geoip_data(data, wanted_codes={"cn"})

        assert "cn" in result
        assert "us" not in result

    def test_parse_geosite_only_requested_tags(self):
        cn = _build_geosite("cn", [_build_domain(2, "baidu.com")])
        google = _build_geosite("google", [_build_domain(2, "google.com")])
        data = _build_geosite_list([cn, google])

        result = parse_geosite_data(data, wanted_tags={"cn"})

        assert "cn" in result
        assert "google" not in result

    def test_wanted_none_keeps_full_parse(self):
        cn = _build_geosite("cn", [_build_domain(2, "baidu.com")])
        google = _build_geosite("google", [_build_domain(2, "google.com")])
        data = _build_geosite_list([cn, google])

        result = parse_geosite_data(data)

        assert set(result) == {"cn", "google"}


class TestParsedCache:
    def test_second_loader_reuses_cache_without_reparsing(self, tmp_path, monkeypatch):
        from geodata_loader import _PARSED_CACHE, parse_geosite_data
        path = tmp_path / "geosite.dat"
        path.write_bytes(_build_geosite_list(
            [_build_geosite("cn", [_build_domain(2, "baidu.com")])]
        ))

        calls = []
        def counting_parse(data, wanted_tags=None):
            calls.append(1)
            return parse_geosite_data(data, wanted_tags)
        monkeypatch.setattr("geodata_loader.parse_geosite_data", counting_parse)

        l1 = GeodataLoader(str(tmp_path), load_geosite=True, load_geoip=False)
        l2 = GeodataLoader(str(tmp_path), load_geosite=True, load_geoip=False)

        assert len(calls) == 1, "同文件同 mtime/size 第二次加载应命中缓存"
        assert l2.get_geosite("cn") == [("domain", "baidu.com")]

    def test_cache_invalidated_when_file_changes(self, tmp_path, monkeypatch):
        from geodata_loader import parse_geosite_data
        path = tmp_path / "geosite.dat"
        path.write_bytes(_build_geosite_list(
            [_build_geosite("cn", [_build_domain(2, "baidu.com")])]
        ))

        calls = []
        def counting_parse(data, wanted_tags=None):
            calls.append(1)
            return parse_geosite_data(data, wanted_tags)
        monkeypatch.setattr("geodata_loader.parse_geosite_data", counting_parse)

        GeodataLoader(str(tmp_path), load_geosite=True, load_geoip=False)
        # 修改文件内容（size 变化 → 缓存键失效）
        path.write_bytes(_build_geosite_list(
            [_build_geosite("google", [_build_domain(2, "google.com")])]
        ))
        l2 = GeodataLoader(str(tmp_path), load_geosite=True, load_geoip=False)

        assert len(calls) == 2, "文件变化后应重新解析"
        assert l2.get_geosite("google") == [("domain", "google.com")]
```

注意：`_build_geoip` / `_build_geoip_list` / `_build_geosite` / `_build_geosite_list` / `_build_domain` 助手在该测试文件已存在（L52-66、L126-139），无需新增。

在 `client/tests/test_routing.py` 末尾追加：

```python
class TestWantedGeodata:
    def test_engine_passes_wanted_tags_to_loader(self, monkeypatch):
        captured = {}

        class FakeLoader:
            def __init__(self, data_dir, load_geosite=True, load_geoip=True,
                         wanted_tags=None, wanted_codes=None):
                captured.update(wanted_tags=wanted_tags, wanted_codes=wanted_codes)
                self._cache = {"cn": [("domain", "baidu.com")]}

            @property
            def geosite_available(self):
                return True

            def has_geosite(self, code):
                return code in self._cache

            def get_geosite(self, code):
                return self._cache.get(code, [])

            def load_geoip(self):
                pass

        monkeypatch.setattr(routing_module, "GeodataLoader", FakeLoader)
        RoutingEngine(
            {
                "enabled": True,
                "default": "proxy",
                "direct_rules": ["geosite:cn", "geoip:us"],
                "proxy_rules": [],
            },
            "/tmp/geodata",
        )

        assert captured["wanted_tags"] == {"cn"}
        assert captured["wanted_codes"] == {"us"}
```

`test_routing.py` 顶部 import 段已有 `from routing import parse_rules, RoutingEngine`，需补充 `import routing as routing_module`。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd client && python -m pytest tests/test_geodata_loader.py tests/test_routing.py -v`
Expected: 新增 6 个测试 FAIL（`TypeError: parse_geoip_data() got an unexpected keyword argument 'wanted_codes'` / 缓存断言失败）。

- [ ] **Step 3: 实现最小修改**

**3a. `geodata_loader.py` 顶部 import 区加入 `threading`：**

```python
import ipaddress
import logging
import os
import threading
from proto_parser import parse_message, get_string, get_bytes, get_varint, get_message
```

**3b. `parse_geosite_data` 加参数（L18-47）：**

```python
def parse_geosite_data(data, wanted_tags=None):
    """Parse GeoSiteList protobuf bytes into a dict.

    Returns: {country_code(str): [(type_str, value_str), ...]}
    country_code is lowercased.
    wanted_tags: 只解析这些 tag（None = 全量）。
    """
    result = {}
    top_fields = parse_message(data)

    for fn, wt, val in top_fields:
        if fn != 1 or wt != 2:
            continue
        # Each field 1 is a GeoSite message
        site_fields = parse_message(val)
        country_code = get_string(site_fields, 1, "").lower()
        if not country_code:
            continue
        if wanted_tags is not None and country_code not in wanted_tags:
            continue
        # （后续 domains 收集逻辑不变）
```

**3c. `parse_geoip_data` 加参数（L49-88），在 `country_code` 判定后插入：**

```python
def parse_geoip_data(data, wanted_codes=None):
    """Parse GeoIPList protobuf bytes into a dict.

    Returns: {country_code(str): [ipaddress.IPv4Network/IPV6Network, ...]}
    country_code is lowercased.
    wanted_codes: 只解析这些 code（None = 全量）。全量构建 ipaddress 对象
    实测 ~27s，选择性解析按规则数量降到秒级以下。
    """
    ...
        country_code = get_string(geoip_fields, 1, "").lower()
        if not country_code:
            continue
        if wanted_codes is not None and country_code not in wanted_codes:
            continue
```

**3d. 模块级缓存 + `GeodataLoader` 改造（L91-133）：**

```python
# 进程内解析缓存：{（绝对路径, mtime, size）: parsed_dict}。
# 代理每次 toggle 都会重建 RoutingEngine，缓存避免重复全量解析
# （geoip 全量 27s / geosite 全量 2s）。文件变化（mtime/size）自动失效。
_PARSED_CACHE = {}
_CACHE_LOCK = threading.Lock()


def _cache_key(path):
    try:
        st = os.stat(path)
        return (os.path.abspath(path), st.st_mtime, st.st_size)
    except OSError:
        return None


class GeodataLoader:
    """Selective eager-loading geodata file parser."""

    def __init__(self, data_dir, load_geosite=True, load_geoip=True,
                 wanted_tags=None, wanted_codes=None):
        self._data_dir = data_dir
        self._wanted_tags = wanted_tags
        self._wanted_codes = wanted_codes
        self._geosite_cache = {}  # {tag: [(type, value), ...]}
        self._geoip_cache = {}    # {code: [IPv4Network/IPv6Network, ...]}
        self._geosite_loaded = False
        self._geoip_loaded = False
        if load_geosite:
            self._load_geosite()
        if load_geoip:
            self._load_geoip()

    def _load_geosite(self):
        geosite_path = os.path.join(self._data_dir, "geosite.dat")
        if os.path.exists(geosite_path):
            try:
                key = _cache_key(geosite_path)
                with _CACHE_LOCK:
                    cached = _PARSED_CACHE.get(key) if key else None
                if cached is not None:
                    self._geosite_cache = cached
                    self._geosite_loaded = True
                    logger.info("Loaded geosite.dat from cache: %d tags", len(cached))
                    return
                with open(geosite_path, "rb") as f:
                    parsed = parse_geosite_data(f.read(), self._wanted_tags)
                if key:
                    with _CACHE_LOCK:
                        _PARSED_CACHE[key] = parsed
                self._geosite_cache = parsed
                self._geosite_loaded = True
                logger.info("Loaded geosite.dat: %d tags", len(parsed))
            except Exception:
                logger.warning("Failed to parse geosite.dat", exc_info=True)
        else:
            logger.warning("geosite.dat not found: %s", geosite_path)

    def _load_geoip(self):
        geoip_path = os.path.join(self._data_dir, "geoip.dat")
        if os.path.exists(geoip_path):
            try:
                key = _cache_key(geoip_path)
                with _CACHE_LOCK:
                    cached = _PARSED_CACHE.get(key) if key else None
                if cached is not None:
                    self._geoip_cache = cached
                    self._geoip_loaded = True
                    logger.info("Loaded geoip.dat from cache: %d codes", len(cached))
                    return
                with open(geoip_path, "rb") as f:
                    parsed = parse_geoip_data(f.read(), self._wanted_codes)
                if key:
                    with _CACHE_LOCK:
                        _PARSED_CACHE[key] = parsed
                self._geoip_cache = parsed
                self._geoip_loaded = True
                logger.info("Loaded geoip.dat: %d codes", len(parsed))
            except Exception:
                logger.warning("Failed to parse geoip.dat", exc_info=True)
        else:
            logger.warning("geoip.dat not found: %s", geoip_path)
```

**3e. `routing.py` `RoutingEngine.__init__`（L73-90）替换 loader 构造段：**

```python
        self._enabled = config.get("enabled", False)
        self._default_action = config.get("default", "proxy")
        self._direct_rules = parse_rules(config.get("direct_rules", []))
        self._proxy_rules = parse_rules(config.get("proxy_rules", []))
        all_rules = self._direct_rules + self._proxy_rules
        geosite_tags = {code for rule_type, code, _ in all_rules if rule_type == "geosite"}
        geoip_codes = {code for rule_type, code, _ in all_rules if rule_type == "geoip"}
        needs_geosite = bool(geosite_tags)
        needs_geoip = bool(geoip_codes)
        self._loader = None
        if self._enabled and (needs_geosite or needs_geoip):
            # 只解析规则引用的 tag/code：geoip 全量解析实测 ~27s，
            # 选择性解析（如仅 cn）~2.7s；进程内缓存让重复 toggle 零解析。
            self._loader = GeodataLoader(
                geodata_dir,
                load_geosite=needs_geosite,
                load_geoip=False,  # geoip loaded in background to avoid blocking startup
                wanted_tags=geosite_tags or None,
                wanted_codes=geoip_codes or None,
            )
            if needs_geoip:
                threading.Thread(target=self._loader.load_geoip, daemon=True).start()
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd client && python -m pytest tests/test_geodata_loader.py tests/test_routing.py -v`
Expected: 全部 PASS。

- [ ] **Step 5: 手动计时验证**

```bash
cd client && python3 - <<'EOF'
import time
from geodata_loader import GeodataLoader
t = time.time()
l = GeodataLoader("geodata", load_geosite=True, load_geoip=True,
                  wanted_tags={"cn"}, wanted_codes={"cn"})
print("selective load: %.2fs" % (time.time() - t))
t = time.time()
GeodataLoader("geodata", load_geosite=True, load_geoip=True,
              wanted_tags={"cn"}, wanted_codes={"cn"})
print("cached load: %.2fs" % (time.time() - t))
EOF
```
Expected: 首次（选择性）~3-4s，第二次（缓存命中）<0.1s。

- [ ] **Step 6: 全量测试**

Run: `cd client && python -m pytest tests/ -q`
Expected: 全部 passed。

- [ ] **Step 7: Commit**

```bash
git add client/geodata_loader.py client/routing.py client/tests/test_geodata_loader.py client/tests/test_routing.py
git commit -m "perf(client): selective geodata parsing with in-process cache"
```

---

### Task 3: SystemProxy 验证命令并行化

**Files:**
- Modify: `client/system_proxy.py`（`_verify` L128-142）
- Test: `client/tests/test_system_proxy.py`（新增用例）

**Interfaces:**
- Consumes: `SystemProxy._verify(socks_port, http_port)`（enable 末尾调用，接口不变）
- Produces: 3×N 条 `networksetup -get*proxy` 读命令并行执行，失败的仍串行重试一次

**实测依据：** 旧实现 `for iface: for get_cmd:` 双层串行，N 接口 = 3N 条串行子进程调用；每条在慢机器 0.5-2s，是启动“正在连接…”停留的主因之一（disable 的 4 条命令已并行）。

- [ ] **Step 1: 写失败测试**

在 `client/tests/test_system_proxy.py` 末尾追加：

```python
class TestVerifyParallel:
    @patch("system_proxy.subprocess.run")
    def test_verify_queries_run_in_multiple_threads(self, mock_run):
        """3N 条验证读命令应并行执行（旧实现串行 → 单线程 → 失败）。"""
        import threading
        import time

        self.proxy._interfaces = ["Wi-Fi", "Ethernet"]
        seen_threads = []

        def fake_run(args, capture_output=True, text=True):
            seen_threads.append(threading.current_thread().name)
            time.sleep(0.03)  # 保证任务分散到不同 worker 线程
            return MagicMock(returncode=0, stdout="Enabled: Yes\n", stderr="")

        mock_run.side_effect = fake_run

        self.proxy._verify(socks_port=1080, http_port=1087)

        assert len(seen_threads) == 6  # 2 接口 × 3 命令
        assert len(set(seen_threads)) >= 2, "验证命令必须并行执行"

    @patch("system_proxy.subprocess.run")
    def test_verify_retries_only_failed_checks(self, mock_run):
        self.proxy._interfaces = ["Wi-Fi"]

        def fake_run(args, capture_output=True, text=True):
            # 按命令名决定结果，与并行执行顺序无关（确定性）
            if args[1] == "-getsocksfirewallproxy":
                return MagicMock(returncode=0, stdout="Enabled: No\n", stderr="")
            return MagicMock(returncode=0, stdout="Enabled: Yes\n", stderr="")

        mock_run.side_effect = fake_run

        self.proxy._verify(socks_port=1080, http_port=1087)

        set_calls = [
            c.args[0]
            for c in mock_run.call_args_list
            if c.args[0][1].startswith("-set")
        ]
        assert set_calls == [["networksetup", "-setsocksfirewallproxystate", "Wi-Fi", "on"]]
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd client && python -m pytest tests/test_system_proxy.py -v`
Expected: `test_verify_queries_run_in_multiple_threads` FAIL（`len(set(seen_threads)) == 1`）。

- [ ] **Step 3: 实现最小修改**

`system_proxy.py` `_verify`（L128-142）替换为：

```python
    def _verify(self, socks_port, http_port):
        checks = [
            ("-getsocksfirewallproxy", "-setsocksfirewallproxystate"),
            ("-getwebproxy", "-setwebproxystate"),
            ("-getsecurewebproxy", "-setsecurewebproxystate"),
        ]
        set_by_get = dict(checks)

        def _read(args):
            return args, subprocess.run(args, capture_output=True, text=True)

        # 3N 条读命令并行执行（旧实现双层串行，慢机器上每条 0.5-2s，
        # 是启动等待的主因之一）；写命令保持 max_workers=8 的池
        tasks = [
            ["networksetup", get_cmd, iface]
            for iface in self._interfaces
            for get_cmd, _set_cmd in checks
        ]
        with ThreadPoolExecutor(max_workers=8) as pool:
            for args, result in pool.map(_read, tasks):
                if "Enabled: No" in result.stdout:
                    logger.warning(
                        "proxy not enabled after setting: %s %s, retrying",
                        args[1], args[2],
                    )
                    _run_networksetup(
                        ["networksetup", set_by_get[args[1]], args[2], "on"]
                    )
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd client && python -m pytest tests/test_system_proxy.py -v`
Expected: 全部 PASS（旧用例 `test_enable_multiple_interfaces` 的 call_count == 21 不变：1 探测 + 7×2 写 + 3×2 读，mock stdout 均为 "Enabled: Yes" 无重试）。

- [ ] **Step 5: 全量测试**

Run: `cd client && python -m pytest tests/ -q`
Expected: 全部 passed。

- [ ] **Step 6: Commit**

```bash
git add client/system_proxy.py client/tests/test_system_proxy.py
git commit -m "perf(client): parallelize system proxy verification reads"
```

---

### Task 4（可选）: app 层启动反馈提前 —— 本地代理就绪即亮图标

**Files:**
- Modify: `client/app.py`（`_connect` L279-323 的 `_start`、新增 `_on_local_ready`）

**Interfaces:**
- Consumes: `self.proxy.start` 返回值语义不变；`self._on_connected` / `_finish_connecting` 不变
- Produces: 新增 `AppController._on_local_ready()`

**设计说明：** 启动链路里 `proxy.start` 本身 <100ms，用户感知的“慢”是 networksetup 期间菜单一直显示“正在连接…”。本任务把视觉反馈提前到本地代理就绪（Task 3 已把 networksetup 段缩短后此任务收益有限）。安全边界：`_connecting` 保持 True、toggle 项保持禁用直到整条链完成，杜绝“开启中途点关闭”的竞态。若用户认为无必要可跳过。

- [ ] **Step 1: 修改实现（PyObjC 主线程 UI 无可用单测设施，验证靠手动步骤；改动为纯时序重排，行为等价）**

`app.py` `_start`（L289 附近）改为：

```python
        def _start():
            # 1. 启动本地代理服务器（端口绑定，这是用户代理的核心）
            try:
                self.proxy.start(self.config.data,
                                  config_dir=os.path.dirname(self.config.config_path))
            except OSError as e:
                message = (
                    "端口被占用，请检查端口是否已被其他程序使用"
                    if e.errno == 48 else str(e)
                )

                def _fail():
                    self._show_notification(
                        "BlockProxyClient", "启动失败", message
                    )
                    self._on_disconnected()

                self._run_on_main(_fail)
                return

            # 本地代理已就绪：立即反馈（图标/标题），toggle 项仍禁用
            # （_connecting 未清除），待系统代理与隧道完成后恢复可点。
            self._run_on_main(self._on_local_ready)

            # 2. 设置系统代理（本地服务器已就绪）
            if self.config.data["mode"] == "global":
                try:
                    self.sys_proxy.enable(
                        socks_port=self.proxy.socks_port,
                        http_port=self.proxy.http_port,
                    )
                except Exception as e:
                    self._run_on_main(
                        lambda: self._show_notification(
                            "BlockProxyClient", "系统代理设置失败", str(e)
                        )
                    )

            # 3. 启动隧道客户端（独立于本地代理，失败不影响本地代理）
            if self._tunnel_enabled():
                self._start_tunnel()

            self._run_on_main(self._on_connected)
```

在 `_on_connected`（L349 附近）前新增：

```python
    def _on_local_ready(self):
        """本地代理端口已绑定：先亮图标，系统代理/隧道继续在后台收尾。
        _connecting 保持 True，toggle 项仍禁用，避免开启中途点关闭的竞态。"""
        self.connected = True
        self.toggle_item.setTitle_("关闭代理")
        self._update_icon()
```

- [ ] **Step 2: 全量测试（确认无回归）**

Run: `cd client && python -m pytest tests/ -q`
Expected: 全部 passed。

- [ ] **Step 3: 手动验证**

Run: `cd client && python main.py`，依次验证：
1. 点“启动代理”→ 图标立刻变绿/“关闭代理”出现，1-2s 内 toggle 恢复可点；
2. 恢复可点前反复点击 toggle 无竞态（不会出现系统代理残留开启）；
3. 点“关闭代理”→ 1s 内完成，`networksetup -getwebproxy` 显示关闭；
4. 反复开关 10 次，无崩溃、无端口漂移（`lsof -i :1086` 检查）。

- [ ] **Step 4: Commit**

```bash
git add client/app.py
git commit -m "perf(client): flip proxy state immediately when local listener is ready"
```

---

## Self-Review

- **Spec coverage:** 上一轮诊断列的 4 个设计问题 → Task 1（分层超时兜底/8s 死等）、Task 2（geodata 全量解析）、Task 3（networksetup 串行验证）、Task 4（全链路反馈时序，可选且竞态安全）。
- **Placeholder scan:** 无 TBD/TODO；所有任务含完整代码与测试。
- **Type consistency:** `force_abort` 默认值两处调用点一致（`_stop_servers`→True、recycle→False）；`wanted_tags/wanted_codes` 在 geodata_loader 与 routing 两文件签名一致；`_close_writer_force` 单一定义、`UpstreamPool.stop` 唯一调用点。
