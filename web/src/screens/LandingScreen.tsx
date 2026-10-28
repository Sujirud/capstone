/**
 * The landing page: one plain sentence on what the app does, the core's
 * general disclaimer, a drawing of a result sheet, who made it, and "Start". Nothing else
 * above the fold; "How it's measured" is linked below.
 */
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { ClientConfig } from "../api/schemas";
import { ABOUT } from "../app/about";
import { ResultSheetDrawing } from "../components/illustrations/Landing";
import { Screen } from "../components/layout/Screen";
import { LinkButton } from "../components/ui/Button";
import { currentLanguage } from "../i18n";

export function LandingScreen({ config }: { config: ClientConfig }) {
  const { t } = useTranslation();
  const language = currentLanguage();
  const course = [ABOUT.course[language], ABOUT.institution[language]].filter(Boolean).join(", ");
  return (
    <Screen
      title={t("app.name")}
      actions={
        <LinkButton to="/subject" variant="primary">
          {t("landing.start")}
        </LinkButton>
      }
    >
      <p className="text-lg">{t("landing.lead")}</p>
      <div className="my-6 max-w-[24rem]">
        <ResultSheetDrawing />
      </div>
      <p className="text-ink-2">{config.strings.disclaimer.general}</p>
      <div className="mt-6 border-t border-line pt-4 text-sm text-ink-3">
        <p>{t("landing.madeBy", { course })}</p>
        {ABOUT.team.length > 0 && <p>{t("landing.team", { names: ABOUT.team.join(", ") })}</p>}
      </div>
      <p className="mt-4">
        <Link to="/method">{t("method.link")}</Link>
      </p>
    </Screen>
  );
}
