/**
 * The scan session, in memory only: a reload ends the scan.
 *
 * For each view (frontal, profile) it holds:
 * - the photo as captured (the bytes that were uploaded, kept for the overlay and for
 *   re-analysis);
 * - the **original** token and result from the analysis, kept for "Reset to automatic";
 * - the **latest** token, result and overlay, replaced after every adjustment.
 *
 * A profile belongs to one frontal analysis: its token carries that analysis's session and
 * scale. So a new frontal analysis (a re-analysis after a language switch or an ended scan)
 * (or a failed one) drops the profile's results but keeps its photo, to be analyzed again; a
 * new frontal photo drops the profile altogether.
 *
 * The report is kept with the tokens and language it was made from, so it is requested
 * again only when an analysis or an adjustment changed them.
 *
 * `scanReducer` is pure; the provider (ScanContext.tsx) runs the API calls and dispatches.
 */
import type { ApiError } from "../api/client";
import type { Locale } from "../api/clientConfig";
import type { View } from "../api/layers";
import type { AnalyzeResponse, ClientConfig, Facing, ReportResponse, Result } from "../api/schemas";
import type { Capture } from "../capture/CaptureSource";
import type { Subject } from "./subject";

export type { View } from "../api/layers";

export type ScanPhase =
  | "home"
  | "subject"
  | `${View}_${"guide" | "capture" | "uploading" | "failed" | "result" | "adjust"}`
  | "report";

/** Photo mode's two inputs, or live mode's burst. */
export type PhotoSource = "camera" | "library" | "live";

export interface Analysis {
  token: string;
  result: Result;
  /** The overlay: a data URI from the analysis, or an object URL from a redraw. */
  overlay: string | null;
  /** Why there is no overlay: the image did not match (say nothing), or the call failed. */
  overlayProblem: "mismatch" | "failed" | null;
  versions: ClientConfig["versions"];
  requestId: string;
  locale: Locale;
  /** When the analysis was made, for the scan footer. */
  analyzedAt: number;
}

export interface Failure {
  status: Exclude<AnalyzeResponse["status"], "ok">;
  hints: string[];
  failedChecks: string[];
  warnings: string[];
  requestId: string;
  /** The language of `hints` (the API's text); the interface may have switched since. */
  locale: Locale;
}

export type Task =
  | { kind: "idle" }
  | { kind: "uploading"; progress: number | null; startedAt: number }
  | { kind: "analyzing"; startedAt: number }
  | { kind: "saving" };

/** The last completed action, announced on the results screen. */
export type Announcement = { kind: "saved"; count: number } | { kind: "reset" };

export interface ViewScan {
  capture: Capture | null;
  /** How the photo was chosen, so "Retake" opens the same source. */
  source: PhotoSource | null;
  /**
   * Object URL of the captured photo, for previews and the viewer. For a live-mode burst, the
   * first frame until the analysis names its reference frame, then that one.
   */
  photoUrl: string | null;
  original: Analysis | null;
  latest: Analysis | null;
  /** Consecutive captures that did not pass (the full protocol after three). */
  failures: number;
  lastFailure: Failure | null;
  task: Task;
  announcement: Announcement | null;
}

export interface ProfileScan extends ViewScan {
  /** Which way the nose points in the photo, chosen before the photo is taken. */
  facing: Facing;
}

/** A report and what it was made from (see `reportKey`). */
export interface ReportEntry {
  key: string;
  response: ReportResponse;
  /** When it was made, for its header and footer. */
  madeAt: number;
}

export interface ScanState {
  phase: ScanPhase;
  /** The form being filled in, prefilled from the last scan on this device. */
  draft: Partial<Subject>;
  /** The confirmed subject, sent with the frontal analysis. */
  subject: Subject | null;
  frontal: ViewScan;
  profile: ProfileScan;
  report: ReportEntry | null;
}

export type ScanAction =
  | { type: "draft"; patch: Partial<Subject> }
  | { type: "subject_confirmed"; subject: Subject }
  | { type: "facing"; facing: Facing }
  | { type: "photo_selected"; view: View; capture: Capture; source: PhotoSource; photoUrl: string }
  | { type: "upload_started"; view: View; at: number }
  | { type: "upload_progress"; view: View; fraction: number }
  | { type: "upload_done"; view: View; at: number }
  | { type: "analysis_ok"; view: View; analysis: Analysis; photoUrl?: string }
  | { type: "analysis_failed"; view: View; failure: Failure }
  | { type: "request_ended"; view: View }
  | { type: "adjust_started"; view: View }
  | { type: "adjusted"; view: View; analysis: Analysis; count: number }
  | { type: "reset_to_automatic"; view: View }
  | { type: "announced"; view: View }
  | { type: "report_ready"; entry: ReportEntry }
  | { type: "phase"; phase: ScanPhase }
  | { type: "new_scan" };

export const emptyView: ViewScan = {
  capture: null,
  source: null,
  photoUrl: null,
  original: null,
  latest: null,
  failures: 0,
  lastFailure: null,
  task: { kind: "idle" },
  announcement: null,
};

/** The default facing: the nose points right. */
export const DEFAULT_FACING: Facing = "right";

export const emptyProfile: ProfileScan = { ...emptyView, facing: DEFAULT_FACING };

export function initialScanState(draft: Partial<Subject> = {}): ScanState {
  return { phase: "home", draft, subject: null, frontal: emptyView, profile: emptyProfile, report: null };
}

/** The view's results and requests, cleared; the photo and its source are kept. */
const noResults = { original: null, latest: null, failures: 0, lastFailure: null, task: { kind: "idle" }, announcement: null } as const;

