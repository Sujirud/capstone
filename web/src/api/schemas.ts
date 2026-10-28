/**
 * Runtime validation of the API responses the UI reads.
 *
 * `api/openapi.json` types `client-config` and `result` as open objects, so these
 * schemas define the fields the UI renders. A response that lacks one of them is an
 * error, never a guess. Unknown extra fields are ignored (the API may add fields in v1).
 * The compile-time checks at the end tie the schemas to the generated OpenAPI types
 * where the contract is specific.
 */
import { z } from "zod";
import type { components } from "./openapi";

type Schemas = components["schemas"];

// ------------------------------------------------------------------ problems (RFC 9457)

export const ProblemSchema = z.object({
  type: z.string().optional(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  code: z.string(),
  request_id: z.string().nullable().optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;

// ------------------------------------------------------------------------ client-config

const TextMap = z.record(z.string(), z.string());

const CaptureGuide = z.object({ title: z.string(), steps: z.array(z.string()).min(1) });

export const ClientStringsSchema = z.object({
  hint: TextMap,
  check: TextMap,
  warning: TextMap,
  disclaimer: z.object({ general: z.string(), consult: z.string() }),
  capture: z.object({ frontal: CaptureGuide, profile: CaptureGuide }),
  point: z.record(z.string(), z.object({ name: z.string(), instruction: z.string() })),
  status: TextMap,
  reference: z.object({ canon: z.string(), population: z.string(), note: z.string() }),
  side_note: z.string(),
});

export const UploadLimitsSchema = z.object({
  max_image_bytes: z.number().int().positive(),
  max_request_bytes: z.number().int().positive(),
  max_frames: z.number().int().positive(),
  max_pixels: z.number().int().positive(),
  max_burst_pixels: z.number().int().positive(),
  accepted_types: z.array(z.string()),
});

export type UploadLimits = z.infer<typeof UploadLimitsSchema>;

/** The frontal capture gates (`capture.yaml`): the guide's distance, and live mode's on-device checks. */
const FrontalGatesSchema = z.object({
  camera_distance_min_m: z.number().positive(),
  camera_distance_recommended_m: z.number().positive(),
  yaw_max_deg: z.number().positive(),
  pitch_max_deg: z.number().positive(),
  roll_max_deg: z.number().positive(),
  expression: z.record(z.string(), z.number()),
  ipd_min_px: z.number().positive(),
  sharpness_min: z.number().nonnegative(),
  roi_width_px: z.number().int().positive(),
  exposure_mean_min: z.number(),
  exposure_mean_max: z.number(),
  exposure_clip_low: z.number(),
  exposure_clip_high: z.number(),
  exposure_clipped_max_frac: z.number(),
});

export const VersionsSchema = z.object({ api: z.string(), core: z.string(), schema: z.string() });

export const ClientConfigSchema = z.object({
  locale: z.enum(["th", "en"]),
  core_version: z.string(),
  schema_version: z.string(),
  config_hash: z.string(),
  upload_limits: UploadLimitsSchema,
  overlay: z.object({ layers: z.array(z.string()), max_side_px: z.number() }),
  rules_version: z.string(),
  versions: VersionsSchema,
  frontal: z.object({
    gates: FrontalGatesSchema,
    burst: z.object({ min_frames: z.number().int().positive(), max_frames: z.number().int().positive(), recommended_frames: z.number().int().positive() }),
    guided_capture: z.object({
      consecutive_pass_frames: z.number().int().positive(),
      one_euro: z.object({ min_cutoff: z.number().positive(), beta: z.number().nonnegative(), d_cutoff: z.number().positive() }),
    }),
    iris_diameter_mm: z.number().positive(),
  }),
  user_adjustable_points: z.object({ frontal: z.array(z.string()), profile: z.array(z.string()) }),
  strings: ClientStringsSchema,
});
export type ClientConfig = z.infer<typeof ClientConfigSchema>;

// ----------------------------------------------------------- results (the core's user_view)

export const MetricStatusSchema = z.enum(["within", "below", "above", "inconclusive", "unavailable", "no_reference"]);
export type MetricStatus = z.infer<typeof MetricStatusSchema>;

const TextItem = z.object({ key: z.string(), text: z.string() });

export const MetricSchema = z.object({
  name: z.string(),
  short: z.string(),
  description: z.string(),
  area: z.string().nullable(),
  role: z.enum(["primary", "secondary"]),
  value: z.number().nullable(),
  unit: z.string(),
  value_text: z.string().nullable(),
  status: MetricStatusSchema,
  status_text: z.string(),
  reference: z
    .object({
      basis: z.enum(["canon", "population"]),
      label: z.string(),
      min: z.number().nullable(),
      max: z.number().nullable(),
      text: z.string(),
    })
    .nullable(),
  confidence: z.enum(["high", "low"]),
  confidence_text: z.string(),
  flags: z.array(TextItem),
});
export type Metric = z.infer<typeof MetricSchema>;

const LandmarkSchema = z.object({
  x: z.number().nullable(),
  y: z.number().nullable(),
  available: z.boolean(),
  source: z.enum(["auto", "segmentation", "contour", "user_adjusted", "clinician"]),
  confidence: z.enum(["high", "low"]),
  adjusted: z.boolean(),
  auto: z.object({ x: z.number().nullable(), y: z.number().nullable() }).nullable(),
  flags: z.array(z.string()),
  adjustable: z.boolean(),
});

export const FacingSchema = z.enum(["left", "right"]);
export type Facing = z.infer<typeof FacingSchema>;

/**
 * An `ok` result: the fields the results, adjust and report screens read. A profile result
 * also has `facing` and the stored silhouette `contour` (≤ 400 points, image pixels), which
 * the adjustment snaps points to; a profile without them is an error.
 */
export const ResultSchema = z
  .object({
    schema_version: z.string(),
    core_version: z.string(),
    view: z.enum(["frontal", "profile"]),
    status: z.literal("ok"),
    locale: z.enum(["th", "en"]),
    warnings: z.array(TextItem),
    disclaimer: z.string(),
    side_note: z.string(),
    reference_note: z.string(),
    image: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
    frames: z.object({ count: z.number().int(), reference_frame: z.number().int(), reference_sha256: z.string() }),
    calibration: z.object({ method: z.string(), available: z.boolean() }).nullable(),
    adjustable_points: z.array(z.object({ id: z.string(), name: z.string(), instruction: z.string() })),
    landmarks: z.record(z.string(), LandmarkSchema),
    metrics: z.record(z.string(), MetricSchema),
    facing: FacingSchema.optional(),
    contour: z.array(z.tuple([z.number(), z.number()])).nullable().optional(),
  })
  .superRefine((r, ctx) => {
    if (r.view !== "profile") return;
    if (r.facing === undefined) ctx.addIssue({ code: "custom", path: ["facing"], message: "a profile result has facing" });
    if (!r.contour || r.contour.length < 2) ctx.addIssue({ code: "custom", path: ["contour"], message: "a profile result has a contour" });
  });
export type Result = z.infer<typeof ResultSchema>;

const AnalysisStatus = z.enum(["ok", "no_face", "multiple_faces", "quality_failed", "contour_failed"]);

/** `/v1/frontal/analyze`, `/v1/profile/analyze` and `/v1/adjust`. */
export const AnalyzeResponseSchema = z.discriminatedUnion("status", [
  z.object({
    request_id: z.string(),
    status: z.literal("ok"),
    failed_checks: z.array(z.string()),
    hints: z.array(z.string()),
    warnings: z.array(z.string()),
    result: ResultSchema,
    result_token: z.string().min(1),
    overlay: z.string().optional(),
    versions: VersionsSchema,
  }),
  z.object({
    request_id: z.string(),
    status: AnalysisStatus.exclude(["ok"]),
    failed_checks: z.array(z.string()),
    hints: z.array(z.string()),
    warnings: z.array(z.string()),
    versions: VersionsSchema,
  }),
]);
export type AnalyzeResponse = z.infer<typeof AnalyzeResponseSchema>;

// ------------------------------------------------------------ the report

const ReferenceSchema = MetricSchema.shape.reference;

/** One discussion topic: the rule's finding, its possible considerations and the measurements behind it. */
export const ConsiderationSchema = z.object({
  rule_id: z.string(),
  area: z.string(),
  area_text: z.string(),
  severity: z.string(),
  severity_text: z.string(),
  finding: z.string(),
  considerations: z.array(z.string()),
  measurements: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      value_text: z.string().nullable(),
      status: MetricStatusSchema,
      status_text: z.string(),
      reference: ReferenceSchema,
    }),
  ),
  consult: z.string(),
});
export type Consideration = z.infer<typeof ConsiderationSchema>;

