from setuptools import setup

APP = ["main.py"]
DATA_FILES = [
    ("resources", ["resources/icon.png", "resources/icon_off.png"]),
]
OPTIONS = {
    "argv_emulation": False,
    "iconfile": "resources/icon.png",
    "plist": {
        "LSUIElement": True,
        "CFBundleName": "BlockProxyClient",
        "CFBundleIdentifier": "com.jaylli.blockproxyclient",
        "CFBundleVersion": "1.0.0",
        "CFBundleShortVersionString": "1.0.0",
    },
    "packages": ["rumps"],
}

setup(
    name="BlockProxyClient",
    app=APP,
    data_files=DATA_FILES,
    options={"py2app": OPTIONS},
    setup_requires=["py2app"],
)
