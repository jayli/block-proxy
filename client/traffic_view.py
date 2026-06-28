"""
Traffic statistics and animation view. Pure PyObjC custom NSView.

Animation:
  - Flow lines: always visible, idle=gentle pulse, active=intense wave
  - Outbound (request):  left→right small dots
  - Inbound (response):  right→left larger dots (LLM streaming = bigger + faster)
  - Proxy=green, Direct=red-violet
"""

import math
import objc
import random
import sys
import time

from Foundation import NSTimer, NSRunLoop, NSString
from AppKit import (
    NSView, NSColor, NSBezierPath, NSFont,
    NSFontAttributeName, NSForegroundColorAttributeName, NSGraphicsContext,
)


PAD = 12
STREAM_H = 105
CHART_H = 90
F_SM = 10
F_MD = 11
F_LG = 13
MAX_OUT = 100
MAX_IN = 100
MAX_HITS = 12
HIST = 30
STATS_INTV = 2.0
ANIM_INTV = 1.0 / 25.0

PXY = (0.5, 1.0, 0.0, 1.0)
DIR = (0.1, 0.4, 1.0, 1.0)
FLOW_ACCENT = (0.76, 0.28, 1.0, 1.0)
PXY_TXT = (0.0, 0.75, 0.3, 1.0)  # 更深绿，用于文字和chart曲线
DIR_TXT = (0.3, 0.6, 1.0, 1.0)   # 稍浅蓝，用于文字和chart曲线
PXY_RATIO = (0.0, 0.82, 0.55, 1.0)  # 翠绿色，用于代理/直连百分比条
DIR_RATIO = (0.0, 0.62, 1.0, 1.0)   # 天蓝色，用于代理/直连百分比条
PXY_IN = (
    (0.4, 1.0, 0.0, 1.0),
    (0.6, 1.0, 0.2, 1.0),
)
DIR_IN = (
    (0.86, 0.24, 1.0, 1.0),
    (0.98, 0.18, 0.42, 1.0),
)


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


def _inbound_color(proxy_weight):
    palette = PXY_IN if random.random() < proxy_weight else DIR_IN
    return random.choice(palette)


def _visible_curve_points(pts, left_x, right_x):
    return [(x, y) for (x, y) in pts if left_x <= x <= right_x]


def _particles_can_collide(out, inc, x_tol=8.0, y_tol=10.0, r_tol=0.8):
    if abs(out["r"] - inc["r"]) > r_tol:
        return False
    return abs(out["x"] - inc["x"]) <= x_tol and abs(out["y"] - inc["y"]) <= y_tol


def _impact_wave(base, t):
    t = _clamp(t, 0.0, 1.0)
    return base * _lerp(2.8, 10.5, t), 0.26 * ((1.0 - t) ** 1.7)


def _flow_wave_offset(x, scroll, phase, freq, amp, weight):
    freq = max(0.2, freq)
    primary = math.sin((x + scroll + phase) / (38.0 * freq))
    drift = math.sin((x + scroll * 0.72 + phase * 1.7) / (17.0 * freq) + 1.2)
    swell = math.sin((x - scroll * 0.38 + phase * 0.55) / (82.0 * freq) - 0.7)
    return (primary * 0.72 + drift * 0.20 + swell * 0.16) * amp * weight


def _flow_strands(proxy_fraction):
    pf = _clamp(proxy_fraction, 0.0, 1.0)
    df = 1.0 - pf
    accent = 0.42 + min(pf, df) * 0.42
    return [
        (PXY, 0.0, 1.0, pf),
        (DIR, 35.0, 0.9, df),
        (FLOW_ACCENT, 72.0, 1.28, accent),
    ]


def _flow_line_width(load):
    return _lerp(1.2, 3.5 * 2.0 / 3.0, _clamp(load, 0.0, 1.0))


def _water_surface_y(y0, y1):
    return y0 + (y1 - y0) * 0.68


def _reflection_point(px, py, surface_y, scroll, phase=0.0):
    dist = max(0.0, surface_y - py)
    wave = (
        math.sin((px + scroll * 1.35 + phase) / 18.0) * 1.45 +
        math.sin((px - scroll * 0.62 + phase * 1.7) / 8.5) * 0.52
    )
    drift = (
        math.sin((py + scroll * 0.85 + phase) / 24.0) * 1.65 +
        math.sin((px + phase) / 43.0) * 0.70
    )
    return px + drift, surface_y + dist * 0.62 + wave


