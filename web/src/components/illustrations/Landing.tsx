/**
 * The landing page's illustration: a drawing of a result sheet, not a real
 * face and not a screenshot. A photo frame with a plain head and three measurement lines,
 * and three rows, each with a range bar: two within their band, one outside it (the accent,
 * as on the sheet). Text is drawn as plain lines, so the drawing has no words to read.
 */
import { useTranslation } from "react-i18next";

const TEXT_LINE = { stroke: "var(--line-strong)", strokeWidth: 4, strokeLinecap: "round" } as const;

function Row({ y, name, marker, out = false }: { y: number; name: number; marker: number; out?: boolean }) {
  return (
    <g>
      {/* The name and the value, as lines of text. */}
      <path d={`M 148 ${y} L ${148 + name} ${y} M 282 ${y} L 302 ${y}`} {...TEXT_LINE} />
      {/* The range bar: track, band, ticks and the marker. */}
      <path d={`M 148 ${y + 18} L 302 ${y + 18}`} stroke="var(--line-strong)" strokeWidth={1} />
      <rect x={188} y={y + 14} width={76} height={8} fill="var(--accent-band)" />
      <path d={`M 188 ${y + 12} L 188 ${y + 24} M 264 ${y + 12} L 264 ${y + 24}`} stroke="var(--line-strong)" strokeWidth={1.5} />
      <circle cx={marker} cy={y + 18} r={4.5} fill={out ? "var(--accent)" : "var(--ink-2)"} />
      {out && <path d={`M 148 ${y + 34} L 206 ${y + 34}`} {...TEXT_LINE} stroke="var(--accent)" />}
    </g>
  );
}

export function ResultSheetDrawing() {
  const { t } = useTranslation();
  return (
    <svg role="img" aria-label={t("landing.illustration")} viewBox="0 0 320 208" className="h-auto w-full">
      <rect x={1} y={1} width={318} height={206} fill="var(--surface)" stroke="var(--line)" strokeWidth={1.5} />
      {/* The photo, on the viewer's surround: a plain head, and lines across it. */}
      <rect x={16} y={16} width={112} height={140} rx={6} fill="var(--viewer)" />
      <g fill="none" stroke="var(--point)" strokeWidth={1.75} strokeLinecap="round">
        <ellipse cx={72} cy={82} rx={28} ry={36} />
        <path d="M 60 118 L 58 156 M 84 118 L 86 156" />
      </g>
      <g stroke="var(--accent-band)" strokeWidth={1.25} strokeDasharray="4 3">
        <path d="M 36 58 L 108 58 M 36 80 L 108 80 M 36 100 L 108 100" />
      </g>
      <Row y={26} name={96} marker={222} />
      <path d="M 148 70 L 302 70" stroke="var(--line)" strokeWidth={1} />
      <Row y={84} name={72} marker={284} out />
      <path d="M 148 138 L 302 138" stroke="var(--line)" strokeWidth={1} />
      <Row y={150} name={110} marker={240} />
      {/* The disclaimer under the photo. */}
      <path d="M 16 176 L 128 176 M 16 190 L 100 190" {...TEXT_LINE} stroke="var(--line)" />
    </svg>
  );
}
