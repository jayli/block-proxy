import json
import sys
import tkinter as tk
from tkinter import ttk


def show_config_window(config_path):
    with open(config_path, "r") as f:
        config = json.load(f)

    def save_and_close():
        config["server"]["address"] = entries["address"].get()
        config["server"]["port"] = int(entries["port"].get())
        config["server"]["username"] = entries["username"].get()
        config["server"]["password"] = entries["password"].get()
        config["server"]["tls"] = tls_var.get()
        config["server"]["allowInsecure"] = insecure_var.get() == "true"
        config["local"]["socks_port"] = int(entries["socks_port"].get())
        config["local"]["http_port"] = int(entries["http_port"].get())
        config["local"]["udp"] = udp_var.get()

        with open(config_path, "w") as f:
            json.dump(config, f, indent=2)
        root.destroy()

    root = tk.Tk()
    root.title("Socks over tls 节点配置")
    root.resizable(False, False)
    w, h = 400, 380
    x = (root.winfo_screenwidth() - w) // 2
    y = (root.winfo_screenheight() - h) // 2
    root.geometry(f"{w}x{h}+{x}+{y}")

    frame = ttk.Frame(root, padding=20)
    frame.pack(fill="both", expand=True)
    frame.grid_columnconfigure(1, weight=1)

    entries = {}
    fields = [
        ("address", "地址:", config["server"]["address"]),
        ("port", "端口:", str(config["server"]["port"])),
        ("username", "用户名:", config["server"]["username"]),
        ("password", "密码:", config["server"]["password"]),
        ("socks_port", "本地SOCKS端口:", str(config["local"]["socks_port"])),
        ("http_port", "本地HTTP端口:", str(config["local"]["http_port"])),
    ]

    for i, (key, label, default) in enumerate(fields):
        ttk.Label(frame, text=label).grid(row=i, column=0, sticky="w", pady=4, padx=(0, 8))
        entry = ttk.Entry(frame)
        entry.insert(0, default)
        entry.grid(row=i, column=1, sticky="ew", pady=4)
        entries[key] = entry

    row = len(fields)

    tls_var = tk.BooleanVar(value=config["server"]["tls"])
    ttk.Label(frame, text="启用 TLS:").grid(row=row, column=0, sticky="w", pady=4, padx=(0, 8))
    ttk.Checkbutton(frame, variable=tls_var).grid(
        row=row, column=1, sticky="w", pady=4
    )
    row += 1

    ttk.Label(frame, text="allowInsecure:").grid(row=row, column=0, sticky="w", pady=4)
    insecure_var = tk.StringVar(
        value="true" if config["server"]["allowInsecure"] else "false"
    )
    insecure_combo = ttk.Combobox(
        frame, textvariable=insecure_var, values=["true", "false"], state="readonly", width=10
    )
    insecure_combo.grid(row=row, column=1, sticky="w", pady=4)
    row += 1

    udp_var = tk.BooleanVar(value=config["local"]["udp"])
    ttk.Label(frame, text="启用 UDP:").grid(row=row, column=0, sticky="w", pady=4, padx=(0, 8))
    ttk.Checkbutton(frame, variable=udp_var).grid(
        row=row, column=1, sticky="w", pady=4
    )
    row += 1

    ttk.Button(frame, text="保存", command=save_and_close).grid(
        row=row, column=0, columnspan=2, pady=15
    )

    root.lift()
    root.attributes("-topmost", True)
    root.mainloop()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python config_window.py <config_path>")
        sys.exit(1)
    show_config_window(sys.argv[1])
