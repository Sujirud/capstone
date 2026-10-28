/**
 * What live mode shows: one hint at a time, in the core's order.
 *
 * - The values that move continuously from frame to frame (distance, the three angles, face
 *   size) are smoothed with the One-Euro filter before they are judged for display, so the
 *   hint does not flicker. Auto-capture uses each frame's raw checks, as the server does.
 * - Screen readers and spoken hints get a hint only once it has held for a while
 *   (`Steady`), not every change.
 */
import { summarize, VALUE_CHECKS, type Gates, type QualityCheck } from "./gates";
import { OneEuroFilter, type OneEuroParams } from "./oneEuro";

type Smoothed = keyof typeof VALUE_CHECKS;
const SMOOTHED = Object.keys(VALUE_CHECKS) as Smoothed[];

export class HintDisplay {
  private readonly filters: Map<Smoothed, OneEuroFilter>;

  constructor(
    private readonly gates: Gates,
    params: OneEuroParams,
  ) {
    this.filters = new Map(SMOOTHED.map((id) => [id, new OneEuroFilter(params)]));
  }

  /** The hint key to show for this frame's checks (null: every gate passes). `t` in seconds. */
  update(checks: readonly QualityCheck[], t: number): string | null {
    if (checks.every((c) => c.id === "face_count")) {
      // No face, or more than one: nothing to smooth until one face is back.
      this.reset();
      return summarize(checks).hintKeys[0] ?? null;
    }
    const shown = checks.map((c) => {
      const filter = this.filters.get(c.id as Smoothed);
      if (!filter || c.value === null) return c;
      return VALUE_CHECKS[c.id as Smoothed](filter.filter(c.value, t), this.gates);
    });
    return summarize(shown).hintKeys[0] ?? null;
  }

  reset(): void {
    for (const f of this.filters.values()) f.reset();
  }
}

/**
 * A value that is passed on once it has stayed the same for `holdMs`; the same value again
 * only after `repeatMs`. For announcements and speech, which must not follow every frame.
 */
export class Steady<T> {
  private current: T | undefined;
  private since = 0;
  private last: { value: T; at: number } | null = null;

  constructor(
    private readonly holdMs: number,
    private readonly repeatMs: number,
  ) {}

  /** The value to pass on now, or undefined. */
  update(value: T, now: number): T | undefined {
    if (value !== this.current) {
      this.current = value;
      this.since = now;
      return undefined;
    }
    if (now - this.since < this.holdMs) return undefined;
    if (this.last && this.last.value === value && now - this.last.at < this.repeatMs) return undefined;
    this.last = { value, at: now };
    return value;
  }

  /** Records that `value` was passed on now by other means, so it is not repeated at once. */
  mark(value: T, now: number): void {
    this.last = { value, at: now };
  }

  reset(): void {
    this.current = undefined;
    this.last = null;
  }
}
