/**
 * The committed fixtures come from the real core and API (scripts/gen_fixtures.py). The
 * zod schemas must accept every one, and no clinic-only metric may appear.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnalyzeResponseSchema, ClientConfigSchema, ReportResponseSchema } from "../src/api/schemas";
import { WEB } from "./paths";

const DIR = join(WEB, "fixtures");
const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
const load = (name: string): unknown => JSON.parse(readFileSync(join(DIR, name), "utf8"));

// The golden ratio is for clinic export only.
const CLINIC_ONLY = ["F10_golden_ratio"];

describe("fixtures", () => {
  it("are all covered by a schema below", () => {
    const known = files.filter((f) =>
      /^(client_config|frontal_ok|frontal_ok_no_hairline|frontal_adjusted|frontal_quality_failed|frontal_no_face|profile_ok|profile_no_scale|profile_adjusted|profile_contour_failed|report_ok|report_frontal_only)\.(th|en)\.json$|^(error_codes|exif_focal|contour_snap|live_gates)\.json$/.test(f),
    );
    expect(known.sort()).toEqual(files.sort());
  });

  it.each(files.filter((f) => f.startsWith("client_config")))("%s is a valid client-config", (name) => {
    const config = ClientConfigSchema.parse(load(name));
    expect(config.locale).toBe(name.split(".")[1]);
  });

  it.each(files.filter((f) => /^(frontal|profile)_/.test(f)))("%s is a valid analyze response", (name) => {
    const response = AnalyzeResponseSchema.parse(load(name));
    if (response.status === "ok") {
      expect(response.result.locale).toBe(name.split(".")[1]);
      expect(response.result.view).toBe(name.split("_")[0]);
      for (const id of CLINIC_ONLY) expect(response.result.metrics).not.toHaveProperty(id);
      expect(Object.keys(response.result.metrics).length).toBeGreaterThan(name.startsWith("frontal") ? 20 : 5);
    } else {
      expect(response).not.toHaveProperty("result");
      expect(response).not.toHaveProperty("result_token");
      expect(response.hints.length).toBeGreaterThan(0);
    }
  });

  it("adjusted: the trichion moved far, a hollow ring with its automatic position kept", () => {
    const r = AnalyzeResponseSchema.parse(load("frontal_adjusted.en.json"));
    if (r.status !== "ok") throw new Error("not ok");
    const tri = r.result.landmarks.trichion!;
    expect(tri).toMatchObject({ adjusted: true, source: "user_adjusted", flags: ["large_user_adjustment"] });
    expect(tri.auto).not.toBeNull();
    expect(r.result.metrics.F1_upper_third!.flags.map((f) => f.key)).toContain("large_user_adjustment");
  });

  it("no hairline: the trichion is unavailable but adjustable", () => {
    const r = AnalyzeResponseSchema.parse(load("frontal_ok_no_hairline.th.json"));
    if (r.status !== "ok") throw new Error("not ok");
    expect(r.result.landmarks.trichion).toMatchObject({ available: false, adjustable: true, x: null });
    expect(r.result.metrics.F1_upper_third!.status).toBe("unavailable");
  });

  it("profile: the silhouette, the facing, and ten adjustable points with the alar crease unplaced", () => {
    const r = AnalyzeResponseSchema.parse(load("profile_ok.en.json"));
    if (r.status !== "ok") throw new Error("not ok");
    expect(r.result.facing).toBe("right");
    expect(r.result.contour!.length).toBeGreaterThan(100);
    expect(r.result.contour!.length).toBeLessThanOrEqual(400);
    expect(r.result.calibration).toEqual({ method: "transferred_from_frontal", available: true });
    expect(r.result.warnings).toEqual([]);
    expect(r.result.adjustable_points.map((p) => p.id)).toContain("alar_crease");
    expect(r.result.adjustable_points).toHaveLength(10);
    expect(r.result.landmarks.alar_crease).toMatchObject({ available: false, adjustable: true, x: null });
    expect(r.result.metrics.P3a_tip_projection_goode!.status).toBe("unavailable");
  });

  it("profile, no scale: the frontal scale could not be used, and no warning says so (request 3 in ASSUMPTIONS.md)", () => {
    const r = AnalyzeResponseSchema.parse(load("profile_no_scale.en.json"));
    if (r.status !== "ok") throw new Error("not ok");
    expect(r.result.calibration?.available).toBe(false);
    expect(r.result.warnings.map((w) => w.key)).not.toContain("no_frontal_scale");
    expect(r.result.metrics.P4_eline_upper_lip_mm!.status).toBe("unavailable");
  });

  it("profile, adjusted: the alar crease placed by hand, the nose tip moved and re-snapped", () => {
    const r = AnalyzeResponseSchema.parse(load("profile_adjusted.en.json"));
    if (r.status !== "ok") throw new Error("not ok");
    expect(r.result.landmarks.alar_crease).toMatchObject({ available: true, adjusted: true, confidence: "low", flags: ["no_automatic_position"] });
    expect(r.result.landmarks.pronasale).toMatchObject({ adjusted: true, source: "user_adjusted" });
    expect(r.result.metrics.P3a_tip_projection_goode!.flags.map((f) => f.key)).toContain("no_automatic_position");
  });

  it("profile, contour failed: the API's real answer, with hints and no result", () => {
    const r = AnalyzeResponseSchema.parse(load("profile_contour_failed.th.json"));
    expect(r.status).toBe("contour_failed");
    expect(r.hints[0]).toMatch(/[฀-๿]/);
  });

  it("a profile result without its contour is refused (missing fields are errors)", () => {
    const body = load("profile_ok.en.json") as { result: Record<string, unknown> };
    const rest = { ...body.result };
    delete rest.contour;
    expect(AnalyzeResponseSchema.safeParse({ ...body, result: rest }).success).toBe(false);
    expect(AnalyzeResponseSchema.safeParse({ ...body, result: { ...body.result, contour: null } }).success).toBe(false);
  });

  it.each(files.filter((f) => f.startsWith("report_")))("%s is a valid report, from the example rules", (name) => {
    const { report } = ReportResponseSchema.parse(load(name));
    expect(report.locale).toBe(name.split(".")[1]);
    expect(report.rules_version).toBe("EXAMPLE");
    for (const id of CLINIC_ONLY) expect(report.frontal.metrics).not.toHaveProperty(id);
    if (name.startsWith("report_ok")) {
      expect(report.profile).not.toBeNull();
      expect(report.considerations.length).toBeGreaterThan(0);
      expect(report.no_considerations_note).toBeNull();
    } else {
      expect(report.profile).toBeNull();
      expect(report.considerations).toEqual([]);
      expect(report.no_considerations_note).toBeTruthy();
    }
  });

  it("have Thai text in the Thai fixtures", () => {
    const th = AnalyzeResponseSchema.parse(load("frontal_ok.th.json"));
    if (th.status !== "ok") throw new Error("not ok");
    expect(Object.values(th.result.metrics)[0]?.name).toMatch(/[฀-๿]/);
  });
});