/** The core's `user_view(report)`: the results it was built from, and the considerations. */
export const ReportSchema = z.object({
  schema_version: z.string(),
  core_version: z.string(),
  status: z.literal("ok"),
  locale: z.enum(["th", "en"]),
  frontal: ResultSchema,
  profile: ResultSchema.nullable(),
  consideration_intro: z.string(),
  considerations: z.array(ConsiderationSchema),
  no_considerations_note: z.string().nullable(),
  rules_version: z.string(),
  disclaimer: z.string(),
});
export type Report = z.infer<typeof ReportSchema>;

/** `/v1/report`. No token is returned. */
export const ReportResponseSchema = z.object({
  request_id: z.string(),
  status: z.literal("ok"),
  report: ReportSchema,
  versions: VersionsSchema,
});
export type ReportResponse = z.infer<typeof ReportResponseSchema>;

/** The rules version of the core's illustrative example rules. */
export const EXAMPLE_RULES_VERSION = "EXAMPLE";

// ------------------------------------------ compile-time agreement with api/openapi.json

type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;

export type _ContractChecks = [
  Assert<Extends<z.infer<typeof UploadLimitsSchema>, Schemas["UploadLimits"]>>,
  Assert<Extends<z.infer<typeof VersionsSchema>, Schemas["Versions"]>>,
  Assert<Extends<Pick<ClientConfig, "locale" | "rules_version">, Pick<Schemas["ClientConfigResponse"], "locale" | "rules_version">>>,
  Assert<Extends<Problem["code"], Schemas["Problem"]["code"]>>,
  Assert<Extends<AnalyzeResponse["status"], Schemas["AnalyzeResponse"]["status"]>>,
  Assert<Extends<ReportResponse["status"], Schemas["ReportResponse"]["status"]>>,
  // The request's field names (openapi-typescript marks fields with defaults as required).
  Assert<Extends<"frontal_token" | "profile_token" | "locale", keyof Schemas["ReportRequest"]>>,
];
