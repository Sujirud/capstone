/**
 * A capture that did not pass: there is no result. The core's hints
 * verbatim as the retake guidance, the names of the failed checks and the warnings; after
 * three failures in a row, the full protocol too. A side photo's `contour_failed` is handled
 * the same way, and the facing choice is shown, since the core's hints refer to it. The two
 * sources are the guide's: for the front photo, "Take a photo" opens live mode again where
 * the browser can show a camera (useTakePhoto).
 */
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useNavigate } from "react-router";
import type { ClientConfig } from "../../api/schemas";
import type { PreflightProblem } from "../../capture/photo/preflight";
import { usePhotoPicker } from "../../capture/photo/usePhotoPicker";
import { Screen } from "../../components/layout/Screen";
import { Button } from "../../components/ui/Button";
import { Notice } from "../../components/ui/Notice";
import { useScan } from "../../scan/ScanContext";
import type { View } from "../../scan/session";
import { scanPath } from "../paths";
import { step } from "../steps";
import { FacingChoice } from "./FacingChoice";
import { preflightMessage } from "./preflightMessage";
import { Protocol } from "./Protocol";
import { useTakePhoto } from "./useTakePhoto";

export const FULL_PROTOCOL_AFTER = 3;

export function RetakeScreen({ config, view }: { config: ClientConfig; view: View }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { state, setFacing } = useScan();
  const checksId = useId();
  const [problem, setProblem] = useState<PreflightProblem | null>(null);
  const picker = usePhotoPicker(view, config, (result) => {
    if (result.ok) navigate(scanPath(view, "preview"));
    else setProblem(result.problem);
  });
  const takePhoto = useTakePhoto(view, picker.takePhoto);
  const { lastFailure: failure, failures } = state[view];
  if (!failure) return <Navigate to={scanPath(view, "guide")} replace />;
  const strings = config.strings;
  // Left and right checks can share a name ("Neutral mouth"): each name once.
  const checks = [...new Set(failure.failedChecks.map((id) => strings.check[id]).filter((s): s is string => Boolean(s)))];
  const warnings = failure.warnings.map((key) => strings.warning[key]).filter((s): s is string => Boolean(s));

  return (
    <Screen
      title={t("retake.title")}
      step={step(t, view)}
      onBack={() => navigate(scanPath(view, "guide"))}
      actions={
        <>
          <Button variant="secondary" onClick={picker.choosePhoto} disabled={picker.busy}>
            {t("guide.choosePhoto")}
          </Button>
          <Button variant="primary" onClick={takePhoto} disabled={picker.busy}>
            {t("guide.takePhoto")}
          </Button>
        </>
      }
    >
      {picker.inputs}
      {problem && (
        <Notice role="alert" className="mb-6">
          <p>{preflightMessage(t, problem, config)}</p>
        </Notice>
      )}
      <p className="mb-3">{t("retake.intro")}</p>
      {/* The API's hints, in the language of the analysis (lang on mixed text). */}
      <ul lang={failure.locale} className="mb-6 list-disc space-y-2 pl-6" data-testid="hints">
        {failure.hints.map((hint) => (
          <li key={hint}>{hint}</li>
        ))}
      </ul>
      {checks.length > 0 && (
        <section aria-labelledby={checksId} className="mb-6">
          <h2 id={checksId} className="mb-2 text-lg">
            {t("retake.checksHeading")}
          </h2>
          <ul className="list-disc space-y-1 pl-6 text-ink-2">
            {checks.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </section>
      )}
      {warnings.map((text) => (
        <Notice key={text} className="mb-4">
          <p>{text}</p>
        </Notice>
      ))}
      {view === "profile" && <FacingChoice value={state.profile.facing} onChange={setFacing} className="mb-6" />}
      {failures >= FULL_PROTOCOL_AFTER ? (
        <section className="mt-8 border-t border-line pt-6" data-testid="full-protocol">
          <h2 className="mb-2 text-xl">{strings.capture[view].title}</h2>
          <p className="mb-4 text-ink-2">{t("retake.protocolIntro", { count: failures })}</p>
          <Protocol config={config} view={view} />
        </section>
      ) : (
        <p>
          <Link to={scanPath(view, "guide")}>{t("retake.backToGuide")}</Link>
        </p>
      )}
    </Screen>
  );
}
