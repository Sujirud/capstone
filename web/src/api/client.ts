/**
 * Typed client for the API in `api/` (contract: `api/openapi.json`).
 *
 * - Errors are RFC 9457 problems; they become `ApiError` with the stable `code`, the
 *   `request_id` and `Retry-After`. `detail` is developer text and is dropped.
 * - `overloaded` / `not_ready` are retried once, automatically, after `Retry-After` when
 *   that is at most 10 s; the second failure goes to the caller.
 * - Every body is validated with its zod schema; a body that does not match is an error.
 */
import type { ZodType } from "zod";
import { CLIENT_CODES, handlingFor, MAX_AUTO_RETRY_S, type ProblemHandling } from "./problems";
import { ProblemSchema } from "./schemas";

export interface ApiErrorInit {
  code: string;
  status: number | null;
  requestId: string | null;
  retryAfterS: number | null;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly retryAfterS: number | null;

  constructor(init: ApiErrorInit) {
    super(`API error: ${init.code}`, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ApiError";
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId;
    this.retryAfterS = init.retryAfterS;
  }

  get handling(): ProblemHandling {
    return handlingFor(this.code);
  }
}

/** `Retry-After` as seconds from now: delta-seconds or an HTTP date (RFC 9110 §10.2.3). */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

// The proxy and the tunnel in front of the API may answer without a problem document,
// e.g. with their own body-size limit or timeout. Such answers are classified by HTTP
// status only.
const STATUS_FALLBACK: Readonly<Record<number, string>> = {
  413: "payload_too_large",
  429: "rate_limited",
  503: "overloaded",
  504: "analysis_timeout",
};

async function problemFrom(response: Response, now: number): Promise<ApiError> {
  const retryAfterS = parseRetryAfter(response.headers.get("Retry-After"), now);
  const headerId = response.headers.get("X-Request-ID");
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // not JSON: handled below
  }
  const problem = ProblemSchema.safeParse(body);
  if (problem.success) {
    return new ApiError({
      code: problem.data.code,
      status: response.status,
      requestId: problem.data.request_id ?? headerId,
      retryAfterS,
    });
  }
  return new ApiError({
    code: STATUS_FALLBACK[response.status] ?? CLIENT_CODES.badResponse,
    status: response.status,
    requestId: headerId,
    retryAfterS,
  });
}

interface BaseRequest {
  path: string;
  method?: "GET" | "POST";
  query?: Record<string, string>;
  /** A JSON body, or a multipart body (photo uploads). */
  json?: unknown;
  form?: FormData;
  signal?: AbortSignal;
  cache?: RequestCache;
  /**
   * Upload progress, 0 … 1. Multipart requests (photo uploads) go through
   * XMLHttpRequest, the only browser API that reports upload progress. `onUploaded` fires
   * when the body is sent.
   */
  onUploadProgress?: (fraction: number) => void;
  onUploaded?: () => void;
}

export interface RequestOptions<T> extends BaseRequest {
  schema: ZodType<T>;
}

export interface ApiResponse<T> {
  data: T;
  response: Response;
}

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** For tests; defaults to the browser's XMLHttpRequest. */
  xhr?: () => XMLHttpRequest;
  /** Stalled uploads end after this long (the API ends its own after 120 s + analysis). */
  uploadTimeoutMs?: number;
}

