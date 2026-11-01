"""冒烟：真实 PyObjC 构建合并窗口，切三个 Tab，验证标题/可见性/动画几何/合并保存。

不进主仓库测试套件（需要 GUI 会话），手动运行：
    python3 tests/smoke_settings_window.py
"""

import json
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from Foundation import NSRunLoop, NSTimer, NSObject
from AppKit import NSApplication, NSApplicationActivationPolicyAccessory, NSApp

import settings_window as sw

REAL_CONFIG = os.path.expanduser(
    "~/Library/Application Support/BlockProxyClient/config.json"
)

TICK_SEC = 0.008          # 采样间隔：要能看清 0.25s 动画的中间帧
SETTLE_SEC = 0.5          # 切 Tab 后等动画跑完再做静态检查
SAMPLE_SEC = 0.8          # 动画采样窗口

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

    tab_order = [
        sw.PANEL_TAB_CONFIG,
        sw.PANEL_TAB_ROUTING,
        sw.PANEL_TAB_SUPER_DNS,
    ]

    def tab_screen_positions():
        """Tab 按钮的屏幕坐标（视觉位置）。内容区原点在左下，窗口改高时
        frame.origin.y 必然变，所以要比视觉位置而不是比 frame。"""
        pos = {}
        for tab, btn in ctrl._tab_buttons.items():
            base = btn.convertPoint_toView_((0, 0), None)
            screen = win.convertBaseToScreen_(base)
            pos[tab] = (round(screen.x, 1), round(screen.y, 1))
        return pos

    def expected_frame_h(tab):
        content_h = sw.TAB_BAR_HEIGHT + ctrl._panels[tab].panelSize()[1]
        return sw.NSWindow.frameRectForContentRect_styleMask_(
            ((0, 0), (sw.WINDOW_WIDTH, content_h)), sw.WINDOW_STYLE
        ).size.height

    # ------------------------------------------------------------------
    # 静态检查：动画跑完后每个 Tab 的最终几何
    # ------------------------------------------------------------------

    def static_checks(tab):
        spec = next(x for x in sw.TAB_SPECS if x["tab"] == tab)
        h = win.frame().size.height
        exp = expected_frame_h(tab)
        check(
            f"tab={tab} 窗口高度随面板自适应",
            abs(h - exp) < 1,
            f"h={h:.0f} expected={exp:.0f}",
        )
        # Tab 栏固定在内容区顶部：按钮顶边距内容区顶边恒为 TAB_BAR_INSET_Y
        btn = ctrl._tab_buttons[tab]
        bf = btn.frame()
        cv_h = win.contentView().frame().size.height
        gap = cv_h - (bf.origin.y + bf.size.height)
        check(
            f"tab={tab} Tab 栏位置固定",
            abs(gap - sw.TAB_BAR_INSET_Y) < 0.6,
            f"btn_top={bf.origin.y + bf.size.height:.0f} content_top={cv_h:.0f} gap={gap:.1f}",
        )
        # 面板顶边紧贴 Tab 栏下沿，底边落在内容区底部（动画结束后必须归位）
        pf = ctrl._panels[tab].view().frame()
        check(
            f"tab={tab} 面板动画后归位",
            abs(pf.origin.y) < 0.6
            and abs((pf.origin.y + pf.size.height) - (cv_h - sw.TAB_BAR_HEIGHT)) < 0.6,
            f"panel_bottom={pf.origin.y:.1f} panel_top={pf.origin.y + pf.size.height:.1f} "
            f"expected_top={cv_h - sw.TAB_BAR_HEIGHT:.1f}",
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

    # ------------------------------------------------------------------
    # 动画采样：切换过程中逐帧量几何
    # ------------------------------------------------------------------

    def sample(target_tab):
        f = win.frame()
        cv_h = win.contentView().frame().size.height
        bf = ctrl._tab_buttons[sw.PANEL_TAB_CONFIG].frame()
        pf = ctrl._panels[target_tab].view().frame()
        return {
            "t": time.time(),
            "frame_h": f.size.height,
            "top": f.origin.y + f.size.height,
            "content_h": cv_h,
            "btn_dist_top": cv_h - (bf.origin.y + bf.size.height),
            "tabbar_bottom": bf.origin.y,
            "panel_top": pf.origin.y + pf.size.height,
            "panel_bottom": pf.origin.y,
        }

    def anim_report(label, target_tab, rows):
        if len(rows) < 5:
            check(f"动画 {label}", False, f"只采到 {len(rows)} 帧，无法判定")
            return
        heights = [r["frame_h"] for r in rows]
        distinct = len({round(h) for h in heights})
        # 动画时长 = 高度最后一次变化相对首帧的时刻
        last_change = 0.0
        for i in range(1, len(rows)):
            if abs(heights[i] - heights[i - 1]) > 0.05:
                last_change = rows[i]["t"] - rows[0]["t"]
        check(
            f"动画 {label} 确实在插值（不是瞬变）",
            distinct >= 5 and last_change > 0.1,
            f"不同高度值={distinct} 时长≈{last_change * 1000:.0f}ms "
            f"{heights[0]:.0f}→{heights[-1]:.0f}",
        )
        tops = [r["top"] for r in rows]
        check(
            f"动画 {label} 顶边不动",
            max(tops) - min(tops) < 1.0,
            f"漂移={max(tops) - min(tops):.1f}px",
        )
        # 关键：面板顶边全程紧贴 Tab 栏下沿，既不顶进 Tab 栏也不裂开缝
        gaps = [r["tabbar_bottom"] - r["panel_top"] for r in rows]
        check(
            f"动画 {label} 面板始终贴在 Tab 栏下方",
            min(gaps) > sw.TAB_BAR_INSET_Y - 1.0 and max(gaps) < sw.TAB_BAR_INSET_Y + 1.0,
            f"间距 min={min(gaps):.1f} max={max(gaps):.1f} "
            f"expected={sw.TAB_BAR_INSET_Y:.1f}",
        )
        btns = {round(r["btn_dist_top"], 1) for r in rows}
        check(
            f"动画 {label} Tab 栏跟着顶边走",
            len(btns) == 1 and abs(next(iter(btns)) - sw.TAB_BAR_INSET_Y) < 0.6,
            f"按钮距内容区顶边={sorted(btns)}",
        )
        fin = rows[-1]
        check(
            f"动画 {label} 结束落位正确",
            abs(fin["panel_bottom"]) < 0.6
            and abs(fin["frame_h"] - expected_frame_h(target_tab)) < 1.0,
            f"panel_bottom={fin['panel_bottom']:.1f} frame_h={fin['frame_h']:.0f} "
            f"expected={expected_frame_h(target_tab):.0f}",
        )

    # ------------------------------------------------------------------
    # 脚本驱动
    # ------------------------------------------------------------------

    script = []
    for tab in tab_order:
        script += [("select", tab), ("wait", SETTLE_SEC), ("static", tab)]
    # 静态检查跑完停在 super_dns，从这里接着量动画；收缩与伸展两个方向都要验
    # （顶进 Tab 栏只发生在伸展，裂开缝隙只发生在收缩）。
    # 最后停在 super_dns，让后面的 IPC 跳转（→routing）真的发生一次切换。
    script += [
        ("anim", sw.PANEL_TAB_SUPER_DNS, sw.PANEL_TAB_CONFIG),
        ("anim", sw.PANEL_TAB_CONFIG, sw.PANEL_TAB_ROUTING),
        ("anim", sw.PANEL_TAB_ROUTING, sw.PANEL_TAB_CONFIG),
        ("anim", sw.PANEL_TAB_CONFIG, sw.PANEL_TAB_SUPER_DNS),
        ("save",),
    ]

    state = {
        "idx": 0,
        "tab_pos": None,
        "busy_until": 0.0,
        "sampling": False,
        "rows": [],
        "anim_label": "",
        "anim_target": None,
        "done": False,
    }

    def finish_save(timer):
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

    def drive(timer):
        if state["done"]:
            return
        now = time.time()

        if state["sampling"]:
            if now < state["busy_until"]:
                state["rows"].append(sample(state["anim_target"]))
                return
            anim_report(state["anim_label"], state["anim_target"], state["rows"])
            state["sampling"] = False
            state["rows"] = []
            state["busy_until"] = now + SETTLE_SEC   # 等落位再进下一步
            return

        if now < state["busy_until"]:
            return

        if state["idx"] >= len(script):
            state["done"] = True
            timer.invalidate()
            NSApp.stopModal()
            return

        item = script[state["idx"]]
        state["idx"] += 1
        kind = item[0]

        if kind == "select":
            ctrl._select_tab(item[1])
        elif kind == "wait":
            state["busy_until"] = now + item[1]
        elif kind == "static":
            static_checks(item[1])
        elif kind == "anim":
            _from, target = item[1], item[2]
            state["anim_label"] = f"{_from}→{target}"
            state["anim_target"] = target
            state["rows"] = []
            state["sampling"] = True
            state["busy_until"] = now + SAMPLE_SEC
            ctrl._select_tab(target)
            state["rows"].append(sample(target))
        elif kind == "save":
            finish_save(timer)
            state["done"] = True

    class Driver(NSObject):
        def tick_(self, t):
            drive(t)

    driver = Driver.alloc().init()
    t = NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
        TICK_SEC, driver, "tick:", None, True
    )
    NSRunLoop.currentRunLoop().addTimer_forMode_(t, "kCFRunLoopCommonModes")

    NSApp.runModalForWindow_(win)

    shutil.rmtree(tmpdir, ignore_errors=True)

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
