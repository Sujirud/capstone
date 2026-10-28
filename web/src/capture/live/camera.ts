/**
 * The camera stream for live mode: the highest resolution the camera gives
 * (ideal 3840 × 2160), the rear camera by default, and 2× zoom where the camera supports a
 * zoom constraint. The stream's pixels are what is measured; the front camera's preview is
 * mirrored on screen only (LiveScreen), never the frames.
 */
export type Facing = "environment" | "user";

export interface ZoomRange {
  min: number;
  max: number;
  step: number;
}

export interface Camera {
  stream: MediaStream;
  track: MediaStreamTrack;
  facing: Facing;
  /** The browser's id for the camera, for calibrations (empty when it gives none). */
  deviceId: string;
  /** Null when the camera has no zoom constraint (most desktop browsers). */
  zoomRange: ZoomRange | null;
  zoom: number;
}

export type CameraProblem = "unsupported" | "denied" | "not_found" | "in_use" | "failed";

export class CameraError extends Error {
  constructor(readonly problem: CameraProblem) {
    super(`camera: ${problem}`);
  }
}

/** The zoom asked for first: the protocol's 2–3×, at its low end. */
export const PREFERRED_ZOOM = 2;
/** The zoom choices offered, where the camera allows them. */
export const ZOOM_CHOICES = [1, 2, 3] as const;

/** Whether this page can use a camera stream at all: a secure context (HTTPS or localhost) and getUserMedia. */
export function liveModeSupported(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === "function";
}

function problemOf(err: unknown): CameraProblem {
  const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined;
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "not_found";
  if (name === "NotReadableError" || name === "AbortError") return "in_use";
  return "failed";
}

function zoomRangeOf(track: MediaStreamTrack): ZoomRange | null {
  const caps = (typeof track.getCapabilities === "function" ? track.getCapabilities() : {}) as { zoom?: Partial<ZoomRange> };
  const z = caps.zoom;
  if (!z || typeof z.min !== "number" || typeof z.max !== "number" || z.max <= z.min) return null;
  return { min: z.min, max: z.max, step: typeof z.step === "number" && z.step > 0 ? z.step : 0.1 };
}

/** The zoom choices this camera allows. */
export function zoomChoices(range: ZoomRange | null): number[] {
  return range ? ZOOM_CHOICES.filter((z) => z >= range.min && z <= range.max) : [];
}

export async function setZoom(camera: Camera, zoom: number): Promise<void> {
  if (!camera.zoomRange) return;
  const value = Math.min(Math.max(zoom, camera.zoomRange.min), camera.zoomRange.max);
  await camera.track.applyConstraints({ advanced: [{ zoom: value } as MediaTrackConstraintSet] });
  camera.zoom = (camera.track.getSettings() as { zoom?: number }).zoom ?? value;
}

/**
 * The camera facing this way, or a given camera (switching: a laptop's webcams have no
 * facing, so they are told apart by id).
 */
export async function openCamera(facing: Facing, deviceId?: string): Promise<Camera> {
  if (!liveModeSupported()) throw new CameraError("unsupported");
  let stream: MediaStream;
  try {
    const which = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: facing } };
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { ...which, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
  } catch (err) {
    throw new CameraError(problemOf(err));
  }
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new CameraError("not_found");
  }
  const settings = track.getSettings();
  const camera: Camera = {
    stream,
    track,
    facing: settings.facingMode === "user" ? "user" : settings.facingMode === "environment" ? "environment" : facing,
    deviceId: settings.deviceId ?? "",
    zoomRange: zoomRangeOf(track),
    zoom: (settings as { zoom?: number }).zoom ?? 1,
  };
  if (camera.zoomRange) {
    try {
      await setZoom(camera, PREFERRED_ZOOM);
    } catch {
      // The camera keeps its zoom; the hints still say when the face is too small.
    }
  }
  return camera;
}

export function closeCamera(camera: Camera | null): void {
  camera?.stream.getTracks().forEach((t) => t.stop());
}

/** The device's cameras by id (empty ids until the browser has camera permission). */
export async function cameraIds(): Promise<string[]> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput").map((d) => d.deviceId);
  } catch {
    return [];
  }
}

/** The camera after `current` in the device's list, or null when there is no other to choose by id. */
export function nextCameraId(ids: readonly string[], current: string): string | null {
  const known = ids.filter(Boolean);
  if (known.length < 2) return null;
  return known[(known.indexOf(current) + 1) % known.length] ?? null;
}
