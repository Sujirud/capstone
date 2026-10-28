/**
 * Switching language during a scan: `locale` is fixed per API call and
 * /v1/adjust needs an override, so results cannot be re-worded in place. With results,
 * the switch is confirmed and the photos in memory are analyzed again in the new language
 * (adjustments are lost): the front photo, then the side photo if it had results; otherwise
 * the scan stays in its language. Without results the switch is immediate.
 *
 * The interface changes language when the front photo's analysis has answered
 * (AnalyzingScreen), so a failed re-analysis leaves the scan and the interface in the old
 * language together.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { useSwitchLanguage } from "../app/useSwitchLanguage";
import { currentLanguage, type Language } from "../i18n";
import { scanPath, type AnalyzeState } from "../screens/paths";
import { useScan } from "./ScanContext";
import { hasResults } from "./session";

export function useLanguageSwitch() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { state } = useScan();
  const [pending, setPending] = useState<Language | null>(null);
  const switchLanguage = useSwitchLanguage();

  function request(language: Language) {
    if (language === currentLanguage()) return;
    if (hasResults(state)) setPending(language);
    else void switchLanguage(language);
  }

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => !open && setPending(null)}
      title={t("language.switchTitle", { language: pending ? t(`languages.${pending}`) : "" })}
      body={<p>{t("language.switchBody", { context: state.profile.latest ? "both" : undefined })}</p>}
      confirm={t("language.switchConfirm")}
      cancel={t("language.switchCancel")}
      onConfirm={() => {
        const language = pending;
        setPending(null);
        if (!language) return;
        navigate(scanPath("frontal", "analyzing"), {
          state: {
            locale: language,
            profileNext: state.profile.latest !== null,
            ...(pathname === "/report" ? { next: "report" as const } : {}),
          } satisfies AnalyzeState,
        });
      }}
    />
  );
  return { request, dialog };
}
