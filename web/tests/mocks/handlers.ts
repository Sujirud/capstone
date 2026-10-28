/**
 * API mocks (MSW), shared by the Vitest tests (msw/node) and the Playwright tests
 * (@msw/playwright). Responses are the committed fixtures, generated from the real core
 * and API by scripts/gen_fixtures.py; problems follow RFC 9457 as the API sends them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import configEn from "../../fixtures/client_config.en.json" with { type: "json" };
import configTh from "../../fixtures/client_config.th.json" with { type: "json" };
import adjustedEn from "../../fixtures/frontal_adjusted.en.json" with { type: "json" };
import adjustedTh from "../../fixtures/frontal_adjusted.th.json" with { type: "json" };
import noFaceEn from "../../fixtures/frontal_no_face.en.json" with { type: "json" };
import noFaceTh from "../../fixtures/frontal_no_face.th.json" with { type: "json" };
import okEn from "../../fixtures/frontal_ok.en.json" with { type: "json" };
import okTh from "../../fixtures/frontal_ok.th.json" with { type: "json" };
import noHairlineEn from "../../fixtures/frontal_ok_no_hairline.en.json" with { type: "json" };
import noHairlineTh from "../../fixtures/frontal_ok_no_hairline.th.json" with { type: "json" };
import failedEn from "../../fixtures/frontal_quality_failed.en.json" with { type: "json" };
import failedTh from "../../fixtures/frontal_quality_failed.th.json" with { type: "json" };
import profileAdjustedEn from "../../fixtures/profile_adjusted.en.json" with { type: "json" };
import profileAdjustedTh from "../../fixtures/profile_adjusted.th.json" with { type: "json" };
import contourFailedEn from "../../fixtures/profile_contour_failed.en.json" with { type: "json" };
import contourFailedTh from "../../fixtures/profile_contour_failed.th.json" with { type: "json" };
import profileNoScaleEn from "../../fixtures/profile_no_scale.en.json" with { type: "json" };
import profileNoScaleTh from "../../fixtures/profile_no_scale.th.json" with { type: "json" };
import profileOkEn from "../../fixtures/profile_ok.en.json" with { type: "json" };
import profileOkTh from "../../fixtures/profile_ok.th.json" with { type: "json" };
import reportFrontalOnlyEn from "../../fixtures/report_frontal_only.en.json" with { type: "json" };
import reportFrontalOnlyTh from "../../fixtures/report_frontal_only.th.json" with { type: "json" };
import reportOkEn from "../../fixtures/report_ok.en.json" with { type: "json" };
import reportOkTh from "../../fixtures/report_ok.th.json" with { type: "json" };

const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures");
export const fixtureBytes = (name: string): Buffer => readFileSync(join(FIXTURES, name));

export const MOCK_API = "http://api.test";

/** A CORS answer: the mocked API has an origin of its own. */
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "X-Request-ID, Retry-After, ETag",
};

export interface ProblemOptions {
  retryAfter?: number;
  requestId?: string;
}

export function problem(code: string, status: number, { retryAfter, requestId = "req_mock" }: ProblemOptions = {}) {
  return HttpResponse.json(
    { type: "about:blank", title: "Error", status, detail: "mock detail, never shown", code, request_id: requestId },
    {
      status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/problem+json",
        "X-Request-ID": requestId,
        ...(retryAfter === undefined ? {} : { "Retry-After": String(retryAfter) }),
      },
    },
  );
}

export const clientConfig = http.get(`${MOCK_API}/v1/client-config`, ({ request }) => {
  const locale = new URL(request.url).searchParams.get("locale") ?? "th";
  if (locale !== "th" && locale !== "en") return problem("invalid_request", 400);
  return HttpResponse.json(locale === "en" ? configEn : configTh, {
    headers: {
      ...CORS_HEADERS,
      ETag: `"fixture-${locale}"`,
      "Cache-Control": "public, max-age=3600",
      "X-Request-ID": "req_mock",
    },
  });
});

export const clientConfigUnreachable = http.get(`${MOCK_API}/v1/client-config`, () => HttpResponse.error());

