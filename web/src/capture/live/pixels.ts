/**
 * The pixel gates, sharpness and exposure, ported from `quality.face_roi` and
 * `quality.image_checks`: the face-oval box of the frame is resized to
 * `roi_width_px` wide, the face is the convex hull of the oval, sharpness is the variance of
 * the Laplacian inside the face (eroded away from its edge), and exposure is the face's
 * luma. The OpenCV operations the core uses are ported here: `resize` (INTER_AREA to reduce,
 * INTER_LINEAR to enlarge, both for 8-bit RGB), `cvtColor` to gray, `fillPoly` of the hull,
 * `erode` and `Laplacian` (3 × 3).
 *
 * The ports follow OpenCV's arithmetic but not every rounding step of its vector code, so
 * values can differ slightly from the core's: tests/live.test.ts states the tolerance.
 */
import type { FrameInfo, Gates, QualityCheck } from "./gates";
import { FACE_OVAL_RING } from "./mesh";

/** Pixels of a frame around the face: `width` × `height` from (`left`, `top`) of the frame. */
export interface Region {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  /** 4 for canvas ImageData (RGBA), 3 for RGB. */
  channels: 3 | 4;
  left: number;
  top: number;
}

/** A box in frame pixels: x0 ≤ x < x1, y0 ≤ y < y1. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Python's `round` and NumPy's `np.round`: halves go to the even neighbour. */
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** The face-oval bounding box, clipped to the frame, as `face_roi` crops it. */
export function faceBox(xy: ReadonlyArray<readonly [number, number]>, width: number, height: number): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const i of FACE_OVAL_RING) {
    const [x, y] = xy[i]!;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return {
    x0: Math.max(Math.floor(minX), 0),
    y0: Math.max(Math.floor(minY), 0),
    x1: Math.min(Math.ceil(maxX), width),
    y1: Math.min(Math.ceil(maxY), height),
  };
}

/** Whether `face_roi` can read the box: at least 8 × 8 pixels. */
export function readableBox(box: Box): boolean {
  return box.x1 - box.x0 >= 8 && box.y1 - box.y0 >= 8;
}

interface Rgb {
  data: Uint8Array;
  width: number;
  height: number;
}

/** The box's pixels as packed RGB. */
function crop(region: Region, box: Box): Rgb {
  const width = box.x1 - box.x0;
  const height = box.y1 - box.y0;
  const out = new Uint8Array(width * height * 3);
  const c = region.channels;
  for (let y = 0; y < height; y++) {
    const ry = box.y0 - region.top + y;
    if (ry < 0 || ry >= region.height) throw new Error("the region does not cover the face box");
    for (let x = 0; x < width; x++) {
      const rx = box.x0 - region.left + x;
      if (rx < 0 || rx >= region.width) throw new Error("the region does not cover the face box");
      const s = (ry * region.width + rx) * c;
      const d = (y * width + x) * 3;
      out[d] = region.data[s]!;
      out[d + 1] = region.data[s + 1]!;
      out[d + 2] = region.data[s + 2]!;
    }
  }
  return { data: out, width, height };
}

// ---------------------------------------------------------------- resize (8-bit, 3 channels)

interface Tap {
  di: number;
  si: number;
  alpha: number;
}

/** OpenCV's `computeResizeAreaTab`: source pixels and their weights for each output pixel. */
function areaTab(ssize: number, dsize: number, scale: number): Tap[] {
  const tab: Tap[] = [];
  for (let dx = 0; dx < dsize; dx++) {
    const fsx1 = dx * scale;
    const fsx2 = fsx1 + scale;
    const cellWidth = Math.min(scale, ssize - fsx1);
    let sx1 = Math.ceil(fsx1);
    const sx2 = Math.min(Math.floor(fsx2), ssize - 1);
    sx1 = Math.min(sx1, sx2);
    if (sx1 - fsx1 > 1e-3) tab.push({ di: dx, si: sx1 - 1, alpha: Math.fround((sx1 - fsx1) / cellWidth) });
    for (let sx = sx1; sx < sx2; sx++) tab.push({ di: dx, si: sx, alpha: Math.fround(1 / cellWidth) });
    if (fsx2 - sx2 > 1e-3) tab.push({ di: dx, si: sx2, alpha: Math.fround(Math.min(Math.min(fsx2 - sx2, 1), cellWidth) / cellWidth) });
  }
  return tab;
}

