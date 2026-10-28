/**
 * Point adjustment.
 *
 * - The reference image as an <img> with an SVG layer whose viewBox is the result's image
 *   size, so the point uses image pixel coordinates directly. No full-size canvas.
 * - Before anything can be adjusted, the displayed image's natural size must equal
 *   `result.image`. A mismatch (e.g. orientation) is reported and blocks adjustment.
 * - The point follows the core's convention: a filled dot while automatic, a hollow ring
 *   once moved. The view's other adjustable points are drawn smaller, for context.
 * - Drag the point (a loupe at 2.5× with a crosshair shows above the finger), tap the photo
 *   to place it, or use the arrow buttons and arrow keys (1 px, Shift 10 px). Coordinates
 *   stay inside the image (0 ≤ x < width, 0 ≤ y < height, as the core checks).
 * - A point on a `track` (the profile's silhouette) slides along it: every placement snaps
 *   to the nearest point of the track, which is drawn, and the arrows move it along the
 *   track, toward the forehead or the chin.
 * - The photo starts framed on the face; pinch or the zoom buttons change it.
 */
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Point } from "../../api/scan";
import type { Result } from "../../api/schemas";
import { Button } from "../ui/Button";
import { cx } from "../ui/cx";
import { ICON } from "../ui/icon";
import { Notice } from "../ui/Notice";
import { Surface } from "../viewer/Surface";
import { frame, useZoomPan } from "../viewer/useZoomPan";
import { ZoomControls } from "../viewer/ZoomControls";
import { projectOntoTrack, slideAlong, type Track } from "./contour";

export const LOUPE_ZOOM = 2.5;
const LOUPE_PX = 120;
const MARKER_PX = 7; // radius on screen, whatever the zoom

export function clampPoint(p: Point, size: { width: number; height: number }): Point {
  return { x: Math.min(size.width - 1, Math.max(0, p.x)), y: Math.min(size.height - 1, Math.max(0, p.y)) };
}

/** Another adjustable point, drawn for context (not interactive). */
export interface ContextPoint {
  id: string;
  point: Point;
  adjusted: boolean;
}

export interface AdjustViewProps {
  photoUrl: string;
  result: Pick<Result, "image" | "landmarks">;
  pointId: string;
  pointName: string;
  /** The position shown: the draft, else the result's. Null: not placed yet. */
  value: Point | null;
  /** True once the point differs from its automatic position (drawn as a ring). */
  adjusted: boolean;
  onChange(p: Point): void;
  /** Called with the outcome of the natural-size check. */
  onImageCheck?(ok: boolean): void;
  /** The silhouette the point slides along; null or absent: the point is placed freely. */
  track?: Track | null;
  /** The view's other adjustable points, for context. */
  others?: readonly ContextPoint[];
}

/** The face's bounding box in image pixels, from the available landmarks, with a margin. */
function faceBox(result: AdjustViewProps["result"]) {
  const pts = Object.values(result.landmarks).filter((l) => l.available && l.x !== null && l.y !== null);
  if (pts.length < 3) return null;
  const xs = pts.map((l) => l.x!);
  const ys = pts.map((l) => l.y!);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const mx = (x1 - x0) * 0.25;
  const my = (y1 - y0) * 0.25;
  return { x: x0 - mx, y: y0 - my * 1.6, width: x1 - x0 + 2 * mx, height: y1 - y0 + my * 2.6 };
}