/** CORS preflight for requests with a JSON body. */
export const preflight = http.options(
  `${MOCK_API}/*`,
  () =>
    new HttpResponse(null, {
      status: 204,
      headers: {
        ...CORS_HEADERS,
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
        "Access-Control-Max-Age": "600",
      },
    }),
);

// ------------------------------------------------------------------------- the scan

type Lang = "th" | "en";
export type AnalysisOutcome = "ok" | "ok_no_hairline" | "quality_failed" | "no_face";

const ANALYSES: Record<AnalysisOutcome, Record<Lang, object>> = {
  ok: { th: okTh, en: okEn },
  ok_no_hairline: { th: noHairlineTh, en: noHairlineEn },
  quality_failed: { th: failedTh, en: failedEn },
  no_face: { th: noFaceTh, en: noFaceEn },
};

export type ProfileOutcome = "ok" | "no_scale" | "contour_failed";

const PROFILE_ANALYSES: Record<ProfileOutcome, Record<Lang, object>> = {
  ok: { th: profileOkTh, en: profileOkEn },
  no_scale: { th: profileNoScaleTh, en: profileNoScaleEn },
  contour_failed: { th: contourFailedTh, en: contourFailedEn },
};

/** Tokens the fixtures carry: a profile token is told from a frontal one by its name. */
const isProfileToken = (token: unknown) => typeof token === "string" && token.startsWith("fixture-token-profile");

const dataUri = (name: string) => `data:image/jpeg;base64,${fixtureBytes(name).toString("base64")}`;

interface Part {
  name: string;
  filename: string | null;
  type: string | null;
  bytes: Uint8Array;
}

/**
 * A small multipart/form-data reader. Node's `request.formData()` fails inside jsdom (its
 * File check sees jsdom's File), so the mocks read the parts themselves.
 */
async function readParts(request: Request): Promise<Part[]> {
  const boundary = /boundary=("?)([^";]+)\1/.exec(request.headers.get("Content-Type") ?? "")?.[2];
  if (!boundary) throw new Error("not multipart");
  const body = new Uint8Array(await request.arrayBuffer());
  const text = new TextDecoder("latin1").decode(body); // one char per byte: offsets match
  const parts: Part[] = [];
  for (let i = text.indexOf(`--${boundary}`); i !== -1; ) {
    const start = i + boundary.length + 4; // "--" + boundary + CRLF
    const next = text.indexOf(`\r\n--${boundary}`, start);
    if (next === -1) break;
    const headerEnd = text.indexOf("\r\n\r\n", start);
    const headers = text.slice(start, headerEnd);
    const disposition = /name="([^"]*)"(?:; filename="([^"]*)")?/.exec(headers);
    parts.push({
      name: disposition?.[1] ?? "",
      filename: disposition?.[2] ?? null,
      type: /Content-Type: ([^\r\n]+)/i.exec(headers)?.[1] ?? null,
      bytes: body.slice(headerEnd + 4, next),
    });
    i = next + 2;
  }
  return parts;
}

const field = (parts: Part[], name: string) => new TextDecoder().decode(parts.find((p) => p.name === name)?.bytes);

export interface FilePart {
  name: string;
  type: string;
  size: number;
  head: number[];
}

const filePart = (p: Part): FilePart => ({ name: p.filename ?? "", type: p.type ?? "", size: p.bytes.length, head: [...p.bytes.slice(0, 4)] });

export interface AnalyzeCall {
  meta: Record<string, unknown>;
  frames: FilePart[];
}

export interface ProfileCall {
  meta: Record<string, unknown>;
  image: FilePart | null;
  parts: string[];
}

export interface ScanCalls {
  analyze: AnalyzeCall[];
  profile: ProfileCall[];
  adjust: Array<Record<string, unknown>>;
  overlay: Array<Record<string, unknown>>;
  /** The image part of each overlay call (the reference image as uploaded). */
  overlayImages: FilePart[];
  report: Array<Record<string, unknown>>;
}

