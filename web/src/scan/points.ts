/**
 * What the app knows about points that the API does not say (requests 8 and 9 in
 * ASSUMPTIONS.md): which profile points slide along the silhouette, and which metric
 * needs the alar crease.
 */
import type { View } from "./session";

/** The side of the nose: not on the silhouette, always placed by hand. */
export const ALAR_CREASE = "alar_crease";

/** P3a, tip projection (Goode), uses the alar crease. */
export const ALAR_CREASE_METRIC = "P3a_tip_projection_goode";

/** Profile points placed freely; every other adjustable profile point is on the silhouette. */
const FREE_PROFILE_POINTS: ReadonlySet<string> = new Set([ALAR_CREASE]);

/** True for points that can only slide along the stored contour (the server re-snaps them anyway). */
export function slidesOnContour(view: View, pointId: string): boolean {
  return view === "profile" && !FREE_PROFILE_POINTS.has(pointId);
}
