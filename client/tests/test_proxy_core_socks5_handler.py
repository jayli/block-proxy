import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import proxy_core


class EofReader:
    async def readexactly(self, n):
        raise asyncio.IncompleteReadError(b"", n)


class ClosingWriter:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True

    async def wait_closed(self):
        return None


def test_socks5_initial_eof_is_silent(monkeypatch):
    """Port probes may connect then close before sending SOCKS5 bytes."""
    warnings = []
    monkeypatch.setattr(
        proxy_core.crash_logger,
        "warning",
        lambda *args, **kwargs: warnings.append((args, kwargs)),
    )

    proxy = proxy_core.ProxyCore()
    writer = ClosingWriter()

    asyncio.run(proxy._do_handle_socks(EofReader(), writer))

    assert writer.closed
    assert warnings == []
