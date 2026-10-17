"""proxy_core / app / tunnel_client 等模块日志落盘回归测试。

背景（2026-10-17 现场）：`logger.py` 只给 access / crash / diagnostics
三个专用 logger 挂 handler，而 `proxy_core.py`、`app.py`、
`tunnel_client.py` 用的是普通模块 logger（`logging.getLogger("proxy_core")`
等），全部无 handler → 端口漂移、recycle 卡死、stop 超时这些排障
关键告警一条都没落盘，grep 全部日志为空。
"""

import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


MODULE_LOGGERS = (
    "proxy_core",
    "app",
    "tunnel_client",
    "routing",
    "system_proxy",
    "node_connect",
    "autostart",
    "geodata_loader",
)


class TestModuleLoggersPersist:
    def setup_method(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.log_dir = os.path.join(self.tmp_dir, "logs")

    def teardown_method(self):
        import logging
        import logger
        for name in MODULE_LOGGERS:
            logging.getLogger(name).handlers.clear()
        logger.access_logger.handlers.clear()
        logger.crash_logger.handlers.clear()
        logger.diagnostics_logger.handlers.clear()
        logger._initialized = False
        if logger._crash_file and not logger._crash_file.closed:
            logger._crash_file.close()
        logger._crash_file = None
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_module_loggers_get_handlers(self):
        import logging
        from logger import setup_logging
        setup_logging(log_dir=self.log_dir)
        for name in MODULE_LOGGERS:
            assert logging.getLogger(name).handlers, f"{name} 没有 handler"

    def test_proxy_core_warning_lands_on_disk(self):
        import logging
        from logger import setup_logging
        setup_logging(log_dir=self.log_dir)
        logging.getLogger("proxy_core").warning(
            "local proxy port 1080/1087 in use, retrying with +1 offset"
        )
        path = os.path.join(self.log_dir, "crash.log")
        with open(path, encoding="utf-8") as f:
            content = f.read()
        assert "retrying with +1 offset" in content

    def test_module_logger_output_is_not_duplicated(self):
        """重复 setup_logging 不能叠加 handler（否则每行日志写多份）。"""
        import logging
        from logger import setup_logging
        setup_logging(log_dir=self.log_dir)
        first = len(logging.getLogger("proxy_core").handlers)
        logger_mod = sys.modules["logger"]
        logger_mod._initialized = False  # 模拟二次初始化
        setup_logging(log_dir=self.log_dir)
        assert len(logging.getLogger("proxy_core").handlers) == first
