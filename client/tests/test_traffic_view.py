import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import traffic_view
from traffic_view import (
    DIR_IN,
    DIR_RATIO,
    DIR_TXT,
    PXY_IN,
    PXY_RATIO,
    PXY_TXT,
    TrafficView,
    _flow_wave_offset,
    _impact_wave,
    _particles_can_collide,
    _reflection_alpha,
    _reflection_ellipse,
    _reflection_point,
    _water_surface_y,
    _spark_count,
    _spark_line,
    _spark_speed,
    _visible_curve_points,
)


class _FakeSize:
    width = 320
    height = 220


class _FakeFrame:
    size = _FakeSize()


class _FakeTrafficView:
    def __init__(self):
        self._in_ = []
        self._frame_n = 0
        self._psi = 60 * 1024
        self._pso = 0
        self._dso = 0

    def frame(self):
        return _FakeFrame()


def test_visible_curve_points_do_not_extend_to_left_edge_before_data_arrives():
    pts = [(90.0, 20.0), (100.0, 18.0), (110.0, 22.0)]

    visible = _visible_curve_points(pts, left_x=10.0, right_x=120.0)

    assert visible[0] == (90.0, 20.0)


def test_proxy_inbound_palette_uses_electric_violet_tones():
    assert PXY_IN == (
        (0.4, 1.0, 0.0, 1.0),
        (0.6, 1.0, 0.2, 1.0),
    )


def test_direct_inbound_palette_uses_premium_red_violet_tones():
    assert DIR_IN == (
        (0.86, 0.24, 1.0, 1.0),
        (0.98, 0.18, 0.42, 1.0),
    )


def test_ratio_bar_uses_separate_emerald_and_sky_blue_colors():
    assert PXY_RATIO == (0.0, 0.82, 0.55, 1.0)
    assert DIR_RATIO == (0.0, 0.62, 1.0, 1.0)
    assert PXY_RATIO != PXY_TXT
    assert DIR_RATIO != DIR_TXT


def test_flow_band_uses_three_distinct_colored_strands():
    strands = traffic_view._flow_strands(proxy_fraction=0.62)
    colors = [strand[0] for strand in strands]

    assert len(strands) == 3
    assert len(set(colors)) == 3
    assert traffic_view.FLOW_ACCENT in colors


def test_flow_line_width_transitions_smoothly_and_caps_peak_thickness():
    idle = traffic_view._flow_line_width(0.0)
    mid = traffic_view._flow_line_width(0.5)
    peak = traffic_view._flow_line_width(1.0)

    assert idle == 1.2
    assert idle < mid < peak
    assert peak <= 3.5 * 2.0 / 3.0


def test_water_surface_sits_in_lower_pipe_band():
    assert _water_surface_y(100.0, 200.0) == 168.0


def test_reflection_point_mirrors_particle_into_water_with_wave_distortion():
    still_x, still_y = _reflection_point(
        px=120.0, py=140.0, surface_y=168.0, scroll=0.0, phase=0.0)
    wave_x, wave_y = _reflection_point(
        px=120.0, py=140.0, surface_y=168.0, scroll=24.0, phase=9.0)

    assert 184.0 < still_y < 188.0
    assert abs(still_x - 120.0) < 3.0
    assert (wave_x, wave_y) != (still_x, still_y)


def test_reflection_fades_as_particles_touch_or_sink_below_surface():
    above = _reflection_alpha(py=140.0, surface_y=168.0, bottom_y=200.0, op=0.9)
    near_surface = _reflection_alpha(py=166.0, surface_y=168.0, bottom_y=200.0, op=0.9)
    below = _reflection_alpha(py=174.0, surface_y=168.0, bottom_y=200.0, op=0.9)

    assert above > near_surface > below
    assert below == 0.0


def test_reflection_ellipse_is_wider_and_flatter_than_particle():
    rx, ry = _reflection_ellipse(3.0)

    assert rx > 3.0
    assert ry < 3.0


def test_inbound_burst_particles_have_slightly_smaller_max_radius(monkeypatch):
    ranges = []

    def record_uniform(lo, hi):
        ranges.append((lo, hi))
        return lo

    monkeypatch.setattr("traffic_view.random.uniform", record_uniform)
    monkeypatch.setattr("traffic_view.random.random", lambda: 0.0)
    monkeypatch.setattr("traffic_view.random.choice", lambda values: values[0])

    view = _FakeTrafficView()
    TrafficView._spawn_in(view, total=60 * 1024)

    assert (2.25, 2.8) in ranges
    assert (3.0, 6.5) not in ranges


