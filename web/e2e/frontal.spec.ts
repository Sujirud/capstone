/**
 * The frontal photo flow in real browsers, with the API mocked from
 * the core's fixtures: failed capture → retake → ok → adjust (drag, loupe) → save → overlay
 * → reset; HEIC in the browser; language switch; an ended scan; 429, 503, 504; axe.
 */
import type { Page } from "@playwright/test";
import { delay, http } from "msw";
import configEn from "../fixtures/client_config.en.json" with { type: "json" };
import configTh from "../fixtures/client_config.th.json" with { type: "json" };
import adjustedTh from "../fixtures/frontal_adjusted.th.json" with { type: "json" };
import exifFocal from "../fixtures/exif_focal.json" with { type: "json" };
import failedTh from "../fixtures/frontal_quality_failed.th.json" with { type: "json" };
import { MOCK_API, newCalls, problem, scanHandlers, type ScanMockOptions } from "../tests/mocks/handlers";
import { expect, expectAccessible, reflows, test } from "./fixtures";

const LAYERS = ["landmarks", "thirds", "fifths", "eyes_brows", "nose_lips", "labels"];

/**
 * Playwright's WebKit interception passes multipart fields but not the bytes of Blob parts,
 * so byte-level checks of uploads run in Chromium; WebKit's own XHR sends them (the
 * real-stack tests check that against the API).
 */
const bytesVisible = (browserName: string) => browserName === "chromium";

async function startScan(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("facescan.subject", JSON.stringify({ sex: "female", age: 21 })));
  await page.goto("/#/subject");
  await page.getByRole("button", { name: "ดำเนินการต่อ" }).click();
  await page.getByRole("button", { name: "ดำเนินการต่อ" }).click();
  await expect(page.getByRole("heading", { level: 1, name: configTh.strings.capture.frontal.title })).toBeVisible();
}

/**
 * The photo as in-memory bytes: Chromium does not show the contents of disk-backed file
 * uploads to Playwright's request interception, so the mocks would see an empty frame.
 */
async function sendPhoto(page: Page, file = "fixtures/photo.jpg", input = "input-camera") {
  const { readFileSync } = await import("node:fs");
  const name = file.split("/").pop()!;
  const mimeType = name.endsWith(".heic") ? "image/heic" : "image/jpeg";
  await page.getByTestId(input).setInputFiles({ name, mimeType, buffer: readFileSync(file) });
  await expect(page.getByRole("heading", { level: 1, name: "ตรวจสอบภาพ" })).toBeVisible();
  await page.getByRole("button", { name: "ใช้ภาพนี้" }).click();
}

async function toResults(page: Page, network: { use: (...h: never[]) => void }, options: ScanMockOptions = {}) {
  const calls = options.calls ?? newCalls();
  network.use(...(scanHandlers({ ...options, calls }) as never[]));
  await startScan(page);
  await sendPhoto(page);
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" })).toBeVisible();
  return calls;
}

