import os
import plistlib
import logging

logger = logging.getLogger("autostart")

PLIST_DIR = os.path.expanduser("~/Library/LaunchAgents")
PLIST_PATH = os.path.join(PLIST_DIR, "com.jaylli.blockproxyclient.plist")


def enable(app_path):
    """Create LaunchAgent plist to start app at login. No-op if app_path is None (dev mode)."""
    if not app_path or not os.path.exists(app_path):
        logger.warning("autostart: app_path not found, skipping: %s", app_path)
        return
    os.makedirs(PLIST_DIR, exist_ok=True)
    plist = {
        "Label": "com.jaylli.blockproxyclient",
        "ProgramArguments": ["/usr/bin/open", "-a", app_path],
        "RunAtLoad": True,
        "KeepAlive": False,
    }
    with open(PLIST_PATH, "wb") as f:
        plistlib.dump(plist, f)
    logger.info("autostart: plist created at %s", PLIST_PATH)


def disable():
    """Remove LaunchAgent plist."""
    try:
        os.remove(PLIST_PATH)
        logger.info("autostart: plist removed")
    except FileNotFoundError:
        pass


def sync(app_path, enabled):
    """Enable or disable autostart based on boolean."""
    if enabled:
        enable(app_path)
    else:
        disable()
