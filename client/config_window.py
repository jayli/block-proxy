import json
import platform
import sys
import tkinter as tk
from tkinter import ttk


def _macos_setup():
    try:
        from AppKit import NSApp
        NSApp.setActivationPolicy_(1)  # NSApplicationActivationPolicyAccessory
        NSApp.activateIgnoringOtherApps_(True)
    except ImportError:
        pass


def _center_on_mouse_screen(w, h):
    if platform.system() == "Darwin":
        try:
            from AppKit import NSScreen, NSEvent
            mouse_loc = NSEvent.mouseLocation()
            primary_h = NSScreen.screens()[0].frame().size.height
            for screen in NSScreen.screens():
                sf = screen.frame()
                if (sf.origin.x <= mouse_loc.x < sf.origin.x + sf.size.width and
                        sf.origin.y <= mouse_loc.y < sf.origin.y + sf.size.height):
                    vf = screen.visibleFrame()
                    x = int(vf.origin.x + (vf.size.width - w) / 2)
                    y = int(primary_h - vf.origin.y - vf.size.height +
                            (vf.size.height - h) / 2)
                    return x, y
        except Exception:
            pass
    return None


def show_config_window(config_path):
    with open(config_path, "r") as f:
        config = json.load(f)

    def save_and_close():
        config["server"]["protocol"] = protocol_var.get()
        config["server"]["address"] = entries["address"].get()
        config["server"]["port"] = int(entries["port"].get())
        config["server"]["username"] = entries["username"].get()
        config["server"]["password"] = entries["password"].get()
        config["server"]["tls"] = tls_var.get()
        config["server"]["allowInsecure"] = insecure_var.get()
        config["local"]["socks_port"] = int(entries["socks_port"].get())
        config["local"]["http_port"] = int(entries["http_port"].get())
        config["local"]["udp"] = udp_var.get()
        config["local"]["proxy_private"] = proxy_private_var.get()
        config["autostart"] = autostart_var.get()

        with open(config_path, "w") as f:
            json.dump(config, f, indent=2)
        root.destroy()

    pos = _center_on_mouse_screen(400, 490)

    root = tk.Tk()
    root.title("节点配置")
    root.resizable(False, False)
    w, h = 400, 490
    if pos:
        x, y = pos
    else:
        x = (root.winfo_screenwidth() - w) // 2
        y = (root.winfo_screenheight() - h) // 2
    root.geometry(f"{w}x{h}+{x}+{y}")

    if platform.system() == "Darwin":
        root.after(50, _macos_setup)

    frame = ttk.Frame(root, padding=20)
    frame.pack(fill="both", expand=True)
    frame.grid_columnconfigure(1, weight=1)

    entries = {}
    row = 0

    ttk.Label(frame, text="协议:").grid(row=row, column=0, sticky="w", pady=4, padx=(0, 8))
    protocol_var = tk.StringVar(value=config["server"].get("protocol", "socks5"))
    protocol_combo = ttk.Combobox(
        frame, textvariable=protocol_var, values=["socks5", "http"], state="readonly", width=10
    )
    protocol_combo.grid(row=row, column=1, sticky="w", pady=4)
    row += 1

    fields = [
        ("address", "地址:", config["server"]["address"]),
        ("port", "端口:", str(config["server"]["port"])),
        ("username", "用户名:", config["server"]["username"]),
        ("password", "密码:", config["server"]["password"]),
        ("socks_port", "本地SOCKS端口:", str(config["local"]["socks_port"])),
        ("http_port", "本地HTTP端口:", str(config["local"]["http_port"])),
    ]

    for key, label, default in fields:
        ttk.Label(frame, text=label).grid(row=row, column=0, sticky="w", pady=4, padx=(0, 8))
        entry = ttk.Entry(frame)
        entry.insert(0, default)
        entry.grid(row=row, column=1, sticky="ew", pady=4)
        entries[key] = entry
        row += 1

    tls_var = tk.BooleanVar(value=config["server"]["tls"])
    ttk.Label(frame, text="启用 TLS:").grid(row=row, column=0, sticky="w", pady=4, padx=(0, 8))
    tls_frame = ttk.Frame(frame)
    tls_frame.grid(row=row, column=1, sticky="w", pady=4)
    ttk.Checkbutton(tls_frame, variable=tls_var).pack(side="left")
    ttk.Label(tls_frame, text="（需节点服务器支持）", foreground="gray").pack(side="left")
    row += 1

    insecure_var = tk.BooleanVar(value=config["server"]["allowInsecure"])
    ttk.Label(frame, text="允许不安全连接:").grid(row=row, column=0, sticky="w", pady=4, padx=(0, 8))
    insecure_frame = ttk.Frame(frame)
    insecure_frame.grid(row=row, column=1, sticky="w", pady=4)
    ttk.Checkbutton(insecure_frame, variable=insecure_var).pack(side="left")
    ttk.Label(insecure_frame, text="（跳过证书验证）", foreground="gray").pack(side="left")
    row += 1

    udp_var = tk.BooleanVar(value=config["local"]["udp"])
    ttk.Label(frame, text="启用 UDP:").grid(row=row, column=0, sticky="w", pady=4, padx=(0, 8))
    udp_frame = ttk.Frame(frame)
    udp_frame.grid(row=row, column=1, sticky="w", pady=4)
    ttk.Checkbutton(udp_frame, variable=udp_var).pack(side="left")
    row += 1

    proxy_private_var = tk.BooleanVar(value=config["local"].get("proxy_private", False))
    ttk.Label(frame, text="代理私有地址段:").grid(row=row, column=0, sticky="w", pady=4, padx=(0, 8))
    private_frame = ttk.Frame(frame)
    private_frame.grid(row=row, column=1, sticky="w", pady=4)
    ttk.Checkbutton(private_frame, variable=proxy_private_var).pack(side="left")
    ttk.Label(private_frame, text="（192.168.x / 172.16.x / 10.x）", foreground="gray").pack(side="left")
    row += 1

    ttk.Separator(frame, orient="horizontal").grid(
        row=row, column=0, columnspan=2, sticky="ew", pady=10
    )
    row += 1

    autostart_var = tk.BooleanVar(value=config.get("autostart", False))
    ttk.Label(frame, text="开机启动:").grid(row=row, column=0, sticky="w", pady=4, padx=(0, 8))
    ttk.Checkbutton(frame, variable=autostart_var).grid(
        row=row, column=1, sticky="w", pady=4
    )
    row += 1

    ttk.Button(frame, text="保存", command=save_and_close).grid(
        row=row, column=0, columnspan=2, pady=15
    )

    root.lift()
    root.attributes("-topmost", True)
    if platform.system() != "Darwin":
        root.after(100, lambda: root.focus_force())
    root.mainloop()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python config_window.py <config_path>")
        sys.exit(1)
    show_config_window(sys.argv[1])
