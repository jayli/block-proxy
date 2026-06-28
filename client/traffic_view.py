"""
Traffic statistics and animation view. Pure PyObjC custom NSView.

Animation:
  - Flow lines: always visible, idle=gentle pulse, active=intense wave
  - Outbound (request):  left→right small dots
  - Inbound (response):  right→left larger dots (LLM streaming = bigger + faster)
  - Proxy=green, Direct=blue
"""

import math
import objc
import random
import sys
import time

from Foundation import NSTimer, NSRunLoop, NSString
from AppKit import (
    NSView, NSColor, NSBezierPath, NSFont,
    NSFontAttributeName, NSForegroundColorAttributeName,
)


PAD = 12
STREAM_H = 105
CHART_H = 90
F_SM = 10
F_MD = 11
F_LG = 13
MAX_OUT = 100
MAX_IN = 100
HIST = 30
STATS_INTV = 2.0
ANIM_INTV = 1.0 / 25.0

PXY = (0.10, 0.88, 0.40, 1.0)
DIR = (0.25, 0.60, 1.0, 1.0)


def _c(r, g, b, a=1.0):
    return NSColor.colorWithRed_green_blue_alpha_(r, g, b, a)


def _s(text):
    """Create NSString for drawing."""
    return NSString.stringWithString_(text)


def _fmt(n):
    if n < 1024:               return f"{n} B"
    if n < 1024*1024:          return f"{n/1024:.1f} KB"
    if n < 1024*1024*1024:     return f"{n/(1024*1024):.1f} MB"
    return f"{n/(1024*1024*1024):.2f} GB"


def _fmts(bps):
    if bps < 1024:        return f"{bps:.0f} B/s"
    if bps < 1024*1024:   return f"{bps/1024:.1f} KB/s"
    return f"{bps/(1024*1024):.1f} MB/s"


def _lerp(a, b, t):
    return a + (b - a) * t


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _set_color(color):
    """Set current fill color. color is (r,g,b,a) tuple."""
    r, g, b, a = color[0:4]
    NSColor.colorWithRed_green_blue_alpha_(r, g, b, a).set()


def _fill_rect(x, y, w, h):
    NSBezierPath.fillRect_(((x, y), (w, h)))


def _fill_oval(cx, cy, rx, ry):
    NSBezierPath.bezierPathWithOvalInRect_(
        ((cx - rx, cy - ry), (rx * 2, ry * 2))).fill()


def _draw_text(text, x, y, attrs):
    _s(text).drawAtPoint_withAttributes_((x, y), attrs)


def _make_attrs(size, color, bold=False):
    font = NSFont.boldSystemFontOfSize_(size) if bold else NSFont.systemFontOfSize_(size)
    return {
        NSFontAttributeName: font,
        NSForegroundColorAttributeName: _c(*color[:4]),
    }


# ────────────────────────────────────────────────────────────────

