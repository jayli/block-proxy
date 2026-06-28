import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from traffic_view import _impact_wave, _particles_can_collide, _visible_curve_points


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