export interface ApiClient {
  readonly baseUrl: string;
  /** A JSON response, validated with `schema`. */
  request<T>(options: RequestOptions<T>): Promise<ApiResponse<T>>;
  /** A binary response (overlay images). */
  requestBlob(options: BaseRequest): Promise<Blob>;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** By name: an AbortError's class can come from another realm (an iframe, a test DOM). */
function isAbort(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

function networkError(cause?: unknown): ApiError {
  return new ApiError({ code: CLIENT_CODES.network, status: null, requestId: null, retryAfterS: null, cause });
}

function parseHeaders(raw: string): Headers {
  const headers = new Headers();
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const i = line.indexOf(":");
    if (i > 0) headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return headers;
}

/** XMLHttpRequest as a fetch-like call, for upload progress. */
function sendXhr(
  make: () => XMLHttpRequest,
  url: URL,
  init: { method: string; headers: Record<string, string>; body: XMLHttpRequestBodyInit | null; signal?: AbortSignal },
  progress: { onUploadProgress?: (f: number) => void; onUploaded?: () => void },
  timeoutMs: number,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = make();
    xhr.open(init.method, url.toString());
    xhr.responseType = "arraybuffer";
    xhr.timeout = timeoutMs;
    for (const [k, v] of Object.entries(init.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) progress.onUploadProgress?.(e.loaded / e.total);
    };
    xhr.upload.onload = () => {
      progress.onUploadProgress?.(1);
      progress.onUploaded?.();
    };
    const abort = () => xhr.abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    const done = () => init.signal?.removeEventListener("abort", abort);
    xhr.onload = () => {
      done();
      if (xhr.status === 0) return reject(networkError());
      resolve(new Response(xhr.status === 204 ? null : (xhr.response as ArrayBuffer), {
        status: xhr.status,
        headers: parseHeaders(xhr.getAllResponseHeaders()),
      }));
    };
    xhr.onerror = () => {
      done();
      reject(networkError());
    };
    xhr.ontimeout = () => {
      done();
      reject(networkError(new Error("upload timed out")));
    };
    xhr.onabort = () => {
      done();
      reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (init.signal?.aborted) {
      xhr.abort();
      return;
    }
    xhr.send(init.body);
  });
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const makeXhr = options.xhr ?? (() => new XMLHttpRequest());
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  const uploadTimeoutMs = options.uploadTimeoutMs ?? 180_000;

  /** One HTTP exchange; a non-2xx answer becomes an ApiError. */
  async function send(req: BaseRequest, accept: string): Promise<Response> {
    const url = new URL(baseUrl + req.path);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Accept: accept };
    let body: string | FormData | null = null;
    if (req.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.json);
    } else if (req.form) {
      body = req.form; // the browser sets the multipart boundary
    }
    const method = req.method ?? "GET";
    let response: Response;
    try {
      response =
        req.form || req.onUploadProgress || req.onUploaded
          ? await sendXhr(makeXhr, url, { method, headers, body, signal: req.signal }, req, uploadTimeoutMs)
          : await fetchImpl(url, { method, headers, body, signal: req.signal, cache: req.cache });
    } catch (err) {
      if (isAbort(err) || err instanceof ApiError) throw err;
      throw networkError(err);
    }
    if (!response.ok) throw await problemFrom(response, now());
    return response;
  }

  async function once<T>(req: RequestOptions<T>): Promise<ApiResponse<T>> {
    const response = await send(req, "application/json");
    const requestId = response.headers.get("X-Request-ID");
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      throw new ApiError({ code: CLIENT_CODES.badResponse, status: response.status, requestId, retryAfterS: null, cause: err });
    }
    const parsed = req.schema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiError({
        code: CLIENT_CODES.badResponse,
        status: response.status,
        requestId,
        retryAfterS: null,
        cause: parsed.error,
      });
    }
    return { data: parsed.data, response };
  }

  async function attempt<R>(run: () => Promise<R>): Promise<R> {
    try {
      return await run();
    } catch (err) {
      // Client bugs: the code and request id only, never image or result data.
      if (err instanceof ApiError && err.handling.action === "log") {
        console.error(`[api] ${err.code} ${err.status ?? ""} ${err.requestId ?? ""}`);
      }
      throw err;
    }
  }

  /** One automatic retry for a busy service, after Retry-After when it is ≤ 10 s. */
  async function withBusyRetry<R>(run: () => Promise<R>, signal?: AbortSignal): Promise<R> {
    try {
      return await attempt(run);
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.handling.action === "retry_once" &&
        err.retryAfterS !== null &&
        err.retryAfterS <= MAX_AUTO_RETRY_S
      ) {
        await sleep(err.retryAfterS * 1000, signal);
        return await attempt(run);
      }
      throw err;
    }
  }

  return {
    baseUrl,
    request: (req) => withBusyRetry(() => once(req), req.signal),
    requestBlob: (req) =>
      withBusyRetry(async () => {
        const response = await send(req, "image/jpeg");
        return await response.blob();
      }, req.signal),
  };
}
