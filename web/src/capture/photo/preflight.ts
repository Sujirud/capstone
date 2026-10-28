/**
 * Pre-flight checks before an upload, with client-config's
 * `upload_limits`. Each failure has its own message:
 *
 * - the type from magic bytes: JPEG, PNG or WebP; HEIC is converted; anything else refused;
 * - the file size (for HEIC: the converted JPEG's size);
 * - the pixel count, from the header, before anything is decoded;
 * - a front-camera photo is a warning only: it may be mirrored.
 *
 * The file itself is uploaded unchanged.
 */
import type { UploadLimits } from "../../api/schemas";
import { singlePhoto, type Capture, type CaptureWarning } from "../CaptureSource";
import { imageSize } from "./dimensions";
import { isFrontCamera, readExif } from "./exif";
import { focalFromExif } from "./focal";
import { sniffImage } from "./magic";

export type PreflightProblem = "unsupported_type" | "too_large" | "too_many_pixels" | "unreadable" | "heic_failed";

export type PreflightResult = { ok: true; capture: Capture } | { ok: false; problem: PreflightProblem };

export interface PreflightDeps {
  convertHeic(data: Uint8Array): Promise<{ blob: Blob; width: number; height: number }>;
}

const defaultDeps: PreflightDeps = {
  convertHeic: async (data) => (await import("./heic")).convertHeic(data),
};

function baseName(name: string): string {
  return name.replace(/\.[^./]+$/, "") || "photo";
}

export async function preflight(file: Blob & { name?: string }, limits: UploadLimits, deps: PreflightDeps = defaultDeps): Promise<PreflightResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(bytes.subarray(0, 64));
  if (kind === null) return { ok: false, problem: "unsupported_type" };
  if (kind !== "heic" && file.size > limits.max_image_bytes) return { ok: false, problem: "too_large" };
  const size = imageSize(bytes, kind);
  if (size === null || size.width < 1 || size.height < 1) return { ok: false, problem: "unreadable" };
  if (size.width * size.height > limits.max_pixels) return { ok: false, problem: "too_many_pixels" };

  const exif = await readExif(bytes);
  const warnings: CaptureWarning[] = isFrontCamera(exif) ? ["front_camera"] : [];
  const name = file.name ?? "photo";

  if (kind !== "heic") {
    return { ok: true, capture: singlePhoto({ blob: file, name, width: size.width, height: size.height }, null, warnings) };
  }
  let converted: { blob: Blob; width: number; height: number };
  try {
    converted = await deps.convertHeic(bytes);
  } catch {
    return { ok: false, problem: "heic_failed" };
  }
  if (converted.blob.size > limits.max_image_bytes) return { ok: false, problem: "too_large" };
  // ispe is the stored size: the port's raw dimensions (rotation does not change focal_px).
  const focal = exif ? focalFromExif(exif.focal, size.width, size.height) : null;
  return {
    ok: true,
    capture: singlePhoto(
      { blob: converted.blob, name: `${baseName(name)}.jpg`, width: converted.width, height: converted.height },
      focal === null ? null : { focal_px: focal, source: "exif" },
      warnings,
    ),
  };
}
