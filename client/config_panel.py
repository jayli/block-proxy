"""
BlockProxyClient 节点配置面板。
Pure PyObjC implementation (no tkinter dependency).

面板本身不建窗口、不写盘：控件建进外部传入的容器 NSView，
保存时由宿主窗口（settings_window.py）调用 apply_to() 改 config dict。
"""

import objc

# allowInsecure 钉死为 True（节点自签证书，身份校验由证书指纹承担）；
# 取值从 config 模块引入，避免两处常量漂移。
from config import ALLOW_INSECURE_FORCED

from Foundation import NSObject
from AppKit import (
    NSView,
    NSTextField,
    NSSecureTextField,
    NSButton,
    NSButtonTypeSwitch,
    NSFont,
    NSPopUpButton,
    NSBox,
    NSColor,
    NSOnState,
    NSOffState,
)


BEZEL_SQUARE = 1  # NSTextFieldSquareBezel
BEZEL_ROUNDED = 1  # NSRoundedBezelStyle
TEXT_RIGHT = 2  # NSRightTextAlignment

# 面板内容尺寸。宽度与 Super DNS 面板一致（520），三个 Tab 在 560 宽的合并窗口里
# 左右留白相同；高度按两列网格重排后从 615 降到 518。
PANEL_WIDTH = 520
PANEL_HEIGHT = 518

# 两列网格：协议独占一行，地址|端口、用户名|密码、本地SOCKS|本地HTTP 端口两两并排。
# 16 + 234 + 20 + 234 + 16 = 520
GRID_MARGIN_X = 16
GRID_GAP_X = 20
GRID_COL_W = 234
GRID_COL2_X = GRID_MARGIN_X + GRID_COL_W + GRID_GAP_X
GRID_LABEL_W = 78        # 常规标签列宽（右对齐）
GRID_LABEL_WIDE = 104    # 「本地SOCKS端口:」这类长标签
GRID_LABEL_GAP = 6       # 标签与控件的间距
GRID_FULL_W = GRID_COL_W * 2 + GRID_GAP_X
RESET_BTN_W = 70

# 标签要比输入框低 2px 才能视觉对齐（实测偏移扫描：-2 时两者文字墨迹
# 中心差 0.00px，0 时差 +2px）。原因：label frame 高 22px、输入框 frame 高 24px，
# 且 label 文字墨迹在自己 frame 内偏上 3px，而输入框文字正好在 frame 中心。
# 注意：改 label 高度没用 —— label 文字是贴顶锚定的，加高只会把文字顶上去。
LABEL_ALIGN_DY = 2

# 证书指纹是 64 位 SHA-256 hex，13pt 系统字体要 552px（超出栅格宽 488px），
# 11pt 等宽实测 479px 刚好放得下，所以完整显示时降到这个字号。
CERT_PIN_FONT_SIZE = 11

# 指纹/提示行相对「绑定服务器证书」复选框额外下推的距离（逻辑 px）
CERT_BIND_LABEL_DROP_Y = 4

# 底部「取消 / 保存」两个按钮：等宽、并排居中，取消在左、保存在右（macOS 惯例）
FOOTER_BTN_W = 100
FOOTER_BTN_H = 28
FOOTER_BTN_GAP = 12

PROTOCOLS = [("socks5", "socks5"), ("http", "http"), ("tunnel", "隧道(双向)")]


