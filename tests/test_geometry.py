import math

import numpy as np
import pytest

from facescan.core import geometry as g


def test_angle_at_right_angle_and_straight():
    assert g.angle_at([1, 0], [0, 0], [0, 1]) == pytest.approx(90.0)
    assert g.angle_at([1, 0], [0, 0], [-1, 0]) == pytest.approx(180.0)
    assert g.angle_at([1, 0], [0, 0], [1, 1]) == pytest.approx(45.0)


def test_signed_point_line_distance():
    a, b = np.array([0.0, 0.0]), np.array([10.0, 0.0])
    # image coordinates (y down): a point below the line lies to the right of a→b on screen
    assert g.signed_point_line_distance([5, 3], a, b) == pytest.approx(3.0)
    assert g.signed_point_line_distance([5, -2], a, b) == pytest.approx(-2.0)


def test_projection_onto_line():
    p = g.project_onto_line([3, 4], [0, 0], [10, 0])
    assert p == pytest.approx([3, 0])


def test_face_axes_projections_and_roll():
    right, left = np.array([100.0, 200.0]), np.array([200.0, 200.0])
    ax = g.FaceAxes.from_medial_canthi(right, left)
    assert ax.h(left) == pytest.approx(50.0)
    assert ax.v([150, 260]) == pytest.approx(60.0)  # below the canthi → positive
    rot = np.radians(10)
    left_r = right + 100 * np.array([math.cos(rot), math.sin(rot)])
    ax_r = g.FaceAxes.from_medial_canthi(right, left_r)
    assert ax_r.roll_deg == pytest.approx(10.0)
    p = ax_r.to_image(12.0, -7.0)
    assert (ax_r.h(p), ax_r.v(p)) == pytest.approx((12.0, -7.0))


def test_fit_line_recovers_direction():
    t = np.linspace(0, 10, 20)
    pts = np.column_stack([t, 2 * t + 1])
    c, d = g.fit_line(pts)
    assert abs(d[1] / d[0]) == pytest.approx(2.0)
    assert d[0] > 0  # oriented first → last


def test_polyline_intersection():
    poly = np.array([[0, 0], [0, 10], [10, 10]], dtype=float)
    hits = g.intersect_polyline_with_line(poly, np.array([-5.0, 4.0]), np.array([1.0, 0.0]))
    assert len(hits) == 1 and hits[0] == pytest.approx([0, 4])


def test_refine_peak_symmetric_and_edges():
    x, y, j = g.refine_peak([0, 1, 2, 3, 4], [0, 3, 4, 3, 0])
    assert (x, y, j) == pytest.approx((2.0, 4.0, 2))
    x, _, j = g.refine_peak([0, 1, 2], [5, 1, 0])
    assert (x, j) == (0.0, 0)


def test_similarity_transform_roundtrip():
    rng = np.random.default_rng(0)
    src = rng.normal(size=(30, 2)) * 50
    th = np.radians(12)
    R = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]])
    dst = 1.3 * src @ R.T + [7, -3]
    A = g.similarity_transform(src, dst)
    assert g.apply_affine(A, src) == pytest.approx(dst, abs=1e-9)
    assert g.apply_affine(g.invert_affine(A), dst) == pytest.approx(src, abs=1e-9)