def test_inbound_regular_particles_are_quarter_smaller(monkeypatch):
    ranges = []

    def record_uniform(lo, hi):
        ranges.append((lo, hi))
        return lo

    monkeypatch.setattr("traffic_view.random.uniform", record_uniform)
    monkeypatch.setattr("traffic_view.random.random", lambda: 0.0)
    monkeypatch.setattr("traffic_view.random.choice", lambda values: values[0])

    view = _FakeTrafficView()
    view._psi = 2 * 1024
    TrafficView._spawn_in(view, total=2 * 1024)

    assert (1.65, 3.0) in ranges
    assert (2.2, 4.0) not in ranges


def test_particles_can_collide_when_position_and_size_are_close():
    out = {"x": 100.0, "y": 50.0, "r": 3.0}
    inc = {"x": 106.0, "y": 56.0, "r": 3.5}

    assert _particles_can_collide(out, inc, x_tol=8.0, y_tol=10.0, r_tol=0.8)


def test_particles_do_not_collide_when_size_differs_too_much():
    out = {"x": 100.0, "y": 50.0, "r": 2.0}
    inc = {"x": 104.0, "y": 54.0, "r": 4.0}

    assert not _particles_can_collide(out, inc, x_tol=8.0, y_tol=10.0, r_tol=0.8)


def test_impact_wave_expands_and_fades():
    early_r, early_a = _impact_wave(base=3.0, t=0.2)
    late_r, late_a = _impact_wave(base=3.0, t=0.8)

    assert late_r > early_r
    assert late_a < early_a


def test_flow_wave_offset_is_not_a_plain_sine():
    x, scroll, phase, freq, amp, weight = 120.0, 18.0, 25.0, 1.15, 12.0, 0.8
    plain = math.sin((x + scroll + phase) / (38.0 * freq)) * amp * weight

    assert _flow_wave_offset(x, scroll, phase, freq, amp, weight) != plain


def test_flow_wave_offset_stays_continuous():
    pts = [
        _flow_wave_offset(float(x), 22.0, 50.0, 1.2, 18.0, 0.75)
        for x in range(0, 96, 4)
    ]
    jumps = [abs(pts[i] - pts[i - 1]) for i in range(1, len(pts))]

    assert max(jumps) < 6.0


def test_spark_line_intensity_makes_line_longer_and_farther():
    low = _spark_line(100.0, 50.0, 40.0, 0.0, t=0.5, intensity=0.8)
    high = _spark_line(100.0, 50.0, 40.0, 0.0, t=0.5, intensity=1.4)

    assert high[0][0] > low[0][0]
    assert (high[0][0] - high[1][0]) > (low[0][0] - low[1][0])


def test_spark_line_length_scale_stays_within_current_maximum():
    full = _spark_line(100.0, 50.0, 40.0, 0.0, t=0.0, intensity=1.6, length_scale=1.0)
    short = _spark_line(100.0, 50.0, 40.0, 0.0, t=0.0, intensity=1.6, length_scale=0.5)

    assert (short[0][0] - short[1][0]) < (full[0][0] - full[1][0])
    assert (full[0][0] - full[1][0]) <= 8.5


def test_spark_line_travel_eases_out():
    start = _spark_line(100.0, 50.0, 40.0, 0.0, t=0.0, intensity=1.0)
    early = _spark_line(100.0, 50.0, 40.0, 0.0, t=0.2, intensity=1.0)
    late = _spark_line(100.0, 50.0, 40.0, 0.0, t=0.8, intensity=1.0)
    end = _spark_line(100.0, 50.0, 40.0, 0.0, t=1.0, intensity=1.0)

    early_step = early[0][0] - start[0][0]
    late_step = end[0][0] - late[0][0]

    assert early_step > late_step * 1.5


def test_spark_count_is_bounded():
    for intensity in (0.6, 1.0, 1.6):
        count = _spark_count(intensity)
        assert 3 <= count <= 7


def test_spark_speed_radius_is_slightly_smaller():
    assert _spark_speed(1.0, unit=0.0) == 50.0
    assert _spark_speed(1.0, unit=1.0) == 82.0
