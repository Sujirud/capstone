/** Routes of the scan screens, one set per view, and the analyzing screen's router state. */
import type { Language } from "../i18n";
import type { View } from "../scan/session";

/** The scan screens; "live" (live mode) is the frontal view's only. */
export type ScanScreen = "guide" | "live" | "preview" | "analyzing" | "retake" | "result" | "adjust";

export function scanPath(view: View, screen: ScanScreen): string {
  return `/scan/${view}/${screen}`;
}

/** Router state for the analyzing screens. */
export interface AnalyzeState {
  /** Analyze in this language, then switch the interface to it (a language switch). */
  locale?: Language;
  /**
   * After the frontal analysis, analyze the side photo in memory again with the new frontal
   * token: a new frontal analysis is a new session, and the profile's scale comes from it.
   */
  profileNext?: boolean;
  /** Where to go once the photos are analyzed again: the report, when it asked for it. */
  next?: "report";
}

/** Router state for the adjustment screen: the point to start with. */
export interface AdjustState {
  point?: string;
}
