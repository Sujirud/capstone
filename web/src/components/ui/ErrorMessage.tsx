/**
 * An API error for the user: the localized message for its `code` (never
 * the API's `detail`) and the request id in small type. Announced assertively.
 */
import { useTranslation } from "react-i18next";
import type { ApiError } from "../../api/client";
import { Notice } from "./Notice";

export function errorMessageKey(error: ApiError): string {
  return error.handling.message ?? "errors.generic";
}

/** `context: "both"` words the message for both photos of a scan (e.g. an ended scan). */
export function ErrorMessage({ error, className, context }: { error: ApiError; className?: string; context?: "both" }) {
  const { t } = useTranslation();
  const minutes = error.retryAfterS === null ? 1 : Math.max(1, Math.ceil(error.retryAfterS / 60));
  return (
    <Notice role="alert" className={className}>
      <p>{t(errorMessageKey(error), { count: minutes, context })}</p>
      {error.requestId && (
        // --ink-3 is 4.45 : 1 on --notice, below 4.5: metadata inside notices uses --ink-2.
        <p className="mt-1 text-sm text-ink-2">
          {t("errors.requestId")}: <span className="break-token" lang="en">{error.requestId}</span>
        </p>
      )}
    </Notice>
  );
}
