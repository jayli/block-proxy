from setuptools import setup

APP = ["main.py"]
DATA_FILES = [
    ("icons", [
        "icons/socks_on_G.png",
        "icons/socks_on_M.png",
        "icons/christmas-sock_light.png",
    ]),
]
OPTIONS = {
    "argv_emulation": False,
    "iconfile": "icons/app_example.png",
    "plist": {
        "LSUIElement": True,
        "CFBundleName": "SocksClient",
        "CFBundleIdentifier": "com.jaylli.socksclient",
        "CFBundleVersion": "1.0.0",
        "CFBundleShortVersionString": "1.0.0",
    },
    "packages": ["rumps"],
}

setup(
    name="SocksClient",
    app=APP,
    data_files=DATA_FILES,
    options={"py2app": OPTIONS},
    setup_requires=["py2app"],
)
