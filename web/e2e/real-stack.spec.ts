/**
 * Real stack: the site against a running API, as the demo runs it.
 *
 *   E2E_API_URL=http://127.0.0.1:8000 pnpm e2e:real
 *
 * The test server (port 5175) forwards /v1 to E2E_API_URL, so every request goes through
 * the same-origin proxy a phone's browser uses.
 *
 * With E2E_OK_PHOTO=<path to a protocol-compliant frontal photo> (never committed), the ok
 * path runs too: results, a hairline adjustment and the overlay redraw, which the API
 * accepts only if the uploaded bytes are exactly the analyzed ones, then the
 * report from the adjusted token. With it, the
 * side photo runs as well: tests/data/profile_lathe_operator_1942.jpg → contour_failed and
 * retake, and with E2E_OK_PROFILE=<a protocol-compliant side photo of the same person, never
 * committed> the side ok path: results, the alar crease placed, and the overlay redrawn.
 *
 * Live mode's burst is sent as the app encodes it (JPEG frames from bitmaps, a calibrated
 * focal length); the API must take it as one burst.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import liveFixture from "../fixtures/live_gates.json" with { type: "json" };

test.skip(process.env.E2E_REAL_STACK !== "1", "real stack: run with pnpm e2e:real");

async function toGuide(page: import("@playwright/test").Page) {
  await page.addInitScript(() => window.localStorage.setItem("facescan.subject", JSON.stringify({ sex: "female", age: 21 })));
  await page.goto("/#/subject");
  await page.getByRole("button", { name: "ดำเนินการต่อ" }).click();
  await page.getByRole("button", { name: "ดำเนินการต่อ" }).click();
  await expect(page.getByTestId("input-camera")).toBeAttached();
}

test("client-config reaches the site and the subject form leads to the API's guide", async ({ page, request }) => {
  const direct = await request.get("/v1/client-config?locale=th");
  expect(direct.status()).toBe(200);
  expect(direct.headers()["etag"]).toBeTruthy();
  expect(direct.headers()["x-request-id"]).toMatch(/^req_/);
  const config = await direct.json();
  expect(config.rules_version).toBe("EXAMPLE");

  await page.goto("/");
  await page.getByRole("link", { name: "เริ่มต้น" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "เพศของคุณ" })).toBeVisible();
  await page.getByRole("radio", { name: "หญิง" }).click();
  await page.getByRole("button", { name: "ดำเนินการต่อ" }).click();
  await page.getByLabel("อายุ (ปี)").fill("21");
  await page.getByRole("button", { name: "ดำเนินการต่อ" }).click();
  await expect(page.getByRole("heading", { level: 1, name: config.strings.capture.frontal.title })).toBeVisible();
});

test("astronaut.png posted from the page → quality_failed with hints", async ({ page }) => {
  const image = readFileSync(join(import.meta.dirname, "../../tests/data/astronaut.png")).toString("base64");
  await page.goto("/");
  const answer = await page.evaluate(async (image) => {
    const bytes = Uint8Array.from(atob(image), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("frames", new Blob([bytes], { type: "image/png" }), "astronaut.png");
    form.append("meta", JSON.stringify({ subject: { sex: "female", age: 21 }, locale: "th" }));
    const r = await fetch("/v1/frontal/analyze", { method: "POST", body: form });
    return { status: r.status, body: await r.json() };
  }, image);
  expect(answer.status).toBe(200);
  expect(answer.body.status).toBe("quality_failed");
  expect(answer.body.hints.length).toBeGreaterThan(0);
  expect(answer.body.hints[0]).toMatch(/[฀-๿]/);
  expect(answer.body).not.toHaveProperty("result");
});

test("a live-mode burst as the app encodes and sends it, with a calibrated focal length", async ({ page }) => {
  const image = readFileSync(join(import.meta.dirname, "../../tests/data/astronaut.png")).toString("base64");
  // A focal length that puts the astronaut's face at 1.5 m (the core's iris diameter for her face).
  const iris = liveFixture.cases.find((c) => c.name === "small")!.expected.iris_px;
  const focal = (1.5 * 1000 * iris) / 11.7;
  await page.goto("/");
  const answer = await page.evaluate(
    async ({ image, focal }) => {
      const bytes = Uint8Array.from(atob(image), (c) => c.charCodeAt(0));
      const framesModule = "/src/capture/live/frames.ts";
      const captureModule = "/src/capture/CaptureSource.ts";
      const scanModule = "/src/api/scan.ts";
      const { bitmapFrame } = await import(/* @vite-ignore */ framesModule);
      const { burstCapture } = await import(/* @vite-ignore */ captureModule);
      const { frontalMeta } = await import(/* @vite-ignore */ scanModule);
      // Three frames (burst.min_frames), each encoded from a bitmap as live mode encodes video frames.
      const frames = [];
      for (let i = 0; i < 3; i++) {
        const frame = bitmapFrame(await createImageBitmap(new Blob([bytes], { type: "image/png" })));
        frames.push({ blob: await frame.encode(), name: `live-${i + 1}.jpg`, width: frame.width, height: frame.height });
        frame.close();
      }
      const capture = burstCapture(frames, { focal_px: focal, source: "calibration" });
      const meta = frontalMeta({ capture, subject: { sex: "female", age: 21 }, locale: "th", layers: ["landmarks"] });
      const form = new FormData();
      for (const f of frames) form.append("frames", f.blob, f.name);
      form.append("meta", JSON.stringify(meta));
      const r = await fetch("/v1/frontal/analyze", { method: "POST", body: form });
      return { status: r.status, meta, body: await r.json() };
    },
    { image, focal },
  );
  expect(answer.meta.camera).toEqual({ focal_px: focal, source: "calibration" });
  expect(answer.status).toBe(200);
  // The astronaut does not pass the gates, but the burst was taken as one: its frames were
  // counted, and the calibrated focal length verified the distance (no distance_unverified).
  expect(answer.body.status).toBe("quality_failed");
  expect(answer.body.failed_checks).toContain("burst_good_frames");
  expect(answer.body.failed_checks).not.toContain("camera_distance_m");
  expect(answer.body.warnings).not.toContain("distance_unverified");
});

