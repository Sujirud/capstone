import { describe, expect, it } from "vitest";
import errorCodes from "../fixtures/error_codes.json" with { type: "json" };
import { CLIENT_PROBLEMS, handlingFor, PROBLEMS } from "../src/api/problems";
import en from "../src/i18n/en.json" with { type: "json" };
import th from "../src/i18n/th.json" with { type: "json" };

function has(resource: unknown, key: string): boolean {
  let node: unknown = resource;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return false;
    const record = node as Record<string, unknown>;
    node = part in record ? record[part] : (record[`${part}_other`] ?? undefined);
  }
  return typeof node === "string";
}

describe("problem codes", () => {
  const codes = Object.keys(errorCodes);

  it("the fixture lists the API's codes", () => {
    expect(codes.length).toBeGreaterThan(15);
    expect(codes).toContain("token_stale");
  });

  it("maps every code in api/facescan_api/errors.py", () => {
    const missing = codes.filter((code) => !(code in PROBLEMS));
    expect(missing).toEqual([]);
  });

  it("has no mapping for a code the API does not define", () => {
    const stale = Object.keys(PROBLEMS).filter((code) => !codes.includes(code));
    expect(stale).toEqual([]);
  });

  it("every message exists in Thai and English", () => {
    for (const handling of [...Object.values(PROBLEMS), ...Object.values(CLIENT_PROBLEMS)]) {
      if (handling.message === null) continue;
      expect(has(th, handling.message), `th ${handling.message}`).toBe(true);
      expect(has(en, handling.message), `en ${handling.message}`).toBe(true);
    }
  });

  it("maps each code to its action", () => {
    for (const code of ["token_invalid", "token_stale"]) expect(PROBLEMS[code]?.action).toBe("scan_ended");
    for (const code of ["payload_too_large", "unsupported_media_type", "too_many_pixels", "frame_size_mismatch"])
      expect(PROBLEMS[code]).toEqual({ message: `errors.photo.${code}`, action: "back_to_capture" });
    expect(PROBLEMS.image_mismatch).toEqual({ message: null, action: "client_points" });
    expect(PROBLEMS.rate_limited?.action).toBe("wait");
    expect(PROBLEMS.overloaded?.action).toBe("retry_once");
    expect(PROBLEMS.not_ready?.action).toBe("retry_once");
    expect(PROBLEMS.analysis_timeout?.action).toBe("offer_retry");
  });

  it("treats an unknown code as an unexpected error", () => {
    expect(handlingFor("something_new")).toEqual({ message: "errors.generic", action: "retry" });
  });
});
