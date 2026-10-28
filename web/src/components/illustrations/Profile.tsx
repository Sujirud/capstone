/**
 * Side-photo drawings: the same 1.75 px `--ink`
 * stroke as the frontal drawings, with `--accent` on the one detail to notice (the 90° turn,
 * the plain background, the hair behind the ear, the line of sight, the chin and neck, the
 * side of the nose). A plain, neutral head in profile, facing right; mirrored for left.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Facing } from "../../api/schemas";
import { ACCENT, Drawing, INK } from "./Guide";

/** The head's front outline, crown to neck (local units, 100 × 140, nose toward +x). */
const FRONT =
  "M 40 4 C 62 4 78 18 80 40 Q 82 48 81 52 Q 79 56 80 58 L 93 74 Q 97 79 91 80 L 83 80 Q 81 84 85 88 " +
  "Q 86 90 82 91 Q 86 93 84 96 Q 80 99 80 102 Q 84 106 82 111";
/** The chin's underside and the front of the neck: what the photo must show. */
const CHIN_NECK = "M 82 111 Q 80 116 72 117 Q 64 118 61 121 L 60 140";
const BACK = "M 40 4 C 20 4 8 20 8 46 C 8 66 12 80 22 92 Q 28 100 29 110 L 30 140";

/**
 * A head in profile at (x, y), local units scaled by `scale`. `accent` picks the one
 * accented detail; `children` draw in the head's own units.
 */
function Head({
  x,
  y,
  scale = 1,
  facing = "right",
  accent,
  children,
}: {
  x: number;
  y: number;
  scale?: number;
  facing?: Facing;
  accent?: "neck" | "hair";
  children?: ReactNode;
}) {
  // Mirrored about the head's own middle, so it stays in place.
  const flip = facing === "left" ? `translate(100 0) scale(-1 1)` : "";
  return (
    <g transform={`translate(${x} ${y}) scale(${scale}) ${flip}`}>
      <path d={FRONT} {...INK} />
      <path d={CHIN_NECK} {...(accent === "neck" ? ACCENT : INK)} />
      <path d={BACK} {...INK} />
      {/* The ear, and the eye as a short line. */}
      <path d="M 48 50 C 39 50 39 70 48 70" {...INK} />
      <path d="M 72 60 L 77 59" {...INK} />
      {accent === "hair" && (
        // The hair's edge: from the forehead, over and behind the ear, to the nape.
        <path d="M 66 12 C 58 22 52 34 51 46 C 50 54 46 62 38 70 C 32 76 26 82 22 90" {...ACCENT} />
      )}
      {children}
    </g>
  );
}

/**
 * Step 1: seen from above, the camera to the side and the face turned 90° from it. A camera
 * icon, the line of sight, and the head from above with the nose pointing up the page.
 */
export function ProfileTurnDrawing({ distance }: { distance: number }) {
  const { t } = useTranslation();
  return (
    <Drawing alt={t("profile.drawing.turn", { distance })} viewBox="0 0 240 150">
      {/* The camera, lens toward the person. */}
      <g {...INK}>
        <rect x={12} y={82} width={30} height={22} rx={3} />
        <rect x={18} y={77} width={10} height={5} rx={1} />
        <path d="M 42 87 L 50 85 L 50 101 L 42 99" />
      </g>
      {/* The line of sight, and the distance under it. */}
      <path d="M 56 93 L 164 93" {...INK} strokeWidth={1} strokeDasharray="4 5" />
      <path d="M 56 112 L 164 112 M 61 108 L 56 112 L 61 116 M 159 108 L 164 112 L 159 116" {...INK} strokeWidth={1} />
      <text x={110} y={136} textAnchor="middle" fontSize={16} fontWeight={600} fill="currentColor" stroke="none">
        {t("guide.drawing.distanceLabel", { distance })}
      </text>
      {/* The person from above: shoulders across, the head, the nose pointing up the page. */}
      <g {...INK}>
        <ellipse cx={196} cy={93} rx={30} ry={11} />
        <circle cx={196} cy={93} r={11} />
        <path d="M 191 83 L 196 75 L 201 83" />
        <path d="M 196 70 L 196 20 M 191 26 L 196 20 L 201 26" strokeWidth={1} />
      </g>
      {/* 90° between the line of sight and the way the face points. */}
      <path d="M 166 93 A 30 30 0 0 1 196 63" {...ACCENT} />
      <text x={160} y={62} textAnchor="end" fontSize={16} fontWeight={600} fill="var(--accent)" stroke="none">
        90°
      </text>
    </Drawing>
  );
}

