/**
 * Image type from the file's first bytes, never from its name or declared type (the API
 * checks magic bytes the same way). HEIC is recognized so it can be
 * converted; anything else is refused.
 */
export type ImageKind = "jpeg" | "png" | "webp" | "heic";

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
const HEIF_GENERIC = new Set(["mif1", "msf1", "mif2"]);

function ascii(b: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...b.subarray(start, start + length));
}

export function sniffImage(b: Uint8Array): ImageKind | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "png";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp") {
    const size = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
    const major = ascii(b, 8, 4);
    if (HEIC_BRANDS.has(major)) return "heic";
    // Generic HEIF: HEVC-coded only if a compatible brand says so (not AVIF).
    const end = Math.min(size, b.length);
    const compatible = new Set<string>();
    for (let i = 16; i + 4 <= end; i += 4) compatible.add(ascii(b, i, 4));
    if (HEIF_GENERIC.has(major) && [...compatible].some((c) => HEIC_BRANDS.has(c)) && !compatible.has("avif")) return "heic";
  }
  return null;
}