class ConfigPanel(NSObject):
    """节点配置面板：把控件建进自己的容器 view，apply_to() 写回 config dict。"""

    def initWithConfig_(self, config):
        self = objc.super(ConfigPanel, self).init()
        if self is None:
            return None
        self._config = config
        self._save_target = None
        self._build_view()
        return self

    def setSaveTarget_(self, target):
        """宿主窗口注册自己，「保存」按钮转发给它。"""
        self._save_target = target

    def saveClicked_(self, sender):
        if self._save_target is not None:
            self._save_target.saveAll_(sender)

    def cancelClicked_(self, sender):
        """取消：不写盘，转发给宿主窗口直接关窗。"""
        if self._save_target is not None:
            self._save_target.cancelAll_(sender)

    def panelSize(self):
        return (PANEL_WIDTH, PANEL_HEIGHT)

    def view(self):
        return self._container

    def _build_view(self):
        config = self._config
        server_cfg = config.get("server", {})
        tunnel_cfg = config.get("tunnel", {})
        protocol = server_cfg.get("protocol", "socks5")

        self._server_port_value = str(server_cfg.get("port", 8002))
        self._tunnel_port_value = str(tunnel_cfg.get("server_port", 8003))
        self._cert_pin = server_cfg.get("certPin", "") or ""
        self._cert_pin_mismatch = bool(server_cfg.get("certPinMismatch", False))
        self._cert_pin_touched = False
        self._initial_server_identity = (
            server_cfg.get("address", ""),
            int(server_cfg.get("port", 8002)),
            protocol,
            bool(server_cfg.get("tls", True)),
        )

        w, h = PANEL_WIDTH, PANEL_HEIGHT
        content = NSView.alloc().initWithFrame_(((0, 0), (w, h)))
        self._container = content

        # Left column width, control offsets, field width
        CHECK_X = 76
        HINT_X = 102
        UI_FONT_SIZE = 13
        CERT_BIND_OFFSET_Y = 5
        LOWER_CONTROLS_OFFSET_Y = 15
        FOOTER_CONTROLS_OFFSET_Y = 5
        ui_font = NSFont.systemFontOfSize_(UI_FONT_SIZE)
        row_h = 28
        y_pos = h - 40

        def label(text, y, x=GRID_MARGIN_X, lw=GRID_LABEL_W):
            lbl = NSTextField.labelWithString_(text)
            lbl.setFrame_(((x, y), (lw, 22)))
            lbl.setAlignment_(TEXT_RIGHT)
            content.addSubview_(lbl)

        def field_row(y, text, default, secure=False, col=0, wide_label=False):
            """一行「右对齐标签 + 输入框」。col 选列。"""
            lw = GRID_LABEL_WIDE if wide_label else GRID_LABEL_W
            col_x = GRID_MARGIN_X if col == 0 else GRID_COL2_X
            label(text, y - LABEL_ALIGN_DY, x=col_x, lw=lw)
            fx = col_x + lw + GRID_LABEL_GAP
            fw = GRID_COL_W - lw - GRID_LABEL_GAP
            cls = NSSecureTextField if secure else NSTextField
            fld = cls.alloc().initWithFrame_(((fx, y), (fw, 24)))
            fld.setBezeled_(True)
            fld.setBezelStyle_(BEZEL_SQUARE)
            fld.setStringValue_(default)
            content.addSubview_(fld)
            return fld

        def checkbox(y, title, default, width=None):
            cb = NSButton.alloc().initWithFrame_(
                ((CHECK_X, y), (width or (w - CHECK_X - 16), 26))
            )
            cb.setButtonType_(NSButtonTypeSwitch)
            cb.setTitle_(title)
            cb.setFont_(ui_font)
            cb.setState_(NSOnState if default else NSOffState)
            content.addSubview_(cb)
            return cb

        def hint_label(y, text, height=20):
            lbl = NSTextField.labelWithString_(text)
            lbl.setFrame_(((HINT_X, y), (w - HINT_X - 16, height)))
            lbl.setFont_(ui_font)
            content.addSubview_(lbl)
            return lbl

        def separator(y):
            sep = NSBox.alloc().initWithFrame_(
                ((GRID_MARGIN_X, y + 13), (w - 2 * GRID_MARGIN_X, 2))
            )
            sep.setBoxType_(2)  # NSBoxSeparator
            content.addSubview_(sep)

        # 协议（端口已移到地址行，本行只有协议）
        # popup 的标签偏移与输入框不同：实测 popup 相对 label 的最佳 offset 是 0
        # （残差 +0.5px），而输入框是 -2；NSPopUpButton 的文字居中方式不一样。
        label("协议:", y_pos - 2)
        self._protocol_popup = NSPopUpButton.alloc().initWithFrame_(
            (
                (GRID_MARGIN_X + GRID_LABEL_W + GRID_LABEL_GAP, y_pos - 2),
                (130, 24),
            )
        )
        self._protocol_popup.setTarget_(self)
        self._protocol_popup.setAction_("onProtocolChange:")

        # Build items; select by config value
        selected_idx = 0
        for idx, (key, title) in enumerate(PROTOCOLS):
            self._protocol_popup.addItemWithTitle_(title)
            if key == protocol:
                selected_idx = idx
        self._protocol_popup.selectItemAtIndex_(selected_idx)
        content.addSubview_(self._protocol_popup)
        y_pos -= row_h + 6

        self._fields = {}
        # 地址 | 端口：与下面「用户名 | 密码」完全同栅格，
        # 地址输入框与用户名等宽，端口与密码左对齐
        self._fields["address"] = field_row(
            y_pos, "地址:", str(server_cfg.get("address", ""))
        )
        self._fields["port"] = field_row(
            y_pos,
            "端口:",
            self._tunnel_port_value if protocol == "tunnel" else self._server_port_value,
            col=1,
        )
        y_pos -= row_h + 4

        # 用户名 | 密码
        self._fields["username"] = field_row(
            y_pos, "用户名:", str(server_cfg.get("username", ""))
        )
        self._fields["password"] = field_row(
            y_pos, "密码:", str(server_cfg.get("password", "")), secure=True, col=1
        )
        y_pos -= row_h + 4

        y_pos -= 4
        separator(y_pos)
        y_pos -= 32

        # 本地SOCKS端口 | 本地HTTP端口（标签长，用宽标签列）
        self._fields["socks_port"] = field_row(
            y_pos,
            "本地SOCKS端口:",
            str(config.get("local", {}).get("socks_port", "")),
            wide_label=True,
        )
        self._fields["http_port"] = field_row(
            y_pos,
            "本地HTTP端口:",
            str(config.get("local", {}).get("http_port", "")),
            col=1,
            wide_label=True,
        )
        y_pos -= row_h + 4

        y_pos -= 4
        separator(y_pos)
        y_pos -= 32

        # Checkboxes
        is_tunnel = protocol == "tunnel"
        tls_default = True if is_tunnel else server_cfg.get("tls", True)
        self._tls_cb = checkbox(y_pos, "启用 TLS（需节点服务器支持）", tls_default)
        self._tls_cb.setTarget_(self)
        self._tls_cb.setAction_("onTlsChange:")
        y_pos -= row_h + 4

        self._insecure_cb = checkbox(y_pos, "允许不安全连接（跳过证书验证）", True)
        # 钉死为 True：节点用自签证书，身份校验由“绑定服务器证书”的指纹承担，
        # 面板上仅作展示，不允许变更。
        self._insecure_cb.setState_(NSOnState)
        self._insecure_cb.setEnabled_(False)
        y_pos -= 20

        self._insecure_hint_label = hint_label(y_pos, "")
        y_pos -= 20

        cert_bind_y = y_pos - CERT_BIND_OFFSET_Y
        self._cert_bind_cb = checkbox(
            cert_bind_y, "绑定服务器证书", server_cfg.get("certBindEnabled", False)
        )
        self._cert_bind_cb.setTarget_(self)
        self._cert_bind_cb.setAction_("onCertBindChange:")
        # 「重置」与复选框同一行，右缘对齐栅格右缘（= 输入框右缘），
        # 这样按钮左右留白与栅格边距一致（都是 GRID_MARGIN_X）
        self._reset_pin_btn = NSButton.alloc().initWithFrame_(
            (
                (GRID_MARGIN_X + GRID_FULL_W - RESET_BTN_W, cert_bind_y + 2),
                (RESET_BTN_W, 22),
            )
        )
        self._reset_pin_btn.setTitle_("重置")
        self._reset_pin_btn.setBezelStyle_(BEZEL_ROUNDED)
        self._reset_pin_btn.setFont_(ui_font)
        self._reset_pin_btn.setTarget_(self)
        self._reset_pin_btn.setAction_("resetCertPin:")
        self._reset_pin_btn.setHidden_(True)
        content.addSubview_(self._reset_pin_btn)
        y_pos -= 20

        # 指纹/提示行再往下推几像素，与上面的「绑定服务器证书」复选框拉开距离
        cert_bind_label_y = y_pos - CERT_BIND_OFFSET_Y - CERT_BIND_LABEL_DROP_Y
        self._cert_bind_label = hint_label(cert_bind_label_y, "")
        # 指纹是 64 位 SHA-256 hex，13pt 下要 552px 放不下；展示指纹时改用
        # 11pt 等宽（实测 479px）并把 label 撑到整个栅格宽（488px），
        # 其余文案仍用 13pt + 原缩进位置。两种 frame 在 _refresh_cert_bind_ui 里切。
        self._cert_pin_font = NSFont.userFixedPitchFontOfSize_(CERT_PIN_FONT_SIZE)
        self._cert_bind_label_default_font = ui_font
        self._cert_bind_label_default_frame = self._cert_bind_label.frame()
        # 原 _cert_pin_error_label（始终隐藏）占的 28px 竖向空间要补回来，
        # 否则下面的「启用 UDP」会压到本行提示文字上。
        # DROP_Y 也要加进来：本行下推了 DROP_Y，下面的控件必须跟着下推同样多，
        # 否则间距被吃掉 DROP_Y（实测会重叠 4px）。
        y_pos -= 22 + 28 + CERT_BIND_LABEL_DROP_Y

        y_pos += LOWER_CONTROLS_OFFSET_Y
        self._udp_cb = checkbox(y_pos, "启用 UDP", config.get("local", {}).get("udp", True))
        y_pos -= row_h + 4

        self._proxy_private_cb = checkbox(
            y_pos, "代理私有地址段（192.168.x / 172.16.x / 10.x）",
            config.get("local", {}).get("proxy_private", False),
        )
        y_pos -= row_h + 4

        if is_tunnel:
            self._set_tunnel_mode(True)
        self._refresh_insecure_hint()
        self._refresh_cert_bind_ui()

        separator(y_pos)
        y_pos -= 32

        y_pos += FOOTER_CONTROLS_OFFSET_Y
        self._autostart_cb = checkbox(y_pos, "开机启动", config.get("autostart", False))
        y_pos -= row_h + 10

        # 取消 / 保存：并排居中，取消在左、保存在右。两个动作都交给宿主窗口：
        # 保存合并写两块 config 再关窗，取消什么都不写直接关窗。
        btns_w = FOOTER_BTN_W * 2 + FOOTER_BTN_GAP
        btns_x = (w - btns_w) // 2

        cancel_btn = NSButton.alloc().initWithFrame_(
            ((btns_x, y_pos), (FOOTER_BTN_W, FOOTER_BTN_H))
        )
        cancel_btn.setTitle_("取消")
        cancel_btn.setBezelStyle_(BEZEL_ROUNDED)
        cancel_btn.setTarget_(self)
        cancel_btn.setAction_("cancelClicked:")
        content.addSubview_(cancel_btn)
        self._cancel_btn = cancel_btn

        btn = NSButton.alloc().initWithFrame_(
            ((btns_x + FOOTER_BTN_W + FOOTER_BTN_GAP, y_pos),
             (FOOTER_BTN_W, FOOTER_BTN_H))
        )
        btn.setTitle_("保存")
        btn.setBezelStyle_(BEZEL_ROUNDED)
        btn.setTarget_(self)
        btn.setAction_("saveClicked:")
        content.addSubview_(btn)
        self._save_btn = btn

    # ------------------------------------------------------------------
    # Protocol change callback
    # ------------------------------------------------------------------

    def _set_tunnel_mode(self, enabled):
        """Enable/disable tunnel-only UI state."""
        if enabled:
            self._tls_cb.setState_(NSOnState)
            self._proxy_private_cb.setState_(NSOffState)
        self._tls_cb.setEnabled_(not enabled)
        self._udp_cb.setEnabled_(not enabled)
        self._proxy_private_cb.setEnabled_(not enabled)
        self._refresh_insecure_hint()
        self._refresh_cert_bind_ui()

    def _selected_protocol(self):
        idx = self._protocol_popup.indexOfSelectedItem()
        return PROTOCOLS[idx][0]

    def _tls_enabled(self):
        return bool(self._tls_cb.state())

    def _refresh_insecure_hint(self):
        if not hasattr(self, "_insecure_hint_label"):
            return
        # 钉死为 True：始终勾选且不可变，仅保留说明文字
        self._insecure_cb.setState_(NSOnState)
        self._insecure_cb.setEnabled_(False)
        self._insecure_hint_label.setStringValue_("节点使用自签证书，已固定开启")
        self._insecure_hint_label.setTextColor_(NSColor.disabledControlTextColor())

    def _refresh_cert_bind_ui(self):
        if not hasattr(self, "_cert_bind_cb"):
            return
        supported = self._selected_protocol() in ("socks5", "http") and self._tls_enabled()
        self._cert_bind_cb.setHidden_(False)
        self._cert_bind_label.setHidden_(False)
        self._cert_bind_cb.setEnabled_(supported)

        enabled = bool(self._cert_bind_cb.state())
        has_pin = bool(self._cert_pin)
        if not enabled:
            self._cert_bind_label.setStringValue_("勾选后首次连接时自动绑定证书指纹")
        elif self._cert_pin_mismatch:
            self._cert_bind_label.setStringValue_("证书指纹不匹配（中间人攻击 or 服务端证书已更新）")
        elif has_pin:
            # 完整显示 64 位指纹，不缩略
            self._cert_bind_label.setStringValue_(f"证书指纹：{self._cert_pin}")
        else:
            self._cert_bind_label.setStringValue_("首次连接时将自动绑定证书指纹")

        # 指纹行用 11pt 等宽 + 撑满栅格宽（488px）才能放下 64 位 hex；
        # 其余文案用 13pt + 原缩进位置（与复选框标题对齐）
        showing_pin = enabled and has_pin and not self._cert_pin_mismatch
        lbl = self._cert_bind_label
        y = lbl.frame().origin.y
        h = lbl.frame().size.height
        if showing_pin:
            lbl.setFont_(self._cert_pin_font)
            lbl.setFrame_(((GRID_MARGIN_X, y), (GRID_FULL_W, h)))
        else:
            lbl.setFont_(self._cert_bind_label_default_font)
            lbl.setFrame_(self._cert_bind_label_default_frame)

        if supported and enabled and self._cert_pin_mismatch:
            self._cert_bind_label.setTextColor_(NSColor.systemRedColor())
        elif supported:
            self._cert_bind_label.setTextColor_(NSColor.labelColor())
        else:
            self._cert_bind_label.setTextColor_(NSColor.disabledControlTextColor())

        self._reset_pin_btn.setHidden_(not (supported and enabled and has_pin))

    def onTlsChange_(self, sender):
        self._refresh_cert_bind_ui()

    def onCertBindChange_(self, sender):
        self._cert_pin_touched = True
        if not bool(self._cert_bind_cb.state()):
            self._cert_pin = ""
            self._cert_pin_mismatch = False
        self._refresh_cert_bind_ui()

    def resetCertPin_(self, sender):
        self._cert_pin = ""
        self._cert_pin_mismatch = False
        self._cert_pin_touched = True
        if hasattr(self, "_cert_bind_cb"):
            self._cert_bind_cb.setState_(NSOnState)
        self._refresh_cert_bind_ui()

    def onProtocolChange_(self, sender):
        key = self._selected_protocol()
        is_tunnel = key == "tunnel"

        if is_tunnel:
            # Remember current port as server.port, switch to tunnel port
            self._server_port_value = self._fields["port"].stringValue()
            self._fields["port"].setStringValue_(self._tunnel_port_value)
        else:
            # Remember current port as tunnel port, restore server port
            self._tunnel_port_value = self._fields["port"].stringValue()
            self._fields["port"].setStringValue_(self._server_port_value)

        self._set_tunnel_mode(is_tunnel)
        self._refresh_cert_bind_ui()

    # ------------------------------------------------------------------
    # Save
    # ------------------------------------------------------------------

    def commit_active_editing(self):
        """把正在编辑的文本框内容提交到控件（否则读 stringValue 会拿到旧值）。"""
        win = self._container.window() if self._container else None
        if win is not None:
            win.makeFirstResponder_(None)

    def apply_to(self, config):
        """把面板当前状态写进 config dict（不落盘、不关窗）。"""
        self.commit_active_editing()
        config.setdefault("server", {})
        config.setdefault("local", {})

        protocol = self._selected_protocol()
        is_tunnel = protocol == "tunnel"

        config["server"]["protocol"] = protocol
        config["server"]["address"] = self._fields["address"].stringValue()

        port_str = self._fields["port"].stringValue()
        port = int(port_str) if port_str else (8003 if is_tunnel else 8002)

        if is_tunnel:
            config["server"]["port"] = int(self._server_port_value) if self._server_port_value else 8002
            if "tunnel" not in config:
                config["tunnel"] = {}
            config["tunnel"]["server_port"] = port
            config["tunnel"]["enabled"] = True
            # Tunnel always uses TLS
            config["server"]["tls"] = True
            config["server"]["allowInsecure"] = ALLOW_INSECURE_FORCED
        else:
            config["server"]["port"] = port
            if "tunnel" in config:
                config["tunnel"]["enabled"] = False
            config["server"]["tls"] = bool(self._tls_cb.state())
            config["server"]["allowInsecure"] = ALLOW_INSECURE_FORCED

        config["server"]["username"] = self._fields["username"].stringValue()
        config["server"]["password"] = self._fields["password"].stringValue()
        config["local"]["socks_port"] = int(self._fields["socks_port"].stringValue() or "1080")
        config["local"]["http_port"] = int(self._fields["http_port"].stringValue() or "1087")
        config["local"]["udp"] = bool(self._udp_cb.state())
        config["local"]["proxy_private"] = bool(self._proxy_private_cb.state())
        config["autostart"] = bool(self._autostart_cb.state())

        cert_bind_enabled = bool(
            self._cert_bind_cb.state()
        ) if hasattr(self, "_cert_bind_cb") else bool(
            config["server"].get("certBindEnabled", False)
        )
        current_identity = (
            config["server"].get("address", ""),
            int(config["server"].get("port", 8002)),
            protocol,
            bool(config["server"].get("tls", True)),
        )
        identity_changed = current_identity != getattr(
            self, "_initial_server_identity", current_identity
        )

        config["server"]["certBindEnabled"] = cert_bind_enabled
        if not cert_bind_enabled or identity_changed:
            config["server"]["certPin"] = ""
            config["server"]["certPinMismatch"] = False
        elif getattr(self, "_cert_pin_touched", False):
            config["server"]["certPin"] = getattr(self, "_cert_pin", "")
            config["server"]["certPinMismatch"] = bool(
                getattr(self, "_cert_pin_mismatch", False)
            )

        return config
