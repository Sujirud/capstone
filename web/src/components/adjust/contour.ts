/**
 * Sliding a point along the profile's stored silhouette: the nearest point on
 * the polyline, and the point at an arc length. A port of `project_onto_polyline` and
 * `point_at_arclength` in `facescan/core/geometry.py`; tests/contour.test.ts checks it
 * against the core's own values (fixtures/contour_snap.json). The server re-snaps anyway.
 */
import type { Point } from "../../api/scan";

export type Polyline = ReadonlyArray<readonly [number, number]>;

const EPS = 1e-9; // geometry.EPS

export interface Track {
  poly: Polyline;
  /** Cumulative arc length at each vertex (first = 0). */
  lengths: number[];
  total: number;
  /** +1 when the polyline runs from top to bottom (the core stores it so), else −1. */
  down: 1 | -1;
}

export function makeTrack(poly: Polyline): Track {
  const lengths = [0];
  for (let i = 1; i < poly.length; i++) {
    lengths.push(lengths[i - 1]! + Math.hypot(poly[i]![0] - poly[i - 1]![0], poly[i]![1] - poly[i - 1]![1]));
  }
  const down = poly[poly.length - 1]![1] >= poly[0]![1] ? 1 : -1;
  return { poly, lengths, total: lengths[lengths.length - 1]!, down };
}

/** The nearest point on the polyline and its arc length (the first segment wins a tie). */
export function projectOntoTrack(p: Point, track: Track): { point: Point; s: number } {
  const { poly, lengths } = track;
  let best = { point: { x: poly[0]![0], y: poly[0]![1] }, s: 0, d: Number.POSITIVE_INFINITY };
  for (let i = 0; i < poly.length - 1; i++) {
    const [ax, ay] = poly[i]!;
    const [bx, by] = poly[i + 1]!;
    const abx = bx - ax;
    const aby = by - ay;
    const denom = Math.max(abx * abx + aby * aby, EPS);
    const t = Math.min(1, Math.max(0, ((p.x - ax) * abx + (p.y - ay) * aby) / denom));
    const x = ax + t * abx;
    const y = ay + t * aby;
    const d = Math.hypot(x - p.x, y - p.y);
    if (d < best.d) best = { point: { x, y }, s: lengths[i]! + t * Math.hypot(abx, aby), d };
  }
  return { point: best.point, s: best.s };
}

/** The point at arc length `s`, clipped to the polyline's ends (numpy's interp per axis). */
export function pointAtArcLength(track: Track, s: number): Point {
  const { poly, lengths, total } = track;
  const c = Math.min(total, Math.max(0, s));
  if (c >= total) return { x: poly[poly.length - 1]![0], y: poly[poly.length - 1]![1] };
  // The last vertex at or before c.
  let lo = 0;
  let hi = lengths.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lengths[mid]! <= c) lo = mid;
    else hi = mid;
  }
  const span = lengths[hi]! - lengths[lo]!;
  const t = span > 0 ? (c - lengths[lo]!) / span : 0;
  const [ax, ay] = poly[lo]!;
  const [bx, by] = poly[hi]!;
  return { x: ax + t * (bx - ax), y: ay + t * (by - ay) };
}

/** Slide a point along the track by `pixels`: positive toward the chin, negative toward the forehead. */
export function slideAlong(p: Point, pixels: number, track: Track): Point {
  return pointAtArcLength(track, projectOntoTrack(p, track).s + pixels * track.down);
}
