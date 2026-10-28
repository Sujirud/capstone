/**
 * "How it's measured": short web strings, consistent with the core, with
 * the core's own numbers and words where they exist: the iris diameter from client-config,
 * the `inconclusive` status text and the classical reference's name, verbatim. Linked from
 * the landing page and the results and report footers.
 */
import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import type { ClientConfig } from "../api/schemas";
import { Screen } from "../components/layout/Screen";

function Part({ heading, children }: { heading: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-t border-line py-4">
      <h2 id={id} className="mb-1 text-lg">
        {heading}
      </h2>
      {children}
    </section>
  );
}

export function MethodScreen({ config }: { config: ClientConfig }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { key } = useLocation();
  // Opened directly (the page's first entry), back goes to the start instead of leaving the app.
  const back = () => (key === "default" ? navigate("/", { replace: true }) : navigate(-1));
  const s = config.strings;
  const parts = ["landmarks", "hairline", "axes", "scale", "profile", "uncertainty", "reference"] as const;
  const values = {
    mm: config.frontal.iris_diameter_mm,
    inconclusive: s.status.inconclusive,
    canon: s.reference.canon,
  };
  return (
    <Screen title={t("method.title")} onBack={back}>
      {parts.map((part) => (
        <Part key={part} heading={t(`method.${part}.heading`)}>
          <p>{t(`method.${part}.body`, values)}</p>
        </Part>
      ))}
      <Part heading={t("method.limits.heading")}>
        <ul className="list-disc space-y-1 pl-6">
          <li>{t("method.limits.diagnose")}</li>
          <li>{t("method.limits.photo")}</li>
          <li>{t("method.limits.protocol")}</li>
        </ul>
      </Part>
      <Part heading={t("method.privacy.heading")}>
        <p>{t("method.privacy.body")}</p>
      </Part>
      <p className="border-t border-line pt-4 text-ink-2">{s.disclaimer.general}</p>
    </Screen>
  );
}
