/**
 * Snap-to-contour: the port of the core's `project_onto_polyline` and
 * `point_at_arclength` gives the core's own values (fixtures/contour_snap.json, from the real
 * profile result's stored contour).
 */
import { describe, expect, it } from "vitest";
import snap from "../fixtures/contour_snap.json" with { type: "json" };
import profileOk from "../fixtures/profile_ok.en.json" with { type: "json" };
import { makeTrack, pointAtArcLength, projectOntoTrack, slideAlong, type Polyline } from "../src/components/adjust/contour";

const track = makeTrack(snap.contour as unknown as Polyline);

describe("contour port", () => {
  it("uses the stored contour of the profile result", () => {
    expect(snap.contour).toEqual(profileOk.result.contour);
    expect(track.total).toBeCloseTo(snap.length, 9);
    expect(track.down).toBe(1); // the core stores it from top to bottom
  });

  it.each(snap.cases.map((c, i) => [i, c] as const))("nearest point %i matches the core", (_, c) => {
    const { point, s } = projectOntoTrack({ x: c.point[0]!, y: c.point[1]! }, track);
    expect(point.x).toBeCloseTo(c.snapped[0]!, 9);
    expect(point.y).toBeCloseTo(c.snapped[1]!, 9);
    expect(s).toBeCloseTo(c.s, 9);
  });

  it.each(snap.arc.map((a) => [a.s, a] as const))("the point at arc length %f matches the core", (_, a) => {
    const p = pointAtArcLength(track, a.s);
    expect(p.x).toBeCloseTo(a.point[0]!, 9);
    expect(p.y).toBeCloseTo(a.point[1]!, 9);
  });

  it("a point already on the contour snaps to itself", () => {
    const lm = profileOk.result.landmarks.pronasale;
    const { point } = projectOntoTrack({ x: lm.x!, y: lm.y! }, track);
    expect(point.x).toBeCloseTo(lm.x!, 6);
    expect(point.y).toBeCloseTo(lm.y!, 6);
  });

  it("slides along the contour by arc length, toward the chin or the forehead, and stops at the ends", () => {
    const lm = profileOk.result.landmarks.subnasale;
    const start = projectOntoTrack({ x: lm.x!, y: lm.y! }, track);
    const down = slideAlong(start.point, 10, track);
    const up = slideAlong(start.point, -10, track);
    expect(projectOntoTrack(down, track).s).toBeCloseTo(start.s + 10, 6);
    expect(projectOntoTrack(up, track).s).toBeCloseTo(start.s - 10, 6);
    const last = snap.contour[snap.contour.length - 1]!;
    expect(slideAlong(start.point, 1e6, track)).toEqual({ x: last[0], y: last[1] });
    expect(slideAlong(start.point, -1e6, track)).toEqual({ x: snap.contour[0]![0], y: snap.contour[0]![1] });
  });

  it("follows a contour stored from bottom to top the same way", () => {
    const reversed = makeTrack([...(snap.contour as unknown as Polyline)].reverse());
    expect(reversed.down).toBe(-1);
    const lm = profileOk.result.landmarks.subnasale;
    const towardChin = slideAlong({ x: lm.x!, y: lm.y! }, 10, reversed);
    expect(towardChin.y).toBeGreaterThan(lm.y!);
  });
});
