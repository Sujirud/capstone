/**
 * The frontal capture gates, ported from `facescan/core/quality.py`: the same
 * checks, limits, hint keys and order, computed from the detector's outputs for one video
 * frame, with the thresholds from `client-config.frontal.gates`. They are guidance only: the
 * server runs every gate again on the frames it receives.
 *
 * tests/live.test.ts checks the port against the core's values for the same detector outputs
 * (fixtures/live_gates.json), and these constants against the core's.
 */
import type { ClientConfig } from "../../api/schemas";
import type { CameraIn } from "../CaptureSource";
import { FACE_OVAL_RING, IRIS, NUM_MESH_POINTS } from "./mesh";
import { imageChecks, type Region } from "./pixels";

export type Gates = ClientConfig["frontal"]["gates"];

/** `quality.CHECK_ORDER`: the order of checks, and so of hints. */
export const CHECK_ORDER = [
  "face_count",
  "face_in_frame",
  "camera_distance_m",
  "yaw_deg",
  "pitch_deg",
  "roll_deg",
  "expression_jawOpen",
  "expression_mouthSmileLeft",
  "expression_mouthSmileRight",
  "expression_eyeBlinkLeft",
  "expression_eyeBlinkRight",
  "expression_browInnerUp",
  "ipd_px",
  "sharpness",
  "exposure_mean",
  "exposure_clipped_frac",
  "burst_good_frames",
] as const;

/** `quality._EXPRESSION_HINTS`; any other blendshape gets `hint.neutral_expression`. */
export const EXPRESSION_HINTS: Readonly<Record<string, string>> = {
  jawOpen: "hint.close_mouth",
  mouthSmileLeft: "hint.relax_smile",
  mouthSmileRight: "hint.relax_smile",
  eyeBlinkLeft: "hint.open_eyes",
  eyeBlinkRight: "hint.open_eyes",
  browInnerUp: "hint.relax_brows",
};

export type CheckStatus = "pass" | "fail" | "unverified";

/** `schema.QualityCheck`: the hint key is kept only when the check did not pass. */
export interface QualityCheck {
  id: string;
  value: number | null;
  limit: number | readonly number[];
  passed: boolean;
  status: CheckStatus;
  hintKey: string | null;
}

/** One detected face, in pixels of the frame (`detector.FaceDetection`). */
export interface Detection {
  /** x and y of each of the 478 mesh points. */
  xy: ReadonlyArray<readonly [number, number]>;
  /** Blendshape scores by name. */
  blendshapes: Readonly<Record<string, number>>;
  /** The facial transformation matrix (canonical face → camera), 4 × 4, row-major. */
  matrix: ReadonlyArray<ReadonlyArray<number>>;
}

