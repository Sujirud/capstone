/**
 * What the user sees and what the app does for every API problem `code`.
 *
 * The complete list of codes is `CODES` in `api/facescan_api/errors.py`, exported to
 * `fixtures/error_codes.json` by `scripts/gen_fixtures.py`; tests/problems.test.ts fails
 * when a code has no entry here. The API's `detail` is developer text and is never shown.
 */

/** What the app does. Screens implement the actions that apply to them. */
export type ProblemAction =
  | "scan_ended" // re-analyze the photos in memory, or start over
  | "new_scan" // start a new scan
  | "back_to_capture" // the photo itself was refused
  | "log" // a client bug: log the code (never image or result data)
  | "client_points" // draw the points in the browser instead of the overlay
  | "wait" // rate limited: disable the action until Retry-After has passed
  | "retry_once" // busy: retry once automatically after Retry-After (≤ 10 s), then ask
  | "offer_retry" // took too long: offer one retry
  | "retry"; // unexpected or network: offer a retry

export interface ProblemHandling {
  /** i18n key of the message, or null when the user sees nothing. */
  message: string | null;
  action: ProblemAction;
}

const GENERIC: ProblemHandling = { message: "errors.generic", action: "retry" };

export const PROBLEMS: Readonly<Record<string, ProblemHandling>> = {
  token_invalid: { message: "errors.scanEnded", action: "scan_ended" },
  token_stale: { message: "errors.scanEnded", action: "scan_ended" },

  subject_mismatch: { message: "errors.generic", action: "new_scan" },
  session_mismatch: { message: "errors.generic", action: "new_scan" },

  payload_too_large: { message: "errors.photo.payload_too_large", action: "back_to_capture" },
  unsupported_media_type: { message: "errors.photo.unsupported_media_type", action: "back_to_capture" },
  too_many_pixels: { message: "errors.photo.too_many_pixels", action: "back_to_capture" },
  frame_size_mismatch: { message: "errors.photo.frame_size_mismatch", action: "back_to_capture" },

  invalid_meta: { message: "errors.generic", action: "log" },
  invalid_request: { message: "errors.generic", action: "log" },
  point_not_adjustable: { message: "errors.generic", action: "log" },
  not_found: { message: "errors.generic", action: "log" },
  method_not_allowed: { message: "errors.generic", action: "log" },

  image_mismatch: { message: null, action: "client_points" },

  rate_limited: { message: "errors.rateLimited", action: "wait" },

  overloaded: { message: "errors.busy", action: "retry_once" },
  not_ready: { message: "errors.busy", action: "retry_once" },

  analysis_timeout: { message: "errors.timeout", action: "offer_retry" },

  internal_error: GENERIC,
};

/** Codes the client produces itself, for failures that never reached the API's handlers. */
export const CLIENT_CODES = {
  network: "network", // offline, DNS, connection reset
  badResponse: "bad_response", // not a problem document, or a body that fails validation
} as const;

export const CLIENT_PROBLEMS: Readonly<Record<string, ProblemHandling>> = {
  [CLIENT_CODES.network]: { message: "errors.network", action: "retry" },
  [CLIENT_CODES.badResponse]: GENERIC,
};

/** Handling for any code; an unknown code is treated as an unexpected error. */
export function handlingFor(code: string): ProblemHandling {
  return PROBLEMS[code] ?? CLIENT_PROBLEMS[code] ?? GENERIC;
}

/** Longest `Retry-After` the app waits for on its own before asking the user. */
export const MAX_AUTO_RETRY_S = 10;
