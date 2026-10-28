/**
 * Focal length in pixels from EXIF: an exact port of `camera_from_exif` in
 * `facescan/core/normalize.py`. Used only for HEIC photos, which are
 * converted to JPEG in the browser: the server reads EXIF itself for every other photo.
 * tests/capture.test.ts checks the port against the core's values (fixtures/exif_focal.json).
 */

/** exifr's names for the tags the core reads. */
export interface FocalTags {
  FocalLengthIn35mmFormat?: number | null;
  FocalLength?: number | null;
  FocalPlaneXResolution?: number | null;
  FocalPlaneResolutionUnit?: number | null;
  /** PixelXDimension: the width of the image the camera stored. */
  ExifImageWidth?: number | null;
}

/** 35 mm film frame diagonal (36 × 24 mm): CIPA DC-008 defines the 35 mm equivalent on it. */
export const FULL_FRAME_DIAGONAL_MM = Math.hypot(36, 24);
const MM_PER_UNIT: Readonly<Record<number, number>> = { 2: 25.4, 3: 10, 4: 1, 5: 0.001 }; // inch, cm, mm, µm

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * `rawWidth` × `rawHeight`: the stored size before orientation. Rotation does not change
 * the focal length in pixels. Returns null when EXIF gives no plausible value.
 */
export function focalFromExif(tags: FocalTags, rawWidth: number, rawHeight: number): number | null {
  const diag = Math.hypot(rawWidth, rawHeight);
  let focal: number | null = null;
  const f35 = num(tags.FocalLengthIn35mmFormat);
  if (f35 !== null && f35 > 0) {
    focal = (f35 * diag) / FULL_FRAME_DIAGONAL_MM;
  } else {
    const f = num(tags.FocalLength);
    const res = num(tags.FocalPlaneXResolution);
    const unit = Math.trunc(num(tags.FocalPlaneResolutionUnit) ?? 2);
    const mmPerUnit = MM_PER_UNIT[unit];
    if (f !== null && res !== null && f > 0 && res > 0 && mmPerUnit !== undefined) {
      const sensorWidth = num(tags.ExifImageWidth);
      const shrink = sensorWidth !== null && sensorWidth > 0 ? rawWidth / sensorWidth : 1;
      focal = f * (res / mmPerUnit) * shrink;
    }
  }
  if (focal === null || !(0.2 * diag < focal && focal < 20 * diag)) return null;
  return focal;
}
