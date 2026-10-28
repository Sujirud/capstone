/**
 * Live mode's two camera questions: the focal length, which the browser does
 * not give, and whether the face can be large enough in the frame at all.
 *
 * **Calibration** (optional). Without a focal length the distance check is unverified, and
 * the core then allows no report topics. The person stands at a tape-measured distance (the
 * recommended 1.5 m from client-config); the focal length in pixels is the mean horizontal
 * iris diameter in pixels (measured as the core does) × that distance ÷
 * `client-config.frontal.iris_diameter_mm`, over about 30 frames that pass every gate. It is
 * saved on this device per camera, resolution and zoom, and sent as
 * `camera: {focal_px, source: "calibration"}`. A new resolution or zoom needs a new one.
 *
 * **Face size.** IPD in pixels ≈ focal_px × 63 mm ÷ distance, so at the recommended distance
 * many streams cannot pass the face-size gate. Without a calibration the focal length is
 * estimated from a typical field of view, only to warn.
 */
import { z } from "zod";
import type { Gates } from "./gates";
import { readStored, STORAGE_KEYS, writeStored } from "../../app/storage";

export const CALIBRATION_FRAMES = 30;

/** `webcam_capture.TYPICAL_IPD_MM`: a typical adult inter-pupillary distance. */
export const TYPICAL_IPD_MM = 63;

/**
 * An assumed horizontal field of view across the stream's long side: phones' main cameras
 * (about 26 mm equivalent, 69°) and webcams (65–78°). Used only for the face-size warning.
 */
export const ASSUMED_FIELD_OF_VIEW_DEG = 70;

export function focalFromIris(meanIrisPx: number, distanceM: number, irisDiameterMm: number): number {
  return (meanIrisPx * distanceM * 1000) / irisDiameterMm;
}

/** Mean iris diameter over the frames that passed every gate. */
export class Calibration {
  private sum = 0;
  count = 0;

  constructor(readonly frames = CALIBRATION_FRAMES) {}

  add(irisPx: number): void {
    if (!(irisPx > 0)) return;
    this.sum += irisPx;
    this.count += 1;
  }

  get done(): boolean {
    return this.count >= this.frames;
  }

  focalPx(distanceM: number, irisDiameterMm: number): number | null {
    return this.done ? focalFromIris(this.sum / this.count, distanceM, irisDiameterMm) : null;
  }
}

/** A camera as a calibration applies to it. The resolution is orientation-free: turning the phone keeps it. */
export interface CameraSetup {
  /** The browser's id for the camera, or its facing when the browser gives none. */
  camera: string;
  width: number;
  height: number;
  zoom: number;
}

export function setupKey(s: CameraSetup): string {
  return `${s.camera}|${Math.max(s.width, s.height)}x${Math.min(s.width, s.height)}|${s.zoom}`;
}

const Saved = z.record(z.string(), z.object({ focal_px: z.number().positive() }));

function readAll(): z.infer<typeof Saved> {
  try {
    const parsed = Saved.safeParse(JSON.parse(readStored(STORAGE_KEYS.calibration) ?? "{}"));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function loadCalibration(setup: CameraSetup): number | null {
  return readAll()[setupKey(setup)]?.focal_px ?? null;
}

export function saveCalibration(setup: CameraSetup, focalPx: number): void {
  writeStored(STORAGE_KEYS.calibration, JSON.stringify({ ...readAll(), [setupKey(setup)]: { focal_px: focalPx } }));
}

/** The focal length assumed from a typical field of view, zoom included. */
export function assumedFocalPx(width: number, height: number, zoom: number): number {
  return (Math.max(width, height) / 2 / Math.tan(((ASSUMED_FIELD_OF_VIEW_DEG / 2) * Math.PI) / 180)) * zoom;
}

/** The expected IPD in pixels at the recommended distance, and whether it reaches the gate. */
export function faceSizeAt(focalPx: number, gates: Gates): { ipdPx: number; reachable: boolean } {
  const ipdPx = (focalPx * TYPICAL_IPD_MM) / (gates.camera_distance_recommended_m * 1000);
  return { ipdPx, reachable: ipdPx >= gates.ipd_min_px };
}