export function AdjustView({ photoUrl, result, pointId, pointName, value, adjusted, onChange, onImageCheck, track = null, others = [] }: AdjustViewProps) {
  const { t } = useTranslation();
  const W = result.image.width;
  const H = result.image.height;
  const helpId = useId();
  const [imageOk, setImageOk] = useState<boolean | null>(null);
  const [dragging, setDragging] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const place = useCallback(
    (p: Point) => onChange(clampPoint(track ? projectOntoTrack(p, track).point : p, result.image)),
    [onChange, result.image, track],
  );

  const { surfaceRef, surfaceStyle, surfaceSize, handlers, contentStyle, view, size, setView, zoomIn, zoomOut, maxScale } =
    useZoomPan({
      maxScale: 8,
      onTap: (surfacePoint) => {
        if (!imageOk) return;
        const s = size();
        place({ x: (surfacePoint.x / s.width) * W, y: (surfacePoint.y / s.height) * H });
      },
    });

  // Start framed on the face (the hairline and the chin both in view).
  useLayoutEffect(() => {
    if (!imageOk) return;
    const box = faceBox(result);
    if (!box) return;
    const s = size();
    const k = s.width / W;
    setView(frame({ x: box.x * k, y: box.y * k, width: box.width * k, height: box.height * k }, s, 3));
    // Only when the image is first checked, not while the point moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageOk]);

  const toImage = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const rect = contentRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return null;
      return { x: ((clientX - rect.left) / rect.width) * W, y: ((clientY - rect.top) / rect.height) * H };
    },
    [W, H],
  );

  // Where the finger took hold of the handle, relative to the point (image px). The 44 px
  // handle is larger than the dot, so without it the point would jump under the finger.
  const grab = useRef<Point>({ x: 0, y: 0 });

  function onMarkerDown(e: PointerEvent<HTMLButtonElement>) {
    e.stopPropagation(); // the surface would pan instead
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = toImage(e.clientX, e.clientY);
    grab.current = p && value ? { x: value.x - p.x, y: value.y - p.y } : { x: 0, y: 0 };
    setDragging(true);
  }
  function onMarkerMove(e: PointerEvent<HTMLButtonElement>) {
    if (!dragging) return;
    e.stopPropagation();
    const p = toImage(e.clientX, e.clientY);
    if (p) place({ x: p.x + grab.current.x, y: p.y + grab.current.y });
  }
  function onMarkerUp(e: PointerEvent<HTMLButtonElement>) {
    e.stopPropagation();
    setDragging(false);
  }

  /** Free points: dx, dy in image pixels. */
  const nudge = useCallback(
    (dx: number, dy: number) => {
      if (value) place({ x: value.x + dx, y: value.y + dy });
    },
    [place, value],
  );
  /** Points on the track: pixels along it, positive toward the chin. */
  const slide = useCallback(
    (pixels: number) => {
      if (value && track) onChange(clampPoint(slideAlong(value, pixels, track), result.image));
    },
    [onChange, result.image, track, value],
  );

  function onMarkerKey(e: KeyboardEvent<HTMLButtonElement>) {
    const step = e.shiftKey ? 10 : 1;
    if (track) {
      // Along the outline: up toward the forehead, down toward the chin.
      const along: Record<string, number> = { ArrowUp: -step, ArrowDown: step };
      if (along[e.key] === undefined) return;
      e.preventDefault(); // not the page
      slide(along[e.key]!);
      return;
    }
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault(); // not the page
    nudge(...move);
  }

  const pad: PadButton[] = track
    ? [
        { key: "up", label: t("adjust.along.up"), Icon: ArrowUp, move: () => slide(-1) },
        { key: "down", label: t("adjust.along.down"), Icon: ArrowDown, move: () => slide(1) },
      ]
    : [
        { key: "up", label: t("adjust.move.up"), Icon: ArrowUp, move: () => nudge(0, -1) },
        { key: "down", label: t("adjust.move.down"), Icon: ArrowDown, move: () => nudge(0, 1) },
        { key: "left", label: t("adjust.move.left"), Icon: ArrowLeft, move: () => nudge(-1, 0) },
        { key: "right", label: t("adjust.move.right"), Icon: ArrowRight, move: () => nudge(1, 0) },
      ];

  // Where the point is on screen (the surface is not transformed; the content is).
  const s = surfaceSize;
  const screen = value ? { x: view.x + (value.x / W) * s.width * view.scale, y: view.y + (value.y / H) * s.height * view.scale } : null;
  const shownScale = (s.width / W) * view.scale; // CSS px per image px
  const r = MARKER_PX / Math.max(shownScale, 1e-6);
  const color = "var(--point)";

  return (
    <div>
      <Surface
        ref={surfaceRef}
        width={W}
        height={H}
        style={surfaceStyle}
        {...handlers}
        className={cx(imageOk && "cursor-crosshair")}
        data-testid="adjust-surface"
      >
        <div ref={contentRef} className="absolute inset-0" style={contentStyle}>
          <img
            src={photoUrl}
            alt={t("adjust.alt", { name: pointName })}
            draggable={false}
            className="absolute inset-0 size-full"
            onLoad={(e) => {
              const ok = e.currentTarget.naturalWidth === W && e.currentTarget.naturalHeight === H;
              setImageOk(ok);
              onImageCheck?.(ok);
            }}
          />
          {imageOk && (
            <svg viewBox={`0 0 ${W} ${H}`} className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
              {track && (
                // The outline the point slides along, with a dark edge so it shows on light skin.
                <g fill="none" strokeLinejoin="round" data-testid="adjust-track">
                  <polyline points={track.poly.map(([x, y]) => `${x},${y}`).join(" ")} stroke="var(--point-shadow)" strokeWidth={r * 0.55} strokeOpacity={0.6} />
                  <polyline points={track.poly.map(([x, y]) => `${x},${y}`).join(" ")} stroke={color} strokeWidth={r * 0.25} />
                </g>
              )}
              {others.map(({ id, point, adjusted: moved }) =>
                moved ? (
                  <circle key={id} cx={point.x} cy={point.y} r={r * 0.75} fill="none" stroke={color} strokeWidth={r * 0.3} />
                ) : (
                  <circle key={id} cx={point.x} cy={point.y} r={r * 0.55} fill={color} stroke="var(--point-shadow)" strokeWidth={r * 0.25} />
                ),
              )}
              {value &&
                (adjusted ? (
                  <>
                    <circle cx={value.x} cy={value.y} r={r * 1.25} fill="none" stroke="var(--point-shadow)" strokeWidth={r * 0.9} />
                    <circle cx={value.x} cy={value.y} r={r * 1.25} fill="none" stroke={color} strokeWidth={r * 0.45} />
                  </>
                ) : (
                  <circle cx={value.x} cy={value.y} r={r} fill={color} stroke="var(--point-shadow)" strokeWidth={r * 0.35} />
                ))}
            </svg>
          )}
        </div>

        {imageOk && screen && (
          <button
            type="button"
            aria-label={pointName}
            aria-describedby={helpId}
            className="absolute size-target -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full"
            style={{ left: screen.x, top: screen.y, touchAction: "none" }}
            onPointerDown={onMarkerDown}
            onPointerMove={onMarkerMove}
            onPointerUp={onMarkerUp}
            onPointerCancel={onMarkerUp}
            onKeyDown={onMarkerKey}
            data-testid="adjust-marker"
            data-point={pointId}
          />
        )}

        {dragging && screen && <Loupe photoUrl={photoUrl} surface={s} view={view} point={screen} />}
      </Surface>

      <p id={helpId} className="sr-only">
        {t(track ? "adjust.keyboardHelpContour" : "adjust.keyboardHelp")}
      </p>

      {imageOk === false && (
        <Notice role="alert" className="mt-4">
          <p>{t("adjust.imageMismatch")}</p>
        </Notice>
      )}

      {imageOk && (
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <ArrowPad label={t(track ? "adjust.alongGroup" : "adjust.moveGroup")} buttons={pad} disabled={!value} />
          <ZoomControls onIn={zoomIn} onOut={zoomOut} canIn={view.scale < maxScale} canOut={view.scale > 1} />
        </div>
      )}
    </div>
  );
}

