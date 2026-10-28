/**
 * Auto-capture. When every gate passes for
 * `guided_capture.consecutive_pass_frames` frames in a row, the sharpest frames of that run
 * are kept and sent as one burst, as `GuidedCapture` in `facescan/apps/webcam_capture.py`
 * does. The web app keeps `burst.recommended_frames` (the desktop app keeps its
 * `keep_best_frames`), within the burst and upload limits.
 */
import type { ClientConfig, UploadLimits } from "../../api/schemas";

/**
 * A run of passing frames, keeping the sharpest `keep` of it. Frames are owned: a frame
 * handed to `update` is released as soon as it drops out (a failed frame at once).
 */
export class Streak<F> {
  streak = 0;
  private kept: Array<{ score: number; order: number; frame: F }> = [];
  private counter = 0;

  constructor(
    readonly needed: number,
    readonly keep: number,
    private readonly release: (frame: F) => void,
  ) {}

  /** Feeds one frame; true when the run is long enough to capture. */
  update(passed: boolean, frame: F, score: number): boolean {
    if (!passed) {
      this.release(frame);
      this.reset();
      return false;
    }
    this.streak += 1;
    this.counter += 1;
    this.kept.push({ score, order: this.counter, frame });
    this.kept.sort((a, b) => b.score - a.score || a.order - b.order);
    for (const dropped of this.kept.splice(this.keep)) this.release(dropped.frame);
    return this.streak >= this.needed;
  }

  /** The kept frames in capture order, with their sharpness; the run starts over. */
  take(): Array<{ frame: F; score: number }> {
    const frames = [...this.kept].sort((a, b) => a.order - b.order).map(({ frame, score }) => ({ frame, score }));
    this.kept = [];
    this.streak = 0;
    return frames;
  }

  /** Ends the run and releases what it kept. */
  reset(): void {
    for (const k of this.kept) this.release(k.frame);
    this.kept = [];
    this.streak = 0;
  }
}

/**
 * How many frames to keep: `burst.recommended_frames`, within `burst.min_frames` …
 * `max_frames`, the API's `max_frames`, and the frames of this size that `max_burst_pixels`
 * allows. Null when not even `min_frames` fit.
 */
export function framesToKeep(config: Pick<ClientConfig, "frontal" | "upload_limits">, width: number, height: number): number | null {
  const { burst } = config.frontal;
  const limits = config.upload_limits;
  const max = Math.min(burst.max_frames, limits.max_frames, Math.floor(limits.max_burst_pixels / (width * height)));
  const keep = Math.min(Math.max(burst.recommended_frames, burst.min_frames), max);
  return keep >= burst.min_frames ? keep : null;
}

/** Room left in a request for the `meta` part and the multipart headers. */
export const REQUEST_OVERHEAD_BYTES = 64 * 1024;

export type BurstProblem = "frame_too_large" | "too_few_frames";

/**
 * The encoded frames that fit one request: each within `max_image_bytes`, and together within
 * `max_request_bytes`. The least sharp go first; the rest stay in capture order. (The frames
 * share one size: the loop starts the run over when it changes.)
 */
export function fitBurst<T extends { bytes: number; score: number }>(
  frames: readonly T[],
  limits: UploadLimits,
  minFrames: number,
): { ok: true; frames: T[] } | { ok: false; problem: BurstProblem } {
  if (frames.some((f) => f.bytes > limits.max_image_bytes)) return { ok: false, problem: "frame_too_large" };
  const kept = [...frames];
  const total = () => kept.reduce((sum, f) => sum + f.bytes, 0) + REQUEST_OVERHEAD_BYTES;
  while (kept.length > minFrames && total() > limits.max_request_bytes) {
    let worst = 0;
    kept.forEach((f, i) => {
      if (f.score < kept[worst]!.score) worst = i;
    });
    kept.splice(worst, 1);
  }
  if (kept.length < minFrames || total() > limits.max_request_bytes) return { ok: false, problem: "too_few_frames" };
  return { ok: true, frames: kept };
}
