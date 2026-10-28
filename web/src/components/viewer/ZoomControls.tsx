/** Zoom buttons: the single-pointer and keyboard alternative to pinching (WCAG 2.5.7). */
import { Minus, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { ICON } from "../ui/icon";

export function ZoomControls({ onIn, onOut, canIn, canOut }: { onIn(): void; onOut(): void; canIn: boolean; canOut: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-2">
      <Button variant="secondary" onClick={onOut} disabled={!canOut} className="px-3">
        <Minus {...ICON} size={20} />
        {t("viewer.zoomOut")}
      </Button>
      <Button variant="secondary" onClick={onIn} disabled={!canIn} className="px-3">
        <Plus {...ICON} size={20} />
        {t("viewer.zoomIn")}
      </Button>
    </div>
  );
}
