import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import proxy_core


class FakeReader:
    def __init__(self, eof=False):
        self.eof = eof

    def at_eof(self):
        return self.eof


class FakeWriter:
    def __init__(self, closing=False):
        self.closing = closing
        self.close_calls = 0

    def is_closing(self):
        return self.closing

    def close(self):
        self.close_calls += 1
        self.closing = True

    async def wait_closed(self):
        pass


async def wait_until(predicate, timeout=0.2):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0)
    raise AssertionError("condition was not reached before timeout")


def tls_socks_config():
    return {"protocol": "socks5", "tls": True}


def test_tls_socks_maintainer_marks_eof_entry_without_immediate_reconnect(monkeypatch):
    monkeypatch.setattr(proxy_core, "POOL_CHECK_INTERVAL", 0.001)

    async def scenario():
        pool = proxy_core.UpstreamPool(tls_socks_config(), None)
        stale_reader, stale_writer = FakeReader(eof=True), FakeWriter()
        live_entries = [(FakeReader(), FakeWriter()), (FakeReader(), FakeWriter())]
        for entry in [(stale_reader, stale_writer), *live_entries]:
            await pool._pool.put(entry)

        create_calls = 0

        async def create_connection():
            nonlocal create_calls
            create_calls += 1
            raise AssertionError("tombstone must not trigger immediate preconnect")

        pool.create_connection = create_connection
        await pool.start()
        await wait_until(lambda: stale_writer.close_calls == 1)

        assert pool._pool.qsize() == proxy_core.POOL_SIZE
        assert list(pool._pool._queue)[0] is proxy_core._POOL_ZOMBIE
        assert pool._pool._unfinished_tasks == proxy_core.POOL_SIZE
        assert create_calls == 0
        await pool.stop()

    asyncio.run(scenario())


def test_tls_socks_scan_marks_closing_entry_as_tombstone():
    async def scenario():
        pool = proxy_core.UpstreamPool(tls_socks_config(), None)
        writer = FakeWriter(closing=True)
        await pool._pool.put((FakeReader(), writer))

        await pool._mark_closed_preconnects()

        assert pool._pool.qsize() == 1
        assert pool._pool._queue[0] is proxy_core._POOL_ZOMBIE
        assert pool._pool._unfinished_tasks == 1
        assert writer.close_calls == 1

    asyncio.run(scenario())


def test_acquire_discards_tombstone_then_returns_next_live_connection():
    async def scenario():
        pool = proxy_core.UpstreamPool(tls_socks_config(), None)
        live_reader, live_writer = FakeReader(), FakeWriter()
        await pool._pool.put(proxy_core._POOL_ZOMBIE)
        await pool._pool.put((live_reader, live_writer))

        async def create_connection():
            raise AssertionError("healthy entry after tombstone must be reused")

        pool.create_connection = create_connection
        assert await pool.acquire() == (live_reader, live_writer)
        assert pool._pool.qsize() == 0
        assert pool._pool._unfinished_tasks == 0

    asyncio.run(scenario())


def test_acquire_with_only_tombstones_creates_connection_for_current_request():
    async def scenario():
        pool = proxy_core.UpstreamPool(tls_socks_config(), None)
        for _ in range(proxy_core.POOL_SIZE):
            await pool._pool.put(proxy_core._POOL_ZOMBIE)
        fresh_reader, fresh_writer = FakeReader(), FakeWriter()
        create_calls = 0

        async def create_connection():
            nonlocal create_calls
            create_calls += 1
            return fresh_reader, fresh_writer

        pool.create_connection = create_connection
        assert await pool.acquire() == (fresh_reader, fresh_writer)
        assert create_calls == 1
        assert pool._pool.qsize() == 0
        assert pool._pool._unfinished_tasks == 0

    asyncio.run(scenario())


def test_existing_maintainer_refills_only_after_tombstone_is_consumed(monkeypatch):
    monkeypatch.setattr(proxy_core, "POOL_CHECK_INTERVAL", 0.001)

    async def scenario():
        pool = proxy_core.UpstreamPool(tls_socks_config(), None)
        for _ in range(proxy_core.POOL_SIZE):
            await pool._pool.put(proxy_core._POOL_ZOMBIE)
        replacements = [(FakeReader(), FakeWriter()) for _ in range(proxy_core.POOL_SIZE + 1)]

        async def create_connection():
            return replacements.pop(0)

        pool.create_connection = create_connection
        await pool.acquire()
        assert pool._pool.qsize() == 0
        await pool.start()
        await wait_until(lambda: pool._pool.qsize() == proxy_core.POOL_SIZE)
        assert all(entry is not proxy_core._POOL_ZOMBIE for entry in pool._pool._queue)
        await pool.stop()

    asyncio.run(scenario())


def test_stop_skips_tombstone_and_closes_each_live_writer_once():
    async def scenario():
        pool = proxy_core.UpstreamPool(tls_socks_config(), None)
        writer = FakeWriter()
        await pool._pool.put(proxy_core._POOL_ZOMBIE)
        await pool._pool.put((FakeReader(), writer))

        await pool.stop()

        assert pool._pool.qsize() == 0
        assert writer.close_calls == 1
        assert pool._pool._unfinished_tasks == 0

    asyncio.run(scenario())


def test_non_tls_socks_and_http_do_not_mark_closed_entries_as_tombstones():
    async def scenario():
        for config in (
            {"protocol": "socks5", "tls": False},
            {"protocol": "http", "tls": True},
        ):
            pool = proxy_core.UpstreamPool(config, None)
            reader, writer = FakeReader(eof=True), FakeWriter()
            await pool._pool.put((reader, writer))

            await pool._mark_closed_preconnects()

            assert pool._pool.qsize() == 1
            assert pool._pool._queue[0] == (reader, writer)
            assert writer.close_calls == 0

    asyncio.run(scenario())