/** `cv2.resize(…, INTER_AREA)` for reducing: each output pixel is the area average of its cell. */
export function resizeArea(src: Rgb, dw: number, dh: number): Rgb {
  const xtab = areaTab(src.width, dw, 1 / (dw / src.width));
  const ytab = areaTab(src.height, dh, 1 / (dh / src.height));
  const sum = new Float64Array(dw * dh * 3);
  const row = new Float64Array(dw * 3);
  for (const { di: dy, si: sy, alpha: beta } of ytab) {
    row.fill(0);
    const s0 = sy * src.width * 3;
    for (const { di, si, alpha } of xtab) {
      for (let c = 0; c < 3; c++) row[di * 3 + c]! += src.data[s0 + si * 3 + c]! * alpha;
    }
    const d0 = dy * dw * 3;
    for (let i = 0; i < dw * 3; i++) sum[d0 + i]! += beta * row[i]!;
  }
  const out = new Uint8Array(dw * dh * 3);
  for (let i = 0; i < out.length; i++) out[i] = Math.min(255, Math.max(0, roundHalfEven(sum[i]!)));
  return { data: out, width: dw, height: dh };
}

const COEF_BITS = 11;
const COEF_SCALE = 1 << COEF_BITS;

/** Linear taps for one axis, as OpenCV's `resize` sets them up (fixed point, 11 bits). */
function linearTaps(ssize: number, dsize: number, clampWeights: boolean): Array<{ s: number; a0: number; a1: number }> {
  const scale = 1 / (dsize / ssize);
  const taps = [];
  for (let d = 0; d < dsize; d++) {
    let f = Math.fround((d + 0.5) * scale - 0.5);
    let s = Math.floor(f);
    f = Math.fround(f - s);
    if (clampWeights) {
      // Columns: at the edges OpenCV uses the edge pixel alone.
      if (s < 0) {
        f = 0;
        s = 0;
      }
      if (s >= ssize - 1) {
        f = 0;
        s = ssize - 1;
      }
    }
    taps.push({ s, a0: roundHalfEven(Math.fround(1 - f) * COEF_SCALE), a1: roundHalfEven(f * COEF_SCALE) });
  }
  return taps;
}

/**
 * `cv2.resize(…, INTER_LINEAR)` for enlarging, 8-bit: fixed-point weights, a horizontal then
 * a vertical pass, with the rounding of OpenCV's vector code for the vertical pass.
 */
export function resizeLinear(src: Rgb, dw: number, dh: number): Rgb {
  const xs = linearTaps(src.width, dw, true);
  const ys = linearTaps(src.height, dh, false);
  const rows = new Map<number, Int32Array>();
  const hrow = (sy: number) => {
    const y = Math.min(Math.max(sy, 0), src.height - 1); // rows are clamped at the edges
    let r = rows.get(y);
    if (!r) {
      r = new Int32Array(dw * 3);
      const s0 = y * src.width * 3;
      for (let dx = 0; dx < dw; dx++) {
        const { s, a0, a1 } = xs[dx]!;
        const s1 = Math.min(s + 1, src.width - 1);
        for (let c = 0; c < 3; c++) {
          r[dx * 3 + c] = a1 === 0 && s === src.width - 1
            ? src.data[s0 + s * 3 + c]! * COEF_SCALE
            : src.data[s0 + s * 3 + c]! * a0 + src.data[s0 + s1 * 3 + c]! * a1;
        }
      }
      rows.set(y, r);
    }
    return r;
  };
  const out = new Uint8Array(dw * dh * 3);
  for (let dy = 0; dy < dh; dy++) {
    const { s, a0: b0, a1: b1 } = ys[dy]!;
    const r0 = hrow(s);
    const r1 = hrow(s + 1);
    for (let i = 0; i < dw * 3; i++) {
      // ((b0 · (r0 >> 4)) >> 16) + ((b1 · (r1 >> 4)) >> 16), then (+ 2) >> 2 (VResizeLinearVec_32s8u).
      const v = ((b0 * (r0[i]! >> 4)) >> 16) + ((b1 * (r1[i]! >> 4)) >> 16);
      out[dy * dw * 3 + i] = Math.min(255, Math.max(0, (v + 2) >> 2));
    }
  }
  return { data: out, width: dw, height: dh };
}

// ---------------------------------------------------------------- gray, face mask, filters

/** `cv2.cvtColor(…, COLOR_RGB2GRAY)` for 8-bit: fixed point with 14 bits. */
export function toGray(rgb: Rgb): Uint8Array {
  const n = rgb.width * rgb.height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgb.data[i * 3]!;
    const g = rgb.data[i * 3 + 1]!;
    const b = rgb.data[i * 3 + 2]!;
    out[i] = (r * 4899 + g * 9617 + b * 1868 + (1 << 13)) >> 14;
  }
  return out;
}

