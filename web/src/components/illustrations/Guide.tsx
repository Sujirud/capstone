/**
 * Capture-guide line drawings: one consistent 1.75 px stroke
 * in --ink, --accent only on the one detail to notice (the distance arrow, the 2× zoom
 * button, the plain background, the hairline, the level line, the lips). Simple, neutral
 * figures with no idealized features. The distance comes from client-config.
 *
 * Inline SVG rather than files in public/: colours come from the tokens and the numbers
 * from the service, which an <img> could not take.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export const INK = { stroke: "currentColor", strokeWidth: 1.75, fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;
export const ACCENT = { ...INK, stroke: "var(--accent)", strokeWidth: 2.25 } as const;

export function Drawing({ alt, children, viewBox = "0 0 240 150" }: { alt: string; children: ReactNode; viewBox?: string }) {
  return (
    <svg role="img" aria-label={alt} viewBox={viewBox} className="h-auto w-full text-ink">
      {children}
    </svg>
  );
}

/**
 * A standing figure, feet at y + 118. `arm` raises one arm to a point (a phone) instead of
 * letting it hang: from the shoulder on the point's side, so it never crosses the body.
 */
function Person({ x, y, arm }: { x: number; y: number; arm?: [number, number] }) {
  const raised = arm ? (arm[0] < x ? "left" : "right") : null;
  const hang = (side: -1 | 1) => `M ${x + side * 20} ${y + 33} L ${x + side * 25} ${y + 72}`;
  const raise = (side: -1 | 1) => `M ${x + side * 20} ${y + 33} L ${arm![0]} ${arm![1]}`;
  return (
    <g {...INK}>
      <circle cx={x} cy={y + 12} r={11} />
      <path d={`M ${x - 20} ${y + 32} Q ${x} ${y + 25} ${x + 20} ${y + 32} L ${x + 16} ${y + 78} L ${x - 16} ${y + 78} Z`} />
      <path d={`M ${x - 8} ${y + 78} L ${x - 9} ${y + 118} M ${x + 8} ${y + 78} L ${x + 9} ${y + 118}`} />
      <path d={raised === "left" ? raise(-1) : hang(-1)} />
      <path d={raised === "right" ? raise(1) : hang(1)} />
    </g>
  );
}

export function Phone({ x, y }: { x: number; y: number }) {
  return <rect x={x} y={y} width={8} height={14} rx={1.5} {...INK} />;
}

/** Face, front view: `hairline`, `lips` or `level` is the accented detail. */
function Face({ accent }: { accent: "hairline" | "lips" | "level" }) {
  return (
    <g>
      <path d="M 88 50 Q 90 22 120 20 Q 150 22 152 50" {...INK} />
      <circle cx={120} cy={14} r={9} {...INK} />
      <ellipse cx={120} cy={78} rx={32} ry={42} {...INK} />
      <path d="M 88 74 Q 83 78 87 88 M 152 74 Q 157 78 153 88" {...INK} />
      <path d="M 103 62 L 113 61 M 127 61 L 137 62" {...INK} />
      <circle cx={108} cy={72} r={2.4} fill="currentColor" />
      <circle cx={132} cy={72} r={2.4} fill="currentColor" />
      <path d="M 120 74 L 118 92 L 123 93" {...INK} />
      <path d="M 109 104 Q 120 107 131 104" {...(accent === "lips" ? ACCENT : INK)} />
      <path d="M 108 118 L 106 148 M 132 118 L 134 148" {...INK} />
      {accent === "hairline" && <path d="M 92 50 Q 120 38 148 50" {...ACCENT} />}
      {accent === "level" && (
        <g>
          <path d="M 70 72 L 196 72" {...ACCENT} strokeDasharray="5 5" />
          <rect x={198} y={63} width={26} height={18} rx={3} {...INK} />
          <circle cx={211} cy={72} r={5} {...INK} />
        </g>
      )}
    </g>
  );
}

