/**
 * What a capture mode hands to the scan: photo mode (one file, milestone 2)
 * and live mode (a burst, milestone 5) share this shape.
 */
export interface CameraIn {
  focal_px: number;
  source: "device" | "exif" | "configured_fov" | "calibration";
}

export type CaptureWarning = "front_camera";

export interface CapturedFrame {
  /** The bytes to upload, unchanged from the camera (HEIC is the only conversion). */
  blob: Blob;
  name: string;
  width: number;
  height: number;
}

export interface Capture {
  frames: CapturedFrame[];
  /** Sent only when the server cannot read the focal length itself (HEIC, live mode). */
  camera: CameraIn | null;
  warnings: CaptureWarning[];
  /** For the overlay and the adjustment view: the frame the result refers to. */
  referenceFrame(index: number): CapturedFrame | undefined;
}

export function singlePhoto(frame: CapturedFrame, camera: CameraIn | null, warnings: CaptureWarning[]): Capture {
  return { frames: [frame], camera, warnings, referenceFrame: (i) => (i === 0 ? frame : undefined) };
}

/** Live mode's burst: frames of one size, encoded from the video, and a calibrated focal length if any. */
export function burstCapture(frames: CapturedFrame[], camera: CameraIn | null): Capture {
  return { frames, camera, warnings: [], referenceFrame: (i) => frames[i] };
}
