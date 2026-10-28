/**
 * On-device face detection for live mode: MediaPipe's FaceLandmarker with
 * blendshapes and facial transformation matrices, the same `face_landmarker.task` as the
 * server, and up to two faces so that "exactly one face" can be checked (as the core's
 * `detector.MAX_FACES`). The model and MediaPipe's WebAssembly files are served by the site
 * itself (`public/models`, `public/mediapipe`, copied by scripts/copy_live_assets.mjs); the
 * library is loaded only when live mode opens.
 */
import type { FaceLandmarker, FaceLandmarkerResult, Matrix } from "@mediapipe/tasks-vision";
import type { Detection } from "./gates";
import { NUM_MESH_POINTS } from "./mesh";

/** `detector.MAX_FACES`. */
export const MAX_FACES = 2;

const base = import.meta.env.BASE_URL;
export const MODEL_URL = `${base}models/face_landmarker.task`;
export const WASM_BASE_URL = `${base}mediapipe`;

export interface FaceDetector {
  /** Faces in a video frame; timestamps (ms) must increase. */
  detect(image: ImageBitmap, timestampMs: number): Detection[];
  close(): void;
}

/**
 * MediaPipe gives matrices as their packed data, column-major (the MatrixData proto's
 * default layout, which the Python API transposes for the core). Row-major 4 × 4 here.
 */
export function matrixRows(m: Matrix | undefined): number[][] {
  if (!m || m.rows !== 4 || m.columns !== 4 || m.data.length !== 16) return [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => (r === c ? 1 : 0)));
  return [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => m.data[c * 4 + r]!));
}

/** Pixels of the frame, as the core's `_convert` makes them. */
export function detections(result: FaceLandmarkerResult, width: number, height: number): Detection[] {
  return result.faceLandmarks.map((points, i) => {
    if (points.length !== NUM_MESH_POINTS) throw new Error(`expected ${NUM_MESH_POINTS} landmarks (model with iris), got ${points.length}`);
    const blendshapes = Object.fromEntries((result.faceBlendshapes[i]?.categories ?? []).map((c) => [c.categoryName, c.score]));
    return {
      xy: points.map((p) => [p.x * width, p.y * height] as const),
      blendshapes,
      matrix: matrixRows(result.facialTransformationMatrixes[i]),
    };
  });
}

async function landmarker(mode: "VIDEO" | "IMAGE", delegate: "GPU" | "CPU"): Promise<FaceLandmarker> {
  const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
  const files = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
  return FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: mode,
    numFaces: MAX_FACES,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
}

/**
 * The GPU delegate reads camera frames without copying them into WebAssembly memory, which
 * matters at 4K; where WebGL is missing, the CPU one (the server's) takes over.
 */
export async function createFaceDetector(mode: "video" | "image" = "video"): Promise<FaceDetector> {
  const runningMode = mode === "video" ? "VIDEO" : "IMAGE";
  let lm: FaceLandmarker;
  try {
    lm = await landmarker(runningMode, "GPU");
  } catch {
    lm = await landmarker(runningMode, "CPU");
  }
  let last = -1;
  return {
    detect(image, timestampMs) {
      if (mode === "image") return detections(lm.detect(image), image.width, image.height);
      last = Math.max(Math.round(timestampMs), last + 1);
      return detections(lm.detectForVideo(image, last), image.width, image.height);
    },
    close() {
      lm.close();
    },
  };
}
