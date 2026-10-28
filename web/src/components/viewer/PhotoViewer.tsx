/**
 * The photo viewer: the `user` overlay on a --viewer surround, with
 * pinch and double-tap zoom inside the viewer (page zoom stays enabled) and a two-option
 * switch between "with measurement lines" and "original". Without an overlay (the redraw
 * failed) the app draws the points itself.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Result } from "../../api/schemas";
import { SegmentedControl } from "../ui/SegmentedControl";
import { cx } from "../ui/cx";
import { PointsLayer } from "./PointsLayer";
import { Surface } from "./Surface";
import { useZoomPan } from "./useZoomPan";
import { ZoomControls } from "./ZoomControls";

export interface PhotoViewerProps {
  photoUrl: string;
  overlayUrl: string | null;
  result: Pick<Result, "image" | "landmarks">;
  /** While uploading and analyzing: the photo is dimmed and not interactive. */
  dimmed?: boolean;
  controls?: boolean;
  /** The "with measurement lines / original" switch (not for a photo without results). */
  toggle?: boolean;
  className?: string;
}

export function PhotoViewer({ photoUrl, overlayUrl, result, dimmed = false, controls = true, toggle = true, className }: PhotoViewerProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"overlay" | "original">("overlay");
  const { surfaceRef, surfaceStyle, handlers, contentStyle, view, zoomIn, zoomOut, maxScale } = useZoomPan({ doubleTapZoom: true });
  const lines = toggle && mode === "overlay";
  const src = lines && overlayUrl ? overlayUrl : photoUrl;
  return (
    <figure className={className}>
      <Surface
        ref={surfaceRef}
        width={result.image.width}
        height={result.image.height}
        style={dimmed ? undefined : surfaceStyle}
        {...(dimmed ? {} : handlers)}
        data-testid="photo-viewer"
      >
        <div className="absolute inset-0" style={contentStyle}>
          <img
            src={src}
            alt={lines ? t("viewer.altOverlay") : t("viewer.altOriginal")}
            draggable={false}
            className={cx("absolute inset-0 size-full transition-opacity", dimmed && "opacity-40")}
          />
          {lines && !overlayUrl && !dimmed && <PointsLayer result={result} />}
        </div>
      </Surface>
      {controls && !dimmed && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          {toggle && (
          <SegmentedControl
            label={t("viewer.label")}
            value={mode}
            onChange={setMode}
            options={[
              { value: "overlay", label: t("viewer.overlay") },
              { value: "original", label: t("viewer.original") },
            ]}
          />
          )}
          <ZoomControls
            onIn={zoomIn}
            onOut={zoomOut}
            canIn={view.scale < maxScale}
            canOut={view.scale > 1}
          />
        </div>
      )}
    </figure>
  );
}
