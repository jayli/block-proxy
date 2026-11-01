"""冒烟：真实 PyObjC 构建合并窗口，切三个 Tab，验证标题/可见性/合并保存。

不进主仓库测试套件（需要 GUI 会话），手动运行：
    python3 tests/smoke_settings_window.py
"""

import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from Foundation import NSRunLoop, NSTimer
from AppKit import NSApplication, NSApplicationActivationPolicyAccessory, NSApp

import settings_window as sw

REAL_CONFIG = os.path.expanduser(
    "~/Library/Application Support/BlockProxyClient/config.json"
)

results = []


def check(label, ok, detail=""):
    results.append((label, ok, detail))
    print(("PASS " if ok else "FAIL ") + label + (f"  {detail}" if detail else ""))


def main():
    tmpdir = tempfile.mkdtemp(prefix="bp-smoke-")
    config_path = os.path.join(tmpdir, "config.json")
    if os.path.exists(REAL_CONFIG):
        shutil.copy(REAL_CONFIG, config_path)
    else:
        with open(config_path, "w") as f:
            json.dump({"server": {"address": "example.com", "port": 8002}}, f)
    print(f"config: {config_path}")

    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
    sw._setup_minimal_menu()

    ctrl = sw.SettingsWindowController.alloc().initWithConfigPath_tab_appPath_(
        config_path, sw.PANEL_TAB_CONFIG, None
    )
    if ctrl is None:
        print("FAIL controller is None")
        return 1

    ctrl.show()
    win = ctrl._window

    def tab_screen_positions():
        """Tab 按钮的屏幕坐标（视觉位置）。内容区原点在左下，窗口改高时
        frame.origin.y 必然变，所以要比视觉位置而不是比 frame。"""
        pos = {}
        for tab, btn in ctrl._tab_buttons.items():
            base = btn.convertPoint_toView_((0, 0), None)
            screen = win.convertBaseToScreen_(base)
            pos[tab] = (round(screen.x, 1), round(screen.y, 1))
        return pos

    state = {"step": 0, "heights": {}, "tab_pos": None}

    def step(timer):
        tab_order = [
            sw.PANEL_TAB_CONFIG,
            sw.PANEL_TAB_ROUTING,
            sw.PANEL_TAB_SUPER_DNS,
        ]
        s = state["step"]
        state["step"] += 1

        if s < len(tab_order):
            tab = tab_order[s]
            ctrl._select_tab(tab)
            spec = next(x for x in sw.TAB_SPECS if x["tab"] == tab)
            h = win.frame().size.height
            state["heights"][tab] = h
            # 窗口 frame 高 = 内容区高（Tab 栏 + 面板）+ 标题栏
            content_h = sw.TAB_BAR_HEIGHT + ctrl._panels[tab].panelSize()[1]
            expected_h = sw.NSWindow.frameRectForContentRect_styleMask_(
                ((0, 0), (sw.WINDOW_WIDTH, content_h)), sw.WINDOW_STYLE
            ).size.height
            check(
                f"tab={tab} 窗口高度随面板自适应",
                abs(h - expected_h) < 1,
                f"h={h:.0f} expected={expected_h:.0f}",
            )
            # Tab 栏固定在内容区顶部：按钮顶边距内容区顶边恒为 6px
            btn = ctrl._tab_buttons[tab]
            bf = btn.frame()
            cv_h = win.contentView().frame().size.height
            gap = cv_h - (bf.origin.y + bf.size.height)
            check(
                f"tab={tab} Tab 栏位置固定",
                abs(gap - sw.TAB_BAR_INSET_Y) < 0.6,
                f"btn_top={bf.origin.y + bf.size.height:.0f} content_top={cv_h:.0f} gap={gap:.1f}",
            )
            check(
                f"tab={tab} 窗口标题",
                win.title() == spec["window_title"],
                f"title={win.title()!r}",
            )
            hidden = {t: p.view().isHidden() for t, p in ctrl._panels.items()}
            check(
                f"tab={tab} 只显示当前面板",
                hidden == {t: (t != tab) for t in tab_order},
                f"hidden={hidden}",
            )
            btn = ctrl._tab_buttons[tab]
            check(
                f"tab={tab} Tab 按钮有图标+文字",
                btn.image() is not None and btn.title() == spec["title"],
                f"title={btn.title()!r} image={'yes' if btn.image() else 'NO'}",
            )
            # 比对 AppKit 真常量，别拿 sw.NSImageAbove 跟自己比（那样是恒真）
            from AppKit import NSImageAbove as REAL_ABOVE
            check(
                f"tab={tab} Tab 按钮图标在上",
                btn.imagePosition() == REAL_ABOVE,
                f"imagePosition={btn.imagePosition()} expected={REAL_ABOVE}",
            )
            # 切 Tab 只换高亮，Tab 栏视觉位置不能动
            pos = tab_screen_positions()
            if state["tab_pos"] is None:
                state["tab_pos"] = pos
            check(
                f"tab={tab} Tab 栏视觉位置不变",
                pos == state["tab_pos"],
                f"{pos}",
            )
            return

        # 最后一步：菜单跳转 IPC + 合并保存
        sw.request_panel_tab(config_path, sw.PANEL_TAB_ROUTING)
        ctrl._pollPanelRequest_(None)
        check(
            "IPC 跳转请求切到 routing Tab",
            ctrl._current_tab == sw.PANEL_TAB_ROUTING,
            f"current={ctrl._current_tab}",
        )

        before = json.loads(open(config_path).read())
        ctrl._config_panel._fields["address"].setStringValue_("smoke.example.com")
        ctrl._routing_panel._enabled_cb.setState_(1)
        ctrl.saveAll_(None)

        after = json.loads(open(config_path).read())
        check(
            "saveAll_ 写入节点配置",
            after["server"]["address"] == "smoke.example.com",
            f"address={after['server']['address']!r}",
        )
        check(
            "saveAll_ 同时写入分流规则",
            after["routing"]["enabled"] is True,
            f"routing={after['routing']}",
        )
        untouched = [k for k in before if k not in ("server", "routing", "autostart")]
        check(
            "saveAll_ 保留其它配置键",
            all(k in after for k in untouched),
            f"keys={sorted(after)}",
        )
        check("saveAll_ 关闭窗口", ctrl._window.isVisible() is False)

        timer.invalidate()
        NSApp.stopModal()

    from Foundation import NSObject

    class Stepper(NSObject):
        def tick_(self, t):
            step(t)

    stepper = Stepper.alloc().init()
    t = NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
        0.15, stepper, "tick:", None, True
    )
    NSRunLoop.currentRunLoop().addTimer_forMode_(t, "kCFRunLoopCommonModes")

    NSApp.runModalForWindow_(win)

    shutil.rmtree(tmpdir, ignore_errors=True)

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
