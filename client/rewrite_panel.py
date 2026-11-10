"""
BlockProxyClient 重定向（透明反向代理）面板。
Pure PyObjC implementation (no tkinter dependency).

面板本身不建窗口、不写盘：控件建进自己的容器 NSView，
保存时由宿主窗口（settings_window.py）调用 apply_to() 改 config dict。

顶部的开关滑块只控制 rewrite.enabled，与主代理的连接开关完全解耦：
代理没有连接时也能独立启用，由 app 层按配置单独启停 RewriteProxy。
"""

import objc

from Foundation import NSObject
from AppKit import (
    NSView,
    NSTextField,
    NSButton,
    NSSwitch,
    NSFont,
    NSColor,
    NSAlert,
    NSOnState,
    NSOffState,
)


BEZEL_SQUARE = 1  # NSTextFieldSquareBezel
BEZEL_ROUNDED = 1  # NSRoundedBezelStyle
TEXT_RIGHT = 2  # NSRightTextAlignment

# 面板内容尺寸：宽度与其它面板一致（520），四个 Tab 在 560 宽的合并窗口里
# 左右留白相同。高度按「开关行 + 两个输入框 + 6 行说明 + 底部按钮」紧凑排布，
# 底部只留必要间距（按钮 y=16，说明末行到按钮顶约 43px）。
PANEL_WIDTH = 520
PANEL_HEIGHT = 330

MARGIN_X = 16
LABEL_W = 100          # 「本地监听端口:」右对齐标签列宽
LABEL_GAP = 6
FIELD_X = MARGIN_X + LABEL_W + LABEL_GAP
UI_FONT_SIZE = 13
HINT_FONT_SIZE = 11
HINT_LINE_H = 17

# 底部「取消 / 保存」两个按钮：等宽、并排居中，取消在左、保存在右（macOS 惯例）
FOOTER_BTN_W = 100
FOOTER_BTN_H = 28
FOOTER_BTN_GAP = 12

# 开关滑块（与节点配置的代理连接开关同款 NSSwitch，实测 fittingSize 42x25）
SWITCH_W = 42
SWITCH_H = 24

# 端口输入框右侧的红色错误提示：起点在端口框右缘外侧，宽度算到面板右留白
PORT_STATUS_X = FIELD_X + 90 + 8
PORT_STATUS_W = PANEL_WIDTH - MARGIN_X - PORT_STATUS_X

# 输入框下方的使用说明（每行一行，HINT_FONT_SIZE 字号）
HINT_LINES = (
    "访问 http://127.0.0.1:监听端口/任意路径 会被透明转发到目标地址的",
    "同一路径，调用方察觉不到目标的存在（类似 nginx 的 proxy_pass）。",
    "目标由本机直连、不经过代理节点，也不校验目标的 TLS 证书。",
    "主要用于 Claude Code 桌面版接入三方 API：把本地地址",
    "http://127.0.0.1:监听端口 填为 baseURL 即可。",
    "本开关与主代理完全独立，代理未连接时也可单独启用；保存后生效。",
)


