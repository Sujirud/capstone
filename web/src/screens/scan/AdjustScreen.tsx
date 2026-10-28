/**
 * Point adjustment: the points in `result.adjustable_points` only, each with
 * the core's name and instruction verbatim. Every changed point goes in one /v1/adjust call
 * (the API sets `source`), then the overlay is redrawn. "Reset to automatic" restores the
 * original token and result from the analysis and sends nothing.
 *
 * Profile: silhouette points slide along `result.contour`; the alar crease is placed freely,
 * with the drawing that shows where it goes (P3a needs it).
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useNavigate } from "react-router";
import type { ApiError } from "../../api/client";
import type { Point } from "../../api/scan";
import type { ClientConfig } from "../../api/schemas";
import { AdjustView, type ContextPoint } from "../../components/adjust/AdjustView";
import { makeTrack } from "../../components/adjust/contour";
import { AlarCreaseDrawing } from "../../components/illustrations/Profile";
import { Screen } from "../../components/layout/Screen";
import { Button } from "../../components/ui/Button";
import { Notice } from "../../components/ui/Notice";
import { Select } from "../../components/ui/Select";
import { ALAR_CREASE, slidesOnContour } from "../../scan/points";
import { useScan } from "../../scan/ScanContext";
import { hasProfilePhoto, type View } from "../../scan/session";
import { scanPath, type AdjustState, type AnalyzeState } from "../paths";
import { step } from "../steps";
import { ScanErrorPanel } from "./ScanErrorPanel";

export function AdjustScreen({ config, view }: { config: ClientConfig; view: View }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const requested = (useLocation().state as AdjustState | null)?.point;
  const scan = useScan();
  const { latest, original, photoUrl, task } = scan.state[view];
  const points = useMemo(() => latest?.result.adjustable_points ?? [], [latest]);
  const [active, setActive] = useState(() => (points.some((p) => p.id === requested) ? requested! : (points[0]?.id ?? "")));
  const [draft, setDraft] = useState<Record<string, Point>>({});
  const [imageOk, setImageOk] = useState<boolean | null>(null);
  const [failure, setFailure] = useState<{ error: ApiError; at: number } | null>(null);

  // Where each point is now: the draft, else the result's position (null: not placed yet).
  const positions = useMemo(() => {
    const out: Record<string, { value: Point | null; adjusted: boolean }> = {};
    if (!latest) return out;
    for (const { id } of points) {
      const lm = latest.result.landmarks[id];
      const auto = lm?.available && lm.x !== null && lm.y !== null ? { x: lm.x, y: lm.y } : null;
      out[id] = { value: draft[id] ?? auto, adjusted: Boolean(draft[id]) || Boolean(lm?.adjusted) };
    }
    return out;
  }, [latest, points, draft]);

  const contour = latest?.result.contour;
  const track = useMemo(() => (contour && contour.length >= 2 ? makeTrack(contour) : null), [contour]);

  if (!latest || !photoUrl || points.length === 0) return <Navigate to={scanPath(view, "result")} replace />;
  const point = points.find((p) => p.id === active) ?? points[0]!;
  const current = positions[point.id]!;
  const onTrack = slidesOnContour(view, point.id) && track !== null;
  const others: ContextPoint[] = points
    .filter((p) => p.id !== point.id)
    .flatMap((p) => {
      const pos = positions[p.id]!;
      return pos.value ? [{ id: p.id, point: pos.value, adjusted: pos.adjusted }] : [];
    });
  const saving = task.kind === "saving";
  const changed = Object.keys(draft).length > 0;
  const hasSavedAdjustments = original !== null && original !== latest;
  const unplaced = current.value === null;
  const count = points.length;

  async function save() {
    const controller = new AbortController();
    setFailure(null);
    const outcome = await scan.saveAdjustment(view, draft, config, controller.signal);
    if (outcome.kind === "ok") navigate(scanPath(view, "result"), { replace: true });
    else if (outcome.kind === "error") setFailure({ error: outcome.error, at: Date.now() });
  }

  return (
    <Screen
      title={t("adjust.title")}
      step={step(t, view)}
      onBack={() => navigate(scanPath(view, "result"))}
      wide
      actions={
        <>
          {hasSavedAdjustments && (
            <Button
              variant="tertiary"
              disabled={saving}
              onClick={() => {
                scan.resetToAutomatic(view);
                navigate(scanPath(view, "result"), { replace: true });
              }}
            >
              {t("adjust.reset")}
            </Button>
          )}
          <Button variant="secondary" disabled={saving} onClick={() => navigate(scanPath(view, "result"))}>
            {t("adjust.cancel")}
          </Button>
          <Button variant="primary" disabled={!changed || saving || imageOk !== true} onClick={() => void save()}>
            {saving ? t("adjust.saving", { count }) : t("adjust.save", { count })}
          </Button>
        </>
      }
    >
      {/* What to do, then where to do it: above the photo on a phone (choosing a point never
          scrolls the photo away), beside it from 1024 px. Feedback follows the photo. */}
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="grid content-start gap-3 lg:col-span-5 lg:col-start-8 lg:row-start-1">
          {points.length > 1 && (
            <Select
              label={t("adjust.pointGroup")}
              value={point.id}
              onChange={setActive}
              options={points.map((p) => ({ value: p.id, label: p.name }))}
              className="mb-1"
            />
          )}
          <h2 className="text-lg">{point.name}</h2>
          <div className="flex items-start gap-4">
            <p className="min-w-0 flex-1">{point.instruction}</p>
            {point.id === ALAR_CREASE && view === "profile" && (
              <div className="w-[8rem] shrink-0">
                <AlarCreaseDrawing />
              </div>
            )}
          </div>
          {unplaced && (
            <Notice>
              {/* The alar crease never has an automatic position; other points were not found. */}
              <p>{t(view === "profile" && !slidesOnContour(view, point.id) ? "adjust.placeByHand" : "adjust.placeHint")}</p>
            </Notice>
          )}
        </div>
        <div className="lg:col-span-7 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <AdjustView
            photoUrl={photoUrl}
            result={latest.result}
            pointId={point.id}
            pointName={point.name}
            value={current.value}
            adjusted={current.adjusted}
            onChange={(p) => setDraft((d) => ({ ...d, [point.id]: p }))}
            onImageCheck={setImageOk}
            track={onTrack ? track : null}
            others={others}
          />
        </div>
        <div className="grid content-start gap-4 lg:col-span-5 lg:col-start-8 lg:row-start-2">
          <p role="status" className="sr-only">
            {saving ? t("adjust.saving", { count }) : ""}
          </p>
          {failure && (
            <ScanErrorPanel
              error={failure.error}
              at={failure.at}
              photos={hasProfilePhoto(scan.state) ? 2 : 1}
              onRetry={() => void save()}
              // An ended scan: analyze the frontal photo again, then the side photo if it had results.
              onReanalyze={() =>
                navigate(scanPath("frontal", "analyzing"), {
                  state: { profileNext: scan.state.profile.latest !== null } satisfies AnalyzeState,
                })
              }
              onStartOver={() => {
                scan.newScan();
                navigate("/subject");
              }}
            />
          )}
        </div>
      </div>
    </Screen>
  );
}