def _reflection_alpha(py, surface_y, bottom_y, op):
    if py >= surface_y:
        return 0.0
    mirrored_y = surface_y + (surface_y - py) * 0.62
    depth_t = _clamp((mirrored_y - surface_y) / max(1.0, bottom_y - surface_y), 0.0, 1.0)
    air_t = _clamp((surface_y - py) / 42.0, 0.0, 1.0)
    return op * 0.34 * air_t * ((1.0 - depth_t) ** 0.9)


def _reflection_ellipse(rad):
    return rad * 2.65, max(0.45, rad * 0.32)


def _spark_count(intensity):
    return random.randint(3, 7)


def _spark_speed(intensity, unit=None):
    if unit is None:
        unit = random.random()
    return _lerp(50.0, 82.0, _clamp(unit, 0.0, 1.0)) * intensity


def _spark_line(x, y, vx, vy, t, intensity=1.0, length_scale=1.0):
    t = _clamp(t, 0.0, 1.0)
    intensity = _clamp(intensity, 0.6, 1.6)
    length_scale = _clamp(length_scale, 0.35, 1.0)
    travel_t = 1.0 - ((1.0 - t) ** 2.2)
    travel = travel_t * ANIM_INTV * 13.0 * intensity
    head = (x + vx * travel, y + vy * travel)
    mag = math.hypot(vx, vy) or 1.0
    length_t = _clamp((intensity - 0.6) / 1.0, 0.0, 1.0)
    line_len = _lerp(3.5, 8.5, length_t) * length_scale * (1.0 - t * 0.35)
    tail = (head[0] - vx / mag * line_len, head[1] - vy / mag * line_len)
    return head, tail


# ────────────────────────────────────────────────────────────────

