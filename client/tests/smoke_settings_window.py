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
import config_panel as cpmod
from AppKit import NSTextField

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
    # 布局回归：面板宽度统一 + config 两列网格 + routing 文本框宽度
    # ------------------------------------------------------------------

    def layout_checks():
        sizes = {t: ctrl._panels[t].panelSize() for t in tab_order}
        widths = {t: s[0] for t, s in sizes.items()}
        check(
            "三个面板宽度一致（左右留白相同）",
            len(set(widths.values())) == 1,
            f"{widths}",
        )
        check(
            "面板宽度不超过窗口宽",
            max(widths.values()) <= sw.WINDOW_WIDTH,
            f"max={max(widths.values())} window={sw.WINDOW_WIDTH}",
        )

        cp = ctrl._panels[sw.PANEL_TAB_CONFIG]
        pw = sizes[sw.PANEL_TAB_CONFIG][0]
        fields = cp._fields
        spans = {
            k: (f.frame().origin.x, f.frame().origin.x + f.frame().size.width)
            for k, f in fields.items()
        }
        rows = {}
        for k, f in fields.items():
            rows.setdefault(round(f.frame().origin.y), []).append(k)

        # 地址|端口与用户名|密码同栅格：地址与用户名等宽同列，端口与密码等宽同列
        addr_row = next(y for y, ks in rows.items() if "address" in ks)
        check(
            "config 地址与端口同行",
            sorted(rows[addr_row]) == ["address", "port"],
            f"同行={rows[addr_row]}",
        )
        check(
            "config 地址与用户名等宽同列",
            abs(spans["address"][0] - spans["username"][0]) < 0.5
            and abs(
                (spans["address"][1] - spans["address"][0])
                - (spans["username"][1] - spans["username"][0])
            ) < 0.5,
            f"address={spans['address']} username={spans['username']}",
        )
        check(
            "config 端口与密码等宽同列（左对齐）",
            abs(spans["port"][0] - spans["password"][0]) < 0.5
            and abs(
                (spans["port"][1] - spans["port"][0])
                - (spans["password"][1] - spans["password"][0])
            ) < 0.5,
            f"port={spans['port']} password={spans['password']}",
        )

        # 短字段两两并排：地址|端口、用户名|密码（本地 SOCKS/HTTP 端口
        # 已合并为单个输入框，不再成对）
        pairs = {frozenset(ks) for y, ks in rows.items() if len(ks) == 2}
        check(
            "config 短字段两两并排",
            pairs == {
                frozenset(["address", "port"]),
                frozenset(["username", "password"]),
            },
            f"实际={[sorted(p) for p in pairs]}",
        )

        # 标签与输入框垂直对齐：label frame 高 22px、输入框 frame 高 24px，
        # 两者同 y 时 label 文字会比输入框文字高约 2px（实测），
        # 所以标签要低 LABEL_ALIGN_DY。这里量 frame 偏移，文字墨迹对齐
        # 靠实测扫描确定（offset=-2 时差 0.00px）。
        labels = [
            v for v in cp.view().subviews()
            if isinstance(v, NSTextField) and not v.isBezeled() and not v.isEditable()
        ]
        misaligned = []
        for k, fld in fields.items():
            fy = fld.frame().origin.y
            same = [l for l in labels
                    if abs(l.frame().origin.y - (fy - cpmod.LABEL_ALIGN_DY)) < 0.5]
            if not same:
                misaligned.append((k, round(fy, 1)))
        check(
            "config 标签比输入框低 LABEL_ALIGN_DY（视觉对齐）",
            not misaligned,
            f"未对齐={misaligned} LABEL_ALIGN_DY={cpmod.LABEL_ALIGN_DY}",
        )
        # 标签文字不能超出自己的 frame（右对齐标签超宽会被左侧截断）。
        # 「本地SOCKS/HTTP代理端口:」实测 166.2px，LOCAL_PORT_LABEL_W 取 170。
        label_overflow = [
            (l.stringValue(), round(l.attributedStringValue().size().width, 1),
             round(l.frame().size.width, 1))
            for l in labels
            if l.attributedStringValue().size().width > l.frame().size.width
        ]
        check(
            "config 标签文字不截断",
            not label_overflow,
            f"{label_overflow}",
        )
        # 本地端口行的文案与提示（单端口 + 仅监听本机）
        check(
            "config 本地端口行文案",
            any(l.stringValue() == "本地SOCKS/HTTP代理端口:" for l in labels),
            f"实际={[l.stringValue() for l in labels]}",
        )
        check(
            "config 仅监听本机提示",
            cp._local_port_hint_label.stringValue() == "（仅监听本机流量）",
            f"实际={cp._local_port_hint_label.stringValue()!r}",
        )
        # 本地端口行的标签文字起点要与「用户名:」左对齐（右对齐标签：
        # 文字起点 = 列起点 + 列宽 - 文字宽）。比文字墨迹，不比 frame。
        def _text_left(lbl):
            f = lbl.frame()
            tw = lbl.attributedStringValue().size().width
            return f.origin.x + f.size.width - tw

        port_lbl = [l for l in labels if l.stringValue() == "本地SOCKS/HTTP代理端口:"]
        user_lbl = [l for l in labels if l.stringValue() == "用户名:"]
        check(
            "config 本地端口标签与用户名左对齐",
            bool(port_lbl) and bool(user_lbl)
            and abs(_text_left(port_lbl[0]) - _text_left(user_lbl[0])) < 1.0,
            f"port={_text_left(port_lbl[0]):.1f} username={_text_left(user_lbl[0]):.1f}"
            if port_lbl and user_lbl else "label missing",
        )
        # 协议行的 popup 偏移与输入框不同（实测最佳 offset=0）
        pp = cp._protocol_popup.frame()
        proto_lbl = [l for l in labels if l.stringValue() == "协议:"]
        check(
            "config 协议标签与 popup 同 y",
            proto_lbl and abs(proto_lbl[0].frame().origin.y - pp.origin.y) < 0.5,
            f"label_y={proto_lbl[0].frame().origin.y if proto_lbl else None} "
            f"popup_y={pp.origin.y:.1f}",
        )

        # 代理连接开关：与协议 popup 同行，x 与下一行「端口」输入框左缘对齐
        swf = cp._proxy_switch.frame()
        check(
            "config 开关与协议 popup 同行",
            abs(swf.origin.y - pp.origin.y) < 0.5,
            f"switch_y={swf.origin.y:.1f} popup_y={pp.origin.y:.1f}",
        )
        check(
            "config 开关 x 与端口输入框左缘对齐",
            abs(swf.origin.x - spans["port"][0]) < 0.5,
            f"switch_x={swf.origin.x:.1f} port_x={spans['port'][0]:.1f}",
        )
        check(
            "config 开关不与协议 popup 重叠",
            swf.origin.x >= pp.origin.x + pp.size.width,
            f"switch_x={swf.origin.x:.1f} popup_right={pp.origin.x + pp.size.width:.1f}",
        )
        stf = cp._proxy_state_label.frame()
        check(
            "config 状态文案紧跟开关且不超面板",
            stf.origin.x >= swf.origin.x + swf.size.width
            and stf.origin.x + stf.size.width <= pw - 12,
            f"text_x={stf.origin.x:.1f} right={stf.origin.x + stf.size.width:.1f} "
            f"switch_right={swf.origin.x + swf.size.width:.1f} panel_w={pw}",
        )

        # 同一行不得重叠，且右边界留出边距
        overlap = []
        overflow = []
        for y, ks in rows.items():
            ss = sorted((spans[k][0], spans[k][1], k) for k in ks)
            for i in range(len(ss) - 1):
                if ss[i][1] > ss[i + 1][0]:
                    overlap.append((y, ss[i][2], ss[i + 1][2]))
            for k in ks:
                if spans[k][1] > pw - 12:
                    overflow.append((k, round(spans[k][1], 1)))
        check("config 同行控件不重叠", not overlap, f"{overlap}")
        check(
            "config 输入框不超出面板右边距",
            not overflow,
            f"{overflow} panel_w={pw}",
        )

        # 竖向重叠：删控件时很容易连带删掉它占的竖向空间，
        # 让下面的控件压到上一行的提示文字上（实际发生过）。
        # 只比真正有可见内容的控件：复选框 frame 故意做得很宽，
        # 标题只占左侧一小段，所以用「标题实际宽度」而不是 frame 宽。
        vitems = []
        for name in [
            "_tls_cb", "_insecure_cb", "_insecure_hint_label",
            "_cert_bind_cb", "_cert_bind_label", "_udp_cb",
            "_proxy_private_cb", "_autostart_cb", "_save_btn", "_cancel_btn",
        ]:
            v = getattr(cp, name)
            f = v.frame()
            if hasattr(v, "attributedTitle"):
                # 复选框/按钮：box(≈20px) + 标题
                right = f.origin.x + 20 + v.attributedTitle().size().width
            else:
                right = f.origin.x + max(
                    v.attributedStringValue().size().width, 1
                )
            vitems.append(
                (name, f.origin.y, f.origin.y + f.size.height, f.origin.x, right)
            )
        # 「重置」按钮与绑定证书复选框同行，单独按 frame 宽参与比较
        rb = cp._reset_pin_btn.frame()
        vitems.append(
            ("_reset_pin_btn", rb.origin.y, rb.origin.y + rb.size.height,
             rb.origin.x, rb.origin.x + rb.size.width)
        )

        voverlap = []
        for i in range(len(vitems)):
            for j in range(i + 1, len(vitems)):
                a, b = vitems[i], vitems[j]
                # y 区间相交 且 x 区间相交 才算真重叠。
                # 留 2px 容差：label 的 frame 自带行高 leading，
                # 与相邻控件 frame 边缘贴 1px 是正常排版，不是 bug
                # （真正要抓的是几十 px 的压字，曾实测发生过）。
                y_ov = min(a[2], b[2]) - max(a[1], b[1])
                x_ov = min(a[4], b[4]) - max(a[3], b[3])
                if y_ov > 2.0 and x_ov > 2.0:
                    voverlap.append((a[0], b[0], round(y_ov, 1), round(x_ov, 1)))
        check(
            "config 控件竖向不重叠",
            not voverlap,
            f"{voverlap}",
        )

        # 提示文字不能被截断
        truncated = []
        for name in ["_insecure_hint_label", "_cert_bind_label", "_local_port_hint_label"]:
            v = getattr(cp, name)
            need = v.attributedStringValue().size().width
            if need > v.frame().size.width:
                truncated.append((name, round(need, 1), round(v.frame().size.width, 1)))
        check("config 提示文字不截断", not truncated, f"{truncated}")

        # 证书指纹要完整显示（64 位 SHA-256 hex），不能缩略成 [:24]...
        # 会改面板状态，所以先存后还，别污染后面的 saveAll_ 测试
        saved_pin = cp._cert_pin
        saved_mismatch = cp._cert_pin_mismatch
        saved_state = cp._cert_bind_cb.state()
        try:
            import hashlib
            pin = hashlib.sha256(b"smoke-test-certificate-der").hexdigest()
            cp._cert_pin = pin
            cp._cert_pin_mismatch = False
            cp._cert_bind_cb.setState_(1)
            cp._refresh_cert_bind_ui()
            lbl = cp._cert_bind_label
            text = lbl.stringValue()
            need = lbl.attributedStringValue().size().width
            have = lbl.frame().size.width
            check(
                "config 证书指纹完整显示（不缩略）",
                pin in text and "..." not in text,
                f"len={len(text)} 含完整指纹={pin in text}",
            )
            check(
                "config 指纹行不截断",
                need <= have,
                f"need={need:.1f} have={have:.1f}",
            )
            # 指纹行撑满栅格宽，左右留白对称
            lx = lbl.frame().origin.x
            rx = pw - (lbl.frame().origin.x + have)
            check(
                "config 指纹行左右留白对称",
                abs(lx - rx) < 0.5,
                f"left={lx:.0f} right={rx:.0f}",
            )
            # 切回非指纹文案时要恢复 13pt + 原缩进（不能一直用小字）
            cp._cert_bind_cb.setState_(0)
            cp._refresh_cert_bind_ui()
            back = cp._cert_bind_label
            check(
                "config 非指纹文案恢复原字体与缩进",
                back.frame().origin.x == 102.0
                and round(back.font().pointSize()) == 13,
                f"x={back.frame().origin.x} size={back.font().pointSize()}",
            )
        finally:
            cp._cert_pin = saved_pin
            cp._cert_pin_mismatch = saved_mismatch
            cp._cert_bind_cb.setState_(saved_state)
            cp._refresh_cert_bind_ui()

        # 「重置」按钮右缘对齐栅格右缘：所有控件都跨 16..504，
        # 按钮右边距 = 栅格左边距，看上去才对称
        rb = cp._reset_pin_btn.frame()
        check(
            "config 重置按钮右缘对齐栅格右缘（左右留白对称）",
            abs((rb.origin.x + rb.size.width) - (pw - 16)) < 0.5,
            f"btn_right={rb.origin.x + rb.size.width:.0f} grid_right={pw - 16:.0f} "
            f"btn_left={rb.origin.x:.0f}",
        )

        # 「取消」在「保存」左边，等宽并排居中，左右留白对称。
        # 不在这里真点取消：cancelAll_ 会关窗，而 windowWillClose_ 会 stopModal，
        # 直接把冒烟脚本的模态循环提前结束。「不写盘」的行为由
        # test_settings_window.py::test_cancel_all_closes_window_without_writing 覆盖。
        cancel = cp._cancel_btn.frame()
        save = cp._save_btn.frame()
        check(
            "config 取消按钮在保存左边且同行",
            cancel.origin.x + cancel.size.width < save.origin.x
            and abs(cancel.origin.y - save.origin.y) < 0.5,
            f"cancel_x={cancel.origin.x:.0f} save_x={save.origin.x:.0f} "
            f"cancel_y={cancel.origin.y:.0f} save_y={save.origin.y:.0f}",
        )
        check(
            "config 取消/保存等宽等高",
            abs(cancel.size.width - save.size.width) < 0.5
            and abs(cancel.size.height - save.size.height) < 0.5,
            f"cancel={cancel.size.width:.0f}x{cancel.size.height:.0f} "
            f"save={save.size.width:.0f}x{save.size.height:.0f}",
        )
        c_left = cancel.origin.x
        c_right = pw - (save.origin.x + save.size.width)
        check(
            "config 底部按钮组居中（左右留白对称）",
            abs(c_left - c_right) < 1.0,
            f"left={c_left:.0f} right={c_right:.0f}",
        )
        check(
            "config 取消按钮标题与动作",
            cp._cancel_btn.title() == "取消"
            and str(cp._cancel_btn.action()) == "cancelClicked:"
            and cp._cancel_btn.target() is cp,
            f"title={cp._cancel_btn.title()!r} action={cp._cancel_btn.action()}",
        )
        check(
            "宿主窗口有 cancelAll_ 方法",
            hasattr(ctrl, "cancelAll_"),
            "",
        )

        # 分流文本框宽度要接近 Super DNS（NSTabView 自身要吃 20px，不可能完全相等）
        rp = ctrl._panels[sw.PANEL_TAB_ROUTING]
        sp = ctrl._panels[sw.PANEL_TAB_SUPER_DNS]
        rw = rp._direct_text.frame().size.width
        sw_w = sp._domains_text.frame().size.width
        check(
            "分流文本框宽度接近 Super DNS",
            sw_w - rw <= 35,
            f"routing={rw:.0f} super_dns={sw_w:.0f} 差={sw_w - rw:.0f}",
        )
        check(
            "分流文本框比加宽前（385）明显变宽",
            rw > 430,
            f"routing={rw:.0f}",
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

    def anim_report(label, target_tab, rows, active_at_submit):
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
        fin = rows[-1]
        final_ok = (
            abs(fin["panel_bottom"]) < 0.6
            and abs(fin["frame_h"] - expected_frame_h(target_tab)) < 1.0
        )
        # animator() 只在 app active 时才真正插值；inactive 时退化为瞬时改高度
        # （settings_window._select_tab 的兜底）。两种情况落位都必须正确，
        # 但「平滑插值」只在 active 时才是硬要求。
        # active_at_submit 由调用方在提交动画那一刻记下，不能用现在的 isActive()。
        if active_at_submit:
            check(
                f"动画 {label} active 时平滑插值",
                distinct >= 5 and last_change > 0.1,
                f"不同高度值={distinct} 时长≈{last_change * 1000:.0f}ms "
                f"{heights[0]:.0f}→{heights[-1]:.0f}",
            )
        else:
            check(
                f"动画 {label} inactive 时瞬时落位",
                final_ok,
                f"不同高度值={distinct} {heights[0]:.0f}→{heights[-1]:.0f} "
                f"expected={expected_frame_h(target_tab):.0f}",
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
        check(
            f"动画 {label} 结束落位正确",
            final_ok,
            f"panel_bottom={fin['panel_bottom']:.1f} frame_h={fin['frame_h']:.0f} "
            f"expected={expected_frame_h(target_tab):.0f}",
        )

    # ------------------------------------------------------------------
    # 脚本驱动
    # ------------------------------------------------------------------

    script = []
    script += [("layout",)]
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
        "anim_active": False,
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
            anim_report(state["anim_label"], state["anim_target"], state["rows"],
                        state["anim_active"])
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
        elif kind == "layout":
            layout_checks()
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
            # 在提交动画的那一刻记 isActive：_select_tab 就是按这个值决定
            # 走动画还是走瞬时兜底。事后再读会不准 —— 激活状态可能在
            # 采样期间翻转，导致拿 active 的标准去要求一个走了兜底路径的切换。
            state["anim_active"] = bool(NSApp.isActive())
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
