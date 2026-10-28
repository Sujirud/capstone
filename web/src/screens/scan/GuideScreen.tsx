/**
 * The capture guide: the core's protocol with drawings, then the two sources.
 * A pre-flight failure is shown here, with its own message.
 *
 * - Frontal (steps 1–2): after the subject form. "Take a photo" opens live mode where
 *   the browser can show a camera on a page (useTakePhoto).
 * - Profile (optional, after frontal results): which way the nose will point comes first
 *   (the core's hints refer to "the side shown in the app"), then the protocol.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router";
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

export function GuideScreen({ config, view }: { config: ClientConfig; view: View }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { state, setFacing } = useScan();
  const [problem, setProblem] = useState<PreflightProblem | null>(null);
  const picker = usePhotoPicker(view, config, (result) => {
    if (result.ok) navigate(scanPath(view, "preview"));
    else setProblem(result.problem);
  });
  const takePhoto = useTakePhoto(view, picker.takePhoto);
  if (state.subject === null) return <Navigate to="/subject" replace />;
  // The side photo needs the front photo's results: its token gives the scale.
  if (view === "profile" && state.frontal.latest === null) return <Navigate to={scanPath("frontal", "result")} replace />;
  return (
    <Screen
      title={config.strings.capture[view].title}
      step={step(t, view)}
      onBack={() => navigate(view === "frontal" ? "/subject/age" : scanPath("frontal", "result"))}
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
      {view === "profile" && <FacingChoice value={state.profile.facing} onChange={setFacing} className="mb-8" />}
      <Protocol config={config} view={view} />
      {/* On a desktop: a photo moved from the phone keeps the EXIF the distance check needs. */}
      <p className="mt-2 text-ink-2">{t("guide.chooseNote")}</p>
    </Screen>
  );
}