/** Step 2: a plain background that contrasts with skin and hair. */
export function ProfileBackgroundDrawing() {
  const { t } = useTranslation();
  return (
    <Drawing alt={t("profile.drawing.background")}>
      <rect x={30} y={8} width={180} height={134} fill="var(--accent-band)" stroke="var(--accent)" strokeWidth={2.25} />
      <Head x={72} y={12} scale={0.92} />
    </Drawing>
  );
}

/** Step 3: hair tucked behind the ear. */
export function ProfileHairDrawing() {
  const { t } = useTranslation();
  return (
    <Drawing alt={t("profile.drawing.hair")}>
      <Head x={70} y={4} accent="hair" />
    </Drawing>
  );
}

/** Step 4: looking straight ahead at a point at eye level. */
export function ProfileGazeDrawing() {
  const { t } = useTranslation();
  return (
    <Drawing alt={t("profile.drawing.gaze")}>
      <Head x={30} y={4} />
      <path d="M 110 63 L 214 63" {...ACCENT} strokeDasharray="5 5" />
      <circle cx={222} cy={63} r={5} {...ACCENT} />
    </Drawing>
  );
}

/** Step 5: the chin and part of the neck visible, the collar below the chin. */
export function ProfileNeckDrawing() {
  const { t } = useTranslation();
  return (
    <Drawing alt={t("profile.drawing.neck")}>
      <Head x={70} y={0} scale={0.95} accent="neck" />
      {/* A collar well below the chin. */}
      <path d="M 88 146 Q 112 138 134 146" {...INK} />
    </Drawing>
  );
}

/** A head for the facing choice, with the direction the nose points. */
export function FacingDrawing({ facing }: { facing: Facing }) {
  return (
    <svg viewBox="0 0 140 110" aria-hidden="true" className="h-auto w-full text-ink">
      {/* The nose 54 units from the arrow's side either way, so the two read as mirror images. */}
      <Head x={facing === "right" ? 14 : 52} y={0} scale={0.74} facing={facing} />
      {facing === "right" ? (
        <path d="M 96 57 L 128 57 M 122 51 L 128 57 L 122 63" {...ACCENT} />
      ) : (
        <path d="M 44 57 L 12 57 M 18 51 L 12 57 L 18 63" {...ACCENT} />
      )}
    </svg>
  );
}

/**
 * The side of the nose (the alar crease): a close view of the nose in profile, with the
 * point where the nostril's wing meets the cheek ringed. Not on the outline, so it is always
 * placed by hand.
 */
export function AlarCreaseDrawing() {
  const { t } = useTranslation();
  return (
    // Cropped to the nose, so it reads at the small sizes it is shown at (no text in it).
    <Drawing alt={t("profile.drawing.alarCrease")} viewBox="48 0 132 150">
      <g {...INK}>
        {/* Forehead, the top of the nose, the bridge, the tip, the base and the lips. */}
        <path d="M 96 0 Q 106 14 106 26 Q 106 34 100 40 Q 126 62 156 94 Q 166 104 156 111 Q 150 113 142 112 L 128 113 Q 124 122 131 130 Q 133 134 124 137 Q 132 141 128 147 L 124 150" />
        {/* The eye. */}
        <path d="M 64 50 L 80 48" />
        {/* The nostril's wing, curving back from under the tip to the cheek, and the nostril. */}
        <path d="M 150 110 C 148 96 130 88 116 94 C 108 98 110 110 124 112" />
        <path d="M 132 108 Q 138 106 142 109" />
      </g>
      {/* Where the wing meets the cheek. */}
      <circle cx={113} cy={99} r={8} {...ACCENT} />
      <circle cx={113} cy={99} r={2} fill="var(--accent)" stroke="none" />
    </Drawing>
  );
}
