import os
import sys
import plistlib
import tempfile
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import autostart


class TestAutostart:
    def setup_method(self):
        self.tmp = tempfile.mkdtemp()
        autostart.PLIST_DIR = self.tmp
        autostart.PLIST_PATH = os.path.join(self.tmp, "com.jaylli.socksclient.plist")

    def teardown_method(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_enable_creates_plist(self):
        fake_app = os.path.join(self.tmp, "SocksClient.app")
        os.makedirs(fake_app)
        autostart.enable(fake_app)
        assert os.path.exists(autostart.PLIST_PATH)
        with open(autostart.PLIST_PATH, "rb") as f:
            data = plistlib.load(f)
        assert data["Label"] == "com.jaylli.socksclient"
        assert data["ProgramArguments"] == ["/usr/bin/open", "-a", fake_app]
        assert data["RunAtLoad"] is True
        assert data["KeepAlive"] is False

    def test_enable_noop_when_app_path_none(self):
        autostart.enable(None)
        assert not os.path.exists(autostart.PLIST_PATH)

    def test_enable_noop_when_app_path_not_exists(self):
        autostart.enable("/nonexistent/Foo.app")
        assert not os.path.exists(autostart.PLIST_PATH)

    def test_disable_removes_plist(self):
        fake_app = os.path.join(self.tmp, "SocksClient.app")
        os.makedirs(fake_app)
        autostart.enable(fake_app)
        autostart.disable()
        assert not os.path.exists(autostart.PLIST_PATH)

    def test_disable_noop_when_no_plist(self):
        autostart.disable()  # should not raise

    def test_sync_enable(self):
        fake_app = os.path.join(self.tmp, "SocksClient.app")
        os.makedirs(fake_app)
        autostart.sync(fake_app, True)
        assert os.path.exists(autostart.PLIST_PATH)

    def test_sync_disable(self):
        fake_app = os.path.join(self.tmp, "SocksClient.app")
        os.makedirs(fake_app)
        autostart.enable(fake_app)
        autostart.sync(fake_app, False)
        assert not os.path.exists(autostart.PLIST_PATH)