test("failed capture → retake → results → drag the hairline → save → reset", async ({ page, network, browserName }) => {
  const calls = newCalls();
  network.use(...(scanHandlers({ outcomes: ["quality_failed", "ok"], calls }) as never[]));
  await startScan(page);
  await expectAccessible(page);

  await sendPhoto(page);
  await expect(page.getByRole("heading", { level: 1, name: "กรุณาถ่ายภาพใหม่" })).toBeVisible();
  for (const hint of failedTh.hints) await expect(page.getByText(hint, { exact: true })).toBeVisible();
  await expectAccessible(page);
  expect(calls.analyze[0]!.meta).toEqual({ subject: { sex: "female", age: 21 }, locale: "th", overlay: { layers: LAYERS } });
  // The file is sent unchanged: the same size and JPEG header.
  expect(calls.analyze[0]!.frames[0]).toMatchObject({ name: "photo.jpg", type: "image/jpeg" });
  if (bytesVisible(browserName)) {
    const size = (await import("node:fs")).statSync("fixtures/photo.jpg").size;
    expect(calls.analyze[0]!.frames[0]).toMatchObject({ size, head: [0xff, 0xd8, 0xff, 0xe0] });
  }

  await sendPhoto(page);
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" })).toBeVisible();
  const overlay = page.getByRole("img", { name: "ภาพของคุณพร้อมเส้นการวัด" });
  await expect(overlay).toHaveJSProperty("complete", true);
  expect(await overlay.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expectAccessible(page);

  // Zoom inside the viewer, and the original photo.
  const viewer = page.getByTestId("photo-viewer");
  await page.getByRole("button", { name: "ขยาย" }).first().click();
  await expect(viewer.locator("div").first()).toHaveAttribute("style", /scale\(1\.6\)/);
  await page.getByRole("radio", { name: "ภาพต้นฉบับ" }).click();
  await expect(page.getByRole("img", { name: "ภาพของคุณ", exact: true })).toBeVisible();

  // Adjust: the real image loads (natural size checked), drag with the loupe.
  await page.getByRole("link", { name: "ปรับตำแหน่งจุด" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "ปรับตำแหน่งจุด" })).toBeVisible();
  const marker = page.getByTestId("adjust-marker");
  await expect(marker).toBeVisible();
  await expectAccessible(page);
  const box = (await marker.boundingBox())!;
  // Taken 12 px right of the handle's centre: the point keeps that offset and moves only
  // as the pointer moves (straight up here), without jumping under it.
  const [cx, cy] = [box.x + box.width / 2 + 12, box.y + box.height / 2];
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 20, { steps: 4 });
  await expect(page.getByTestId("loupe")).toBeVisible();
  await page.mouse.move(cx, cy - 40, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId("loupe")).toHaveCount(0);
  await page.getByRole("button", { name: "บันทึกตำแหน่ง" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" })).toBeVisible();
  expect(calls.adjust).toHaveLength(1);
  const moved = (calls.adjust[0] as { overrides: { trichion: { x: number; y: number } } }).overrides.trichion;
  expect(Object.keys(moved).sort()).toEqual(["x", "y"]); // never a source
  expect(moved.y).toBeLessThan(540);
  expect(Math.abs(moved.x - 800)).toBeLessThan(3);
  expect(calls.overlay).toEqual([{ result_token: "fixture-token-frontal-adjusted", layers: LAYERS, locale: "th" }]);
  await expect(page.getByText(adjustedTh.result.metrics.F1_upper_third.flags[0]!.text).first()).toBeVisible();
  await expect(page.getByRole("img", { name: "ภาพของคุณพร้อมเส้นการวัด" })).toHaveAttribute("src", /^blob:/);

  // Reset to automatic: nothing is sent.
  await page.getByRole("link", { name: "ปรับตำแหน่งจุด" }).click();
  await page.getByRole("button", { name: "กลับไปใช้ตำแหน่งอัตโนมัติ" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" })).toBeVisible();
  await expect(page.getByText(adjustedTh.result.metrics.F1_upper_third.flags[0]!.text)).toHaveCount(0);
  expect(calls.adjust).toHaveLength(1);
  expect(calls.overlay).toHaveLength(1);
});

test("the preview and the analyzing screen pass axe and reflow", async ({ page, network }) => {
  network.use(...(scanHandlers() as never[]));
  await startScan(page);
  // Held at "analyzing": the service does not answer.
  network.use(http.post(`${MOCK_API}/v1/frontal/analyze`, () => delay("infinite")) as never);
  const { readFileSync } = await import("node:fs");
  await page.getByTestId("input-camera").setInputFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: readFileSync("fixtures/photo.jpg") });
  await expect(page.getByRole("heading", { level: 1, name: "ตรวจสอบภาพ" })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "ใช้ภาพนี้" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "กำลังส่งและวิเคราะห์ภาพ" })).toBeVisible();
  await expect(page.getByText(/กำลังอัปโหลด|กำลังวิเคราะห์ภาพ/).first()).toBeVisible();
  await expectAccessible(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await reflows(page);
});

