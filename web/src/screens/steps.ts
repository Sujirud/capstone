/** The scan's steps for the step indicator: text plus a thin line. */
import type { TFunction } from "i18next";
import type { Step } from "../components/layout/TopBar";

export const STEP_KEYS = ["subject", "frontal", "profile", "results"] as const;
export type StepKey = (typeof STEP_KEYS)[number];

export function step(t: TFunction, key: StepKey): Step {
  return { current: STEP_KEYS.indexOf(key) + 1, total: STEP_KEYS.length, label: t(`steps.${key}`) };
}
