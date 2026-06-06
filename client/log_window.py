import os
import sys
import tkinter as tk
from tkinter import ttk

LOG_DIR = os.path.expanduser("~/Library/Application Support/SocksClient/logs")
LINES_TO_SHOW = 100


def read_last_lines(filepath, n):
    if not os.path.exists(filepath):
        return []
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        return lines[-n:][::-1]
    except Exception:
        return []


class LogWindow:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("SocksClient 日志")
        self.root.geometry("750x500")
        self.root.minsize(600, 400)

        btn_frame = tk.Frame(self.root)
        btn_frame.pack(fill=tk.X, padx=10, pady=(10, 5))

        self.access_btn = tk.Button(
            btn_frame, text="Access", command=self.show_access, width=10
        )
        self.access_btn.pack(side=tk.LEFT, padx=(0, 5))

        self.crash_btn = tk.Button(
            btn_frame, text="Crash", command=self.show_crash, width=10
        )
        self.crash_btn.pack(side=tk.LEFT, padx=(0, 5))

        refresh_btn = tk.Button(
            btn_frame, text="刷新", command=self.refresh, width=8
        )
        refresh_btn.pack(side=tk.LEFT, padx=(0, 5))

        close_btn = tk.Button(
            btn_frame, text="关闭", command=self.root.destroy, width=8
        )
        close_btn.pack(side=tk.RIGHT)

        text_frame = tk.Frame(self.root)
        text_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=(0, 10))

        scrollbar = tk.Scrollbar(text_frame)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        self.text = tk.Text(
            text_frame,
            wrap=tk.NONE,
            yscrollcommand=scrollbar.set,
            font=("Menlo", 11),
            state=tk.DISABLED,
        )
        self.text.pack(fill=tk.BOTH, expand=True)
        scrollbar.config(command=self.text.yview)

        h_scrollbar = tk.Scrollbar(text_frame, orient=tk.HORIZONTAL, command=self.text.xview)
        h_scrollbar.pack(side=tk.BOTTOM, fill=tk.X)
        self.text.config(xscrollcommand=h_scrollbar.set)

        self.text.tag_configure("crash", foreground="red")

        self.current_tab = "access"
        self.show_access()
        self._bring_to_front()

    def _bring_to_front(self):
        self.root.lift()
        self.root.attributes("-topmost", True)
        self.root.after(100, lambda: self.root.attributes("-topmost", False))

    def show_access(self):
        self.current_tab = "access"
        self.access_btn.config(relief=tk.SUNKEN)
        self.crash_btn.config(relief=tk.RAISED)
        lines = read_last_lines(os.path.join(LOG_DIR, "access.log"), LINES_TO_SHOW)
        self._display(lines)

    def show_crash(self):
        self.current_tab = "crash"
        self.crash_btn.config(relief=tk.SUNKEN)
        self.access_btn.config(relief=tk.RAISED)
        lines = read_last_lines(os.path.join(LOG_DIR, "crash.log"), LINES_TO_SHOW)
        self._display(lines, tag="crash")

    def refresh(self):
        if self.current_tab == "access":
            self.show_access()
        else:
            self.show_crash()

    def _display(self, lines, tag=None):
        self.text.config(state=tk.NORMAL)
        self.text.delete("1.0", tk.END)
        if not lines:
            self.text.insert(tk.END, "(暂无日志)")
        else:
            for line in lines:
                if tag:
                    self.text.insert(tk.END, line, tag)
                else:
                    self.text.insert(tk.END, line)
        self.text.config(state=tk.DISABLED)

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    LogWindow().run()
