/**
 * Pixel dimensions from the file header, without decoding the image (the pixel cap is
 * checked before anything is decoded). Rotation does not change the
 * pixel count, so the stored dimensions are enough.
 */
import type { ImageKind } from "./magic";

export interface Size {
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

/** SOF markers carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) do not. */
function isSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegSize(b: Uint8Array): Size | null {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    while (b[i + 1] === 0xff) i += 1; // fill bytes
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // image data before any frame header
    const length = u16be(b, i + 2);
    if (isSof(marker)) {
      if (i + 9 > b.length) return null;
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

function pngSize(b: Uint8Array): Size | null {
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function webpSize(b: Uint8Array): Size | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  return null;
}

interface Box {
  type: string;
  start: number; // payload start
  end: number;
}

function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  let i = start;
  while (i + 8 <= end) {
    let size = u32be(b, i);
    const type = ascii(b, i + 4, 4);
    let header = 8;
    if (size === 1) {
      if (i + 16 > end) return;
      size = u32be(b, i + 8) * 2 ** 32 + u32be(b, i + 12);
      header = 16;
    } else if (size === 0) {
      size = end - i;
    }
    if (size < header || i + size > end) return;
    yield { type, start: i + header, end: i + size };
    i += size;
  }
}

/**
 * HEIF: the `ispe` (image spatial extent) properties in meta/iprp/ipco. The primary image
 * (a grid of tiles on phones) is the largest; tiles and thumbnails are smaller. `ispe` is
 * the stored size, before any rotation (`irot`).
 */
function heicSize(b: Uint8Array): Size | null {
  for (const top of boxes(b, 0, b.length)) {
    if (top.type !== "meta") continue;
    for (const meta of boxes(b, top.start + 4, top.end)) {
      if (meta.type !== "iprp") continue;
      for (const iprp of boxes(b, meta.start, meta.end)) {
        if (iprp.type !== "ipco") continue;
        let best: Size | null = null;
        for (const prop of boxes(b, iprp.start, iprp.end)) {
          if (prop.type !== "ispe" || prop.start + 12 > prop.end) continue;
          const size = { width: u32be(b, prop.start + 4), height: u32be(b, prop.start + 8) };
          if (!best || size.width * size.height > best.width * best.height) best = size;
        }
        return best;
      }
    }
  }
  return null;
}

export function imageSize(b: Uint8Array, kind: ImageKind): Size | null {
  switch (kind) {
    case "jpeg":
      return jpegSize(b);
    case "png":
      return pngSize(b);
    case "webp":
      return webpSize(b);
    case "heic":
      return heicSize(b);
  }
}
