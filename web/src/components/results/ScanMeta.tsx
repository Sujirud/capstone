/**
 * The scan footer: date and time of the scan and the versions (API, core,
 * schema) in small type. Dates use th-TH (Buddhist era) or en-GB.
 */
import { useTranslation } from "react-i18next";
import type { ClientConfig } from "../../api/schemas";
import { currentLanguage } from "../../i18n";

export function formatScanDate(date: Date, language: "th" | "en"): string {
  return new Intl.DateTimeFormat(language === "th" ? "th-TH" : "en-GB", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

export function ScanMeta({ date, versions }: { date: Date; versions: ClientConfig["versions"] }) {
  const { t } = useTranslation();
  return (
    <p className="text-sm text-ink-3">
      <span>{formatScanDate(date, currentLanguage())}</span>
      <span aria-hidden="true"> ·</span>{" "}
      <span>{t("scan.versionsLabel")}: </span>
      <span className="tabular-nums" lang="en">
        API {versions.api} · core {versions.core} · schema {versions.schema}
      </span>
    </p>
  );
}
