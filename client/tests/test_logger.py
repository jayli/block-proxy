import os
import sys
import tempfile
import logging

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


class TestSetupLogging:
    def setup_method(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.log_dir = os.path.join(self.tmp_dir, "logs")

    def test_creates_log_directory(self):
        from logger import setup_logging
        setup_logging(log_dir=self.log_dir)
        assert os.path.isdir(self.log_dir)

    def test_creates_access_log_file(self):
        from logger import setup_logging
        setup_logging(log_dir=self.log_dir)
        from logger import access_logger
        access_logger.info("test")
        assert os.path.exists(os.path.join(self.log_dir, "access.log"))

    def test_creates_crash_log_file(self):
        from logger import setup_logging
        setup_logging(log_dir=self.log_dir)
        from logger import crash_logger
        crash_logger.critical("test crash")
        assert os.path.exists(os.path.join(self.log_dir, "crash.log"))

    def test_access_logger_format(self):
        from logger import setup_logging
        setup_logging(log_dir=self.log_dir)
        from logger import access_logger
        access_logger.info("CONNECT | google.com:443 | proxy | ok")
        log_path = os.path.join(self.log_dir, "access.log")
        with open(log_path) as f:
            line = f.readline()
        assert "CONNECT | google.com:443 | proxy | ok" in line
        # timestamp format: YYYY-MM-DD HH:MM:SS
        assert line[4] == "-" and line[10] == " " and line[13] == ":"

    def test_excepthook_installed(self):
        from logger import setup_logging
        setup_logging(log_dir=self.log_dir)
        assert sys.excepthook != sys.__excepthook__
