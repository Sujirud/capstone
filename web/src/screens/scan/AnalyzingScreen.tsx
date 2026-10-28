/**
 * Upload and analysis: the photo dimmed, a determinate line
 * with the real upload percent, then an indeterminate line with "analyzing" and the
 * elapsed seconds. No invented stages. This screen owns the request: leaving it cancels.
 *
 * It also serves re-analysis of the photos in memory (an ended scan, a language switch).
 * The analysis uses the current language, or the one a language switch asked for; the
 * interface switches to it once the service has answered. A frontal re-analysis starts
 * a new session, so a side photo that had results (`profileNext`) is analyzed next, with the
 * new frontal token. A re-analysis the report asked for (`next`) ends on the report.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useNavigate } from "react-router";
import type { ApiError } from "../../api/client";
import type { ClientConfig } from "../../api/schemas";
import { usePhotoPicker } from "../../capture/photo/usePhotoPicker";
import { Screen } from "../../components/layout/Screen";
import { Button } from "../../components/ui/Button";
import { ProgressLine } from "../../components/ui/ProgressLine";
import { PhotoViewer } from "../../components/viewer/PhotoViewer";
import { useSwitchLanguage } from "../../app/useSwitchLanguage";
import { currentLanguage, isLanguage, type Language } from "../../i18n";
import { useScan } from "../../scan/ScanContext";
import { hasProfilePhoto, type View } from "../../scan/session";
import { scanPath, type AnalyzeState } from "../paths";
import { step } from "../steps";
import { ScanErrorPanel } from "./ScanErrorPanel";

/** Screen readers hear the upload in quarter steps, not every percent. */
function spoken(fraction: number | null): number {
  return fraction === null ? 0 : Math.floor(fraction * 4) * 25;
}

export function AnalyzingScreen({ config, view }: { config: ClientConfig; view: View }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const requested = useLocation().state as AnalyzeState | null;
  const locale: Language = isLanguage(requested?.locale) ? requested.locale : currentLanguage();
  const next = requested?.next;
  const scan = useScan();
  const { capture, photoUrl, task, source } = scan.state[view];
  const [attempt, setAttempt] = useState(0);
  const again = () => {
    setFailure(null);
    setAttempt((n) => n + 1);
  };
  const [failure, setFailure] = useState<{ error: ApiError; at: number } | null>(null);
  const [timeouts, setTimeouts] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const picker = usePhotoPicker(view, config, (result) => {
    if (result.ok) navigate(scanPath(view, "preview"), { replace: true });
  });
  // A live-mode burst is taken again on the live screen; a photo on the preview.
  const captureScreen = source === "live" ? "live" : "preview";
  const retake = () => (source === "live" ? navigate(scanPath(view, "live"), { replace: true }) : picker.open(source ?? "camera"));
  const { analyze } = scan;
  const switchLanguage = useSwitchLanguage();
  const hasCapture = capture !== null;
  // The profile is analyzed with the frontal token; without frontal results there is none.
  const ready = hasCapture && (view === "frontal" || scan.state.frontal.latest !== null);

  // After a frontal re-analysis, the side photo in memory goes next (read when the answer comes).
  const chain = view === "frontal" && requested?.profileNext === true && scan.state.profile.capture !== null;
  const chainRef = useRef(chain);
  useEffect(() => {
    chainRef.current = chain;
  });

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    // Started a tick later: a mount that is undone at once (React's StrictMode in development)
    // must not send the photo, since every upload counts toward the hourly limit.
    const start = setTimeout(() => {
      void analyze(view, config, locale, controller.signal).then(async (outcome) => {
        if (controller.signal.aborted) return;
        if (outcome.kind === "ok" || outcome.kind === "failed") {
          // The scan is now in this language, so the interface follows it.
          if (locale !== currentLanguage()) await switchLanguage(locale);
          if (controller.signal.aborted) return;
          if (outcome.kind === "ok" && chainRef.current) {
            navigate(scanPath("profile", "analyzing"), { replace: true, state: { locale, next } satisfies AnalyzeState });
          } else if (outcome.kind === "ok" && next === "report") {
            navigate("/report", { replace: true });
          } else {
            navigate(scanPath(view, outcome.kind === "ok" ? "result" : "retake"), { replace: true });
          }
        } else if (outcome.kind === "error") {
          if (outcome.error.code === "analysis_timeout") setTimeouts((n) => n + 1);
          setFailure({ error: outcome.error, at: Date.now() });
        }
      });
    }, 0);
    return () => {
      clearTimeout(start);
      controller.abort();
    };
    // A new attempt or language re-runs the analysis; the config and view are fixed for this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, ready, locale]);

  // Elapsed seconds while the service analyzes.
  const analyzing = task.kind === "analyzing";
  useEffect(() => {
    if (!analyzing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [analyzing]);

  if (!capture || !photoUrl) return <Navigate to={scanPath(view, "guide")} replace />;
  if (!ready) return <Navigate to={scanPath("frontal", "result")} replace />;
  const frame = capture.frames[0]!;
  const progress = task.kind === "uploading" ? task.progress : null;
  const percent = progress === null ? 0 : Math.round(progress * 100);
  const elapsed = task.kind === "analyzing" ? Math.max(0, Math.floor((now - task.startedAt) / 1000)) : 0;
  const photos = hasProfilePhoto(scan.state) ? 2 : 1;

  return (
    <Screen
      title={t("analyzing.title")}
      step={step(t, view)}
      onBack={() => navigate(scanPath(view, captureScreen), { replace: true })}
      actions={
        failure ? undefined : (
          <Button variant="secondary" onClick={() => navigate(scanPath(view, captureScreen), { replace: true })}>
            {t("analyzing.cancel")}
          </Button>
        )
      }
    >
      {picker.inputs}
      <PhotoViewer
        photoUrl={photoUrl}
        overlayUrl={null}
        result={{ image: { width: frame.width, height: frame.height }, landmarks: {} }}
        dimmed
        controls={false}
      />
      <div className="mt-4">
        {failure ? (
          <ScanErrorPanel
            error={failure.error}
            at={failure.at}
            retryAllowed={timeouts < 2}
            photos={photos}
            onRetry={again}
            onRetake={retake}
            // An ended scan: the frontal photo first (a new session), then the side photo.
            onReanalyze={
              view === "frontal"
                ? again
                : () => navigate(scanPath("frontal", "analyzing"), { replace: true, state: { locale, profileNext: true, next } satisfies AnalyzeState })
            }
            onStartOver={() => {
              scan.newScan();
              navigate("/subject", { replace: true });
            }}
          />
        ) : task.kind === "analyzing" ? (
          <>
            <ProgressLine value={null} />
            <p className="mt-2" aria-live="polite">
              {t("progress.analyzing")}{" "}
              <span className="text-ink-3 tabular-nums" aria-hidden="true">
                {t("progress.elapsed", { seconds: elapsed })}
              </span>
            </p>
          </>
        ) : (
          <>
            <ProgressLine value={progress ?? 0} />
            <p className="mt-2 tabular-nums" aria-hidden="true">
              {t("progress.uploading", { percent })}
            </p>
            <p className="sr-only" aria-live="polite">
              {t("progress.uploading", { percent: spoken(progress) })}
            </p>
          </>
        )}
      </div>
    </Screen>
  );
}
