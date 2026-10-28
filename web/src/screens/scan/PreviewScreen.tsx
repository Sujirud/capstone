/**
 * The photo before it is sent: "Use this photo" or "Retake". A
 * front-camera photo carries a warning, and the user may continue anyway. A side
 * photo shows the facing choice again, to check it against the photo.
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
import { PhotoViewer } from "../../components/viewer/PhotoViewer";
import { useScan } from "../../scan/ScanContext";
import type { View } from "../../scan/session";
import { scanPath } from "../paths";
import { step } from "../steps";
import { FacingChoice } from "./FacingChoice";
import { preflightMessage } from "./preflightMessage";

export function PreviewScreen({ config, view }: { config: ClientConfig; view: View }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { state, setFacing } = useScan();
  const [problem, setProblem] = useState<PreflightProblem | null>(null);
  const picker = usePhotoPicker(view, config, (result) => setProblem(result.ok ? null : result.problem));
  const { capture, photoUrl, source } = state[view];
  const ready = state.subject !== null && (view === "frontal" || state.frontal.latest !== null);
  if (!capture || !photoUrl || !ready) return <Navigate to={scanPath(view, "guide")} replace />;
  const frame = capture.frames[0]!;
  return (
    <Screen
      title={t("preview.title")}
      step={step(t, view)}
      onBack={() => navigate(scanPath(view, "guide"))}
      actions={
        <>
          <Button
            variant="secondary"
            onClick={() => (source === "live" ? navigate(scanPath(view, "live")) : picker.open(source ?? "camera"))}
            disabled={picker.busy}
          >
            {source === "library" ? t("preview.chooseAnother") : t("preview.retake")}
          </Button>
          <Button variant="primary" onClick={() => navigate(scanPath(view, "analyzing"))} disabled={picker.busy}>
            {t("preview.use")}
          </Button>
        </>
      }
    >
      {picker.inputs}
      {problem && (
        <Notice role="alert" className="mb-4">
          <p>{preflightMessage(t, problem, config)}</p>
        </Notice>
      )}
      {capture.warnings.includes("front_camera") && (
        <Notice className="mb-4">
          <p>{t("guide.preflight.front_camera")}</p>
        </Notice>
      )}
      <PhotoViewer
        photoUrl={photoUrl}
        overlayUrl={null}
        result={{ image: { width: frame.width, height: frame.height }, landmarks: {} }}
        toggle={false}
      />
      {view === "profile" && <FacingChoice value={state.profile.facing} onChange={setFacing} help="check" className="mt-6" />}
      <p className="mt-4 text-ink-2">{t("preview.help")}</p>
    </Screen>
  );
}