export function HelperDistanceDrawing({ distance }: { distance: number }) {
  const { t } = useTranslation();
  const label = t("guide.drawing.distanceLabel", { distance });
  return (
    <Drawing alt={t("guide.drawing.distance", { distance })} viewBox="0 0 240 180">
      <Person x={52} y={8} />
      <Person x={190} y={8} arm={[164, 46]} />
      <Phone x={156} y={38} />
      <path d="M 12 128 L 228 128" {...INK} strokeWidth={1} />
      {/* The distance, under the floor line, between the subject and the phone. */}
      <path d="M 52 144 L 160 144 M 58 139 L 52 144 L 58 149 M 154 139 L 160 144 L 154 149" {...ACCENT} />
      <text x={106} y={172} textAnchor="middle" fontSize={16} fontWeight={600} fill="var(--accent)" stroke="none">
        {label}
      </text>
    </Drawing>
  );
}

/**
 * Text in a drawing is at least this many viewBox units. Drawings are 240 units wide and
 * shown at least 240 px wide (up to 256 px), so it renders at 14 px or more.
 */
export const DRAWING_MIN_FONT = 14;

export function ZoomDrawing() {
  const { t } = useTranslation();
  const levels = ["1×", "2×", "3×"];
  return (
    <Drawing alt={t("guide.drawing.zoom")} viewBox="0 0 240 160">
      <rect x={52} y={4} width={136} height={152} rx={12} {...INK} />
      <rect x={62} y={14} width={116} height={80} rx={2} {...INK} strokeWidth={1} />
      <circle cx={120} cy={44} r={12} {...INK} />
      <path d="M 96 94 Q 98 66 120 64 Q 142 66 144 94" {...INK} />
      {levels.map((level, i) => {
        const cx = 82 + i * 38;
        const on = level === "2×";
        return (
          <g key={level}>
            <circle cx={cx} cy={116} r={15} {...(on ? ACCENT : INK)} strokeWidth={on ? 2.25 : 1} />
            <text
              x={cx}
              y={121}
              textAnchor="middle"
              fontSize={DRAWING_MIN_FONT}
              fontWeight={on ? 600 : 400}
              fill={on ? "var(--accent)" : "currentColor"}
              stroke="none"
            >
              {level}
            </text>
          </g>
        );
      })}
      <circle cx={120} cy={143} r={7} {...INK} />
    </Drawing>
  );
}

export function SelfieDrawing() {
  const { t } = useTranslation();
  return (
    <Drawing alt={t("guide.drawing.selfie")}>
      <path d="M 12 142 L 228 142" {...INK} strokeWidth={1} />
      <Person x={100} y={22} arm={[140, 36]} />
      <Phone x={140} y={26} />
      <path d="M 196 18 L 222 44 M 222 18 L 196 44" {...INK} strokeWidth={2.75} />
    </Drawing>
  );
}

export function BackgroundDrawing() {
  const { t } = useTranslation();
  return (
    <Drawing alt={t("guide.drawing.background")}>
      <rect x={30} y={8} width={180} height={134} fill="var(--accent-band)" stroke="var(--accent)" strokeWidth={2.25} />
      <g {...INK}>
        <circle cx={120} cy={62} r={20} />
        <path d="M 78 142 Q 80 100 120 96 Q 160 100 162 142" />
      </g>
    </Drawing>
  );
}

export function HairlineDrawing() {
  const { t } = useTranslation();
  return (
    <Drawing alt={t("guide.drawing.hair")}>
      <Face accent="hairline" />
    </Drawing>
  );
}

export function LevelDrawing() {
  const { t } = useTranslation();
  return (
    <Drawing alt={t("guide.drawing.level")}>
      <Face accent="level" />
    </Drawing>
  );
}

export function NeutralDrawing() {
  const { t } = useTranslation();
  return (
    <Drawing alt={t("guide.drawing.neutral")}>
      <Face accent="lips" />
    </Drawing>
  );
}
