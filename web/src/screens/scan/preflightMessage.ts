import type { TFunction } from "i18next";
import type { ClientConfig } from "../../api/schemas";
import type { PreflightProblem } from "../../capture/photo/preflight";

/** A pre-flight failure as a message, with the service's limits. */
export function preflightMessage(t: TFunction, problem: PreflightProblem, config: ClientConfig): string {
  const limits = config.upload_limits;
  return t(`guide.preflight.${problem}`, {
    limit:
      problem === "too_large"
        ? Math.floor(limits.max_image_bytes / 1_000_000)
        : Math.floor(limits.max_pixels / 1_000_000),
  });
}
