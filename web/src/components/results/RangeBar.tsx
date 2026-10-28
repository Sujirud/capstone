/**
 * The range bar: a supplementary graphic. The status is always given as
 * text next to it, so the bar is hidden from assistive technology.
 *
 * - A thin track with the reference band in --accent-band and --line-strong ticks at the
 *   band's min and max.
 * - One marker at the value: --accent when the status is above / below, --ink-2 within.
 * - The scale is the band plus half its width on each side. A value beyond the scale is
 *   pinned to the edge as an arrow.
 * - No centre line, no gradient, no animation.
 *
 * Positioning the marker from `value`, `reference.min` and `max` is the one computation
 * the client may do with a measurement; colour comes from the API's `status`.
 */
import type { MetricStatus } from "../../api/schemas";

export type RangeBarStatus = Extract<MetricStatus, "within" | "above" | "below">;

export interface RangeGeometry {
  /** Fractions of the bar width, 0 … 1. */
  bandStart: number;
  bandEnd: number;
  marker: number;
  pinned: "low" | "high" | null;
}

/** Share of the band width added on each side of the band. */
export const SCALE_MARGIN = 0.5;

export function rangeGeometry(value: number, min: number, max: number): RangeGeometry {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const width = hi - lo;
  // A zero-width band (a single target) still needs a visible scale.
  const margin = width > 0 ? width * SCALE_MARGIN : Math.max(Math.abs(lo), 1) * 0.1;
  const start = lo - margin;
  const span = hi + margin - start;
  const at = (v: number) => (v - start) / span;
  const raw = at(value);
  return {
    bandStart: at(lo),
    bandEnd: at(hi),
    marker: Math.min(1, Math.max(0, raw)),
    pinned: raw < 0 ? "low" : raw > 1 ? "high" : null,
  };
}

export function isRangeBarStatus(status: MetricStatus): status is RangeBarStatus {
  return status === "within" || status === "above" || status === "below";
}

const pct = (f: number) => `${(f * 100).toFixed(3)}%`;

export function RangeBar({ value, min, max, status }: { value: number; min: number; max: number; status: RangeBarStatus }) {
  const g = rangeGeometry(value, min, max);
  const markerColor = status === "within" ? "var(--ink-2)" : "var(--accent)";
  return (
    <div aria-hidden="true" data-testid="range-bar" data-pinned={g.pinned ?? undefined} className="relative my-2 h-4 w-full">
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line" />
      <div
        className="absolute top-1/2 h-2 -translate-y-1/2 bg-accent-band"
        style={{ left: pct(g.bandStart), width: pct(g.bandEnd - g.bandStart) }}
      />
      <div className="absolute top-0 h-4 w-px bg-line-strong" style={{ left: pct(g.bandStart) }} />
      <div className="absolute top-0 h-4 w-px bg-line-strong" style={{ left: pct(g.bandEnd) }} />
      {g.pinned === null ? (
        <div
          className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface"
          style={{ left: pct(g.marker), background: markerColor }}
        />
      ) : (
        <svg
          width="10"
          height="12"
          viewBox="0 0 10 12"
          className="absolute top-1/2 -translate-y-1/2"
          style={g.pinned === "low" ? { left: 0 } : { right: 0 }}
        >
          <path d={g.pinned === "low" ? "M0 6 L10 0 L10 12 Z" : "M10 6 L0 0 L0 12 Z"} fill={markerColor} />
        </svg>
      )}
    </div>
  );
}
