import json

import numpy as np
import pytest

from facescan.apps.webcam_capture import GuidedCapture, OneEuroFilter, focal_from_hfov
from facescan.tools.evaluate import bland_altman, icc_1_1
from helpers import DATA, MODELS, models_available


def test_guided_capture_needs_consecutive_passes_and_keeps_the_sharpest():
    g = GuidedCapture(needed=4, keep=2)
    frames = [np.full((2, 2, 3), i, np.uint8) for i in range(6)]
    assert not g.update(True, frames[0], 1.0)
    assert not g.update(False, None, 0.0)      # a failing frame resets the streak
    assert g.streak == 0 and g.kept == []
    for i, score in zip(range(1, 5), [5.0, 1.0, 9.0, 3.0]):
        ready = g.update(True, frames[i], score)
    assert ready and g.streak == 4
    kept = g.take()
    assert [int(f[0, 0, 0]) for f in kept] == [1, 3]  # two sharpest, in capture order
    assert g.streak == 0


def test_one_euro_smooths_but_follows():
    f = OneEuroFilter(min_cutoff=1.0, beta=0.0)
    assert f(0.0, 0.0) == 0.0
    y = f(10.0, 0.033)
    assert 0.0 < y < 10.0
    for k in range(2, 200):
        y = f(10.0, 0.033 * k)
    assert y == pytest.approx(10.0, abs=1e-3)


def test_focal_from_hfov():
    assert focal_from_hfov(3840, 90.0) == pytest.approx(1920.0)


def test_icc_and_bland_altman():
    assert icc_1_1([[1.0, 1.0], [5.0, 5.0], [9.0, 9.0]]) == pytest.approx(1.0)
    assert icc_1_1([[1.0, 2.0]]) is None
    ba = bland_altman([1.0, -1.0, 1.0, -1.0])
    assert ba["mean_diff"] == 0.0 and ba["loa_high"] == pytest.approx(1.96 * np.std([1, -1, 1, -1], ddof=1))


@pytest.mark.skipif(not models_available(), reason="models missing")
def test_cli_writes_outputs_only_to_out_dir(tmp_path):
    from facescan.apps.analyze_image import main

    out = tmp_path / "out"
    rc = main([str(DATA / "astronaut.png"), "--sex", "female", "--age", "30", "--out-dir", str(out),
               "--models-dir", str(MODELS), "--styles", "user", "clinical", "--locale", "en"])
    assert rc == 0
    assert sorted(p.name for p in out.iterdir()) == ["overlay_clinical.png", "overlay_user.png", "result.json",
                                                      "user_view_en.json"]
    assert json.loads((out / "result.json").read_text())["status"] == "quality_failed"


@pytest.mark.skipif(not models_available(), reason="models missing")
def test_cli_profile_mode(tmp_path):
    from facescan.apps.analyze_image import main

    out = tmp_path / "out"
    rc = main([str(DATA / "profile_pollaiuolo_painting.jpg"), "--view", "profile", "--facing", "left",
               "--sex", "female", "--age", "30", "--out-dir", str(out), "--models-dir", str(MODELS),
               "--styles", "user", "clinical", "--override", "alar_crease=190,330"])
    assert rc == 0
    res = json.loads((out / "result.json").read_text())
    assert res["view"] == "profile" and res["status"] == "contour_failed"
    assert res["landmarks"]["alar_crease"]["source"] == "user_adjusted"
    assert (out / "overlay_clinical.png").exists()
    with pytest.raises(SystemExit):
        main([str(DATA / "profile_pollaiuolo_painting.jpg"), "--view", "profile", "--sex", "female",
              "--age", "30", "--out-dir", str(out)])   # --facing missing