function patch(state: ScanState, view: View, change: Partial<ViewScan>, phase: ScanPhase = state.phase): ScanState {
  return view === "frontal"
    ? { ...state, phase, frontal: { ...state.frontal, ...change } }
    : { ...state, phase, profile: { ...state.profile, ...change } };
}

export function scanReducer(state: ScanState, action: ScanAction): ScanState {
  if (action.type === "draft") return { ...state, phase: "subject", draft: { ...state.draft, ...action.patch } };
  if (action.type === "subject_confirmed") return { ...state, phase: "frontal_guide", draft: action.subject, subject: action.subject };
  if (action.type === "facing") return { ...state, profile: { ...state.profile, facing: action.facing } };
  if (action.type === "phase") return { ...state, phase: action.phase };
  if (action.type === "report_ready") return { ...state, phase: "report", report: action.entry };
  if (action.type === "new_scan") return { ...initialScanState(state.subject ?? state.draft), profile: { ...emptyProfile, facing: state.profile.facing } };

  const { view } = action;
  const v = state[view];
  switch (action.type) {
    case "photo_selected": {
      // A new photo replaces the old one and any results made from it. A new front photo
      // may be of someone else: the side photo goes too.
      const next = patch(
        state,
        view,
        { capture: action.capture, source: action.source, photoUrl: action.photoUrl, original: null, latest: null, task: { kind: "idle" } },
        `${view}_capture`,
      );
      return view === "frontal" ? { ...next, profile: { ...emptyProfile, facing: state.profile.facing } } : next;
    }
    case "upload_started":
      return patch(state, view, { task: { kind: "uploading", progress: null, startedAt: action.at } }, `${view}_uploading`);
    case "upload_progress":
      return v.task.kind === "uploading" ? patch(state, view, { task: { ...v.task, progress: action.fraction } }) : state;
    case "upload_done":
      return v.task.kind === "uploading" ? patch(state, view, { task: { kind: "analyzing", startedAt: action.at } }) : state;
    case "analysis_ok": {
      const next = patch(
        state,
        view,
        {
          original: action.analysis,
          latest: action.analysis,
          failures: 0,
          lastFailure: null,
          task: { kind: "idle" },
          announcement: null,
          ...(action.photoUrl ? { photoUrl: action.photoUrl } : {}),
        },
        `${view}_result`,
      );
      // A new frontal analysis is a new session: the side photo must be analyzed again with it.
      return view === "frontal" ? { ...next, profile: { ...next.profile, ...noResults } } : next;
    }
    case "analysis_failed": {
      const next = patch(
        state,
        view,
        { original: null, latest: null, failures: v.failures + 1, lastFailure: action.failure, task: { kind: "idle" } },
        `${view}_failed`,
      );
      // Without frontal results, side results made with the old frontal token are orphaned.
      return view === "frontal" ? { ...next, profile: { ...next.profile, ...noResults } } : next;
    }
    case "request_ended":
      return patch(state, view, { task: { kind: "idle" } });
    case "adjust_started":
      return patch(state, view, { task: { kind: "saving" } }, `${view}_adjust`);
    case "adjusted":
      return patch(
        state,
        view,
        { latest: action.analysis, task: { kind: "idle" }, announcement: { kind: "saved", count: action.count } },
        `${view}_result`,
      );
    case "reset_to_automatic":
      // The original token and result from the analysis; nothing is sent.
      return v.original ? patch(state, view, { latest: v.original, announcement: { kind: "reset" } }, `${view}_result`) : state;
    case "announced":
      return patch(state, view, { announcement: null });
  }
}

/** Object URLs the state refers to; the provider revokes the ones no longer used. */
export function objectUrls(state: ScanState): Set<string> {
  const urls = new Set<string>();
  for (const v of [state.frontal, state.profile]) {
    for (const url of [v.photoUrl, v.original?.overlay, v.latest?.overlay]) if (url?.startsWith("blob:")) urls.add(url);
  }
  return urls;
}

export function hasResults(state: ScanState): boolean {
  return state.frontal.latest !== null;
}

/**
 * What a report is made from: the latest frontal token, the latest side token (if any) and
 * the scan's language. Null without frontal results.
 */
export function reportKey(state: ScanState): string | null {
  const frontal = state.frontal.latest;
  if (!frontal) return null;
  return [frontal.token, state.profile.latest?.token ?? "", frontal.locale].join("\n");
}

/** The kept report, if it still matches the scan. */
export function currentReport(state: ScanState): ReportEntry | null {
  const key = reportKey(state);
  return key !== null && state.report?.key === key ? state.report : null;
}

/** Both photos are in memory: re-analysis and its messages cover both. */
export function hasProfilePhoto(state: ScanState): boolean {
  return state.profile.capture !== null;
}

export function analysisFrom(response: Extract<AnalyzeResponse, { status: "ok" }>, locale: Locale, now: number): Analysis {
  return {
    token: response.result_token,
    result: response.result,
    overlay: response.overlay ?? null,
    overlayProblem: null,
    versions: response.versions,
    requestId: response.request_id,
    locale,
    analyzedAt: now,
  };
}

export function failureFrom(
  response: Extract<AnalyzeResponse, { status: Exclude<AnalyzeResponse["status"], "ok"> }>,
  locale: Locale,
): Failure {
  return {
    status: response.status,
    hints: response.hints,
    failedChecks: response.failed_checks,
    warnings: response.warnings,
    requestId: response.request_id,
    locale,
  };
}

export type RequestOutcome = { kind: "ok" } | { kind: "failed" } | { kind: "error"; error: ApiError } | { kind: "aborted" };
