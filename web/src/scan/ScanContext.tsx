/**
 * The scan session provider: the reducer in session.ts plus the calls that
 * change it (pre-flight, analysis, adjustment, overlay redraw, the report), for either view. Object URLs
 * are revoked as soon as nothing refers to them, and all of them when the scan ends.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type Dispatch, type ReactNode } from "react";
import { ApiError } from "../api/client";
import type { Locale } from "../api/clientConfig";
import { overlayLayers } from "../api/layers";
import { CLIENT_CODES } from "../api/problems";
import { adjust, analyzeFrontal, analyzeProfile, buildReport, redrawOverlay, type Point } from "../api/scan";
import type { AnalyzeResponse, ClientConfig, Facing } from "../api/schemas";
import { useServices } from "../app/services";
import type { Capture } from "../capture/CaptureSource";
import { preflight, type PreflightResult } from "../capture/photo/preflight";
import {
  analysisFrom,
  failureFrom,
  hasResults,
  initialScanState,
  objectUrls,
  reportKey,
  scanReducer,
  type PhotoSource,
  type RequestOutcome,
  type ScanAction,
  type ScanState,
  type View,
} from "./session";
import { loadLastSubject, saveLastSubject, type Subject } from "./subject";

export type { ScanPhase, ScanState, View } from "./session";

interface ScanValue {
  state: ScanState;
  dispatch: Dispatch<ScanAction>;
  confirmSubject(subject: Subject): void;
  setFacing(facing: Facing): void;
  selectPhoto(view: View, file: File, source: PhotoSource, config: ClientConfig): Promise<PreflightResult>;
  /** A live-mode burst as the frontal capture. */
  selectBurst(capture: Capture): void;
  analyze(view: View, config: ClientConfig, locale: Locale, signal: AbortSignal): Promise<RequestOutcome>;
  saveAdjustment(view: View, overrides: Record<string, Point>, config: ClientConfig, signal: AbortSignal): Promise<RequestOutcome>;
  resetToAutomatic(view: View): void;
  /** The report for the latest tokens; kept in the session until they change. */
  requestReport(signal: AbortSignal): Promise<RequestOutcome>;
  newScan(): void;
}

const ScanContext = createContext<ScanValue | null>(null);

