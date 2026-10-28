/**
 * The report: `POST /v1/report` with the latest tokens, rendered verbatim
 * and in the API's order: `consideration_intro`, each consideration, `no_considerations_note`,
 * and the `disclaimer` last. When the rules are the core's illustrative examples
 * (`rules_version: "EXAMPLE"`), a note at the top says so.
 *
 * The page is also the printed report: a header with the scan's date and versions,
 * each photo with its measurement lines, the measurement tables, and the disclaimer at the
 * end; the print stylesheet removes navigation and buttons. "Save as PDF or print" opens the
 * browser's print dialog; nothing leaves the browser.
 */
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useNavigate } from "react-router";
import type { ApiError } from "../api/client";
import { EXAMPLE_RULES_VERSION, type Result } from "../api/schemas";
import { Screen } from "../components/layout/Screen";
import { ConsiderationItem } from "../components/report/ConsiderationItem";
import { ReportFigure } from "../components/report/ReportFigure";
import { MeasurementTable } from "../components/results/MeasurementTable";
import { ScanMeta } from "../components/results/ScanMeta";
import { Button } from "../components/ui/Button";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Notice } from "../components/ui/Notice";
import { useScan } from "../scan/ScanContext";
import { currentReport, hasProfilePhoto, reportKey, type View } from "../scan/session";
import { scanPath, type AnalyzeState } from "./paths";
import { ScanErrorPanel } from "./scan/ScanErrorPanel";
import { step } from "./steps";

function ViewTables({ view, result, photoUrl, overlayUrl }: { view: View; result: Result; photoUrl: string | null; overlayUrl: string | null }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section aria-labelledby={id} className="pt-4">
      <h3 id={id} className="mb-3 text-lg">
        {t(`steps.${view}`)}
      </h3>
      {/* The photo beside its table from 1024 px, above it on a phone and on paper. */}
      <div className="grid gap-4 lg:grid-cols-12 print:block">
        <div className="lg:col-span-3 print:mb-3">
          {photoUrl && <ReportFigure photoUrl={photoUrl} overlayUrl={overlayUrl} result={result} />}
        </div>
        <div className="lg:col-span-9">
          <MeasurementTable metrics={result.metrics} labelledBy={id} />
        </div>
      </div>
    </section>
  );
}

export function ReportScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const scan = useScan();
  const { state, requestReport } = scan;
  const entry = currentReport(state);
  const key = reportKey(state);
  const [failure, setFailure] = useState<{ error: ApiError; at: number } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [confirmNew, setConfirmNew] = useState(false);
  const introId = useId();
  const allId = useId();
  const missing = entry === null;

  // Requested when the page opens without a report for the latest tokens (StrictMode-safe, as
  // in AnalyzingScreen: started a tick later, cancelled when the page goes).
  useEffect(() => {
    if (key === null || !missing) return;
    const controller = new AbortController();
    const start = setTimeout(() => {
      void requestReport(controller.signal).then((outcome) => {
        if (outcome.kind === "error") setFailure({ error: outcome.error, at: Date.now() });
      });
    }, 0);
    return () => {
      clearTimeout(start);
      controller.abort();
    };
  }, [key, missing, attempt, requestReport]);

  if (key === null || !state.frontal.latest) return <Navigate to={scanPath("frontal", "guide")} replace />;
  const withProfile = state.profile.latest !== null;
  const backTo = scanPath(withProfile ? "profile" : "frontal", "result");
  const startOver = () => {
    scan.newScan();
    navigate("/subject");
  };
  const report = entry?.response.report;
  const scanDate = new Date(state.frontal.latest.analyzedAt);

  return (
    <Screen
      title={t("report.title")}
      step={step(t, "results")}
      onBack={() => navigate(backTo)}
      wide
      actions={
        report ? (
          <Button variant="primary" onClick={() => window.print()}>
            {t("report.print")}
          </Button>
        ) : undefined
      }
    >
      {!report && !failure && (
        <p role="status" className="text-ink-2">
          {t("report.loading")}
        </p>
      )}
      {failure && (
        <ScanErrorPanel
          error={failure.error}
          at={failure.at}
          photos={hasProfilePhoto(state) ? 2 : 1}
          onRetry={() => {
            setFailure(null);
            setAttempt((n) => n + 1);
          }}
          // An ended scan: analyze the photos again, then come back here.
          onReanalyze={() =>
            navigate(scanPath("frontal", "analyzing"), {
              state: { profileNext: withProfile, next: "report" } satisfies AnalyzeState,
            })
          }
          onStartOver={startOver}
        />
      )}
      {report && entry && (
        <div lang={report.locale} className="grid gap-4">
          {/* Print header: the scan's date and versions. */}
          <div className="hidden max-w-page print:block">
            <ScanMeta date={scanDate} versions={entry.response.versions} />
          </div>
          {report.rules_version === EXAMPLE_RULES_VERSION && (
            <Notice data-testid="example-rules" className="max-w-page">
              <p>{t("report.exampleRules")}</p>
            </Notice>
          )}

          {/* Prose keeps the reading column; the tables below use the full width. */}
          <section aria-labelledby={introId} className="max-w-page">
            <h2 id={introId} className="text-xl">
              {report.consideration_intro}
            </h2>
            {report.considerations.map((item) => (
              <ConsiderationItem key={item.rule_id} item={item} />
            ))}
            {report.no_considerations_note && (
              <p className="border-t border-line pt-4" data-testid="no-considerations">
                {report.no_considerations_note}
              </p>
            )}
          </section>

          <section aria-labelledby={allId} className="border-t border-line pt-4">
            <h2 id={allId} className="text-xl">
              {t("report.allMeasurements")}
            </h2>
            <ViewTables
              view="frontal"
              result={report.frontal}
              photoUrl={state.frontal.photoUrl}
              overlayUrl={state.frontal.latest.overlay}
            />
            {report.profile && state.profile.latest && (
              <ViewTables
                view="profile"
                result={report.profile}
                photoUrl={state.profile.photoUrl}
                overlayUrl={state.profile.latest.overlay}
              />
            )}
          </section>

          <p className="max-w-page border-t border-line pt-4 text-ink-2">{report.disclaimer}</p>

          <footer className="grid gap-2 print:hidden">
            <ScanMeta date={scanDate} versions={entry.response.versions} />
            <p className="flex flex-wrap items-center gap-x-6">
              <Link to="/method">{t("method.link")}</Link>
              <Button variant="tertiary" onClick={() => setConfirmNew(true)}>
                {t("results.newScan")}
              </Button>
            </p>
          </footer>
        </div>
      )}
      <ConfirmDialog
        open={confirmNew}
        onOpenChange={setConfirmNew}
        title={t("newScan.title")}
        body={<p>{t("newScan.body", { context: hasProfilePhoto(state) ? "both" : undefined })}</p>}
        confirm={t("newScan.confirm")}
        cancel={t("newScan.cancel")}
        onConfirm={startOver}
      />
    </Screen>
  );
}
