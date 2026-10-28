/**
 * Points drawn by the app in image pixel coordinates: the fallback
 * when the overlay cannot be redrawn, and the marker style of the adjustment view. As in
 * the core's overlay: automatic points are filled dots, adjusted points hollow
 * rings; low confidence is the lighter shade.
 */
import type { Result } from "../../api/schemas";

export function PointsLayer({ result, radius }: { result: Pick<Result, "image" | "landmarks">; radius?: number }) {
  const { width, height } = result.image;
  const r = radius ?? Math.max(3, Math.min(width, height) / 180);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
      {Object.entries(result.landmarks).map(([name, lm]) => {
        if (!lm.available || lm.x === null || lm.y === null || name === "mesh_top") return null;
        const color = lm.confidence === "high" ? "var(--point)" : "var(--point-low)";
        return lm.adjusted ? (
          <g key={name}>
            <circle cx={lm.x} cy={lm.y} r={r * 1.2} fill="none" stroke="var(--point-shadow)" strokeWidth={r * 0.9} />
            <circle cx={lm.x} cy={lm.y} r={r * 1.2} fill="none" stroke={color} strokeWidth={r * 0.45} />
          </g>
        ) : (
          <circle key={name} cx={lm.x} cy={lm.y} r={r} fill={color} stroke="var(--point-shadow)" strokeWidth={r * 0.35} />
        );
      })}
    </svg>
  );
}