test("keyboard nudging moves the point by 1 and 10 pixels, the arrow buttons by 1", async ({ page, network }) => {
  const calls = await toResults(page, network);
  await page.getByRole("link", { name: "ปรับตำแหน่งจุด" }).click();
  const marker = page.getByTestId("adjust-marker");
  await marker.focus();
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowLeft");
  // The arrow buttons: a touch tap and a mouse click, one image pixel each.
  const pad = page.getByRole("group", { name: "เลื่อนจุด" });
  await pad.getByRole("button", { name: "ขวา" }).tap();
  await pad.getByRole("button", { name: "ขวา" }).click();
  await pad.getByRole("button", { name: "ลง" }).tap();
  await page.getByRole("button", { name: "บันทึกตำแหน่ง" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" })).toBeVisible();
  expect(calls.adjust[0]).toMatchObject({ overrides: { trichion: { x: 801, y: 540 } } });
});

test("a HEIC photo is converted in the browser and sent with its focal length", async ({ page, network, browserName }) => {
  const calls = newCalls();
  network.use(...(scanHandlers({ calls }) as never[]));
  await startScan(page);
  await sendPhoto(page, "fixtures/photo.heic", "input-library");
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" })).toBeVisible();
  const sent = calls.analyze[0]!;
  expect(sent.frames[0]).toMatchObject({ type: "image/jpeg", name: "photo.jpg" });
  if (bytesVisible(browserName)) expect(sent.frames[0]!.head.slice(0, 3)).toEqual([0xff, 0xd8, 0xff]);
  const camera = sent.meta.camera as { focal_px: number; source: string };
  expect(camera.source).toBe("exif");
  expect(camera.focal_px).toBeCloseTo(exifFocal.photos["photo.jpg"]!, 6);
});

test("switching language with results analyzes the photo again", async ({ page, network }) => {
  const calls = await toResults(page, network);
  await page.getByRole("banner").getByRole("button", { name: "English" }).click();
  const dialog = page.getByRole("dialog", { name: "เปลี่ยนเป็น English หรือไม่" });
  await expect(dialog).toBeVisible();
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "เปลี่ยนภาษาและวิเคราะห์อีกครั้ง" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Front photo results" })).toBeVisible();
  await expect.poll(() => calls.analyze.map((c) => c.meta.locale)).toEqual(["th", "en"]);
  await expect(page.getByText(configEn.strings.reference.canon).first()).toBeVisible();
});

test("a language switch whose re-analysis fails leaves the scan and the interface in Thai", async ({ page, network }) => {
  const calls = await toResults(page, network);
  let answers = 0;
  network.use(http.post(`${MOCK_API}/v1/frontal/analyze`, () => (++answers === 1 ? problem("internal_error", 500) : undefined)) as never);
  await page.getByRole("banner").getByRole("button", { name: "English" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "เปลี่ยนภาษาและวิเคราะห์อีกครั้ง" }).click();
  const panel = page.getByTestId("scan-error");
  await expect(panel).toContainText("เกิดข้อผิดพลาดที่ไม่คาดคิด");
  await expect(page.locator("html")).toHaveAttribute("lang", "th");
  await expect(page.getByRole("heading", { level: 1, name: "กำลังส่งและวิเคราะห์ภาพ" })).toBeVisible();
  // Trying again still asks for English; the interface follows once the service answers.
  await panel.getByRole("button", { name: "ลองอีกครั้ง" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Front photo results" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(calls.analyze.map((c) => c.meta.locale)).toEqual(["th", "en"]);
});

test("keeping the language leaves the scan as it is", async ({ page, network }) => {
  const calls = await toResults(page, network);
  await page.getByRole("banner").getByRole("button", { name: "English" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "ใช้ภาษาเดิมต่อ" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" })).toBeVisible();
  expect(calls.analyze).toHaveLength(1);
});

test("a scan that ended on save (a new service version): analyze the same photo again", async ({ page, network }) => {
  const calls = await toResults(page, network);
  network.use(http.post(`${MOCK_API}/v1/adjust`, () => problem("token_stale", 400)));
  await page.getByRole("link", { name: "ปรับตำแหน่งจุด" }).click();
  await page.getByTestId("adjust-marker").focus();
  await page.keyboard.press("ArrowUp");
  await page.getByRole("button", { name: "บันทึกตำแหน่ง" }).click();
  const panel = page.getByTestId("scan-error");
  await expect(panel).toContainText("การวัดครั้งนี้สิ้นสุดแล้ว");
  await expect(panel.getByRole("button", { name: "เริ่มใหม่" })).toBeVisible();
  await panel.getByRole("button", { name: "วิเคราะห์ภาพเดิมอีกครั้ง" }).click();
  await expect.poll(() => calls.analyze.length).toBe(2);
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" })).toBeVisible();
});

test.describe("errors", () => {
  async function failing(page: Page, network: { use: (...h: never[]) => void }, code: string, status: number, retryAfter?: number) {
    network.use(...(scanHandlers() as never[]));
    await startScan(page);
    network.use(http.post(`${MOCK_API}/v1/frontal/analyze`, () => problem(code, status, { retryAfter })) as never);
    await sendPhoto(page);
    return page.getByTestId("scan-error");
  }

  test("429: says when, and the retry waits", async ({ page, network }) => {
    const panel = await failing(page, network, "rate_limited", 429, 600);
    await expect(panel).toContainText("กรุณาลองอีกครั้งในอีกประมาณ 10 นาที");
    await expect(panel.getByRole("button", { name: "ลองอีกครั้ง" })).toBeDisabled();
    await expectAccessible(page);
  });

  test("503: retried once automatically", async ({ page, network }) => {
    const calls = newCalls();
    network.use(...(scanHandlers({ calls }) as never[]));
    await startScan(page);
    let busy = 0;
    network.use(
      http.post(`${MOCK_API}/v1/frontal/analyze`, () => {
        busy += 1;
        return busy === 1 ? problem("overloaded", 503, { retryAfter: 1 }) : undefined;
      }) as never,
    );
    await sendPhoto(page);
    await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" })).toBeVisible();
    expect(busy).toBe(2);
    expect(calls.analyze).toHaveLength(1);
  });

  test("504: took too long, one retry offered, then another photo", async ({ page, network }) => {
    const panel = await failing(page, network, "analysis_timeout", 504);
    await expect(panel).toContainText("การวิเคราะห์ใช้เวลานานเกินไป");
    await panel.getByRole("button", { name: "ลองอีกครั้ง" }).click();
    await expect(page.getByTestId("scan-error").getByRole("button", { name: "ลองอีกครั้ง" })).toHaveCount(0);
    await expect(page.getByTestId("scan-error").getByRole("button", { name: "ถ่ายใหม่" })).toBeVisible();
  });
});

test.describe("reflow at 320 px and 200 % text (WCAG 1.4.4, 1.4.10)", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test("guide, preview, retake, results and adjust", async ({ page, network }) => {
    network.use(...(scanHandlers({ outcomes: ["quality_failed", "ok"] }) as never[]));
    await startScan(page);
    await reflows(page);
    const { readFileSync } = await import("node:fs");
    await page.getByTestId("input-camera").setInputFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: readFileSync("fixtures/photo.jpg") });
    await expect(page.getByRole("heading", { level: 1, name: "ตรวจสอบภาพ" })).toBeVisible();
    await reflows(page);
    await page.getByRole("button", { name: "ใช้ภาพนี้" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "กรุณาถ่ายภาพใหม่" })).toBeVisible();
    await reflows(page);
    await sendPhoto(page);
    await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" })).toBeVisible();
    await reflows(page);
    await page.getByRole("link", { name: "ปรับตำแหน่งจุด" }).click();
    await expect(page.getByTestId("adjust-marker")).toBeVisible();
    await reflows(page);
  });
});

test("leaving the page with results asks first", async ({ page, network, browserName }) => {
  test.skip(browserName === "webkit", "Playwright's WebKit hangs on page.close({ runBeforeUnload: true })");
  await toResults(page, network);
  const dialog = new Promise<string>((resolve) =>
    page.once("dialog", (d) => {
      resolve(d.type());
      void d.dismiss();
    }),
  );
  await page.close({ runBeforeUnload: true });
  expect(await dialog).toBe("beforeunload");
});

test("a new scan asks, then clears the photo and results", async ({ page, network }) => {
  await toResults(page, network);
  await page.getByRole("button", { name: "เริ่มการวัดใหม่" }).click();
  const dialog = page.getByRole("dialog", { name: "เริ่มการวัดใหม่หรือไม่" });
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "เริ่มใหม่" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "เพศของคุณ" })).toBeVisible();
  await page.goto("/#/scan/frontal/result");
  await expect(page.getByRole("heading", { level: 1, name: "เพศของคุณ" })).toBeVisible();
});
