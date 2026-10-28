/**
 * The few EXIF fields the web app reads (exifr, only these tags): the focal-length tags for
 * the HEIC port, and the lens model to tell a front-camera photo.
 */
import exifr from "exifr";
import type { FocalTags } from "./focal";

export interface ExifInfo {
  focal: FocalTags;
  lensModel: string | null;
}

const PICK = [
  "FocalLengthIn35mmFormat",
  "FocalLength",
  "FocalPlaneXResolution",
  "FocalPlaneResolutionUnit",
  "ExifImageWidth",
  "LensModel",
];

export async function readExif(data: ArrayBuffer | Uint8Array): Promise<ExifInfo | null> {
  let tags: Record<string, unknown> | undefined;
  try {
    tags = await exifr.parse(data, { pick: PICK, translateValues: false, reviveValues: false });
  } catch {
    return null; // unreadable EXIF never blocks a photo; the server decides what it can use
  }
  if (!tags) return null;
  const n = (k: string) => (typeof tags[k] === "number" ? (tags[k] as number) : null);
  return {
    focal: {
      FocalLengthIn35mmFormat: n("FocalLengthIn35mmFormat"),
      FocalLength: n("FocalLength"),
      FocalPlaneXResolution: n("FocalPlaneXResolution"),
      FocalPlaneResolutionUnit: n("FocalPlaneResolutionUnit"),
      ExifImageWidth: n("ExifImageWidth"),
    },
    lensModel: typeof tags.LensModel === "string" ? tags.LensModel : null,
  };
}

/**
 * Phones name the lens in EXIF: "iPhone 15 Pro front TrueDepth camera 2.69mm f/1.9",
 * "Pixel 8 front camera". A front-camera photo may be mirrored, which swaps left and right.
 */
export function isFrontCamera(exif: ExifInfo | null): boolean {
  return exif?.lensModel !== null && exif?.lensModel !== undefined && /\bfront\b/i.test(exif.lensModel);
}
