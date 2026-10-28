/**
 * Results: the photo viewer with the overlay, the core's notices (warnings,
 * side note, reference note), the measurement sheet grouped by area, the disclaimer last,
 * and the scan's date and versions. Two columns from 1024 px, with the viewer sticky on the
 * left.
 *
 * - Frontal: the side photo is offered next (optional), and the report without it.
 * - Profile: the report next.
 * - Profile: a note when the frontal scale could not be used (request 3 in ASSUMPTIONS.md), and the request
 *   to place the alar crease while it has no position.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useNavigate } from "react-router";
import { Screen } from "../../components/layout/Screen";
import { MeasurementSheet } from "../../components/results/MeasurementSheet";
import { ScanMeta } from "../../components/results/ScanMeta";
import { Button, LinkButton } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Notice } from "../../components/ui/Notice";
import { PhotoViewer } from "../../components/viewer/PhotoViewer";
import { useScan } from "../../scan/ScanContext";
import { hasProfilePhoto, type View } from "../../scan/session";
import { scanPath } from "../paths";
import { step } from "../steps";
import { AlarCreasePrompt } from "./AlarCreasePrompt";

export function ResultScreen({ view }: { view: View }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const scan = useScan();
  const { latest, photoUrl, announcement } = scan.state[view];
  const [confirmNew, setConfirmNew] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { dispatch } = scan;

  // "Position saved" and "restored" are announced once, politely. The live region
  // is filled just after the screen appears, so screen readers hear the change.
  useEffect(() => {
    if (!announcement) return;
    const timer = setTimeout(() => {
      setMessage(announcement.kind === "saved" ? t("results.saved", { count: announcement.count }) : t("results.reset"));
      dispatch({ type: "announced", view });
    }, 150);
    return () => clearTimeout(timer);
  }, [announcement, dispatch, t, view]);

  if (!latest || !photoUrl) return <Navigate to={scanPath(view, "guide")} replace />;
  const result = latest.result;
  const startOver = () => {
    scan.newScan();
    navigate("/subject");
  };
  const canAdjust = result.adjustable_points.length > 0;
  // A profile whose frontal scale could not be used has no warning key for it (request 3 in ASSUMPTIONS.md).
  const noScale =
    view === "profile" && result.calibration?.available === false && !result.warnings.some((w) => w.key === "no_frontal_scale");
  const profileResults = scan.state.profile.latest !== null;

  return (
    <Screen
      title={view === "frontal" ? t("results.title") : t("profile.results.title")}
      step={step(t, view)}
      onBack={view === "profile" ? () => navigate(scanPath("frontal", "result")) : undefined}
      wide
      actions={
        // The next step is the primary action: the side photo, then the report.
        view === "frontal" && !profileResults ? (
          <>
            <LinkButton to="/report" variant="secondary">
              {t("report.see")}
            </LinkButton>
            <LinkButton to={scanPath("profile", "guide")} variant="primary">
              {t("results.addProfile")}
            </LinkButton>
          </>
        ) : (
          <>
            {view === "frontal" && (
              <LinkButton to={scanPath("profile", "result")} variant="secondary">
                {t("results.seeProfile")}
              </LinkButton>
            )}
            <LinkButton to="/report" variant="primary">
              {t("report.see")}
            </LinkButton>
          </>
        )
      }
    >
      <p role="status" className="sr-only">
        {message ?? ""}
      </p>
      <div className="grid gap-8 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <div className="lg:sticky lg:top-4">
            <PhotoViewer photoUrl={photoUrl} overlayUrl={latest.overlay} result={result} />
            {latest.overlayProblem === "failed" && <p className="mt-3 text-sm text-ink-2">{t("results.overlayFailed")}</p>}
            {message && <p className="mt-3 text-sm text-ink-2" aria-hidden="true">{message}</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              {canAdjust && (
                <LinkButton to={scanPath(view, "adjust")} variant="secondary">
                  {t("results.adjust")}
                </LinkButton>
              )}
              {view === "profile" && (
                <LinkButton to={scanPath("profile", "guide")} variant="secondary">
                  {t("profile.results.retake")}
                </LinkButton>
              )}
            </div>
            {view === "profile" && <AlarCreasePrompt result={result} />}
          </div>
        </div>

        <div className="grid content-start gap-4 lg:col-span-7">
          {result.warnings.map((w) => (
            <Notice key={w.key} data-warning={w.key}>
              <p>{w.text}</p>
            </Notice>
          ))}
          {noScale && (
            <Notice data-warning="no_scale">
              <p>{t("profile.results.noScale")}</p>
            </Notice>
          )}
          <Notice icon={false}>
            <p>{result.side_note}</p>
            <p className="mt-2">{result.reference_note}</p>
          </Notice>
          <MeasurementSheet metrics={result.metrics} />
          <p className="text-ink-2">{result.disclaimer}</p>
          <ScanMeta date={new Date(latest.analyzedAt)} versions={latest.versions} />
          <p className="flex flex-wrap items-center gap-x-6">
            <Link to="/method">{t("method.link")}</Link>
            <Button variant="tertiary" onClick={() => setConfirmNew(true)}>
              {t("results.newScan")}
            </Button>
          </p>
        </div>
      </div>

      <ConfirmDialog
        open={confirmNew}
        onOpenChange={setConfirmNew}
        title={t("newScan.title")}
        body={<p>{t("newScan.body", { context: hasProfilePhoto(scan.state) ? "both" : undefined })}</p>}
        confirm={t("newScan.confirm")}
        cancel={t("newScan.cancel")}
        onConfirm={startOver}
      />
    </Screen>
  );
}
