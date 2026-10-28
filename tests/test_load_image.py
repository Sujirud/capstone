import io
import math

import numpy as np
import pytest
from PIL import Image

from facescan import CameraInfo, ImageDecodeError, LoadedImage, load_image


def _jpeg(exif=None, size=(40, 20)):
    im = Image.new("RGB", size, (0, 0, 255))
    im.paste((255, 0, 0), (0, 0, size[0] // 2, size[1]))  # left half red
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=95, **({"exif": exif} if exif is not None else {}))
    return buf.getvalue()


def test_exif_orientation_is_applied():
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90° clockwise for display
    img = load_image(_jpeg(exif))
    assert (img.width, img.height) == (20, 40)
    assert img.pixels[2, 10, 0] > 200 and img.pixels[2, 10, 2] < 50     # original left (red) is now on top
    assert img.pixels[37, 10, 2] > 200 and img.pixels[37, 10, 0] < 50   # blue at the bottom


def test_focal_from_35mm_equivalent_uses_the_diagonal():
    exif = Image.Exif()
    exif[0x0112] = 6
    exif.get_ifd(0x8769)[0xA405] = 26
    img = load_image(_jpeg(exif))
    assert img.camera.source == "exif"
    assert img.camera.focal_px == pytest.approx(26 * math.hypot(40, 20) / math.hypot(36, 24))


def test_focal_from_focal_length_and_sensor_resolution():
    exif = Image.Exif()
    ifd = exif.get_ifd(0x8769)
    ifd[0x920A] = 4.2        # focal length, mm
    ifd[0xA20E] = 1000.0     # focal-plane resolution: 1000 px per cm
    ifd[0xA210] = 3          # unit: cm
    ifd[0xA002] = 80         # sensor image width; the stored image is 40 px wide (downscaled 2×)
    img = load_image(_jpeg(exif))
    assert img.camera.focal_px == pytest.approx(4.2 * 100 * 0.5)


def test_caller_camera_wins_over_exif_and_png_without_exif_has_no_camera():
    exif = Image.Exif()
    exif.get_ifd(0x8769)[0xA405] = 26
    cam = CameraInfo(focal_px=2890.0, source="device")
    assert load_image(_jpeg(exif), camera=cam).camera == cam
    buf = io.BytesIO()
    Image.new("RGB", (8, 8)).save(buf, "PNG")
    assert load_image(buf.getvalue()).camera is None


def test_sha256_is_of_decoded_pixels_and_from_array_bgr():
    data = _jpeg()
    a, b = load_image(data), load_image(data)
    assert a.sha256 == b.sha256 and len(a.sha256) == 64
    bgr = np.ascontiguousarray(a.pixels[:, :, ::-1])
    c = LoadedImage.from_array(bgr, channel_order="bgr")
    assert c.sha256 == a.sha256
    assert not c.pixels.flags.writeable
    d = LoadedImage.from_array(np.zeros((5, 4, 3), np.uint8))
    e = LoadedImage.from_array(np.zeros((4, 5, 3), np.uint8))
    assert d.sha256 != e.sha256


def test_undecodable_and_unsupported_formats_raise():
    with pytest.raises(ImageDecodeError):
        load_image(b"not an image")
    buf = io.BytesIO()
    Image.new("RGB", (8, 8)).save(buf, "BMP")
    with pytest.raises(ImageDecodeError):
        load_image(buf.getvalue())
