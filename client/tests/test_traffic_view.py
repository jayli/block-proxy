import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from traffic_view import (
    _impact_wave,
    _particles_can_collide,
    _spark_count,
    _spark_line,
    _visible_curve_points,
)


def test_visible_curve_points_do_not_extend_to_left_edge_before_data_arrives():
    pts = [(90.0, 20.0), (100.0, 18.0), (110.0, 22.0)]

    visible = _visible_curve_points(pts, left_x=10.0, right_x=120.0)

    assert visible[0] == (90.0, 20.0)


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


def test_spark_count_is_bounded():
    for intensity in (0.6, 1.0, 1.6):
        count = _spark_count(intensity)
        assert 3 <= count <= 7
