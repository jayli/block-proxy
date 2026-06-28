import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from traffic_view import _visible_curve_points


def test_visible_curve_points_do_not_extend_to_left_edge_before_data_arrives():
    pts = [(90.0, 20.0), (100.0, 18.0), (110.0, 22.0)]

    visible = _visible_curve_points(pts, left_x=10.0, right_x=120.0)

    assert visible[0] == (90.0, 20.0)
