import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import node_connect


@pytest.fixture(autouse=True)
def _reset_node_connect_state():
    """node_connect 按域名缓存地址状态与 SNI 降级记忆，测试间必须隔离。"""
    node_connect.clear_node_states()
    yield
    node_connect.clear_node_states()