test("profile_lathe_operator_1942.jpg posted from the page → contour_failed with hints", async ({ page }) => {
  const image = readFileSync(join(import.meta.dirname, "../../tests/data/profile_lathe_operator_1942.jpg")).toString("base64");
  await page.goto("/");
  const answer = await page.evaluate(async (image) => {
    const bytes = Uint8Array.from(atob(image), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: "image/jpeg" }), "lathe.jpg");
    // Without a frontal token the subject is required (the app always sends the token).
    form.append("meta", JSON.stringify({ facing: "right", locale: "th", subject: { sex: "female", age: 21 } }));
    const r = await fetch("/v1/profile/analyze", { method: "POST", body: form });
    return { status: r.status, body: await r.json() };
  }, image);
  expect(answer.status).toBe(200);
  expect(answer.body.status).toBe("contour_failed");
  expect(answer.body.warnings).toContain("no_frontal_scale");
  expect(answer.body.hints[0]).toMatch(/[฀-๿]/);
  expect(answer.body).not.toHaveProperty("result_token");
});

test("the capture flow: astronaut.png → retake with the core's hints", async ({ page }) => {
  await toGuide(page);
  await page.getByTestId("input-camera").setInputFiles(join(import.meta.dirname, "../../tests/data/astronaut.png"));
  await page.getByRole("button", { name: "ใช้ภาพนี้" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "กรุณาถ่ายภาพใหม่" })).toBeVisible({ timeout: 30_000 });
  const hints = await page.getByTestId("hints").getByRole("listitem").allTextContents();
  expect(hints.length).toBeGreaterThan(0);
  for (const hint of hints) expect(hint).toMatch(/[฀-๿]/);
});

test("the ok path with a real photo: results, adjust, overlay redraw", async ({ page }) => {
  const photo = process.env.E2E_OK_PHOTO;
  test.skip(!photo, "set E2E_OK_PHOTO (a protocol-compliant frontal photo, never committed)");
  await toGuide(page);
  await page.getByTestId("input-library").setInputFiles(photo!);
  await page.getByRole("button", { name: "ใช้ภาพนี้" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: "ปรับตำแหน่งจุด" }).click();
  const marker = page.getByTestId("adjust-marker");
  await marker.focus();
  await page.keyboard.press("Shift+ArrowUp");
  await page.getByRole("button", { name: "บันทึกตำแหน่ง" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" })).toBeVisible();
  // The API redrew the overlay (it refuses an image that is not the analyzed one).
  await expect(page.getByRole("img", { name: "ภาพของคุณพร้อมเส้นการวัด" })).toHaveAttribute("src", /^blob:/);
  await expect(page.getByText("ยังวาดเส้นการวัดใหม่ไม่ได้")).toHaveCount(0);
  // The report from the adjusted token, with the example rules' note.
  await page.getByRole("link", { name: "ดูรายงาน" }).click();
  await expect(page.getByTestId("example-rules")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("table", { name: "ภาพหน้าตรง" })).toBeVisible();
});

test("the side photo with a real frontal token: contour failed, then (with E2E_OK_PROFILE) results and the alar crease", async ({ page }) => {
  const photo = process.env.E2E_OK_PHOTO;
  test.skip(!photo, "set E2E_OK_PHOTO (a protocol-compliant frontal photo, never committed)");
  await toGuide(page);
  await page.getByTestId("input-library").setInputFiles(photo!);
  await page.getByRole("button", { name: "ใช้ภาพนี้" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: "เพิ่มภาพด้านข้าง" }).click();

  // A real contour_failed, sent with the frontal token: the core's hints, then retake.
  await page.getByTestId("input-library").setInputFiles(join(import.meta.dirname, "../../tests/data/profile_lathe_operator_1942.jpg"));
  await page.getByRole("button", { name: "ใช้ภาพนี้" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "กรุณาถ่ายภาพใหม่" })).toBeVisible({ timeout: 30_000 });
  for (const hint of await page.getByTestId("hints").getByRole("listitem").allTextContents()) expect(hint).toMatch(/[฀-๿]/);

  const side = process.env.E2E_OK_PROFILE;
  test.skip(!side, "set E2E_OK_PROFILE (a protocol-compliant side photo of the same person, never committed)");
  await page.getByTestId("input-library").setInputFiles(side!);
  await page.getByRole("button", { name: "ใช้ภาพนี้" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพด้านข้าง" })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("alar-prompt").getByRole("link", { name: "วางจุด" }).click();
  const surface = page.getByTestId("adjust-surface");
  await expect(surface.locator("svg")).toBeAttached();
  const box = (await surface.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByRole("button", { name: "บันทึกตำแหน่ง" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพด้านข้าง" })).toBeVisible();
  // The API redrew the overlay on the side photo as uploaded.
  await expect(page.getByRole("img", { name: "ภาพของคุณพร้อมเส้นการวัด" })).toHaveAttribute("src", /^blob:/);
  await expect(page.getByText("ยังวาดเส้นการวัดใหม่ไม่ได้")).toHaveCount(0);
  await expect(page.getByTestId("alar-prompt")).toHaveCount(0);
});