export interface HeadPose {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

function check(id: string, value: number | null, limit: number | readonly number[], ok: boolean | null, hint: string | null): QualityCheck {
  if (ok === null) return { id, value, limit, passed: true, status: "unverified", hintKey: hint };
  return { id, value, limit, passed: ok, status: ok ? "pass" : "fail", hintKey: ok ? null : hint };
}

function point(det: Detection, index: number): readonly [number, number] {
  const p = det.xy[index];
  if (!p) throw new Error(`landmark ${index} missing: expected ${NUM_MESH_POINTS} points`);
  return p;
}

function distance(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function faceCountCheck(faces: number): QualityCheck {
  return check("face_count", faces, 1, faces === 1, faces === 0 ? "hint.no_face" : "hint.multiple_faces");
}

/** The whole face in the frame: every face-oval point inside it (MediaPipe extrapolates the others). */
export function faceInFrameCheck(det: Detection, width: number, height: number): QualityCheck {
  let inside = 0;
  for (const i of FACE_OVAL_RING) {
    const [x, y] = point(det, i);
    if (x >= 0 && x < width && y >= 0 && y < height) inside++;
  }
  const frac = inside / FACE_OVAL_RING.length;
  return check("face_in_frame", frac, 1, frac >= 1, "hint.face_in_frame");
}

/** Mean horizontal iris diameter in pixels, from the mesh (`quality.mesh_iris_px`). */
export function meshIrisPx(det: Detection): number {
  const right = distance(point(det, IRIS.iris_right_lateral), point(det, IRIS.iris_right_medial));
  const left = distance(point(det, IRIS.iris_left_lateral), point(det, IRIS.iris_left_medial));
  return (right + left) / 2;
}

/** Pinhole estimate (`normalize.camera_distance_m`): focal_px × iris_mm ÷ iris_px, in metres. */
export function cameraDistanceM(focalPx: number, irisPx: number, irisDiameterMm: number): number {
  return (focalPx * irisDiameterMm) / irisPx / 1000;
}

/**
 * The checks decided by their value alone, judged as the core judges them: the gates below
 * use them, and so does the display, for values smoothed over frames (display.ts).
 */
export const VALUE_CHECKS = {
  camera_distance_m: (d: number, g: Gates) => check("camera_distance_m", d, g.camera_distance_min_m, d >= g.camera_distance_min_m, "hint.move_back"),
  // Yaw > 0: the face is turned toward the subject's left, so they turn back to their right.
  yaw_deg: (v: number, g: Gates) => check("yaw_deg", v, g.yaw_max_deg, Math.abs(v) <= g.yaw_max_deg, v > 0 ? "hint.turn_right" : "hint.turn_left"),
  pitch_deg: (v: number, g: Gates) => check("pitch_deg", v, g.pitch_max_deg, Math.abs(v) <= g.pitch_max_deg, v > 0 ? "hint.chin_down" : "hint.chin_up"),
  roll_deg: (v: number, g: Gates) => check("roll_deg", v, g.roll_max_deg, Math.abs(v) <= g.roll_max_deg, "hint.head_level"),
  ipd_px: (v: number, g: Gates) => check("ipd_px", v, g.ipd_min_px, v >= g.ipd_min_px, "hint.face_too_small"),
} as const satisfies Record<string, (value: number, gates: Gates) => QualityCheck>;

/** Without a focal length the distance is unverified: the check passes, with a warning. */
export function distanceCheck(det: Detection, camera: CameraIn | null, gates: Gates, irisDiameterMm: number): QualityCheck {
  const min = gates.camera_distance_min_m;
  if (camera === null) return check("camera_distance_m", null, min, null, "hint.distance_unverified");
  const iris = meshIrisPx(det);
  if (iris <= 0) return check("camera_distance_m", null, min, false, "hint.move_back");
  return VALUE_CHECKS.camera_distance_m(cameraDistanceM(camera.focal_px, iris, irisDiameterMm), gates);
}

const DEG = 180 / Math.PI;

/**
 * Head pose from the facial transformation matrix (`detector.pose_from_matrix`). The canonical
 * face looks toward +z; its forward vector in camera space is the rotation's third column.
 * Yaw > 0: turned toward the image right (the subject's left). Pitch > 0: chin up.
 */
export function poseFromMatrix(matrix: ReadonlyArray<ReadonlyArray<number>>): HeadPose {
  const at = (r: number, c: number) => matrix[r]?.[c] ?? Number.NaN;
  const column = (c: number) => {
    const v = [at(0, c), at(1, c), at(2, c)] as const;
    const n = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); // drop the scale
    return [v[0] / n, v[1] / n, v[2] / n] as const;
  };
  const fwd = column(2);
  const xaxis = column(0);
  return {
    yawDeg: Math.atan2(fwd[0], fwd[2]) * DEG,
    pitchDeg: Math.atan2(fwd[1], Math.hypot(fwd[0], fwd[2])) * DEG,
    rollDeg: Math.atan2(-xaxis[1], xaxis[0]) * DEG,
  };
}

export function poseChecks(pose: HeadPose, gates: Gates): QualityCheck[] {
  return [VALUE_CHECKS.yaw_deg(pose.yawDeg, gates), VALUE_CHECKS.pitch_deg(pose.pitchDeg, gates), VALUE_CHECKS.roll_deg(pose.rollDeg, gates)];
}

/** Each blendshape strictly below its limit. A missing one cannot be verified as neutral: it fails. */
export function expressionChecks(blendshapes: Readonly<Record<string, number>>, gates: Gates): QualityCheck[] {
  return Object.entries(gates.expression).map(([name, limit]) => {
    const score = Object.hasOwn(blendshapes, name) ? blendshapes[name]! : null;
    const hint = EXPRESSION_HINTS[name] ?? "hint.neutral_expression";
    return check(`expression_${name}`, score, limit, score !== null && score < limit, hint);
  });
}

/** Face size: the distance between the iris centres, in pixels. */
export function ipdCheck(det: Detection, gates: Gates): QualityCheck {
  return VALUE_CHECKS.ipd_px(distance(point(det, IRIS.iris_center_right), point(det, IRIS.iris_center_left)), gates);
}

/** Checks in the core's order (`quality._ordered`); unknown ids go last, in their order. */
export function ordered(checks: readonly QualityCheck[]): QualityCheck[] {
  const rank = (id: string) => {
    const i = (CHECK_ORDER as readonly string[]).indexOf(id);
    return i < 0 ? CHECK_ORDER.length : i;
  };
  return [...checks].sort((a, b) => rank(a.id) - rank(b.id));
}

export interface FrameInfo {
  width: number;
  height: number;
}

/**
 * Every frontal gate for one frame with exactly one face (`quality.frontal_checks`), in the
 * core's order. `region` holds the frame's pixels around the face (pixels.ts, `faceBox`), or
 * null when the face box is too small to read.
 */
export function frontalChecks(
  det: Detection,
  frame: FrameInfo,
  region: Region | null,
  camera: CameraIn | null,
  gates: Gates,
  irisDiameterMm: number,
): QualityCheck[] {
  return ordered([
    faceCountCheck(1),
    faceInFrameCheck(det, frame.width, frame.height),
    distanceCheck(det, camera, gates, irisDiameterMm),
    ...poseChecks(poseFromMatrix(det.matrix), gates),
    ...expressionChecks(det.blendshapes, gates),
    ipdCheck(det, gates),
    ...imageChecks(region, det.xy, frame, gates),
  ]);
}

export interface Summary {
  passed: boolean;
  /** Hint keys of the failed checks, in the core's order, each once (`hint.move_back`, …). */
  hintKeys: string[];
  warnings: string[];
}

/** `quality.summarize`: whether the frame passed, and its hints in order. */
export function summarize(checks: readonly QualityCheck[]): Summary {
  const inOrder = ordered(checks);
  const hintKeys: string[] = [];
  for (const c of inOrder) if (c.status === "fail" && c.hintKey && !hintKeys.includes(c.hintKey)) hintKeys.push(c.hintKey);
  const distanceUnverified = inOrder.some((c) => c.id === "camera_distance_m" && c.status === "unverified");
  return { passed: inOrder.every((c) => c.passed), hintKeys, warnings: distanceUnverified ? ["distance_unverified"] : [] };
}

/** A hint key (`hint.move_back`) as `client-config.strings.hint` names it (`move_back`). */
export function hintName(key: string): string {
  return key.startsWith("hint.") ? key.slice("hint.".length) : key;
}