type Pt = readonly [number, number];

/** Convex hull (monotone chain), counter-clockwise in image coordinates' orientation. */
export function convexHull(points: readonly Pt[]): Pt[] {
  const pts = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** OpenCV's 8-connected line (`LineIterator`, left to right), clipped to the mask. */
function drawLine(mask: Uint8Array, w: number, h: number, a: Pt, b: Pt): void {
  let [x0, y0] = a;
  let [x1, y1] = b;
  if (x1 < x0) [x0, y0, x1, y1] = [x1, y1, x0, y0];
  let dx = x1 - x0;
  let dy = Math.abs(y1 - y0);
  const sy = y1 < y0 ? -1 : 1;
  const steep = dy > dx;
  if (steep) [dx, dy] = [dy, dx];
  let err = dx - (dy + dy);
  const plus = dx + dx;
  const minus = -(dy + dy);
  let x = x0;
  let y = y0;
  for (let i = 0; i <= dx; i++) {
    if (x >= 0 && x < w && y >= 0 && y < h) mask[y * w + x] = 255;
    const step = err < 0;
    err += minus + (step ? plus : 0);
    if (steep) {
      y += sy;
      if (step) x += 1;
    } else {
      x += 1;
      if (step) y += sy;
    }
  }
}

/** `cv2.fillPoly` of a convex polygon (8-connected edges): its edges and the spans between them. */
export function fillConvex(hull: readonly Pt[], w: number, h: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  if (hull.length === 0) return mask;
  const ys = hull.map((p) => p[1]);
  const top = Math.max(Math.min(...ys), 0);
  const bottom = Math.min(Math.max(...ys), h - 1);
  for (let y = top; y <= bottom; y++) {
    let xl = Infinity;
    let xr = -Infinity;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i]!;
      const b = hull[(i + 1) % hull.length]!;
      if (a[1] === b[1]) {
        if (a[1] === y) {
          xl = Math.min(xl, a[0], b[0]);
          xr = Math.max(xr, a[0], b[0]);
        }
      } else if (y >= Math.min(a[1], b[1]) && y <= Math.max(a[1], b[1])) {
        const x = a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
        xl = Math.min(xl, x);
        xr = Math.max(xr, x);
      }
    }
    if (xl > xr) continue;
    // The span between the two edges, each to the nearest pixel.
    const from = Math.max(Math.floor(xl + 0.5), 0);
    const to = Math.min(Math.floor(xr + 0.5), w - 1);
    mask.fill(255, y * w + from, y * w + to + 1);
  }
  for (let i = 0; i < hull.length; i++) drawLine(mask, w, h, hull[i]!, hull[(i + 1) % hull.length]!);
  return mask;
}

/**
 * `cv2.erode` with a k × k square (anchor at k / 2): the minimum over x − k/2 … x + k − 1 − k/2.
 * Pixels outside the image do not erode (OpenCV's default border value for erosion).
 */
export function erode(mask: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const before = Math.floor(k / 2);
  const after = k - 1 - before;
  const rows = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 255;
      for (let i = Math.max(0, x - before); i <= Math.min(w - 1, x + after); i++) m = Math.min(m, mask[y * w + i]!);
      rows[y * w + x] = m;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 255;
      for (let j = Math.max(0, y - before); j <= Math.min(h - 1, y + after); j++) m = Math.min(m, rows[j * w + x]!);
      out[y * w + x] = m;
    }
  }
  return out;
}

/** Index with OpenCV's default border (BORDER_REFLECT_101: … 2 1 | 0 1 2 … n−2 n−1 | n−2 …). */
function reflect101(i: number, n: number): number {
  if (n === 1) return 0;
  if (i < 0) return -i;
  if (i >= n) return 2 * n - 2 - i;
  return i;
}

/** `cv2.Laplacian(gray, CV_64F, ksize=3)`: the kernel [2 0 2; 0 −8 0; 2 0 2]. */
export function laplacian3(gray: Uint8Array, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const up = reflect101(y - 1, h) * w;
    const down = reflect101(y + 1, h) * w;
    for (let x = 0; x < w; x++) {
      const l = reflect101(x - 1, w);
      const r = reflect101(x + 1, w);
      out[y * w + x] = 2 * (gray[up + l]! + gray[up + r]! + gray[down + l]! + gray[down + r]!) - 8 * gray[y * w + x]!;
    }
  }
  return out;
}