/** The magnifier above the finger while dragging: a round window on the photo, 2.5×. */
function Loupe({
  photoUrl,
  surface,
  view,
  point,
}: {
  photoUrl: string;
  surface: { width: number; height: number };
  view: { scale: number; x: number; y: number };
  point: { x: number; y: number };
}) {
  const shownW = surface.width * view.scale * LOUPE_ZOOM;
  const shownH = surface.height * view.scale * LOUPE_ZOOM;
  // The point in the magnified photo.
  const px = (point.x - view.x) * LOUPE_ZOOM;
  const py = (point.y - view.y) * LOUPE_ZOOM;
  // Above the finger; near the top edge, beside it (a loupe below would be under the finger).
  const gap = 24;
  const clampY = (y: number) => Math.min(surface.height - LOUPE_PX, Math.max(0, y));
  const clampX = (x: number) => Math.min(surface.width - LOUPE_PX, Math.max(0, x));
  let left: number;
  let top: number;
  if (point.y - LOUPE_PX - gap >= 0) {
    left = clampX(point.x - LOUPE_PX / 2);
    top = point.y - LOUPE_PX - gap;
  } else {
    const roomRight = surface.width - point.x - gap >= LOUPE_PX;
    left = roomRight ? point.x + gap : clampX(point.x - gap - LOUPE_PX);
    top = clampY(point.y - LOUPE_PX / 2);
  }
  return (
    <div
      aria-hidden="true"
      data-testid="loupe"
      className="pointer-events-none absolute overflow-hidden rounded-full border-2 border-surface bg-viewer"
      style={{
        left,
        top,
        width: LOUPE_PX,
        height: LOUPE_PX,
        backgroundImage: `url("${photoUrl}")`,
        backgroundSize: `${shownW}px ${shownH}px`,
        backgroundPosition: `${LOUPE_PX / 2 - px}px ${LOUPE_PX / 2 - py}px`,
        backgroundRepeat: "no-repeat",
        outline: "1px solid var(--ink)",
      }}
    >
      <span className="absolute top-1/2 left-0 h-px w-full bg-accent" />
      <span className="absolute top-0 left-1/2 h-full w-px bg-accent" />
    </div>
  );
}

