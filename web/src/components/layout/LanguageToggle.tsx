/** The language control in the top bar: names the other language, in that language. */
import { useTranslation } from "react-i18next";
import { currentLanguage } from "../../i18n";
import { useLanguageSwitch } from "../../scan/useLanguageSwitch";

export function LanguageToggle() {
  const { t } = useTranslation();
  const { request, dialog } = useLanguageSwitch();
  const other = currentLanguage() === "th" ? "en" : "th";
  return (
    <>
      <button
        type="button"
        lang={other}
        onClick={() => request(other)}
        className="min-h-target shrink-0 rounded-control px-2 text-sm font-medium text-accent underline underline-offset-[3px] hover:text-ink"
      >
        {t("nav.otherLanguage")}
      </button>
      {dialog}
    </>
  );
}