// ---------------------------------------------------------------- the checks

export interface FaceRoi {
  gray: Uint8Array;
  /** 255 inside the face (the convex hull of the oval), 0 outside. */
  mask: Uint8Array;
  width: number;
  height: number;
}

/** `quality.face_roi`: the face box resized to `roiWidth` wide, gray, and its face mask; null if too small. */
export function faceRoi(region: Region, xy: ReadonlyArray<readonly [number, number]>, frame: FrameInfo, roiWidth: number): FaceRoi | null {
  const box = faceBox(xy, frame.width, frame.height);
  if (!readableBox(box)) return null;
  const src = crop(region, box);
  const s = roiWidth / src.width;
  const dh = Math.max(8, roundHalfEven(src.height * s));
  const resized = s < 1 ? resizeArea(src, roiWidth, dh) : resizeLinear(src, roiWidth, dh);
  const poly = FACE_OVAL_RING.map((i) => {
    const [x, y] = xy[i]!;
    return [roundHalfEven((x - box.x0) * s), roundHalfEven((y - box.y0) * s)] as const;
  });
  return { gray: toGray(resized), mask: fillConvex(convexHull(poly), roiWidth, dh), width: roiWidth, height: dh };
}

function variance(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  let sq = 0;
  for (const v of values) sq += (v - mean) * (v - mean);
  return sq / values.length;
}

function unreadable(gates: Gates): QualityCheck[] {
  return [
    { id: "sharpness", value: null, limit: gates.sharpness_min, passed: false, status: "fail", hintKey: "hint.hold_still" },
    { id: "exposure_mean", value: null, limit: [gates.exposure_mean_min, gates.exposure_mean_max], passed: false, status: "fail", hintKey: "hint.more_light" },
    { id: "exposure_clipped_frac", value: null, limit: gates.exposure_clipped_max_frac, passed: false, status: "fail", hintKey: "hint.avoid_glare" },
  ];
}

/**
 * Sharpness and exposure (`quality.image_checks`). `region` must cover the face box of the
 * frame (`faceBox`); null when it could not be read, which fails the three checks as the core
 * does for a face too small to crop.
 */
export function imageChecks(region: Region | null, xy: ReadonlyArray<readonly [number, number]>, frame: FrameInfo, gates: Gates): QualityCheck[] {
  const roi = region ? faceRoi(region, xy, frame, gates.roi_width_px) : null;
  if (!roi) return unreadable(gates);
  const { gray, mask, width, height } = roi;
  // Sharpness inside the face, away from the face/background edge.
  const k = Math.max(3, Math.floor(gates.roi_width_px / 20));
  const inner = erode(mask, width, height, k);
  const lap = laplacian3(gray, width, height);
  const inside: number[] = [];
  const luma: number[] = [];
  for (let i = 0; i < gray.length; i++) {
    if (inner[i]! > 0) inside.push(lap[i]!);
    if (mask[i]! > 0) luma.push(gray[i]!);
  }
  const sharp = inside.length > 0 ? variance(inside) : 0;
  let total = 0;
  let clipped = 0;
  for (const v of luma) {
    total += v;
    if (v <= gates.exposure_clip_low || v >= gates.exposure_clip_high) clipped++;
  }
  const mean = total / luma.length;
  const clippedFrac = clipped / luma.length;
  const exposureHint = mean < gates.exposure_mean_min ? "hint.more_light" : "hint.less_light";
  const status = (ok: boolean): "pass" | "fail" => (ok ? "pass" : "fail");
  const sharpOk = sharp >= gates.sharpness_min;
  const meanOk = gates.exposure_mean_min <= mean && mean <= gates.exposure_mean_max;
  const clipOk = clippedFrac < gates.exposure_clipped_max_frac;
  return [
    { id: "sharpness", value: sharp, limit: gates.sharpness_min, passed: sharpOk, status: status(sharpOk), hintKey: sharpOk ? null : "hint.hold_still" },
    {
      id: "exposure_mean",
      value: mean,
      limit: [gates.exposure_mean_min, gates.exposure_mean_max],
      passed: meanOk,
      status: status(meanOk),
      hintKey: meanOk ? null : exposureHint,
    },
    {
      id: "exposure_clipped_frac",
      value: clippedFrac,
      limit: gates.exposure_clipped_max_frac,
      passed: clipOk,
      status: status(clipOk),
      hintKey: clipOk ? null : "hint.avoid_glare",
    },
  ];
}
