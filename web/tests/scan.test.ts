/** The scan session and the requests it makes. */
import { describe, expect, it } from "vitest";
import configEn from "../fixtures/client_config.en.json" with { type: "json" };
import okEn from "../fixtures/frontal_ok.en.json" with { type: "json" };
import adjustedEn from "../fixtures/frontal_adjusted.en.json" with { type: "json" };
import failedEn from "../fixtures/frontal_quality_failed.en.json" with { type: "json" };
import profileOkEn from "../fixtures/profile_ok.en.json" with { type: "json" };
import profileAdjustedEn from "../fixtures/profile_adjusted.en.json" with { type: "json" };
import { overlayLayers, VIEW_LAYERS } from "../src/api/layers";
import { frontalMeta, profileMeta } from "../src/api/scan";
import { AnalyzeResponseSchema, ClientConfigSchema } from "../src/api/schemas";
import { singlePhoto } from "../src/capture/CaptureSource";
import {
  analysisFrom,
  failureFrom,
  hasProfilePhoto,
  initialScanState,
  objectUrls,
  scanReducer,
  type ScanState,
} from "../src/scan/session";

const config = ClientConfigSchema.parse(configEn);
const ok = AnalyzeResponseSchema.parse(okEn);
const adjusted = AnalyzeResponseSchema.parse(adjustedEn);
const failed = AnalyzeResponseSchema.parse(failedEn);
const profileOk = AnalyzeResponseSchema.parse(profileOkEn);
const profileAdjusted = AnalyzeResponseSchema.parse(profileAdjustedEn);
if (ok.status !== "ok" || adjusted.status !== "ok" || failed.status === "ok") throw new Error("fixtures");
if (profileOk.status !== "ok" || profileAdjusted.status !== "ok") throw new Error("fixtures");

const photo = singlePhoto({ blob: new Blob(["x"]), name: "p.jpg", width: 1600, height: 1800 }, null, []);
const side = singlePhoto({ blob: new Blob(["y"]), name: "side.jpg", width: 1000, height: 1300 }, null, []);

function withResults(): ScanState {
  let s = scanReducer(initialScanState(), { type: "subject_confirmed", subject: { sex: "female", age: 21 } });
  s = scanReducer(s, { type: "photo_selected", view: "frontal", capture: photo, source: "camera", photoUrl: "blob:photo" });
  s = scanReducer(s, { type: "upload_started", view: "frontal", at: 0 });
  return scanReducer(s, { type: "analysis_ok", view: "frontal", analysis: analysisFrom(ok as never, "en", 1000) });
}

function withProfile(): ScanState {
  let s = withResults();
  s = scanReducer(s, { type: "facing", facing: "left" });
  s = scanReducer(s, { type: "photo_selected", view: "profile", capture: side, source: "library", photoUrl: "blob:side" });
  s = scanReducer(s, { type: "upload_started", view: "profile", at: 2000 });
  return scanReducer(s, { type: "analysis_ok", view: "profile", analysis: analysisFrom(profileOk as never, "en", 3000) });
}

describe("overlay layers (request 4 in ASSUMPTIONS.md)", () => {
  it("are the view's list, within client-config's, never golden_ratio", () => {
    expect(config.overlay.layers).toContain("golden_ratio");
    expect(overlayLayers("frontal", config)).toEqual(["landmarks", "thirds", "fifths", "eyes_brows", "nose_lips", "labels"]);
    expect(overlayLayers("profile", config)).toEqual(["landmarks", "profile_lines", "labels"]);
    for (const view of ["frontal", "profile"] as const) {
      expect(overlayLayers(view, config)).not.toContain("golden_ratio");
      expect(VIEW_LAYERS[view]).not.toContain("golden_ratio");
    }
  });

  it("drop a layer the service does not offer", () => {
    expect(overlayLayers("frontal", { overlay: { layers: ["landmarks", "labels", "golden_ratio"], max_side_px: 1600 } })).toEqual([
      "landmarks",
      "labels",
    ]);
  });
});

