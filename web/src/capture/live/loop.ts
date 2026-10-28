/**
 * Live mode's frame loop. For each video frame: detect faces, run the ported
 * gates (one face: every check; otherwise the face count alone), update the displayed hint,
 * and feed auto-capture or the calibration. One frame is processed at a time; frames that
 * arrive meanwhile are skipped.
 *
 * - **Capture:** once every gate has passed for `consecutive_pass_frames` frames in a row,
 *   the sharpest frames of the run are handed over (`onBurst`) and the loop stops.
 * - **Calibration:** frames that pass every gate count toward the focal length; auto-capture
 *   waits meanwhile.
 * - A change of frame size (the phone turned, another camera) starts the run over: a burst's
 *   frames must all have one size.
 * - A detector that fails on every frame (a lost GPU context, say) is reported after
 *   `MAX_FAILED_FRAMES` frames in a row, instead of leaving the screen waiting.
 */
import type { ClientConfig } from "../../api/schemas";
import type { CameraIn } from "../CaptureSource";
import { framesToKeep, Streak } from "./burst";
import { Calibration } from "./calibration";
import type { FaceDetector } from "./detector";
import { HintDisplay } from "./display";
import type { Frame, FrameSource } from "./frames";
import { faceCountCheck, frontalChecks, meshIrisPx, summarize, type QualityCheck } from "./gates";
import { faceBox, readableBox } from "./pixels";

export interface LiveStatus {
  /** The hint key shown (`hint.move_back`), or null when every gate passes. */
  hint: string | null;
  /** Consecutive frames that passed every gate, of `needed`. */
  streak: number;
  needed: number;
  /** Frames of the stream. */
  width: number;
  height: number;
  /** Calibration frames collected so far, while calibrating. */
  calibration: { count: number; of: number } | null;
}

export interface KeptFrame {
  frame: Frame;
  /** The frame's sharpness (the core's value, ported). */
  score: number;
}

export interface LiveCallbacks {
  onStatus(status: LiveStatus): void;
  /** The kept frames, in capture order; the loop has stopped and they are the receiver's to close. */
  onBurst(frames: KeptFrame[]): void;
  /** Calibration done: the mean iris diameter over its frames gave this focal length. */
  onCalibrated(focalPx: number): void;
  /** Stream frames of this size cannot hold `burst.min_frames` within the upload limits. */
  onTooLarge(): void;
  /** Processing failed for `MAX_FAILED_FRAMES` frames in a row; the loop has stopped. */
  onError(): void;
}

export interface LiveDeps {
  detector: FaceDetector;
  frames: FrameSource;
  /** Runs `callback` at the next video frame; returns a cancel function. */
  nextFrame(callback: () => void): () => void;
  /** Milliseconds, increasing. */
  now(): number;
}

type Config = Pick<ClientConfig, "frontal" | "upload_limits">;

/** Frames in a row whose processing failed before the loop gives up (`onError`). */
export const MAX_FAILED_FRAMES = 30;

export class LiveLoop {
  private running = false;
  private cancel: (() => void) | null = null;
  private busy = false;
  private failures = 0;
  private streak: Streak<Frame> | null = null;
  private size: { width: number; height: number } | null = null;
  private calibration: Calibration | null = null;
  private readonly display: HintDisplay;
  camera: CameraIn | null = null;

  constructor(
    private readonly config: Config,
    private readonly deps: LiveDeps,
    private readonly callbacks: LiveCallbacks,
  ) {
    this.display = new HintDisplay(config.frontal.gates, config.frontal.guided_capture.one_euro);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  /** Stops the loop and releases the frames it kept. */
  stop(): void {
    this.running = false;
    this.cancel?.();
    this.cancel = null;
    this.streak?.reset();
  }

  /** Starts collecting calibration frames; the person stands at the recommended distance. */
  calibrate(): void {
    this.calibration = new Calibration();
    this.streak?.reset();
  }

  cancelCalibration(): void {
    this.calibration = null;
  }

  get calibrating(): boolean {
    return this.calibration !== null;
  }

  /**
   * One callback at a time: a stop and start while a frame is still being processed (a zoom
   * change) must not leave two chains of callbacks.
   */
  private schedule(): void {
    if (!this.running || this.cancel) return;
    this.cancel = this.deps.nextFrame(() => {
      this.cancel = null;
      if (this.busy) return this.schedule();
      this.busy = true;
      void this.step()
        .then(
          () => (this.failures = 0),
          () => {
            this.failures += 1;
            if (this.failures >= MAX_FAILED_FRAMES && this.running) {
              this.stop();
              this.callbacks.onError();
            }
          },
        )
        .finally(() => {
          this.busy = false;
          this.schedule();
        });
    });
  }

  /** One frame. Public for tests, which drive the loop frame by frame. */
  async step(): Promise<void> {
    const frame = await this.deps.frames.grab();
    if (!frame) return;
    let owned = true; // until auto-capture keeps it or drops it
    try {
      if (this.running) this.process(frame, () => (owned = false));
    } finally {
      if (owned) frame.close();
    }
  }

  private process(frame: Frame, handOver: () => void): void {
    const { gates, guided_capture, iris_diameter_mm } = this.config.frontal;
    const t = this.deps.now();

    if (!this.size || this.size.width !== frame.width || this.size.height !== frame.height) {
      this.size = { width: frame.width, height: frame.height };
      this.streak?.reset();
      const keep = framesToKeep(this.config, frame.width, frame.height);
      if (keep === null) {
        this.stop();
        return this.callbacks.onTooLarge();
      }
      this.streak = new Streak<Frame>(guided_capture.consecutive_pass_frames, keep, (f) => f.close());
      if (this.calibration) this.calibration = new Calibration(); // a calibration holds for one resolution
    }

    let checks: QualityCheck[];
    const faces = this.deps.detector.detect(frame.image, t);
    const face = faces.length === 1 ? faces[0]! : null;
    if (face) {
      const box = faceBox(face.xy, frame.width, frame.height);
      const region = readableBox(box) ? frame.region(box) : null;
      checks = frontalChecks(face, frame, region, this.calibration ? null : this.camera, gates, iris_diameter_mm);
    } else {
      checks = [faceCountCheck(faces.length)];
    }
    const passed = summarize(checks).passed;
    const hint = this.display.update(checks, t / 1000);

    if (this.calibration) {
      if (passed && face) this.calibration.add(meshIrisPx(face));
      const { count, frames } = this.calibration;
      this.status(hint, 0, { count: Math.min(count, frames), of: frames });
      const focal = this.calibration.focalPx(gates.camera_distance_recommended_m, iris_diameter_mm);
      if (focal !== null) {
        this.calibration = null;
        this.callbacks.onCalibrated(focal);
      }
      return;
    }

    const streak = this.streak!;
    const sharpness = checks.find((c) => c.id === "sharpness")?.value ?? 0;
    handOver();
    const ready = streak.update(passed, frame, sharpness);
    this.status(hint, streak.streak, null);
    if (ready) {
      this.running = false;
      this.cancel?.();
      this.cancel = null;
      this.callbacks.onBurst(streak.take());
    }
  }

  private status(hint: string | null, streak: number, calibration: LiveStatus["calibration"]): void {
    this.callbacks.onStatus({
      hint,
      streak,
      needed: this.config.frontal.guided_capture.consecutive_pass_frames,
      width: this.size?.width ?? 0,
      height: this.size?.height ?? 0,
      calibration,
    });
  }
}