class TrafficView(NSView):

    def initWithFrame_(self, frame):
        self = objc.super(TrafficView, self).initWithFrame_(frame)
        if self is None:
            return None

        self._out = []
        self._in_ = []
        self._hits = []
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
        self._flow_load = 0.0
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
        self._hits[:] = []
        self._scroll = 0.0
        self._amp = 0.0
        self._flow_load = 0.0
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
        self._hits[:] = []

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
            flow_tgt = _clamp(t / (400*1024), 0.0, 1.0)
            self._flow_load = _lerp(self._flow_load, flow_tgt, 0.10)

            self._spawn_out(to)
            self._spawn_in(ti)
            self._move_parts(self._out, 1)
            self._move_parts(self._in_, -1)
            self._detect_hits()
            self._move_hits()
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
        pl = PAD

        for _ in range(n):
            c = PXY if random.random() < pr else DIR
            self._out.append({
                "x": pl + random.uniform(-15, 3),
                "y": my + random.uniform(-20, 20),
                "s": random.uniform(50, 100),
                "r": random.uniform(1.4, 2.8),
                "c": c,
                "op": random.uniform(0.7, 1.0),
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
        pr_edge = w - PAD

        ot = self._pso + self._dso
        burst = (total > 3*1024) and (ot < total * 0.2)

        for _ in range(n):
            c = _inbound_color(pr)
            r = random.uniform(2.25, 2.8) if burst else random.uniform(1.65, 3.0)
            op = random.uniform(0.8, 1.0) if burst else random.uniform(0.65, 0.95)
            s = random.uniform(65, 130) if burst else random.uniform(40, 80)
            self._in_.append({
                "x": pr_edge + random.uniform(-3, 20),
                "y": my + random.uniform(-25, 25),
                "s": s, "r": r, "c": c, "op": op,
            })

    def _move_parts(self, parts, d):
        w = self.frame().size.width
        pl = PAD
        pr = w - PAD
        dt = ANIM_INTV
        keep = []
        for p in parts:
            p["x"] += p["s"] * dt * d
            ok = (d == 1 and p["x"] < pr + 30) or (d == -1 and p["x"] > pl - 30)
            if ok:
                keep.append(p)
        if d == 1:
            self._out = keep
        else:
            self._in_ = keep

    def _detect_hits(self):
        if len(self._hits) >= MAX_HITS:
            return
        made = 0
        for out in self._out:
            if made >= 2 or len(self._hits) >= MAX_HITS:
                break
            for inc in self._in_:
                if _particles_can_collide(out, inc):
                    x = (out["x"] + inc["x"]) / 2.0
                    y = (out["y"] + inc["y"]) / 2.0
                    r = (out["r"] + inc["r"]) / 2.0
                    c1 = out["c"]
                    c2 = inc["c"]
                    color = (
                        min(1.0, (c1[0] + c2[0]) * 0.55),
                        min(1.0, (c1[1] + c2[1]) * 0.55),
                        min(1.0, (c1[2] + c2[2]) * 0.55),
                        1.0,
                    )
                    intensity = random.uniform(0.82, 1.38)

                    # Random collision style for visual variety
                    style = random.choice(["spark", "shock", "lightning", "nova"])

                    # Base sparks — all styles get some
                    sparks = []
                    sc = _spark_count(intensity)
                    for i in range(sc):
                        a = (math.pi * 2.0 / sc) * i + random.uniform(-0.4, 0.4)
                        sp = _spark_speed(intensity)
                        sparks.append((
                            math.cos(a) * sp,
                            math.sin(a) * sp,
                            random.uniform(0.4, 1.0),
                        ))

                    # Expanding shockwave rings — style-biased count
                    rings = []
                    ring_n = random.choices([1, 2, 3], weights=[3, 5, 2])[0]
                    if style == "shock":
                        ring_n = max(ring_n, 2)
                    for i in range(ring_n):
                        rings.append({
                            "r0": random.uniform(1.5, 4.0),
                            "r_max": random.uniform(18, 35) * intensity,
                            "speed": random.uniform(0.7, 1.4),
                            "alpha": random.uniform(0.25, 0.50),
                            "delay": i * random.uniform(1.0, 2.5),
                        })

                    # Lightning arcs — guaranteed for lightning style
                    arcs = []
                    if style == "lightning" or random.random() < 0.06:
                        arc_n = random.randint(2, 5) if style == "lightning" else random.randint(1, 3)
                        for _ in range(arc_n):
                            angle = random.uniform(0, math.pi * 2)
                            segs = []
                            cx, cy = 0.0, 0.0
                            da = random.uniform(-0.6, 0.6)
                            seg_n = random.randint(4, 8)
                            for si in range(seg_n):
                                da += random.uniform(-0.9, 0.9)
                                sl = random.uniform(3, 10) * intensity
                                cx += math.cos(angle + da) * sl
                                cy += math.sin(angle + da) * sl
                                segs.append((cx, cy))
                            branches = []
                            if style == "lightning" and len(segs) >= 2 and random.random() < 0.55:
                                bi = random.randint(1, min(3, len(segs) - 1))
                                bx, by = segs[bi]
                                bda = da + random.uniform(-1.2, 1.2)
                                for _ in range(random.randint(2, 4)):
                                    bda += random.uniform(-0.7, 0.7)
                                    bl = random.uniform(2, 6) * intensity
                                    bx += math.cos(angle + bda) * bl
                                    by += math.sin(angle + bda) * bl
                                    branches.append((bx, by))
                            arcs.append({
                                "angle": angle, "segs": segs,
                                "branches": branches,
                                "branch_at": segs[bi] if branches else None,
                            })

                    # Debris particles with gravity
                    debris = []
                    d_n = 0 if style == "shock" else random.randint(0, int(4 * intensity))
                    if style == "nova":
                        d_n = random.randint(4, 8)
                    for _ in range(d_n):
                        a = random.uniform(0, math.pi * 2)
                        sp = random.uniform(15, 55) * intensity
                        debris.append({
                            "vx": math.cos(a) * sp,
                            "vy": math.sin(a) * sp,
                            "r": random.uniform(0.8, 2.2),
                            "gravity": random.uniform(35, 90),
                            "op": random.uniform(0.5, 1.0),
                        })

                    # Color shockwave wash
                    shock = None
                    if style in ("nova", "shock") or random.random() < 0.25:
                        shock = {
                            "r_max": random.uniform(25, 50) * intensity,
                            "alpha": random.uniform(0.12, 0.25),
                        }

                    life = random.randint(12, 18)

                    self._hits.append({
                        "x": x, "y": y, "r": r,
                        "age": 0, "life": life,
                        "c": color, "sparks": sparks,
                        "intensity": intensity, "style": style,
                        "rings": rings, "arcs": arcs,
                        "debris": debris, "shock": shock,
                    })

                    out["dead"] = True
                    inc["dead"] = True
                    made += 1
                    break

        # Remove collided particles from both lists
        self._out = [p for p in self._out if not p.get("dead")]
        self._in_ = [p for p in self._in_ if not p.get("dead")]

    def _move_hits(self):
        keep = []
        for h in self._hits:
            h["age"] += 1
            if h["age"] < h["life"]:
                keep.append(h)
        self._hits = keep

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

        pl = PAD          # pipe left edge
        pr = w - PAD      # pipe right edge
        pw = pr - pl      # pipe inner width

        # Background
        _set_color((0.03, 0.03, 0.05, 1.0))
        _fill_rect(pl, y0, pw, sh)

        # Clip all pipe contents to the band rectangle
        NSGraphicsContext.saveGraphicsState()
        clip = NSBezierPath.bezierPathWithRect_(((pl, y0), (pw, sh)))
        clip.addClip()

        load = getattr(self, "_flow_load", _clamp(t / (400*1024), 0.0, 1.0))
        base_a = _lerp(0.18, 0.45, load)
        lw = _flow_line_width(load)

        pf = (self._pso + self._psi) / t if t > 0 else 0.5
        strands = _flow_strands(pf)

        for col, phase, freq, wt in strands:
            if wt < 0.05:
                continue
            a = base_a * wt
            path = NSBezierPath.bezierPath()
            x = float(pl)
            path.moveToPoint_((x, mid + _flow_wave_offset(x, scroll, phase, freq, amp, wt)))
            while x < pr:
                path.lineToPoint_(
                    (x, mid + _flow_wave_offset(x, scroll, phase, freq, amp, wt)))
                x += 4.0

            _c(col[0], col[1], col[2], a * 0.24).set()
            path.setLineWidth_(lw * _lerp(2.4, 3.4, wt))
            path.setLineCapStyle_(1)
            path.stroke()

            _c(col[0], col[1], col[2], a * 1.05).set()
            path.setLineWidth_(lw * _lerp(0.55, 0.9, wt))
            path.setLineCapStyle_(1)
            path.stroke()

        # Edge highlights
        _c(0.6, 0.6, 0.6, 0.08).set()
        p = NSBezierPath.bezierPath()
        p.moveToPoint_((pl, y0)); p.lineToPoint_((pr, y0))
        p.setLineWidth_(1.0); p.stroke()
        _c(0.6, 0.6, 0.6, 0.05).set()
        p = NSBezierPath.bezierPath()
        p.moveToPoint_((pl, y1)); p.lineToPoint_((pr, y1))
        p.setLineWidth_(1.0); p.stroke()

        # End glows
        go = _clamp(to / (100*1024), 0.0, 0.4)
        gi = _clamp(ti / (100*1024), 0.0, 0.4)
        if go > 0.02:
            rc = PXY if pf > 0.5 else DIR
            _c(rc[0], rc[1], rc[2], go*0.6).set()
            _fill_oval(pl + 11, mid, 7, 7)
            _c(rc[0], rc[1], rc[2], go*0.18).set()
            _fill_oval(pl + 9, mid, 13, 13)
        if gi > 0.02:
            pr_in = self._psi / max(self._psi + self._dsi, 1)
            rc = PXY_IN[0] if pr_in > 0.5 else DIR_IN[0]
            _c(rc[0], rc[1], rc[2], gi*0.6).set()
            _fill_oval(pr - 11, mid, 7, 7)
            _c(rc[0], rc[1], rc[2], gi*0.18).set()
            _fill_oval(pr - 9, mid, 13, 13)

        self._draw_water_reflections(pl, pr, y0, y1)

        # Particles
        self._draw_parts(self._out)
        self._draw_parts(self._in_)
        self._draw_hits()

        NSGraphicsContext.restoreGraphicsState()

        # Labels (outside clip, just inside band edges)
        sm = _make_attrs(F_SM, (0.5, 0.5, 0.5, 1.0))
        _draw_text("本机", pl + 6, y1 - 18, sm)
        _draw_text("互联网", pr - 42, y1 - 18, sm)

    def _draw_water_reflections(self, pl, pr, y0, y1):
        surface_y = _water_surface_y(y0, y1)
        water_h = y1 - surface_y
        if water_h <= 2.0:
            return

        try:
            from AppKit import NSGradient
            grad = NSGradient.alloc().initWithStartingColor_endingColor_(
                _c(0.06, 0.18, 0.24, 0.20), _c(0.01, 0.04, 0.07, 0.42))
            grad.drawInRect_angle_(((pl, surface_y), (pr - pl, water_h)), 90.0)
        except Exception:
            _c(0.03, 0.11, 0.16, 0.24).set()
            _fill_rect(pl, surface_y, pr - pl, water_h)

        scroll = self._scroll
        for i, (alpha, offset, amp, step) in enumerate((
                (0.18, 0.0, 1.10, 5.0),
                (0.12, 17.0, 0.75, 6.0),
                (0.08, 43.0, 1.55, 7.0))):
            path = NSBezierPath.bezierPath()
            x = float(pl)
            y = surface_y + 4.0 + i * max(4.0, water_h * 0.18)
            path.moveToPoint_((x, y))
            while x <= pr:
                ripple = (
                    math.sin((x + scroll * 1.6 + offset) / 22.0) * amp +
                    math.sin((x - scroll * 0.9 + offset) / 9.0) * amp * 0.28
                )
                path.lineToPoint_((x, y + ripple))
                x += step
            _c(0.42, 0.84, 0.95, alpha).set()
            path.setLineWidth_(_lerp(0.45, 0.9, i / 2.0))
            path.setLineCapStyle_(1)
            path.stroke()

        self._draw_reflection_parts(self._out, surface_y, y1, scroll, 0.0)
        self._draw_reflection_parts(self._in_, surface_y, y1, scroll, 23.0)

    def _draw_reflection_parts(self, parts, surface_y, bottom_y, scroll, phase):
        for p in parts:
            op = _reflection_alpha(p["y"], surface_y, bottom_y, p["op"])
            if op < 0.01:
                continue
            r, g, b, _ = p["c"]
            px, py = _reflection_point(p["x"], p["y"], surface_y, scroll, phase)
            if py > bottom_y + 4.0:
                continue
            rx, ry = _reflection_ellipse(p["r"])
            shimmer = 0.78 + math.sin((p["x"] + scroll * 2.1 + phase) / 13.0) * 0.16

            _c(r, g, b, op * 0.34).set()
            _fill_oval(px, py, rx * 2.4, ry * 2.2)
            _c(r, g, b, op * shimmer).set()
            _fill_oval(px, py, rx, ry)

            path = NSBezierPath.bezierPath()
            path.moveToPoint_((px - rx * 1.6, py))
            path.lineToPoint_((px + rx * 1.6, py + math.sin((px + scroll) / 11.0) * 0.9))
            _c(r, g, b, op * 0.55).set()
            path.setLineWidth_(max(0.4, ry * 0.7))
            path.setLineCapStyle_(1)
            path.stroke()

    def _draw_parts(self, parts):
        for p in parts:
            r, g, b, _ = p["c"]
            px, py = p["x"], p["y"]
            rad = p["r"]
            op = p["op"]
            _c(r, g, b, op*0.07).set()
            _fill_oval(px, py, rad*5, rad*5)
            _c(r, g, b, op*0.22).set()
            _fill_oval(px, py, rad*2.2, rad*2.2)
            _c(r, g, b, op).set()
            _fill_oval(px, py, rad, rad)

    def _draw_hits(self):
        for h in self._hits:
            t = h["age"] / float(max(1, h["life"]))
            fade = 1.0 - t
            r, g, b, _ = h["c"]
            x, y = h["x"], h["y"]
            base = h["r"]
            intensity = h.get("intensity", 1.0)
            style = h.get("style", "spark")

            # ── Layer 1: Color shockwave wash (early, fast fade) ──
            shock = h.get("shock")
            if shock is not None:
                st = _clamp(t * 2.5, 0.0, 1.0)
                sr = shock["r_max"] * (1.0 - ((1.0 - st) ** 2))
                sa = shock["alpha"] * ((1.0 - st) ** 1.5)
                if sa > 0.01:
                    _c(r, g, b, sa).set()
                    _fill_oval(x, y, sr, sr)

            # ── Layer 2: Expanding shockwave rings ──
            for ring in h.get("rings", []):
                rt = _clamp((t * h["life"] - ring["delay"]) / max(1, h["life"] - ring["delay"]), 0.0, 1.0)
                if rt <= 0.0 or rt >= 1.0:
                    continue
                ease = 1.0 - ((1.0 - rt) ** 2.5)
                rr = _lerp(ring["r0"], ring["r_max"], ease)
                ra = ring["alpha"] * ((1.0 - rt) ** 1.8)
                if ra < 0.01:
                    continue
                # Outer glow ring
                _c(r, g, b, ra * 0.3).set()
                ring_path = NSBezierPath.bezierPath()
                ring_path.appendBezierPathWithArcWithCenter_radius_startAngle_endAngle_(
                    (x, y), rr * 1.15, 0, 360)
                ring_path.setLineWidth_(max(1.5, base * 0.6))
                ring_path.stroke()
                # Sharp inner ring
                _c(1.0, 1.0, 1.0, ra * 0.8).set()
                ring_path2 = NSBezierPath.bezierPath()
                ring_path2.appendBezierPathWithArcWithCenter_radius_startAngle_endAngle_(
                    (x, y), rr, 0, 360)
                ring_path2.setLineWidth_(max(0.6, base * 0.25))
                ring_path2.stroke()

            # ── Layer 3: Lightning arcs with branches ──
            for arc in h.get("arcs", []):
                arc_fade = _clamp(fade * 1.5, 0.0, 1.0)
                if arc_fade < 0.01 or not arc["segs"]:
                    continue
                # Main bolt
                _c(1.0, 0.92, 0.65, 0.75 * arc_fade).set()
                bp = NSBezierPath.bezierPath()
                bp.moveToPoint_((x, y))
                for sx, sy in arc["segs"]:
                    bp.lineToPoint_((x + sx, y + sy))
                bp.setLineWidth_(max(1.0, base * 0.5))
                bp.setLineCapStyle_(1)
                bp.setLineJoinStyle_(0)
                bp.stroke()
                # Bolt core (brighter, thinner)
                _c(1.0, 1.0, 0.95, 0.60 * arc_fade).set()
                cp = NSBezierPath.bezierPath()
                cp.moveToPoint_((x, y))
                for sx, sy in arc["segs"]:
                    cp.lineToPoint_((x + sx, y + sy))
                cp.setLineWidth_(max(0.5, base * 0.2))
                cp.setLineCapStyle_(1)
                cp.setLineJoinStyle_(0)
                cp.stroke()
                # Branches
                if arc.get("branches") and arc.get("branch_at"):
                    bx0, by0 = arc["branch_at"]
                    _c(r, g, b, 0.45 * arc_fade).set()
                    brp = NSBezierPath.bezierPath()
                    brp.moveToPoint_((x + bx0, y + by0))
                    for bx, by in arc["branches"]:
                        brp.lineToPoint_((x + bx, y + by))
                    brp.setLineWidth_(max(0.5, base * 0.3))
                    brp.setLineCapStyle_(1)
                    brp.stroke()

            # ── Layer 4: Debris with gravity ──
            for d in h.get("debris", []):
                dt_ = t * h["life"] * ANIM_INTV
                dx = x + d["vx"] * dt_
                dy = y + d["vy"] * dt_ - 0.5 * d["gravity"] * dt_ * dt_
                dop = d["op"] * fade
                if dop < 0.02:
                    continue
                # Glow
                _c(r, g, b, dop * 0.15).set()
                _fill_oval(dx, dy, d["r"] * 3, d["r"] * 3)
                # Core
                _c(1.0, 0.9, 0.6, dop).set()
                _fill_oval(dx, dy, d["r"], d["r"])

            # ── Layer 5: Central flash ──
            flash_t = _clamp(t * 3.0, 0.0, 1.0)
            flash_r = base * _lerp(3.5, 1.0, flash_t)
            flash_a = 0.7 * ((1.0 - flash_t) ** 2)
            if flash_a > 0.01:
                # White hot center
                _c(1.0, 1.0, 1.0, flash_a).set()
                _fill_oval(x, y, flash_r, flash_r)
                # Colored glow
                _c(r, g, b, flash_a * 0.35).set()
                _fill_oval(x, y, flash_r * 2.5, flash_r * 2.5)

            # ── Layer 6: Sparks (glowing line trails) ──
            for spark_data in h.get("sparks", []):
                if len(spark_data) == 3:
                    vx, vy, length_scale = spark_data
                else:
                    vx, vy = spark_data
                    length_scale = 1.0
                head, tail = _spark_line(
                    x, y, vx, vy, t, intensity=intensity, length_scale=length_scale)

                # Outer glow
                _c(r, g, b, 0.25 * fade).set()
                glow_path = NSBezierPath.bezierPath()
                glow_path.moveToPoint_(tail)
                glow_path.lineToPoint_(head)
                glow_path.setLineWidth_(max(2.0, base * 0.8))
                glow_path.setLineCapStyle_(1)
                glow_path.stroke()

                # Bright trail
                _c(1.0, 0.88, 0.46, 0.65 * fade).set()
                trail = NSBezierPath.bezierPath()
                trail.moveToPoint_(tail)
                trail.lineToPoint_(head)
                trail.setLineWidth_(max(0.8, base * 0.42))
                trail.setLineCapStyle_(1)
                trail.stroke()

                # Core line
                _c(1.0, 1.0, 0.9, 0.80 * fade).set()
                core = NSBezierPath.bezierPath()
                core.moveToPoint_(tail)
                core.lineToPoint_(head)
                core.setLineWidth_(max(0.4, base * 0.2))
                core.setLineCapStyle_(1)
                core.stroke()

                # Spark tip dot
                _c(1.0, 1.0, 0.85, 0.9 * fade).set()
                _fill_oval(head[0], head[1], max(0.6, base * 0.3), max(0.6, base * 0.3))

    # ── Info ───────────────────────────────────────────────

    def _draw_info(self, w, y0, y1):
        la = _make_attrs(F_SM, (0.4, 0.4, 0.4, 1.0))
        ta = _make_attrs(F_SM, (0.5, 0.5, 0.5, 1.0))
        pa = _make_attrs(F_LG, PXY_TXT)
        da = _make_attrs(F_LG, DIR_TXT)

        _draw_text("当前速度 (↑上传 / ↓下载)", PAD, y1 - 14, la)
        _draw_text(f"代理  {_fmts(self._pso)} ↑  {_fmts(self._psi)} ↓", PAD, y1 - 36, pa)
        direct_x = PAD + 210
        _draw_text(f"直连  {_fmts(self._dso)} ↑  {_fmts(self._dsi)} ↓", direct_x, y1 - 36, da)

        _draw_text(f"代理累计: {_fmt(self._tpo + self._tpi)}", PAD, y1 - 56, ta)
        _draw_text(f"直连累计: {_fmt(self._tdo + self._tdi)}", direct_x, y1 - 56, ta)

        # Ratio bar
        bx, bw, bh, by = w - 240, 220, 6, y1 - 22
        pt = self._tpo + self._tpi
        dt = self._tdo + self._tdi
        tot = pt + dt
        pr = pt / tot if tot > 0 else 0.5
        dr = dt / tot if tot > 0 else 0.5

        _c(0, 0, 0, 0.06).set()
        _fill_rect(bx, by, bw, bh)
        if pr > 0.003:
            _set_color(PXY_RATIO)
            _fill_rect(bx, by, max(3, bw*pr), bh)
        if dr > 0.003:
            _set_color(DIR_RATIO)
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
        Points outside [left_x, right_x] are clipped. The fill starts at the
        first real data point so startup gaps remain empty."""
        if len(pts) < 2:
            return None
        visible = _visible_curve_points(pts, left_x, right_x)
        if len(visible) < 2:
            return None

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
        visible = _visible_curve_points(pts, left_x, right_x)
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
        if cw <= 0 or ch <= 0:
            return
        _c(0, 0, 0, 0.06).set()
        _fill_rect(PAD, y0, cw, ch)

        NSGraphicsContext.saveGraphicsState()
        clip = NSBezierPath.bezierPathWithRect_(((PAD, y0), (cw, ch)))
        clip.addClip()
        try:
            self._draw_chart_contents(w, y0, y1, cw, ch)
        finally:
            NSGraphicsContext.restoreGraphicsState()

    def _draw_chart_contents(self, w, y0, y1, cw, ch):
        gx = PAD + 4
        gw = cw - 8
        gy = y0 + 4
        gh = ch - 22
        if gw <= 0 or gh <= 0:
            return

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

        self._fill_curve_gradient(direct_pts, left_x, right_x, baseline, DIR_TXT)
        self._fill_curve_gradient(proxy_pts, left_x, right_x, baseline, PXY_TXT)
        self._stroke_curve(proxy_pts, left_x, right_x, PXY_TXT, 2.0)
        self._stroke_curve(direct_pts, left_x, right_x, DIR_TXT, 2.0)

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
