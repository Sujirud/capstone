/**
 * The scan's API calls: frontal and profile analysis (multipart, with
 * upload progress), point adjustment and overlay redraw. Responses are validated; errors
 * are ApiError with the problem code.
 */
import type { Capture, CapturedFrame } from "../capture/CaptureSource";
import type { Subject } from "../scan/subject";
import type { ApiClient } from "./client";
import type { Locale } from "./clientConfig";
import { AnalyzeResponseSchema, ReportResponseSchema, type AnalyzeResponse, type Facing, type ReportResponse } from "./schemas";

export interface UploadProgress {
  onUploadProgress?: (fraction: number) => void;
  onUploaded?: () => void;
  signal?: AbortSignal;
}

export interface FrontalRequest extends UploadProgress {
  capture: Capture;
  subject: Subject;
  locale: Locale;
  layers: string[];
}

/** The `meta` part (FrontalAnalyzeMeta): `camera` only when the server cannot read EXIF. */
export function frontalMeta(req: Pick<FrontalRequest, "capture" | "subject" | "locale" | "layers">) {
  return {
    subject: req.subject,
    locale: req.locale,
    overlay: { layers: req.layers },
    ...(req.capture.camera ? { camera: req.capture.camera } : {}),
  };
}

export async function analyzeFrontal(api: ApiClient, req: FrontalRequest): Promise<AnalyzeResponse> {
  const form = new FormData();
  for (const frame of req.capture.frames) form.append("frames", frame.blob, frame.name);
  form.append("meta", JSON.stringify(frontalMeta(req)));
  const { data } = await api.request({
    path: "/v1/frontal/analyze",
    method: "POST",
    form,
    schema: AnalyzeResponseSchema,
    signal: req.signal,
    onUploadProgress: req.onUploadProgress,
    onUploaded: req.onUploaded,
  });
  return data;
}

export interface ProfileRequest extends UploadProgress {
  capture: Capture;
  facing: Facing;
  /** The latest frontal token: its scale gives mm values, and its subject and session carry over. */
  frontalToken: string;
  locale: Locale;
  layers: string[];
}

/** The `meta` part (ProfileAnalyzeMeta): never `subject` (it comes from the frontal token). */
export function profileMeta(req: Pick<ProfileRequest, "capture" | "facing" | "frontalToken" | "locale" | "layers">) {
  return {
    facing: req.facing,
    locale: req.locale,
    overlay: { layers: req.layers },
    frontal_token: req.frontalToken,
    ...(req.capture.camera ? { camera: req.capture.camera } : {}),
  };
}

export async function analyzeProfile(api: ApiClient, req: ProfileRequest): Promise<AnalyzeResponse> {
  const image = req.capture.frames[0]!;
  const form = new FormData();
  form.append("image", image.blob, image.name);
  form.append("meta", JSON.stringify(profileMeta(req)));
  const { data } = await api.request({
    path: "/v1/profile/analyze",
    method: "POST",
    form,
    schema: AnalyzeResponseSchema,
    signal: req.signal,
    onUploadProgress: req.onUploadProgress,
    onUploaded: req.onUploaded,
  });
  return data;
}

export interface Point {
  x: number;
  y: number;
}

/** Every changed point in one call; the API sets `source` itself (never sent). */
export async function adjust(
  api: ApiClient,
  req: { token: string; overrides: Record<string, Point>; locale: Locale; signal?: AbortSignal },
): Promise<AnalyzeResponse> {
  const { data } = await api.request({
    path: "/v1/adjust",
    method: "POST",
    json: { result_token: req.token, overrides: req.overrides, locale: req.locale },
    schema: AnalyzeResponseSchema,
    signal: req.signal,
  });
  return data;
}

/**
 * The report from the session's latest tokens. The profile token is sent only when
 * there is a side photo; both tokens share the session (a new frontal analysis drops the
 * side results, session.ts).
 */
export async function buildReport(
  api: ApiClient,
  req: { frontalToken: string; profileToken: string | null; locale: Locale; signal?: AbortSignal },
): Promise<ReportResponse> {
  const { data } = await api.request({
    path: "/v1/report",
    method: "POST",
    json: {
      frontal_token: req.frontalToken,
      ...(req.profileToken ? { profile_token: req.profileToken } : {}),
      locale: req.locale,
    },
    schema: ReportResponseSchema,
    signal: req.signal,
  });
  return data;
}

/** The overlay for a token, drawn on its reference image as uploaded. */
export async function redrawOverlay(
  api: ApiClient,
  req: { image: CapturedFrame; token: string; layers: string[]; locale: Locale; signal?: AbortSignal },
): Promise<Blob> {
  const form = new FormData();
  form.append("image", req.image.blob, req.image.name);
  form.append("meta", JSON.stringify({ result_token: req.token, layers: req.layers, locale: req.locale }));
  return await api.requestBlob({ path: "/v1/overlay", method: "POST", form, signal: req.signal });
}
