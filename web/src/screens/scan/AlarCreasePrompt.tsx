/**
 * Asks for the alar crease: it is not on the silhouette, so the user places it,
 * and P3a (tip projection, Goode) needs it. Shown on the side-photo results while the point
 * has no position, with the drawing that shows where it is. The point's name is the core's.
 */
import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { Result } from "../../api/schemas";
import { AlarCreaseDrawing } from "../../components/illustrations/Profile";
import { LinkButton } from "../../components/ui/Button";
import { ALAR_CREASE, ALAR_CREASE_METRIC } from "../../scan/points";
import { scanPath, type AdjustState } from "../paths";

export function needsAlarCrease(result: Pick<Result, "adjustable_points" | "landmarks">): boolean {
  const lm = result.landmarks[ALAR_CREASE];
  return result.adjustable_points.some((p) => p.id === ALAR_CREASE) && lm !== undefined && !lm.available;
}

export function AlarCreasePrompt({ result }: { result: Result }) {
  const { t } = useTranslation();
  const id = useId();
  const point = result.adjustable_points.find((p) => p.id === ALAR_CREASE);
  if (!point || !needsAlarCrease(result)) return null;
  const metric = result.metrics[ALAR_CREASE_METRIC]?.name;
  return (
    <section aria-labelledby={id} className="mt-6 border-t border-line pt-4" data-testid="alar-prompt">
      <h2 id={id} className="text-lg">
        {point.name}
      </h2>
      <div className="my-3 max-w-[10rem]">
        <AlarCreaseDrawing />
      </div>
      <p>{metric ? t("profile.alar.body", { metric }) : t("profile.alar.bodyGeneric")}</p>
      <LinkButton
        to={scanPath("profile", "adjust")}
        state={{ point: ALAR_CREASE } satisfies AdjustState}
        variant="secondary"
        className="mt-3"
      >
        {t("profile.alar.action")}
      </LinkButton>
    </section>
  );
}
