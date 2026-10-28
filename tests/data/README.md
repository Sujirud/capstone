# Test data

Only public-domain images are committed here, each with its source below.

| File | Source | License | Notes |
|---|---|---|---|
| `astronaut.png` | scikit-image sample data (`skimage/data/astronaut.png`, v0.19.3); NASA photograph of Eileen Collins | Public domain (NASA) | 512 × 512. The face is too small for the face-size gate, so analyses end with `quality_failed`, which is what the smoke tests expect. |
| `profile_lathe_operator_1942.jpg` | Howard R. Hollem, "Turret lathe operator machining parts for transport planes…", Fort Worth, Texas, October 1942. Library of Congress, digital ID fsac.1a34951 (Wikimedia Commons: `WomanFactory1940s.jpg`) | Public domain (U.S. Office of War Information) | Head crop, downscaled to 900 × 1000. Near-profile facing right on a dark background; the shirt collar touches the chin, so the expected result is `contour_failed` (chin underside not visible). |
| `profile_pollaiuolo_painting.jpg` | Piero del Pollaiuolo, *Profile Portrait of a Young Lady*, c. 1465, Gemäldegalerie Berlin (Google Art Project scan on Wikimedia Commons) | Public domain | Downscaled to 1000 px high. Painted profile facing left on a plain sky background, neck visible. Its idealized straight forehead–nose line has no anatomical nasion concavity, so the expected result is `contour_failed` (`nasion_not_found`). |

The profile pipeline's `ok` path is tested on synthetic profiles (`tests/profile_synth.py`)
with known landmarks and a colour-based fake segmenter. Blank, two-face and
EXIF-oriented images are generated inside the tests and never written to the repository.
