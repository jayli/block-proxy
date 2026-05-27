import os
import threading
import rumps
from config import Config
from xray_manager import XrayManager
from system_proxy import SystemProxy


class BlockProxyClient(rumps.App):
    def __init__(self):
        super().__init__("BlockProxyClient", quit_button=None)

        self.config = Config()
        self.config.load()
        self.xray = XrayManager()
        self.sys_proxy = SystemProxy()
        self.connected = False

        self._build_menu()
        self._update_icon()
        self._start_health_check()

    def _build_menu(self):
        self.toggle_item = rumps.MenuItem("开启代理", callback=self.toggle_proxy)
        self.config_item = rumps.MenuItem("节点配置...", callback=self.open_config)

        self.global_item = rumps.MenuItem("全局代理", callback=self.set_global_mode)
        self.manual_item = rumps.MenuItem("手动模式", callback=self.set_manual_mode)

        self.quit_item = rumps.MenuItem("退出", callback=self.quit_app)

        self.menu = [
            self.toggle_item,
            self.config_item,
            None,
            self.global_item,
            self.manual_item,
            None,
            self.quit_item,
        ]

        self._update_mode_menu()

    def _update_mode_menu(self):
        is_global = self.config.data["mode"] == "global"
        self.global_item.state = 1 if is_global else 0
        self.manual_item.state = 1 if not is_global else 0

    def _update_icon(self):
        icon_name = "icon.png" if self.connected else "icon_off.png"
        icon_path = os.path.join(self._resource_dir(), icon_name)
        if os.path.exists(icon_path):
            self.icon = icon_path

    def _resource_dir(self):
        app_dir = os.path.dirname(os.path.abspath(__file__))
        return os.path.join(app_dir, "resources")

    def toggle_proxy(self, sender):
        if self.connected:
            self._disconnect()
        else:
            self._connect()

    def _connect(self):
        if not self.config.is_configured():
            rumps.alert("请先配置节点信息")
            return

        self.xray.start(self.config.data)
        if self.config.data["mode"] == "global":
            self.sys_proxy.enable(
                socks_port=self.config.data["local"]["socks_port"],
                http_port=self.config.data["local"]["http_port"],
            )
        self.connected = True
        self.toggle_item.title = "关闭代理"
        self._update_icon()

    def _disconnect(self):
        self.sys_proxy.disable()
        self.xray.stop()
        self.connected = False
        self.toggle_item.title = "开启代理"
        self._update_icon()

    def open_config(self, sender):
        self._show_config_window()

    def _show_config_window(self):
        import tkinter as tk
        from tkinter import ttk

        def save_and_close():
            self.config.data["server"]["address"] = entries["address"].get()
            self.config.data["server"]["port"] = int(entries["port"].get())
            self.config.data["server"]["username"] = entries["username"].get()
            self.config.data["server"]["password"] = entries["password"].get()
            self.config.data["server"]["tls"] = tls_var.get()
            self.config.data["server"]["allowInsecure"] = insecure_var.get() == "true"
            self.config.data["local"]["socks_port"] = int(entries["socks_port"].get())
            self.config.data["local"]["http_port"] = int(entries["http_port"].get())
            self.config.data["local"]["udp"] = udp_var.get()
            self.config.save()
            root.destroy()

        root = tk.Tk()
        root.title("节点配置")
        root.geometry("400x380")
        root.resizable(False, False)

        frame = ttk.Frame(root, padding=20)
        frame.pack(fill="both", expand=True)

        entries = {}
        fields = [
            ("address", "地址:", self.config.data["server"]["address"]),
            ("port", "端口:", str(self.config.data["server"]["port"])),
            ("username", "用户名:", self.config.data["server"]["username"]),
            ("password", "密码:", self.config.data["server"]["password"]),
            ("socks_port", "本地SOCKS端口:", str(self.config.data["local"]["socks_port"])),
            ("http_port", "本地HTTP端口:", str(self.config.data["local"]["http_port"])),
        ]

        for i, (key, label, default) in enumerate(fields):
            ttk.Label(frame, text=label).grid(row=i, column=0, sticky="w", pady=4)
            entry = ttk.Entry(frame, width=30)
            if key == "password":
                entry.config(show="*")
            entry.insert(0, default)
            entry.grid(row=i, column=1, sticky="w", pady=4)
            entries[key] = entry

        row = len(fields)

        tls_var = tk.BooleanVar(value=self.config.data["server"]["tls"])
        ttk.Checkbutton(frame, text="启用 TLS", variable=tls_var).grid(
            row=row, column=0, columnspan=2, sticky="w", pady=4
        )
        row += 1

        ttk.Label(frame, text="allowInsecure:").grid(row=row, column=0, sticky="w", pady=4)
        insecure_var = tk.StringVar(
            value="true" if self.config.data["server"]["allowInsecure"] else "false"
        )
        insecure_combo = ttk.Combobox(
            frame, textvariable=insecure_var, values=["true", "false"], state="readonly", width=10
        )
        insecure_combo.grid(row=row, column=1, sticky="w", pady=4)
        row += 1

        udp_var = tk.BooleanVar(value=self.config.data["local"]["udp"])
        ttk.Checkbutton(frame, text="启用 UDP", variable=udp_var).grid(
            row=row, column=0, columnspan=2, sticky="w", pady=4
        )
        row += 1

        ttk.Button(frame, text="保存", command=save_and_close).grid(
            row=row, column=0, columnspan=2, pady=15
        )

        root.lift()
        root.attributes("-topmost", True)
        root.mainloop()

    def set_global_mode(self, sender):
        self.config.data["mode"] = "global"
        self.config.save()
        self._update_mode_menu()
        if self.connected:
            self.sys_proxy.enable(
                socks_port=self.config.data["local"]["socks_port"],
                http_port=self.config.data["local"]["http_port"],
            )

    def set_manual_mode(self, sender):
        self.config.data["mode"] = "manual"
        self.config.save()
        self._update_mode_menu()
        if self.connected:
            self.sys_proxy.disable()

    def quit_app(self, sender):
        if self.connected:
            self._disconnect()
        rumps.quit_application()

    def _start_health_check(self):
        def check():
            while True:
                import time
                time.sleep(5)
                if self.connected and not self.xray.is_running():
                    self._disconnect()
                    rumps.notification(
                        "BlockProxyClient",
                        "代理已断开",
                        "xray-core 进程意外退出",
                    )

        t = threading.Thread(target=check, daemon=True)
        t.start()
