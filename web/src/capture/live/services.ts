/**
 * What live mode needs from the browser, in one place so that tests can pass fakes (the
 * camera, MediaPipe, video frames and their timing). `browserLive` is the real one.
 */
import { cameraIds, closeCamera, liveModeSupported, openCamera, setZoom, type Camera, type Facing } from "./camera";
import { createFaceDetector, type FaceDetector } from "./detector";
import { videoFrames, type FrameSource } from "./frames";

export interface LiveServices {
  supported(): boolean;
  openCamera(facing: Facing, deviceId?: string): Promise<Camera>;
  closeCamera(camera: Camera): void;
  setZoom(camera: Camera, zoom: number): Promise<void>;
  cameraIds(): Promise<string[]>;
  createDetector(): Promise<FaceDetector>;
  frames(video: HTMLVideoElement): FrameSource;
  /** Runs `callback` at the video's next frame; returns a cancel function. */
  nextFrame(video: HTMLVideoElement, callback: () => void): () => void;
  /** Milliseconds, increasing. */
  now(): number;
}

export const browserLive: LiveServices = {
  supported: liveModeSupported,
  openCamera,
  closeCamera,
  setZoom,
  cameraIds,
  createDetector: () => createFaceDetector("video"),
  frames: videoFrames,
  nextFrame(video, callback) {
    if (typeof video.requestVideoFrameCallback === "function") {
      const id = video.requestVideoFrameCallback(() => callback());
      return () => video.cancelVideoFrameCallback(id);
    }
    const id = requestAnimationFrame(() => callback());
    return () => cancelAnimationFrame(id);
  },
  now: () => performance.now(),
};
