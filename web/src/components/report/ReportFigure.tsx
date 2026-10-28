/**
 * A view's photo in the report: the latest overlay, or the photo
 * with the app's own points when the overlay could not be redrawn. Small and static:
 * the viewer with zoom is on the results screens.
 */
import { useTranslation } from "react-i18next";
import type { Result } from "../../api/schemas";
import { PointsLayer } from "../viewer/PointsLayer";

export function ReportFigure({ photoUrl, overlayUrl, result }: { photoUrl: string; overlayUrl: string | null; result: Result }) {
  const { t } = useTranslation();
  const { width, height } = result.image;
  return (
    <figure className="w-full max-w-[16rem] break-inside-avoid print:max-w-[60mm]">
      <div className="relative overflow-hidden rounded-viewer bg-viewer" style={{ aspectRatio: `${width} / ${height}` }}>
        <img
          src={overlayUrl ?? photoUrl}
          alt={t("viewer.altOverlay")}
          className="absolute inset-0 size-full"
          draggable={false}
        />
        {!overlayUrl && <PointsLayer result={result} />}
      </div>
    </figure>
  );
}