/** By name: an AbortError's class can come from another realm (an iframe, a test DOM). */
function isAbort(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

function asApiError(err: unknown): ApiError {
  return err instanceof ApiError
    ? err
    : new ApiError({ code: CLIENT_CODES.badResponse, status: null, requestId: null, retryAfterS: null, cause: err });
}

export function ScanProvider({ children, now = Date.now }: { children: ReactNode; now?: () => number }) {
  const { api } = useServices();
  const [state, dispatch] = useReducer(scanReducer, undefined, () => initialScanState(loadLastSubject()));
  // The calls read the latest state; it is synced after each render (before any user event).
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Revoke object URLs the state no longer refers to.
  const tracked = useRef(new Set<string>());
  useEffect(() => {
    const live = objectUrls(state);
    for (const url of tracked.current) if (!live.has(url)) URL.revokeObjectURL(url);
    tracked.current = live;
  }, [state]);
  useEffect(() => () => tracked.current.forEach((url) => URL.revokeObjectURL(url)), []);

  // Leaving the page ends the scan: warn while there are results.
  const results = hasResults(state);
  useEffect(() => {
    if (!results) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [results]);

  const confirmSubject = useCallback((subject: Subject) => {
    saveLastSubject(subject); // prefills the next scan on this device
    dispatch({ type: "subject_confirmed", subject });
  }, []);

  const setFacing = useCallback((facing: Facing) => dispatch({ type: "facing", facing }), []);

  const selectPhoto = useCallback(async (view: View, file: File, source: PhotoSource, config: ClientConfig) => {
    const checked = await preflight(file, config.upload_limits);
    if (checked.ok) {
      const frame = checked.capture.frames[0]!;
      dispatch({ type: "photo_selected", view, capture: checked.capture, source, photoUrl: URL.createObjectURL(frame.blob) });
    }
    return checked;
  }, []);

  const selectBurst = useCallback((capture: Capture) => {
    const first = capture.frames[0];
    if (!first) return;
    dispatch({ type: "photo_selected", view: "frontal", capture, source: "live", photoUrl: URL.createObjectURL(first.blob) });
  }, []);

  const analyze = useCallback(
    async (view: View, config: ClientConfig, locale: Locale, signal: AbortSignal): Promise<RequestOutcome> => {
      const { frontal, profile, subject } = stateRef.current;
      const capture = view === "frontal" ? frontal.capture : profile.capture;
      if (!capture) return { kind: "aborted" };
      // The profile is analyzed with the latest frontal token: its scale, subject and session.
      const frontalToken = frontal.latest?.token;
      if (view === "frontal" ? !subject : !frontalToken) return { kind: "aborted" };
      dispatch({ type: "upload_started", view, at: now() });
      const progress = {
        signal,
        layers: overlayLayers(view, config),
        locale,
        onUploadProgress: (fraction: number) => dispatch({ type: "upload_progress", view, fraction }),
        onUploaded: () => dispatch({ type: "upload_done", view, at: now() }),
      };
      try {
        const response: AnalyzeResponse =
          view === "frontal"
            ? await analyzeFrontal(api, { ...progress, capture, subject: subject! })
            : await analyzeProfile(api, { ...progress, capture, facing: profile.facing, frontalToken: frontalToken! });
        if (signal.aborted) return { kind: "aborted" };
        if (response.status === "ok") {
          // A burst's photo is the frame the result refers to.
          const reference = capture.frames.length > 1 ? capture.referenceFrame(response.result.frames.reference_frame) : undefined;
          const photoUrl = reference ? URL.createObjectURL(reference.blob) : undefined;
          dispatch({ type: "analysis_ok", view, analysis: analysisFrom(response, locale, now()), photoUrl });
          return { kind: "ok" };
        }
        dispatch({ type: "analysis_failed", view, failure: failureFrom(response, locale) });
        return { kind: "failed" };
      } catch (err) {
        dispatch({ type: "request_ended", view });
        if (isAbort(err) || signal.aborted) return { kind: "aborted" };
        return { kind: "error", error: asApiError(err) };
      }
    },
    [api, now],
  );

  const saveAdjustment = useCallback(
    async (view: View, overrides: Record<string, Point>, config: ClientConfig, signal: AbortSignal): Promise<RequestOutcome> => {
      const scan = stateRef.current[view];
      const latest = scan.latest;
      if (!latest || !scan.capture) return { kind: "aborted" };
      dispatch({ type: "adjust_started", view });
      const layers = overlayLayers(view, config);
      try {
        const response = await adjust(api, { token: latest.token, overrides, locale: latest.locale, signal });
        if (response.status !== "ok") throw new ApiError({ code: CLIENT_CODES.badResponse, status: 200, requestId: response.request_id, retryAfterS: null });
        const analysis = analysisFrom(response, latest.locale, latest.analyzedAt);
        // Redraw the overlay for the new token on the reference image, as uploaded.
        const image = scan.capture.referenceFrame(analysis.result.frames.reference_frame);
        let overlay: string | null = null;
        let problem: "mismatch" | "failed" | null = null;
        try {
          if (!image) throw new ApiError({ code: "image_mismatch", status: null, requestId: null, retryAfterS: null });
          const blob = await redrawOverlay(api, { image, token: analysis.token, layers, locale: latest.locale, signal });
          overlay = URL.createObjectURL(blob);
        } catch (err) {
          if (isAbort(err)) throw err;
          problem = err instanceof ApiError && err.code === "image_mismatch" ? "mismatch" : "failed";
        }
        dispatch({ type: "adjusted", view, analysis: { ...analysis, overlay, overlayProblem: problem }, count: Object.keys(overrides).length });
        return { kind: "ok" };
      } catch (err) {
        dispatch({ type: "request_ended", view });
        if (isAbort(err) || signal.aborted) return { kind: "aborted" };
        return { kind: "error", error: asApiError(err) };
      }
    },
    [api],
  );

  const resetToAutomatic = useCallback((view: View) => dispatch({ type: "reset_to_automatic", view }), []);

  const requestReport = useCallback(
    async (signal: AbortSignal): Promise<RequestOutcome> => {
      const current = stateRef.current;
      const key = reportKey(current);
      const frontal = current.frontal.latest;
      if (key === null || !frontal) return { kind: "aborted" };
      try {
        const response = await buildReport(api, {
          frontalToken: frontal.token,
          profileToken: current.profile.latest?.token ?? null,
          locale: frontal.locale,
          signal,
        });
        if (signal.aborted) return { kind: "aborted" };
        dispatch({ type: "report_ready", entry: { key, response, madeAt: now() } });
        return { kind: "ok" };
      } catch (err) {
        if (isAbort(err) || signal.aborted) return { kind: "aborted" };
        return { kind: "error", error: asApiError(err) };
      }
    },
    [api, now],
  );
  const newScan = useCallback(() => dispatch({ type: "new_scan" }), []);

  const value = useMemo<ScanValue>(
    () => ({ state, dispatch, confirmSubject, setFacing, selectPhoto, selectBurst, analyze, saveAdjustment, resetToAutomatic, requestReport, newScan }),
    [state, confirmSubject, setFacing, selectPhoto, selectBurst, analyze, saveAdjustment, resetToAutomatic, requestReport, newScan],
  );
  return <ScanContext.Provider value={value}>{children}</ScanContext.Provider>;
}

export function useScan(): ScanValue {
  const value = useContext(ScanContext);
  if (!value) throw new Error("useScan outside ScanProvider");
  return value;
}