interface PadButton {
  key: string;
  label: string;
  Icon: LucideIcon;
  move(): void;
}

/**
 * Arrow buttons: one image pixel per press, repeating while held (WCAG 2.5.7).
 *
 * A press is a `click`, which every input sends: mouse, touch, Enter and Space, and the
 * screen readers and voice control that activate a button without pointer events
 * (TalkBack, Voice Access, NVDA). Holding a pointer down repeats the step after 400 ms; the
 * click that ends a hold is not counted again.
 */
export const HOLD_DELAY_MS = 400;

function ArrowPad({ label, buttons, disabled }: { label: string; buttons: readonly PadButton[]; disabled: boolean }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeating = useRef(false);
  const holdEndedAt = useRef(Number.NEGATIVE_INFINITY);
  const latest = useRef(buttons);
  useEffect(() => {
    latest.current = buttons;
  }, [buttons]);
  /** `at`: the event's timeStamp, when a pointer ends the press. */
  const stop = (at?: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (repeating.current) {
      repeating.current = false;
      if (at !== undefined) holdEndedAt.current = at;
    }
  };
  useEffect(() => stop, []);
  const hold = (key: string) => {
    stop();
    const repeat = (delay: number) => {
      timer.current = setTimeout(() => {
        repeating.current = true;
        latest.current.find((b) => b.key === key)?.move();
        repeat(Math.max(30, delay * 0.85));
      }, delay);
    };
    repeat(HOLD_DELAY_MS);
  };
  const press = (button: PadButton, at: number) => {
    if (at - holdEndedAt.current < HOLD_DELAY_MS) return; // the click that ends a hold
    button.move();
  };
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {buttons.map((button) => (
        <Button
          key={button.key}
          variant="secondary"
          disabled={disabled}
          // No selection or callout on a long press, and no double-tap zoom on quick presses.
          // (Not preventDefault on pointerdown: WebKit then drops the tap's click.)
          className="touch-manipulation px-3 select-none [-webkit-touch-callout:none]"
          onPointerDown={(e) => {
            if (e.pointerType === "mouse" && e.button !== 0) return;
            hold(button.key);
          }}
          onPointerUp={(e) => stop(e.timeStamp)}
          onPointerLeave={(e) => stop(e.timeStamp)}
          onPointerCancel={(e) => stop(e.timeStamp)}
          onContextMenu={(e) => e.preventDefault()} // a long press is a hold, not a menu
          onClick={(e) => press(button, e.timeStamp)}
        >
          <button.Icon {...ICON} size={20} />
          {button.label}
        </Button>
      ))}
    </div>
  );
}