describe("the analysis request's meta", () => {
  const base = { subject: { sex: "female", age: 21 } as const, locale: "th" as const, layers: overlayLayers("frontal", config) };

  it("sends the subject, locale and the overlay layers; no camera for a JPEG", () => {
    expect(frontalMeta({ ...base, capture: photo })).toEqual({
      subject: { sex: "female", age: 21 },
      locale: "th",
      overlay: { layers: ["landmarks", "thirds", "fifths", "eyes_brows", "nose_lips", "labels"] },
    });
  });

  it("sends the camera only when it came from HEIC's EXIF", () => {
    const heic = singlePhoto(photo.frames[0]!, { focal_px: 2894.4, source: "exif" }, []);
    expect(frontalMeta({ ...base, capture: heic })).toMatchObject({ camera: { focal_px: 2894.4, source: "exif" } });
  });
});

describe("the profile request's meta", () => {
  const base = { facing: "left" as const, frontalToken: "tok", locale: "en" as const, layers: overlayLayers("profile", config) };

  it("sends the facing, locale, the profile layers and the frontal token; never the subject", () => {
    const meta = profileMeta({ ...base, capture: side });
    expect(meta).toEqual({
      facing: "left",
      locale: "en",
      overlay: { layers: ["landmarks", "profile_lines", "labels"] },
      frontal_token: "tok",
    });
    expect(meta).not.toHaveProperty("subject");
  });

  it("sends the camera only when it came from HEIC's EXIF", () => {
    const heic = singlePhoto(side.frames[0]!, { focal_px: 3100, source: "exif" }, []);
    expect(profileMeta({ ...base, capture: heic })).toMatchObject({ camera: { focal_px: 3100, source: "exif" } });
    expect(profileMeta({ ...base, capture: side })).not.toHaveProperty("camera");
  });
});

describe("scan session", () => {
  it("keeps the original analysis and replaces the latest after an adjustment", () => {
    let s = withResults();
    expect(s.phase).toBe("frontal_result");
    expect(s.frontal.original).toBe(s.frontal.latest);
    s = scanReducer(s, { type: "adjust_started", view: "frontal" });
    s = scanReducer(s, { type: "adjusted", view: "frontal", count: 1, analysis: { ...analysisFrom(adjusted as never, "en", 1000), overlay: "blob:redrawn" } });
    expect(s.frontal.latest?.token).toBe("fixture-token-frontal-adjusted");
    expect(s.frontal.original?.token).toBe("fixture-token-frontal");
    expect(s.frontal.announcement).toEqual({ kind: "saved", count: 1 });
  });

  it("Reset to automatic restores the original token and result, and needs no request", () => {
    let s = withResults();
    const original = s.frontal.original;
    s = scanReducer(s, { type: "adjusted", view: "frontal", count: 1, analysis: analysisFrom(adjusted as never, "en", 1000) });
    s = scanReducer(s, { type: "reset_to_automatic", view: "frontal" });
    expect(s.frontal.latest).toBe(original);
    expect(s.frontal.latest?.token).toBe("fixture-token-frontal");
    expect(s.frontal.latest?.result.landmarks.trichion?.adjusted).toBe(false);
    expect(s.frontal.announcement).toEqual({ kind: "reset" });
  });

  it("counts failures in a row, and an ok analysis resets the count", () => {
    let s = withResults();
    for (let i = 1; i <= 3; i++) {
      s = scanReducer(s, { type: "photo_selected", view: "frontal", capture: photo, source: "camera", photoUrl: `blob:${i}` });
      s = scanReducer(s, { type: "analysis_failed", view: "frontal", failure: failureFrom(failed as never, "en") });
      expect(s.frontal.failures).toBe(i);
      expect(s.frontal.latest).toBeNull();
    }
    expect(s.frontal.lastFailure).toMatchObject({ hints: failed.hints, locale: "en" });
    s = scanReducer(s, { type: "analysis_ok", view: "frontal", analysis: analysisFrom(ok as never, "en", 1) });
    expect(s.frontal.failures).toBe(0);
  });

  it("a new photo replaces the results made from the old one", () => {
    let s = withResults();
    s = scanReducer(s, { type: "photo_selected", view: "frontal", capture: photo, source: "library", photoUrl: "blob:new" });
    expect(s.frontal.latest).toBeNull();
    expect(s.frontal.original).toBeNull();
    expect(s.frontal.source).toBe("library");
  });

  it("a new scan clears everything except the subject form and the facing", () => {
    const s = scanReducer(withProfile(), { type: "new_scan" });
    expect(s.frontal.capture).toBeNull();
    expect(s.frontal.latest).toBeNull();
    expect(s.profile.capture).toBeNull();
    expect(s.profile.latest).toBeNull();
    expect(s.profile.facing).toBe("left");
    expect(s.draft).toEqual({ sex: "female", age: 21 });
    expect(objectUrls(s).size).toBe(0);
  });

  it("tracks the object URLs it refers to, so the rest can be revoked", () => {
    let s = withResults();
    expect([...objectUrls(s)]).toEqual(["blob:photo"]); // the analysis overlay is a data URI
    s = scanReducer(s, { type: "adjusted", view: "frontal", count: 1, analysis: { ...analysisFrom(adjusted as never, "en", 1), overlay: "blob:redrawn" } });
    expect([...objectUrls(s)].sort()).toEqual(["blob:photo", "blob:redrawn"]);
  });

  it("takes the overlay from the response", () => {
    expect(analysisFrom(ok as never, "en", 0).overlay).toBeNull(); // the fixture carries no overlay; the mock adds one
    expect(analysisFrom({ ...ok, overlay: "data:image/jpeg;base64,x" } as never, "en", 0).overlay).toBe("data:image/jpeg;base64,x");
  });
});

