/**
 * Skip link. The app uses hash routing, so "#main" would be read as a route: the
 * link moves focus itself instead of following its href.
 */
import { useTranslation } from "react-i18next";

export function SkipLink() {
  const { t } = useTranslation();
  return (
    <a
      href="#main"
      onClick={(e) => {
        e.preventDefault();
        document.getElementById("main")?.focus();
      }}
      className="sr-only rounded-control bg-surface px-4 py-2 focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-20"
    >
      {t("app.skipToContent")}
    </a>
  );
}
