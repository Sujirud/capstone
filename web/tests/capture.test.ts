/**
 * Photo mode: magic bytes, header dimensions, pre-flight checks and the
 * EXIF focal port, with expected values from the core (fixtures/exif_focal.json).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import focalFixture from "../fixtures/exif_focal.json" with { type: "json" };
import configTh from "../fixtures/client_config.th.json" with { type: "json" };
import { imageSize } from "../src/capture/photo/dimensions";
import { isFrontCamera, readExif } from "../src/capture/photo/exif";
import { focalFromExif } from "../src/capture/photo/focal";
import { sniffImage } from "../src/capture/photo/magic";
import { preflight } from "../src/capture/photo/preflight";
import { WEB } from "./paths";

const fixture = (name: string): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(join(WEB, "fixtures", name)));
const limits = configTh.upload_limits;

function file(bytes: Uint8Array, name: string, type = ""): File {
  return new File([bytes as Uint8Array<ArrayBuffer>], name, { type });
}

describe("magic bytes", () => {
  it("recognizes the accepted types and HEIC, whatever the name says", () => {
    expect(sniffImage(fixture("photo.jpg"))).toBe("jpeg");
    expect(sniffImage(fixture("formats/sample_301x199.png"))).toBe("png");
    expect(sniffImage(fixture("formats/sample_304x196_lossy.webp"))).toBe("webp");
    expect(sniffImage(fixture("photo.heic"))).toBe("heic");
  });

  it("refuses everything else", () => {
    const enc = new TextEncoder();
    expect(sniffImage(enc.encode("GIF89a......"))).toBeNull();
    expect(sniffImage(enc.encode("%PDF-1.7 ...."))).toBeNull();
    expect(sniffImage(new Uint8Array([0, 0, 0, 0x1c, ...enc.encode("ftypavif"), 0, 0, 0, 0, ...enc.encode("avifmif1")]))).toBeNull();
    expect(sniffImage(new Uint8Array([0, 0, 0, 0x18, ...enc.encode("ftypmif1"), 0, 0, 0, 0, ...enc.encode("mif1heic")]))).toBe("heic");
    expect(sniffImage(new Uint8Array(0))).toBeNull();
  });
});

describe("header dimensions", () => {
  const samples = readdirSync(join(WEB, "fixtures/formats"));

  it.each(samples)("%s", (name) => {
    const [, w, h] = name.match(/_(\d+)x(\d+)/)!;
    const bytes = fixture(`formats/${name}`);
    expect(imageSize(bytes, sniffImage(bytes)!)).toEqual({ width: Number(w), height: Number(h) });
  });

  it("reads the photo and its HEIC copy", () => {
    expect(imageSize(fixture("photo.jpg"), "jpeg")).toEqual({ width: 1600, height: 1800 });
    expect(imageSize(fixture("photo.heic"), "heic")).toEqual({ width: 1600, height: 1800 });
  });

  it("gives up on truncated data instead of guessing", () => {
    expect(imageSize(fixture("photo.jpg").subarray(0, 20), "jpeg")).toBeNull();
    expect(imageSize(fixture("formats/sample_301x199.png").subarray(0, 20), "png")).toBeNull();
    expect(imageSize(fixture("photo.heic").subarray(0, 40), "heic")).toBeNull();
  });
});

describe("EXIF focal port (facescan.core.normalize.camera_from_exif)", () => {
  it.each(focalFixture.cases.map((c) => [c.name, c] as const))("%s", (_, c) => {
    const got = focalFromExif(c.tags, c.raw[0]!, c.raw[1]!);
    if (c.focal_px === null) expect(got).toBeNull();
    else expect(got).toBeCloseTo(c.focal_px, 9);
  });

  it.each(["photo.jpg", "photo.heic"])("%s: EXIF read in the browser gives the core's value", async (name) => {
    const bytes = fixture(name);
    const exif = await readExif(bytes);
    const size = imageSize(bytes, sniffImage(bytes)!)!;
    expect(focalFromExif(exif!.focal, size.width, size.height)).toBeCloseTo(focalFixture.photos["photo.jpg"]!, 9);
  });
});

describe("front camera", () => {
  it("is told by the lens model", async () => {
    expect(isFrontCamera(await readExif(fixture("photo_front.jpg")))).toBe(true);
    expect(isFrontCamera(await readExif(fixture("photo.jpg")))).toBe(false);
    expect(isFrontCamera(null)).toBe(false);
    expect(isFrontCamera({ focal: {}, lensModel: "iPhone 15 Pro front TrueDepth camera 2.69mm f/1.9" })).toBe(true);
    expect(isFrontCamera({ focal: {}, lensModel: "iPhone 15 Pro back triple camera 6.765mm f/1.78" })).toBe(false);
  });
});

describe("pre-flight", () => {
  it("passes a JPEG through unchanged, without camera (the server reads its EXIF)", async () => {
    const photo = file(fixture("photo.jpg"), "IMG_0001.JPG", "image/jpeg");
    const r = await preflight(photo, limits);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.capture.frames[0]!.blob).toBe(photo);
    expect(r.capture.frames[0]).toMatchObject({ width: 1600, height: 1800, name: "IMG_0001.JPG" });
    expect(r.capture.camera).toBeNull();
    expect(r.capture.warnings).toEqual([]);
  });

  it("warns about a front-camera photo but lets it through", async () => {
    const r = await preflight(file(fixture("photo_front.jpg"), "selfie.jpg"), limits);
    expect(r).toMatchObject({ ok: true, capture: { warnings: ["front_camera"] } });
  });

  it("refuses by magic bytes, not by name", async () => {
    const r = await preflight(file(new TextEncoder().encode("GIF89a0000000000"), "photo.jpg", "image/jpeg"), limits);
    expect(r).toEqual({ ok: false, problem: "unsupported_type" });
  });

  it("refuses files over max_image_bytes", async () => {
    const r = await preflight(file(fixture("photo.jpg"), "photo.jpg"), { ...limits, max_image_bytes: 50_000 });
    expect(r).toEqual({ ok: false, problem: "too_large" });
  });

  it("refuses more than max_pixels from the header", async () => {
    const r = await preflight(file(fixture("photo.jpg"), "photo.jpg"), { ...limits, max_pixels: 1600 * 1800 - 1 });
    expect(r).toEqual({ ok: false, problem: "too_many_pixels" });
  });

  it("refuses a header it cannot read", async () => {
    const r = await preflight(file(fixture("photo.jpg").subarray(0, 30), "photo.jpg"), limits);
    expect(r).toEqual({ ok: false, problem: "unreadable" });
  });

  it("converts HEIC and sends the focal length from its EXIF", async () => {
    const jpeg = new Blob([fixture("photo.jpg")], { type: "image/jpeg" });
    const convertHeic = vi.fn(async () => ({ blob: jpeg, width: 1600, height: 1800 }));
    const r = await preflight(file(fixture("photo.heic"), "IMG_0002.HEIC"), limits, { convertHeic });
    expect(convertHeic).toHaveBeenCalledOnce();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.capture.frames[0]).toMatchObject({ blob: jpeg, name: "IMG_0002.jpg", width: 1600, height: 1800 });
    expect(r.capture.camera?.source).toBe("exif");
    expect(r.capture.camera?.focal_px).toBeCloseTo(focalFixture.photos["photo.jpg"]!, 9);
  });

  it("checks HEIC pixels before converting, and reports a failed conversion", async () => {
    const convertHeic = vi.fn(async () => {
      throw new Error("no");
    });
    expect(await preflight(file(fixture("photo.heic"), "a.heic"), { ...limits, max_pixels: 1000 }, { convertHeic })).toEqual({
      ok: false,
      problem: "too_many_pixels",
    });
    expect(convertHeic).not.toHaveBeenCalled();
    expect(await preflight(file(fixture("photo.heic"), "a.heic"), limits, { convertHeic })).toEqual({ ok: false, problem: "heic_failed" });
  });
});