describe("the side view in the session", () => {
  it("defaults to the nose pointing right", () => {
    expect(initialScanState().profile.facing).toBe("right");
  });

  it("holds its own photo, original and latest results", () => {
    let s = withProfile();
    expect(s.phase).toBe("profile_result");
    expect(s.profile.original).toBe(s.profile.latest);
    expect(s.profile.latest?.token).toBe("fixture-token-profile");
    expect(s.frontal.latest?.token).toBe("fixture-token-frontal"); // untouched
    expect(hasProfilePhoto(s)).toBe(true);
    s = scanReducer(s, { type: "adjusted", view: "profile", count: 2, analysis: { ...analysisFrom(profileAdjusted as never, "en", 3000), overlay: "blob:side-redrawn" } });
    expect(s.profile.latest?.token).toBe("fixture-token-profile-adjusted");
    expect(s.profile.announcement).toEqual({ kind: "saved", count: 2 });
    expect([...objectUrls(s)].sort()).toEqual(["blob:photo", "blob:side", "blob:side-redrawn"]);
    s = scanReducer(s, { type: "reset_to_automatic", view: "profile" });
    expect(s.profile.latest?.token).toBe("fixture-token-profile");
    expect(s.profile.latest?.result.landmarks.alar_crease?.available).toBe(false);
    expect(s.frontal.latest?.token).toBe("fixture-token-frontal");
  });

  it("a new frontal analysis (a new session) drops the side results but keeps the side photo", () => {
    let s = withProfile();
    s = scanReducer(s, { type: "upload_started", view: "frontal", at: 5000 });
    s = scanReducer(s, { type: "analysis_ok", view: "frontal", analysis: analysisFrom(ok as never, "th", 6000) });
    expect(s.profile.latest).toBeNull();
    expect(s.profile.original).toBeNull();
    expect(s.profile.capture).toBe(side);
    expect(s.profile.photoUrl).toBe("blob:side");
    expect(s.profile.facing).toBe("left");
  });

  it("a failed frontal analysis drops the side results made with the old frontal token", () => {
    let s = withProfile();
    s = scanReducer(s, { type: "upload_started", view: "frontal", at: 5000 });
    s = scanReducer(s, { type: "analysis_failed", view: "frontal", failure: failureFrom(failed as never, "en") });
    expect(s.frontal.latest).toBeNull();
    expect(s.profile.latest).toBeNull();
    expect(s.profile.original).toBeNull();
    expect(s.profile.capture).toBe(side);
  });

  it("a new frontal photo drops the side photo too", () => {
    let s = withProfile();
    s = scanReducer(s, { type: "photo_selected", view: "frontal", capture: photo, source: "camera", photoUrl: "blob:other" });
    expect(s.profile.capture).toBeNull();
    expect(s.profile.latest).toBeNull();
    expect(s.profile.facing).toBe("left");
    expect(objectUrls(s)).toEqual(new Set(["blob:other"]));
  });

  it("counts side-photo failures on their own", () => {
    let s = withResults();
    s = scanReducer(s, { type: "photo_selected", view: "profile", capture: side, source: "camera", photoUrl: "blob:side" });
    s = scanReducer(s, { type: "analysis_failed", view: "profile", failure: failureFrom(failed as never, "en") });
    expect(s.profile.failures).toBe(1);
    expect(s.frontal.failures).toBe(0);
    expect(s.phase).toBe("profile_failed");
  });
});
