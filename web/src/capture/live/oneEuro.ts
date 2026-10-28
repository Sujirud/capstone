/**
 * One-Euro filter (Casiez et al., CHI 2012), ported from `OneEuroFilter` in
 * `facescan/apps/webcam_capture.py` with `client-config.frontal.guided_capture.one_euro`. It
 * smooths values for display only; the gates and auto-capture use the raw
 * values of each frame. Times are in seconds.
 */
export interface OneEuroParams {
  min_cutoff: number;
  beta: number;
  d_cutoff: number;
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private t: number | null = null;

  constructor(private readonly params: OneEuroParams) {}

  /** The smoothed value. A first value, or one whose time is not after the last, starts over. */
  filter(x: number, t: number): number {
    if (this.x === null || this.t === null || t <= this.t) {
      this.x = x;
      this.t = t;
      return x;
    }
    const dt = t - this.t;
    const dx = (x - this.x) / dt;
    const ad = alpha(this.params.d_cutoff, dt);
    this.dx = ad * dx + (1 - ad) * this.dx;
    const cutoff = this.params.min_cutoff + this.params.beta * Math.abs(this.dx);
    const a = alpha(cutoff, dt);
    this.x = a * x + (1 - a) * this.x;
    this.t = t;
    return this.x;
  }

  reset(): void {
    this.x = null;
    this.t = null;
    this.dx = 0;
  }
}