class TrafficView(NSView):

    def initWithFrame_(self, frame):
        self = objc.super(TrafficView, self).initWithFrame_(frame)
        if self is None:
            return None

        self._out = []
        self._in_ = []
        self._hist = []

        self._pso = self._psi = self._dso = self._dsi = 0.0
        self._tpo = self._tpi = self._tdo = self._tdi = 0
        self._last = (0, 0, 0, 0)
        self._last_ts = None
        self._active = False
        self._t_anim = None
        self._t_stats = None
        self._scroll = 0.0
        self._amp = 0.0
        self._frame_n = 0
        self._draw_ok = True  # set False if drawing ever fails

        return self

    # ── Timer lifecycle ─────────────────────────────────────

    def start(self):
        """Start stats collection immediately. Animation starts separately via resume_anim()."""
        if self._active:
            return
        self._active = True
        self._last_ts = None
        self._last = (0, 0, 0, 0)
        self._pso = self._psi = self._dso = self._dsi = 0.0
        self._tpo = self._tpi = self._tdo = self._tdi = 0
        self._hist[:] = []
        self._out[:] = []
        self._in_[:] = []
        self._scroll = 0.0
        self._amp = 0.0
        self._frame_n = 0
        self._draw_ok = True

        self._t_stats = NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            STATS_INTV, self, "_onStats:", None, True)
        NSRunLoop.currentRunLoop().addTimer_forMode_(
            self._t_stats, "kCFRunLoopCommonModes")

        # Start animation immediately if view is visible
        if not self.isHidden():
            self.resume_anim()

    def resume_anim(self):
        """Start/restart the animation timer (called when tab becomes visible)."""
        if not self._active:
            return
        if self._t_anim is not None:
            return  # already running
        self._t_anim = NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            ANIM_INTV, self, "_onAnim:", None, True)
        NSRunLoop.currentRunLoop().addTimer_forMode_(
            self._t_anim, "kCFRunLoopCommonModes")

    def pause_anim(self):
        """Pause the animation timer (called when tab is hidden). Saves CPU, stats still run."""
        if self._t_anim:
            self._t_anim.invalidate()
            self._t_anim = None
        self._out[:] = []
        self._in_[:] = []

    def stop(self):
        """Stop everything — stats and animation (called when window closes)."""
        self._active = False
        self.pause_anim()
        if self._t_stats:
            self._t_stats.invalidate()
            self._t_stats = None

    # ── Stats poll ─────────────────────────────────────────

    def _onStats_(self, timer):
        if not self._active:
            return
        try:
            from traffic_stats import read_stats
            s = read_stats()
        except Exception:
            return
        if s is None:
            return

        now = time.time()
        po = s.get("proxy_out", 0)
        pi = s.get("proxy_in", 0)
        do_ = s.get("direct_out", 0)
        di = s.get("direct_in", 0)
        self._tpo, self._tpi, self._tdo, self._tdi = po, pi, do_, di

        if self._last_ts is not None:
            dt = now - self._last_ts
            if dt > 0:
                lpo, lpi, ldo, ldi = self._last
                self._pso = (po - lpo) / dt if po >= lpo else po / dt
                self._psi = (pi - lpi) / dt if pi >= lpi else pi / dt
                self._dso = (do_ - ldo) / dt if do_ >= ldo else do_ / dt
                self._dsi = (di - ldi) / dt if di >= ldi else di / dt
                self._hist.append((self._pso, self._psi, self._dso, self._dsi))
                if len(self._hist) > HIST:
                    self._hist.pop(0)

        self._last = (po, pi, do_, di)
        self._last_ts = now

    # ── Animation tick ─────────────────────────────────────

    def _onAnim_(self, timer):
        if not self._active:
            return
        try:
            self._frame_n += 1
            to = self._pso + self._dso
            ti = self._psi + self._dsi
            t = to + ti

            self._scroll += 1.5
            tgt = 4.0 if t < 1024 else _clamp(4.0 + t / (120*1024) * 26.0, 4.0, 30.0)
            self._amp = _lerp(self._amp, tgt, 0.06)

            self._spawn_out(to)
            self._spawn_in(ti)
            self._move_parts(self._out, 1)
            self._move_parts(self._in_, -1)
            self.setNeedsDisplay_(True)
        except Exception:
            print("[traffic_view] _onAnim_ error:", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            sys.stderr.flush()

    # ── Spawning ───────────────────────────────────────────

    def _spawn_out(self, total):
        if len(self._out) >= MAX_OUT:
            return
        n = 0
        if total > 0:
            n = min(10, max(1, int(total / (20*1024))))
        elif self._frame_n % 12 == 0 and len(self._out) < 6:
            n = 1  # ambient
        if n <= 0:
            return

        pr = self._pso / total if total > 0 else 0.5
        w = self.frame().size.width
        h = self.frame().size.height
        my = h - PAD - STREAM_H + STREAM_H / 2.0

        for _ in range(n):
            c = PXY if random.random() < pr else DIR
            self._out.append({
                "x": random.uniform(-20, 5),
                "y": my + random.uniform(-20, 20),
                "s": random.uniform(50, 100),
                "r": random.uniform(1.4, 2.8),
                "c": c,
                "op": random.uniform(0.5, 0.9),
            })

    def _spawn_in(self, total):
        if len(self._in_) >= MAX_IN:
            return
        n = 0
        if total > 0:
            n = min(12, max(1, int(total / (15*1024))))
        elif self._frame_n % 12 == 0 and len(self._in_) < 6:
            n = 1  # ambient
        if n <= 0:
            return

        pr = self._psi / total if total > 0 else 0.5
        w = self.frame().size.width
        h = self.frame().size.height
        my = h - PAD - STREAM_H + STREAM_H / 2.0

        ot = self._pso + self._dso
        burst = (total > 3*1024) and (ot < total * 0.2)

        for _ in range(n):
            c = PXY if random.random() < pr else DIR
            r = random.uniform(3.0, 6.5) if burst else random.uniform(2.2, 4.0)
            op = random.uniform(0.6, 1.0) if burst else random.uniform(0.45, 0.85)
            s = random.uniform(65, 130) if burst else random.uniform(40, 80)
            self._in_.append({
                "x": w + random.uniform(0, 25),
                "y": my + random.uniform(-25, 25),
                "s": s, "r": r, "c": c, "op": op,
            })

    def _move_parts(self, parts, d):
        w = self.frame().size.width
        dt = ANIM_INTV
        keep = []
        for p in parts:
            p["x"] += p["s"] * dt * d
            ok = (d == 1 and p["x"] < w + 30) or (d == -1 and p["x"] > -30)
            if ok:
                keep.append(p)
        if d == 1:
            self._out = keep
        else:
            self._in_ = keep

    # ── Drawing ────────────────────────────────────────────

    def drawRect_(self, dirtyRect):
        if not self._draw_ok:
            return
        try:
            self._draw()
        except Exception:
            self._draw_ok = False
            import traceback
            print("[traffic_view] drawRect_ error (drawing disabled):", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            sys.stderr.flush()

    def _draw(self):
        w = self.frame().size.width
        h = self.frame().size.height
        if w <= 0 or h <= 0:
            return

        st_top = h - PAD
        st_bot = st_top - STREAM_H
        info_top = st_bot - 4
        info_bot = info_top - 70
        ch_top = info_bot - 4
        ch_bot = PAD

        self._draw_bg(w, h)
        self._draw_pipe(w, st_bot, st_top)
        self._draw_info(w, info_bot, info_top)
        self._draw_chart(w, ch_bot, ch_top)

    def _draw_bg(self, w, h):
        NSColor.controlBackgroundColor().set()
        _fill_rect(0, 0, w, h)

    # ── Pipe ───────────────────────────────────────────────

    def _draw_pipe(self, w, y0, y1):
        sh = y1 - y0
        mid = y0 + sh / 2.0
        amp = self._amp
        scroll = self._scroll
        to = self._pso + self._dso
        ti = self._psi + self._dsi
        t = to + ti

        # Background
        _set_color((0.03, 0.03, 0.05, 1.0))
        _fill_rect(0, y0, w, sh)

        idle = t < 1024
        base_a = 0.18 if idle else _lerp(0.22, 0.45, _clamp(t / (400*1024), 0.0, 1.0))
        lw = 1.2 if idle else _lerp(1.5, 3.5, _clamp(t / (400*1024), 0.0, 1.0))

        pf = (self._pso + self._psi) / t if t > 0 else 0.5
        df = 1.0 - pf

        strands = [
            (PXY, 0.0, 1.0, pf),
            (PXY, 50.0, 1.4, pf * 0.7),
            (DIR, 25.0, 0.85, df),
            (DIR, 75.0, 1.15, df * 0.7),
        ]

        for col, phase, freq, wt in strands:
            if wt < 0.05:
                continue
            a = base_a * wt
            _c(col[0], col[1], col[2], a).set()
            path = NSBezierPath.bezierPath()
            x = 0.0
            path.moveToPoint_((x, mid))
            while x < w:
                v = math.sin((x + scroll + phase) / (38.0 * freq)) * amp * wt
                path.lineToPoint_((x, mid + v))
                x += 4.0
            path.setLineWidth_(lw * _lerp(0.6, 1.0, wt))
            path.stroke()

        # Edge highlights
        _c(0.6, 0.6, 0.6, 0.08).set()
        p = NSBezierPath.bezierPath()
        p.moveToPoint_((0, y0)); p.lineToPoint_((w, y0))
        p.setLineWidth_(1.0); p.stroke()
        _c(0.6, 0.6, 0.6, 0.05).set()
        p = NSBezierPath.bezierPath()
        p.moveToPoint_((0, y1)); p.lineToPoint_((w, y1))
        p.setLineWidth_(1.0); p.stroke()

        # End glows
        go = _clamp(to / (100*1024), 0.0, 0.4)
        gi = _clamp(ti / (100*1024), 0.0, 0.4)
        if go > 0.02:
            rc = PXY if pf > 0.5 else DIR
            _c(rc[0], rc[1], rc[2], go*0.6).set()
            _fill_oval(11, mid, 7, 7)
            _c(rc[0], rc[1], rc[2], go*0.18).set()
            _fill_oval(9, mid, 13, 13)
        if gi > 0.02:
            rc = PXY if (self._psi / max(self._psi + self._dsi, 1)) > 0.5 else DIR
            _c(rc[0], rc[1], rc[2], gi*0.6).set()
            _fill_oval(w-11, mid, 7, 7)
            _c(rc[0], rc[1], rc[2], gi*0.18).set()
            _fill_oval(w-9, mid, 13, 13)

        # Particles
        self._draw_parts(self._out)
        self._draw_parts(self._in_)

        # Labels
        sm = _make_attrs(F_SM, (0.5, 0.5, 0.5, 1.0))
        _draw_text("本机", 6, y1 - 18, sm)
        _draw_text("互联网", w - 42, y1 - 18, sm)

    def _draw_parts(self, parts):
        for p in parts:
            r, g, b, _ = p["c"]
            px, py = p["x"], p["y"]
            rad = p["r"]
            op = p["op"]
            _c(r, g, b, op*0.06).set()
            _fill_oval(px, py, rad*5, rad*5)
            _c(r, g, b, op*0.2).set()
            _fill_oval(px, py, rad*2, rad*2)
            _c(r, g, b, op).set()
            _fill_oval(px, py, rad, rad)

    # ── Info ───────────────────────────────────────────────

    def _draw_info(self, w, y0, y1):
        la = _make_attrs(F_SM, (0.4, 0.4, 0.4, 1.0))
        ta = _make_attrs(F_SM, (0.5, 0.5, 0.5, 1.0))
        pa = _make_attrs(F_LG, PXY)
        da = _make_attrs(F_LG, DIR)

        _draw_text("当前速度 (↓上传 / ↑下载)", PAD, y1 - 14, la)
        _draw_text(f"代理  {_fmts(self._pso)} ↓  {_fmts(self._psi)} ↑", PAD, y1 - 36, pa)
        _draw_text(f"直连  {_fmts(self._dso)} ↓  {_fmts(self._dsi)} ↑", PAD + 210, y1 - 36, da)

        _draw_text(f"代理累计: {_fmt(self._tpo + self._tpi)}", PAD, y1 - 56, ta)
        _draw_text(f"直连累计: {_fmt(self._tdo + self._tdi)}", PAD + 170, y1 - 56, ta)

        # Ratio bar
        bx, bw, bh, by = w - 240, 220, 18, y1 - 28
        pt = self._tpo + self._tpi
        dt = self._tdo + self._tdi
        tot = pt + dt
        pr = pt / tot if tot > 0 else 0.5
        dr = dt / tot if tot > 0 else 0.5

        _c(0, 0, 0, 0.06).set()
        _fill_rect(bx, by, bw, bh)
        if pr > 0.003:
            _set_color(PXY)
            _fill_rect(bx, by, max(3, bw*pr), bh)
        if dr > 0.003:
            _set_color(DIR)
            _fill_rect(bx + bw*pr, by, max(3, bw*dr), bh)

        ra = _make_attrs(F_SM, (0.4, 0.4, 0.4, 1.0))
        _draw_text(f"代理 {pr*100:.0f}%  /  直连 {dr*100:.0f}%", bx, by - 18, ra)

        # Separator
        _c(0, 0, 0, 0.08).set()
        s = NSBezierPath.bezierPath()
        s.moveToPoint_((PAD, y0))
        s.lineToPoint_((w - PAD, y0))
        s.setLineWidth_(1.0)
        s.stroke()

    # ── Chart ──────────────────────────────────────────────

    @staticmethod
    def _curve_path(pts, left_x, right_x, baseline):
        """Build a closed path: smooth curve → down to baseline → back to start.
        Points outside [left_x, right_x] are clipped. A boundary point is inserted
        at the left edge for proper fill closure."""
        if len(pts) < 2:
            return None
        # Prune points outside visible range, keeping one boundary point on each side
        visible = []
        for i, (x, y) in enumerate(pts):
            if x < left_x:
                continue
            if x > right_x:
                continue
            visible.append((x, y))
        if len(visible) < 2:
            return None

        # Insert a left-edge boundary point via linear extrapolation from first 2 visible
        v0, v1 = visible[0], visible[1]
        if v0[0] > left_x + 1 and v1[0] != v0[0]:
            t = (left_x - v0[0]) / (v1[0] - v0[0])
            by = v0[1] + (v1[1] - v0[1]) * t
            visible.insert(0, (left_x, by))

        path = NSBezierPath.bezierPath()
        path.moveToPoint_(visible[0])
        for i in range(1, len(visible)):
            x0, y0 = visible[i - 1]
            x1, y1 = visible[i]
            cpx = (x0 + x1) / 2.0
            path.curveToPoint_controlPoint1_controlPoint2_(
                (x1, y1), (cpx, y0), (cpx, y1))
        path.lineToPoint_((visible[-1][0], baseline))
        path.lineToPoint_((visible[0][0], baseline))
        path.closePath()
        return path

    @classmethod
    def _fill_curve_gradient(cls, pts, left_x, right_x, baseline, color):
        path = cls._curve_path(pts, left_x, right_x, baseline)
        if path is None:
            return
        r, g, b = color[0], color[1], color[2]
        try:
            from AppKit import NSGradient
            grad = NSGradient.alloc().initWithStartingColor_endingColor_(
                _c(r, g, b, 0.22), _c(r, g, b, 0.0))
            grad.drawInBezierPath_angle_(path, 90.0)
        except Exception:
            _c(r, g, b, 0.08).set()
            path.fill()

    @classmethod
    def _stroke_curve(cls, pts, left_x, right_x, color, width):
        if len(pts) < 2:
            return
        # Filter to visible + one edge point
        visible = [(x, y) for (x, y) in pts if left_x <= x <= right_x]
        if len(visible) < 2:
            return
        _c(color[0], color[1], color[2], 0.85).set()
        path = NSBezierPath.bezierPath()
        path.moveToPoint_(visible[0])
        for i in range(1, len(visible)):
            x0, y0 = visible[i - 1]
            x1, y1 = visible[i]
            cpx = (x0 + x1) / 2.0
            path.curveToPoint_controlPoint1_controlPoint2_(
                (x1, y1), (cpx, y0), (cpx, y1))
        path.setLineWidth_(width)
        path.setLineCapStyle_(1)
        path.setLineJoinStyle_(0)
        path.stroke()

    def _draw_chart(self, w, y0, y1):
        cw = w - PAD * 2
        ch = y1 - y0
        _c(0, 0, 0, 0.06).set()
        _fill_rect(PAD, y0, cw, ch)

        gx = PAD + 4
        gw = cw - 8
        gy = y0 + 4
        gh = ch - 22

        la = _make_attrs(F_SM, (0.5, 0.5, 0.5, 1.0))
        _draw_text("速度历史 (最近60秒)", gx + gw - 126, y1 - 14, la)

        baseline = gy + gh
        left_x, right_x = gx, gx + gw

        if not self._hist:
            ea = _make_attrs(F_SM, (0.5, 0.5, 0.5, 1.0))
            _draw_text("等待数据...", gx + gw / 2.0 - 30, gy + gh / 2.0 - 6, ea)
            return

        mx = 1024.0
        for pso, psi, dso, dsi in self._hist:
            mx = max(mx, pso + psi + dso + dsi)
        mx *= 1.15

        # Fixed time scale: each sample = 2s, 30 samples = 60s = full width
        n = len(self._hist)
        step_x = gw / 30.0  # fixed pixel per sample
        # Newest point is at rightmost position
        rightmost = gx + gw - step_x

        proxy_pts = []
        direct_pts = []
        for i, (pso, psi, dso, dsi) in enumerate(self._hist):
            x = rightmost - (n - 1 - i) * step_x
            pv = ((pso + psi) / mx) * gh if mx > 0 else 0.0
            dv = ((dso + dsi) / mx) * gh if mx > 0 else 0.0
            proxy_pts.append((x, baseline - pv))
            direct_pts.append((x, baseline - dv))

        self._fill_curve_gradient(direct_pts, left_x, right_x, baseline, DIR)
        self._fill_curve_gradient(proxy_pts, left_x, right_x, baseline, PXY)
        self._stroke_curve(proxy_pts, left_x, right_x, PXY, 2.0)
        self._stroke_curve(direct_pts, left_x, right_x, DIR, 2.0)

        # Bottom axis
        _c(0, 0, 0, 0.1).set()
        ax = NSBezierPath.bezierPath()
        ax.moveToPoint_((gx, baseline))
        ax.lineToPoint_((gx + gw, baseline))
        ax.setLineWidth_(0.5)
        ax.stroke()

        # Time markers
        tm = _make_attrs(8, (0.4, 0.4, 0.4, 1.0))
        _draw_text("60s", gx, baseline + 2, tm)
        _draw_text("0s", gx + gw - 14, baseline + 2, tm)

    # ── NSView overrides ───────────────────────────────────

    def isFlipped(self):
        return True

    def viewDidMoveToWindow(self):
        if self.window() is None:
            self.stop()
