import json
import os
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


def _parse_rules_text(text):
    """Parse a multi-line text into a list of rule lines (preserving comments for storage)."""
    lines = []
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped:  # keep non-empty lines including comments
            lines.append(stripped)
    return lines


def _rules_to_text(rules):
    """Convert a list of rule strings to multi-line text."""
    return "\n".join(rules)


def show_routing_window(config_path):
    with open(config_path, "r") as f:
        config = json.load(f)

    routing = config.get("routing", {
        "enabled": False,
        "direct_rules": [],
        "proxy_rules": [],
        "default": "proxy",
    })

    def save_and_close():
        config["routing"] = {
            "enabled": enabled_var.get(),
            "direct_rules": _parse_rules_text(direct_text.get("1.0", tk.END)),
            "proxy_rules": _parse_rules_text(proxy_text.get("1.0", tk.END)),
            "default": default_var.get(),
        }
        with open(config_path, "w") as f:
            json.dump(config, f, indent=2)
        root.destroy()

    pos = _center_on_mouse_screen(400, 450)

    root = tk.Tk()
    root.title("分流规则")
    root.resizable(False, False)
    w, h = 400, 450
    if pos:
        x, y = pos
    else:
        x = (root.winfo_screenwidth() - w) // 2
        y = (root.winfo_screenheight() - h) // 2
    root.geometry(f"{w}x{h}+{x}+{y}")

    if platform.system() == "Darwin":
        root.after(50, _macos_setup)

    frame = ttk.Frame(root, padding=15)
    frame.pack(fill="both", expand=True)

    # Tab notebook
    notebook = ttk.Notebook(frame)
    notebook.pack(fill="both", expand=True, pady=(0, 10))

    # Direct rules tab
    direct_frame = ttk.Frame(notebook, padding=5)
    notebook.add(direct_frame, text="直连规则")

    direct_text = tk.Text(direct_frame, width=42, height=14, font=("Menlo", 12))
    direct_text.pack(fill="both", expand=True)
    direct_text.insert("1.0", _rules_to_text(routing.get("direct_rules", [])))

    # Proxy rules tab
    proxy_frame = ttk.Frame(notebook, padding=5)
    notebook.add(proxy_frame, text="代理规则")

    proxy_text = tk.Text(proxy_frame, width=42, height=14, font=("Menlo", 12))
    proxy_text.pack(fill="both", expand=True)
    proxy_text.insert("1.0", _rules_to_text(routing.get("proxy_rules", [])))

    # Default action
    default_frame = ttk.Frame(frame)
    default_frame.pack(fill="x", pady=(0, 8))
    ttk.Label(default_frame, text="默认规则:").pack(side="left", padx=(0, 5))
    default_var = tk.StringVar(value=routing.get("default", "proxy"))
    default_combo = ttk.Combobox(
        default_frame, textvariable=default_var,
        values=["proxy", "direct"], state="readonly", width=8,
    )
    default_combo.pack(side="left")

    # Enabled checkbox
    enabled_var = tk.BooleanVar(value=routing.get("enabled", False))
    ttk.Checkbutton(frame, text="启用分流规则", variable=enabled_var).pack(
        anchor="w", pady=(0, 10)
    )

    # Hint
    hint_frame = ttk.Frame(frame)
    hint_frame.pack(fill="x", pady=(0, 5))
    ttk.Label(
        hint_frame,
        text="每行一条规则，如 domain:example.com  geosite:cn  geoip:!cn\n"
             "# 开头为注释，domain 匹配域名及子域名，geoip 仅对 IP 生效",
        foreground="gray",
        justify="left",
    ).pack(anchor="w")

    # Save button
    ttk.Button(frame, text="保存", command=save_and_close).pack(pady=(5, 0))

    root.lift()
    root.attributes("-topmost", True)
    if platform.system() != "Darwin":
        root.after(100, lambda: root.focus_force())
    root.mainloop()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python routing_window.py <config_path>")
        sys.exit(1)
    show_routing_window(sys.argv[1])