class RewritePanel(NSObject):
    """重定向面板：把控件建进自己的容器 view。"""

    def initWithConfig_(self, config):
        self = objc.super(RewritePanel, self).init()
        if self is None:
            return None
        self._rewrite = (config or {}).get("rewrite", {})
        self._save_target = None
        self._build_view()
        return self

    def setSaveTarget_(self, target):
        """宿主窗口注册自己，「保存 / 取消」按钮转发给它。"""
        self._save_target = target

    def panelSize(self):
        return (PANEL_WIDTH, PANEL_HEIGHT)

    def view(self):
        return self._container

    def _build_view(self):
        rewrite = self._rewrite
        w, h = PANEL_WIDTH, PANEL_HEIGHT
        content = NSView.alloc().initWithFrame_(((0, 0), (w, h)))
        self._container = content
        ui_font = NSFont.systemFontOfSize_(UI_FONT_SIZE)

        # ---- 开关行：滑块 + 「启用重定向」 ----
        # 滑块左缘对齐下方「本地监听端口」输入框的左缘（FIELD_X），
        # 而不是贴着面板左边距。
        y = h - 40
        switch = NSSwitch.alloc().initWithFrame_(
            ((FIELD_X, y), (SWITCH_W, SWITCH_H))
        )
        switch.setState_(NSOnState if rewrite.get("enabled", False) else NSOffState)
        switch.setTarget_(self)
        switch.setAction_("onEnabledSwitchChanged:")
        content.addSubview_(switch)
        self._enabled_switch = switch

        switch_label = NSTextField.labelWithString_("启用重定向")
        switch_label.setFrame_(
            ((FIELD_X + SWITCH_W + 8, y), (200, 22))
        )
        switch_label.setFont_(ui_font)
        content.addSubview_(switch_label)

        # ---- 本地监听端口 ----
        y -= 42
        port_label = NSTextField.labelWithString_("本地监听端口:")
        port_label.setFrame_(((MARGIN_X, y - 2), (LABEL_W, 22)))
        port_label.setAlignment_(TEXT_RIGHT)
        content.addSubview_(port_label)

        port_field = NSTextField.alloc().initWithFrame_(
            ((FIELD_X, y), (90, 24))
        )
        port_field.setBezeled_(True)
        port_field.setBezelStyle_(BEZEL_SQUARE)
        port_field.setStringValue_(str(rewrite.get("listen_port", 996)))
        port_field.setDelegate_(self)
        content.addSubview_(port_field)
        self._port_field = port_field

        # 端口输入框右侧的红色错误提示：端口绑不上（如 < 1024 的保留端口）
        # 时显示「启动失败…」文案，正常为空不占视觉空间
        port_status = NSTextField.labelWithString_("")
        port_status.setFrame_(
            ((PORT_STATUS_X, y + 2), (PORT_STATUS_W, 20))
        )
        port_status.setFont_(NSFont.systemFontOfSize_(HINT_FONT_SIZE))
        port_status.setTextColor_(NSColor.systemRedColor())
        content.addSubview_(port_status)
        self._port_status_label = port_status

        # ---- 目标地址 ----
        y -= 36
        target_label = NSTextField.labelWithString_("目标地址:")
        target_label.setFrame_(((MARGIN_X, y - 2), (LABEL_W, 22)))
        target_label.setAlignment_(TEXT_RIGHT)
        content.addSubview_(target_label)

        target_field = NSTextField.alloc().initWithFrame_(
            ((FIELD_X, y), (w - FIELD_X - MARGIN_X, 24))
        )
        target_field.setBezeled_(True)
        target_field.setBezelStyle_(BEZEL_SQUARE)
        target_field.setStringValue_(str(rewrite.get("target", "")))
        target_field.setDelegate_(self)
        content.addSubview_(target_field)
        self._target_field = target_field

        # ---- 使用说明 ----
        hint_y = y - 40
        hint_font = NSFont.systemFontOfSize_(HINT_FONT_SIZE)
        for line in HINT_LINES:
            hint = NSTextField.labelWithString_(line)
            hint.setFrame_(((MARGIN_X, hint_y), (w - 2 * MARGIN_X, HINT_LINE_H)))
            hint.setFont_(hint_font)
            hint.setTextColor_(NSColor.secondaryLabelColor())
            content.addSubview_(hint)
            hint_y -= HINT_LINE_H

        # ---- 取消 / 保存：并排居中，取消在左、保存在右 ----
        btns_w = FOOTER_BTN_W * 2 + FOOTER_BTN_GAP
        btns_x = (w - btns_w) // 2
        btn_y = 16

        cancel_btn = NSButton.alloc().initWithFrame_(
            ((btns_x, btn_y), (FOOTER_BTN_W, FOOTER_BTN_H))
        )
        cancel_btn.setTitle_("取消")
        cancel_btn.setBezelStyle_(BEZEL_ROUNDED)
        cancel_btn.setTarget_(self)
        cancel_btn.setAction_("cancelClicked:")
        content.addSubview_(cancel_btn)

        save_btn = NSButton.alloc().initWithFrame_(
            ((btns_x + FOOTER_BTN_W + FOOTER_BTN_GAP, btn_y),
             (FOOTER_BTN_W, FOOTER_BTN_H))
        )
        save_btn.setTitle_("保存")
        save_btn.setBezelStyle_(BEZEL_ROUNDED)
        save_btn.setTarget_(self)
        save_btn.setAction_("saveClicked:")
        content.addSubview_(save_btn)

    # ------------------------------------------------------------------
    # Validation（失焦标红 + 保存前兜底，与节点配置面板同款）
    # ------------------------------------------------------------------

    def commit_active_editing(self):
        """把正在编辑的文本框内容提交到控件（否则读 stringValue 会拿到旧值）。"""
        win = self._container.window() if self._container else None
        if win is not None:
            win.makeFirstResponder_(None)

    def _validate_port_field(self):
        from config import validate_port

        error = validate_port(self._port_field.stringValue(), name="本地监听端口")
        self._mark_field(self._port_field, error)
        return error

    def _validate_target_field(self):
        from config import validate_rewrite_target

        error = validate_rewrite_target(self._target_field.stringValue())
        self._mark_field(self._target_field, error)
        return error

    def _mark_field(self, field, error):
        field.setTextColor_(
            NSColor.systemRedColor() if error else NSColor.textColor()
        )
        field.setToolTip_(error or None)

    # ------------------------------------------------------------------
    # 端口可绑定性探测（打开开关 / 端口失焦时试绑一次）
    # ------------------------------------------------------------------

    def onEnabledSwitchChanged_(self, sender):
        """打开开关时立即探测端口能否绑定；关闭时清空提示。"""
        if self._enabled_switch.state() == NSOnState:
            self._check_port_bindability()
        else:
            self._set_port_status(None)

    def _saved_listener_may_hold_port(self, port):
        """主进程的 rewrite listener 可能正占着这个端口：已保存配置处于
        enabled 且端口没改。这是正常运行状态，探测时要把「已占用」当可用。"""
        rewrite = getattr(self, "_rewrite", None) or {}
        try:
            return (
                bool(rewrite.get("enabled"))
                and int(rewrite.get("listen_port")) == int(port)
            )
        except (TypeError, ValueError):
            return False

    def _check_port_bindability(self):
        """试绑 127.0.0.1:<端口>，把结果显示在端口输入框右侧。

        真正的 bind 发生在主进程的 RewriteProxy，但能否绑定只取决于端口号 +
        运行身份，面板子进程与主进程同用户，这里探测到的结论与主进程一致
        （如 < 1024 的保留端口非 root 必然被拒），不必等保存后翻日志。
        """
        from config import probe_rewrite_listen_port

        port_text = str(self._port_field.stringValue() or "").strip()
        error = probe_rewrite_listen_port(
            port_text,
            ignore_in_use=self._saved_listener_may_hold_port(port_text),
        )
        self._set_port_status(error)
        return error

    def _set_port_status(self, message):
        label = getattr(self, "_port_status_label", None)
        if label is not None:
            label.setStringValue_(message or "")

    def controlTextDidEndEditing_(self, notification):
        """输入框失去编辑焦点时跑一轮校验；输入过程中不做任何校验。"""
        field = notification.object()
        if field is self._port_field:
            self._validate_port_field()
            self._check_port_bindability()
        elif field is self._target_field:
            self._validate_target_field()

    def validate_before_save(self):
        """保存前再跑一轮（防止用户输入后直接点保存、从未失焦过）。"""
        self.commit_active_editing()
        errors = []
        port_error = self._validate_port_field()
        if port_error:
            errors.append(port_error)
        elif self._enabled_switch.state() == NSOnState:
            # 开关打开时保存前再试绑一次：绑不上就拦下来，避免保存后主进程
            # 静默启动失败、用户看着「已启用」实际端口没监听
            bind_error = self._check_port_bindability()
            if bind_error:
                errors.append(
                    f"本地监听端口 {self._port_field.stringValue()}：{bind_error}"
                )
        target_error = self._validate_target_field()
        if target_error:
            errors.append(target_error)
        return errors

    # ------------------------------------------------------------------
    # Save / cancel
    # ------------------------------------------------------------------

    def saveClicked_(self, sender):
        errors = self.validate_before_save()
        if errors:
            alert = NSAlert.alloc().init()
            alert.setMessageText_("无法保存")
            alert.setInformativeText_("\n".join(errors))
            alert.addButtonWithTitle_("确定")
            alert.runModal()
            return
        if self._save_target is not None:
            self._save_target.saveAll_(sender)

    def cancelClicked_(self, sender):
        """取消：不写盘，转发给宿主窗口直接关窗。"""
        if self._save_target is not None:
            self._save_target.cancelAll_(sender)

    def apply_to(self, config):
        """把面板当前状态写进 config dict（不落盘、不关窗）。

        端口非法时保留原值：运行侧 RewriteProxy.start 会对无效配置
        报错并拒绝启动，不会带着坏端口去绑。
        """
        self.commit_active_editing()
        rewrite = config.setdefault("rewrite", {})
        rewrite["enabled"] = bool(self._enabled_switch.state() == NSOnState)

        port_text = str(self._port_field.stringValue() or "").strip()
        if port_text.isdigit() and 1 <= int(port_text) <= 65535:
            rewrite["listen_port"] = int(port_text)
        rewrite["target"] = str(self._target_field.stringValue() or "").strip()
        return config
