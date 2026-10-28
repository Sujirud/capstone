/**
 * An API error during a scan, with the actions its code allows: retake, analyze the
 * same photo again, start over, wait for the rate limit, or try again.
 */
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { ApiError } from "../../api/client";
import { Button } from "../../components/ui/Button";
import { ErrorMessage, errorMessageKey } from "../../components/ui/ErrorMessage";
import { currentLanguage } from "../../i18n";

export interface ScanErrorPanelProps {
  error: ApiError;
  /** When the error happened (ms), for the rate-limit wait. */
  at: number;
  onRetry?: () => void;
  onRetake?: () => void;
  onReanalyze?: () => void;
  onStartOver?: () => void;
  /** An analysis that took too long is offered one retry. */
  retryAllowed?: boolean;
  /** Photos in memory: with both, an ended scan offers to analyze both again. */
  photos?: 1 | 2;
}

export function ScanErrorPanel({ error, at, onRetry, onRetake, onReanalyze, onStartOver, retryAllowed = true, photos = 1 }: ScanErrorPanelProps) {
  const { t } = useTranslation();
  const context = photos === 2 ? "both" : undefined;
  const action = error.handling.action;
  const retryAt = action === "wait" ? at + (error.retryAfterS ?? 60) * 1000 : 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (retryAt <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(retryAt - now + 50, 30_000));
    return () => clearTimeout(timer);
  }, [retryAt, now]);
  const waiting = retryAt > now;
  const time = new Intl.DateTimeFormat(currentLanguage() === "th" ? "th-TH" : "en-GB", { timeStyle: "short" }).format(retryAt);

  const buttons: ReactElement[] = [];
  // A refused photo, or an analysis that took too long again: another photo is the way on.
  const retake = action === "back_to_capture" || (action === "offer_retry" && !retryAllowed);
  if (retake && onRetake) buttons.push(<Button key="retake" variant="secondary" onClick={onRetake}>{t("scanError.retake")}</Button>);
  if (action === "scan_ended" && onReanalyze)
    buttons.push(<Button key="reanalyze" variant="secondary" onClick={onReanalyze}>{t("scanError.reanalyze", { context })}</Button>);
  if ((action === "scan_ended" || action === "new_scan") && onStartOver)
    buttons.push(<Button key="start" variant="secondary" onClick={onStartOver}>{t("scanError.startOver")}</Button>);
  if (["retry", "retry_once", "log", "wait"].includes(action) || (action === "offer_retry" && retryAllowed)) {
    if (onRetry) buttons.push(<Button key="retry" variant="secondary" onClick={onRetry} disabled={waiting}>{t("scanError.retry")}</Button>);
  }

  return (
    <div className="grid gap-3" data-testid="scan-error" data-code={error.code} data-message={errorMessageKey(error)}>
      <ErrorMessage error={error} context={context} />
      {waiting && <p className="text-sm text-ink-2">{t("scanError.waitUntil", { time })}</p>}
      {buttons.length > 0 && <div className="flex flex-wrap gap-2">{buttons}</div>}
    </div>
  );
}
