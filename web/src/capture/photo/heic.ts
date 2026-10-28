/**
 * HEIC → JPEG in the browser, for the rare phone that still hands
 * over HEIC. libheif (WebAssembly, ~2 MB) is loaded only when a HEIC file arrives.
 *
 * - Full resolution, with libheif's rotation and mirroring applied (the image as shown).
 * - JPEG quality 0.95.
 * - The focal length goes with it as `camera: {focal_px, source: "exif"}`: the JPEG has no
 *   EXIF, and focal_px is the same for the rotated image (see focal.ts).
 */
export interface Converted {
  blob: Blob;
  width: number;
  height: number;
}

export const HEIC_JPEG_QUALITY = 0.95;

export async function convertHeic(data: Uint8Array): Promise<Converted> {
  const { default: factory } = await import("libheif-js/libheif-wasm/libheif-bundle.mjs");
  const libheif = factory();
  const images = new libheif.HeifDecoder().decode(data);
  const image = images.find((i) => i.is_primary()) ?? images[0];
  if (!image) throw new Error("no image in the HEIC file");
  try {
    const width = image.get_width();
    const height = image.get_height();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2D canvas");
    const pixels = context.createImageData(width, height);
    await new Promise<void>((resolve, reject) =>
      image.display(pixels, (out) => (out ? resolve() : reject(new Error("HEIC decoding failed")))),
    );
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", HEIC_JPEG_QUALITY));
    canvas.width = canvas.height = 0; // release the canvas memory now (iOS limits)
    if (!blob) throw new Error("JPEG encoding failed");
    return { blob, width, height };
  } finally {
    for (const i of images) i.free();
  }
}