export interface ScanMockOptions {
  /** Outcomes of successive frontal analyses; the last one repeats. */
  outcomes?: AnalysisOutcome[];
  /** Outcomes of successive profile analyses; the last one repeats. */
  profileOutcomes?: ProfileOutcome[];
  calls?: ScanCalls;
}

export function scanHandlers({ outcomes = ["ok"], profileOutcomes = ["ok"], calls }: ScanMockOptions = {}) {
  let n = 0;
  let m = 0;
  return [
    http.post(`${MOCK_API}/v1/frontal/analyze`, async ({ request }) => {
      const parts = await readParts(request);
      const meta = JSON.parse(field(parts, "meta")) as Record<string, unknown>;
      const frames = parts.filter((p) => p.name === "frames").map(filePart);
      calls?.analyze.push({ meta, frames });
      const outcome = outcomes[Math.min(n, outcomes.length - 1)]!;
      n += 1;
      const lang = (meta.locale === "en" ? "en" : "th") as Lang;
      let body = ANALYSES[outcome][lang] as Record<string, unknown>;
      if (body.status === "ok") body = { ...body, overlay: dataUri(`overlay_ok.${lang}.jpg`) };
      return HttpResponse.json(body, { headers: { ...CORS_HEADERS, "X-Request-ID": "req_mock" } });
    }),
    http.post(`${MOCK_API}/v1/profile/analyze`, async ({ request }) => {
      const parts = await readParts(request);
      const meta = JSON.parse(field(parts, "meta")) as Record<string, unknown>;
      const image = parts.find((p) => p.name === "image");
      calls?.profile.push({ meta, image: image ? filePart(image) : null, parts: parts.map((p) => p.name) });
      const outcome = profileOutcomes[Math.min(m, profileOutcomes.length - 1)]!;
      m += 1;
      const lang = (meta.locale === "en" ? "en" : "th") as Lang;
      let body = PROFILE_ANALYSES[outcome][lang] as Record<string, unknown>;
      if (body.status === "ok") body = { ...body, overlay: dataUri(`overlay_profile_ok.${lang}.jpg`) };
      return HttpResponse.json(body, { headers: { ...CORS_HEADERS, "X-Request-ID": "req_mock" } });
    }),
    // The report: with a side photo, the one with a consideration; without, the one without.
    http.post(`${MOCK_API}/v1/report`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls?.report.push(body);
      const lang = (body.locale === "en" ? "en" : "th") as Lang;
      const answer = body.profile_token ? { th: reportOkTh, en: reportOkEn } : { th: reportFrontalOnlyTh, en: reportFrontalOnlyEn };
      return HttpResponse.json(answer[lang], { headers: { ...CORS_HEADERS, "X-Request-ID": "req_mock" } });
    }),
    http.post(`${MOCK_API}/v1/adjust`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls?.adjust.push(body);
      const lang = (body.locale === "en" ? "en" : "th") as Lang;
      const answer = isProfileToken(body.result_token)
        ? { th: profileAdjustedTh, en: profileAdjustedEn }
        : { th: adjustedTh, en: adjustedEn };
      return HttpResponse.json(answer[lang], { headers: { ...CORS_HEADERS, "X-Request-ID": "req_mock" } });
    }),
    http.post(`${MOCK_API}/v1/overlay`, async ({ request }) => {
      const parts = await readParts(request);
      const meta = JSON.parse(field(parts, "meta")) as Record<string, unknown>;
      calls?.overlay.push(meta);
      const image = parts.find((p) => p.name === "image");
      if (image) calls?.overlayImages.push(filePart(image));
      const lang = (meta.locale === "en" ? "en" : "th") as Lang;
      const overlay = isProfileToken(meta.result_token) ? "overlay_profile_adjusted" : "overlay_adjusted";
      return new HttpResponse(fixtureBytes(`${overlay}.${lang}.jpg`), {
        headers: { ...CORS_HEADERS, "Content-Type": "image/jpeg", "X-Request-ID": "req_mock" },
      });
    }),
  ];
}

export function newCalls(): ScanCalls {
  return { analyze: [], profile: [], adjust: [], overlay: [], overlayImages: [], report: [] };
}

export const handlers = [clientConfig, preflight, ...scanHandlers()];
