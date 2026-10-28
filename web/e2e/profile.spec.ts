/**
 * The side-photo flow in real browsers, with the
 * API mocked from the core's fixtures: guide with the facing choice → contour failed → retake
 * → results → the alar crease placed by a tap → a silhouette point dragged (it stays on the
 * outline) → save → overlay → reset; the keyboard and the along-the-outline buttons; HEIC;
 * a language switch and an ended scan, both re-analyzing the two photos; reflow; axe.
 */
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { http } from "msw";
import configTh from "../fixtures/client_config.th.json" with { type: "json" };
import contourFailedTh from "../fixtures/profile_contour_failed.th.json" with { type: "json" };
import exifFocal from "../fixtures/exif_focal.json" with { type: "json" };
import profileAdjustedTh from "../fixtures/profile_adjusted.th.json" with { type: "json" };
import profileOkTh from "../fixtures/profile_ok.th.json" with { type: "json" };
import { makeTrack, projectOntoTrack, slideAlong, type Polyline } from "../src/components/adjust/contour";
import { MOCK_API, newCalls, problem, scanHandlers, type ScanMockOptions } from "../tests/mocks/handlers";
import { expect, expectAccessible, reflows, test } from "./fixtures";

const LAYERS = ["landmarks", "profile_lines", "labels"];
const track = makeTrack(profileOkTh.result.contour as unknown as Polyline);
const point = (id: string) => profileOkTh.result.adjustable_points.find((p) => p.id === id)!;
type Network = { use: (...h: never[]) => void };

/** Files as in-memory bytes (Chromium hides disk-backed uploads from request interception). */
async function choose(page: Page, file: string, input = "input-camera") {
  const name = file.split("/").pop()!;
  const mimeType = name.endsWith(".heic") ? "image/heic" : "image/jpeg";
  await page.getByTestId(input).setInputFiles({ name, mimeType, buffer: readFileSync(file) });
  await expect(page.getByRole("heading", { level: 1, name: "ตรวจสอบภาพ" })).toBeVisible();
}

async function send(page: Page, file: string, input = "input-camera") {
  await choose(page, file, input);
  await page.getByRole("button", { name: "ใช้ภาพนี้" }).click();
}

/** Subject → frontal photo → frontal results → the side-photo guide. */
async function toProfileGuide(page: Page, network: Network, options: ScanMockOptions = {}) {
  const calls = options.calls ?? newCalls();
  network.use(...(scanHandlers({ ...options, calls }) as never[]));
  await page.addInitScript(() => window.localStorage.setItem("facescan.subject", JSON.stringify({ sex: "female", age: 21 })));
  await page.goto("/#/subject");
  await page.getByRole("button", { name: "ดำเนินการต่อ" }).click();
  await page.getByRole("button", { name: "ดำเนินการต่อ" }).click();
  await send(page, "fixtures/photo.jpg");
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" })).toBeVisible();
  await page.getByRole("link", { name: "เพิ่มภาพด้านข้าง" }).click();
  await expect(page.getByRole("heading", { level: 1, name: configTh.strings.capture.profile.title })).toBeVisible();
  return calls;
}

async function toProfileResults(page: Page, network: Network, options: ScanMockOptions = {}) {
  const calls = await toProfileGuide(page, network, options);
  await send(page, "fixtures/profile.jpg");
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพด้านข้าง" })).toBeVisible();
  return calls;
}

/** The photo's position on screen, to turn screen points into image pixels (1000 × 1300). */
async function imageBox(page: Page) {
  return (await page.getByRole("img", { name: /สำหรับวางจุด/ }).boundingBox())!;
}

test("guide → contour failed → retake → place the alar crease → drag the nose tip → save → reset", async ({ page, network }) => {
  const calls = await toProfileGuide(page, network, { profileOutcomes: ["contour_failed", "ok"] });
  await expect(page.getByText("ขั้นที่ 3 จาก 4 · ภาพด้านข้าง")).toBeVisible();
  for (const text of configTh.strings.capture.profile.steps) await expect(page.getByText(text)).toBeVisible();
  await expect(page.getByRole("radio", { name: "ขวา" })).toBeChecked();
  await expectAccessible(page);
  await page.getByText("ซ้าย", { exact: true }).click(); // the card is the label
  await expect(page.getByRole("radio", { name: "ซ้าย" })).toBeChecked();

  await choose(page, "fixtures/profile.jpg");
  await expect(page.getByRole("radio", { name: "ซ้าย" })).toBeChecked();
  await expectAccessible(page);
  await page.getByRole("button", { name: "ใช้ภาพนี้" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "กรุณาถ่ายภาพใหม่" })).toBeVisible();
  for (const hint of contourFailedTh.hints) await expect(page.getByText(hint, { exact: true })).toBeVisible();
  await expectAccessible(page);
  expect(calls.profile[0]!.meta).toEqual({ facing: "left", locale: "th", overlay: { layers: LAYERS }, frontal_token: "fixture-token-frontal" });

  await send(page, "fixtures/profile.jpg");
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพด้านข้าง" })).toBeVisible();
  const overlay = page.getByRole("img", { name: "ภาพของคุณพร้อมเส้นการวัด" });
  await expect(overlay).toHaveJSProperty("complete", true);
  expect(await overlay.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1000);
  await expect(page.getByTestId("alar-prompt")).toBeVisible();
  await expectAccessible(page);

  // The alar crease: placed by a tap, where it was tapped.
  await page.getByTestId("alar-prompt").getByRole("link", { name: "วางจุด" }).click();
  await expect(page.getByRole("heading", { level: 2, name: point("alar_crease").name })).toBeVisible();
  await expect(page.getByTestId("adjust-surface").locator("svg")).toBeAttached();
  await expect(page.getByTestId("adjust-marker")).toHaveCount(0);
  await expectAccessible(page);
  const tip = profileOkTh.result.landmarks.pronasale;
  // On a phone the instruction comes first: bring the photo clear of the sticky action bar.
  await page.getByTestId("adjust-surface").evaluate((el) => el.scrollIntoView({ block: "center" }));
  const box = await imageBox(page);
  // Tap 60 image px behind the nose tip, level with it.
  const tap = { x: box.x + ((tip.x! - 60) / 1000) * box.width, y: box.y + (tip.y! / 1300) * box.height };
  await page.mouse.click(tap.x, tap.y);
  await expect(page.getByRole("button", { name: point("alar_crease").name })).toBeVisible();

  // The nose tip, dragged away from the face: it stays on the outline.
  await page.getByLabel("จุดที่ต้องการปรับ").selectOption(point("pronasale").name);
  await expect(page.getByTestId("adjust-track")).toBeAttached();
  const marker = page.getByRole("button", { name: point("pronasale").name });
  await marker.evaluate((el) => el.scrollIntoView({ block: "center" })); // clear of the sticky action bar
  const m = (await marker.boundingBox())!;
  const [cx, cy] = [m.x + m.width / 2, m.y + m.height / 2];
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 20, cy + 15, { steps: 4 });
  await expect(page.getByTestId("loupe")).toBeVisible();
  await page.mouse.move(cx + 40, cy + 30, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId("loupe")).toHaveCount(0);
  await page.getByRole("button", { name: "บันทึกตำแหน่ง" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพด้านข้าง" })).toBeVisible();
  const sent = calls.adjust[0] as { result_token: string; overrides: Record<string, { x: number; y: number }> };
  expect(sent.result_token).toBe("fixture-token-profile");
  expect(Object.keys(sent.overrides).sort()).toEqual(["alar_crease", "pronasale"]);
  expect(Math.abs(sent.overrides.alar_crease!.x - (tip.x! - 60))).toBeLessThan(2);
  expect(Math.abs(sent.overrides.alar_crease!.y - tip.y!)).toBeLessThan(2);
  const moved = sent.overrides.pronasale!;
  const snapped = projectOntoTrack(moved, track).point;
  expect(Math.hypot(snapped.x - moved.x, snapped.y - moved.y)).toBeLessThan(1e-6); // on the outline
  expect(moved.y).toBeGreaterThan(tip.y!); // it moved along, toward the chin
  expect(calls.overlay).toEqual([{ result_token: "fixture-token-profile-adjusted", layers: LAYERS, locale: "th" }]);
  await expect(page.getByRole("img", { name: "ภาพของคุณพร้อมเส้นการวัด" })).toHaveAttribute("src", /^blob:/);
  await expect(page.getByText(profileAdjustedTh.result.metrics.P3a_tip_projection_goode.flags[0]!.text).first()).toBeVisible();
  await expect(page.getByTestId("alar-prompt")).toHaveCount(0);

  // Reset to automatic: nothing is sent, the alar crease is unplaced again.
  await page.getByRole("link", { name: "ปรับตำแหน่งจุด" }).click();
  await page.getByRole("button", { name: "กลับไปใช้ตำแหน่งอัตโนมัติ" }).click();
  await expect(page.getByTestId("alar-prompt")).toBeVisible();
  expect(calls.adjust).toHaveLength(1);
  expect(calls.overlay).toHaveLength(1);
});

test("keyboard and buttons move a silhouette point along the outline, 1 and 10 pixels at a time", async ({ page, network }) => {
  const calls = await toProfileResults(page, network);
  await page.getByRole("link", { name: "ปรับตำแหน่งจุด" }).click();
  await page.getByLabel("จุดที่ต้องการปรับ").selectOption(point("subnasale").name);
  await page.getByRole("button", { name: point("subnasale").name }).focus();
  await page.keyboard.press("Shift+ArrowDown"); // +10 toward the chin
  await page.keyboard.press("ArrowUp"); // −1
  await page.keyboard.press("ArrowRight"); // nothing: the point only moves along the outline
  const pad = page.getByRole("group", { name: "เลื่อนตามเส้นขอบ" });
  await pad.getByRole("button", { name: "ไปทางคาง" }).tap(); // +1
  await pad.getByRole("button", { name: "ไปทางคาง" }).click(); // +1
  await pad.getByRole("button", { name: "ไปทางหน้าผาก" }).click(); // −1
  await page.getByRole("button", { name: "บันทึกตำแหน่ง" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพด้านข้าง" })).toBeVisible();
  const auto = profileOkTh.result.landmarks.subnasale;
  const expected = slideAlong({ x: auto.x!, y: auto.y! }, 10, track);
  const sent = (calls.adjust[0] as { overrides: Record<string, { x: number; y: number }> }).overrides;
  expect(Object.keys(sent)).toEqual(["subnasale"]);
  expect(sent.subnasale!.x).toBeCloseTo(expected.x, 6);
  expect(sent.subnasale!.y).toBeCloseTo(expected.y, 6);
});

test("a HEIC side photo is converted in the browser and sent with its focal length", async ({ page, network }) => {
  const calls = await toProfileGuide(page, network);
  await send(page, "fixtures/photo.heic", "input-library");
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพด้านข้าง" })).toBeVisible();
  const sent = calls.profile[0]!;
  expect(sent.image).toMatchObject({ type: "image/jpeg", name: "photo.jpg" });
  const camera = sent.meta.camera as { focal_px: number; source: string };
  expect(camera.source).toBe("exif");
  expect(camera.focal_px).toBeCloseTo(exifFocal.photos["photo.jpg"]!, 6);
  expect(sent.meta).not.toHaveProperty("subject");
});

test("switching language with side results analyzes both photos again", async ({ page, network }) => {
  const calls = await toProfileResults(page, network);
  await page.getByRole("banner").getByRole("button", { name: "English" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("วิเคราะห์ภาพเดิมทั้งสองภาพอีกครั้ง");
  await dialog.getByRole("button", { name: "เปลี่ยนภาษาและวิเคราะห์อีกครั้ง" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Side photo results" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(calls.analyze.map((c) => c.meta.locale)).toEqual(["th", "en"]);
  expect(calls.profile.map((c) => c.meta.locale)).toEqual(["th", "en"]);
});

test("a scan that ended on save analyzes both photos again", async ({ page, network }) => {
  const calls = await toProfileResults(page, network);
  network.use(http.post(`${MOCK_API}/v1/adjust`, () => problem("token_stale", 400)) as never);
  await page.getByRole("link", { name: "ปรับตำแหน่งจุด" }).click();
  await page.getByRole("button", { name: point("trichion").name }).focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("button", { name: "บันทึกตำแหน่ง" }).click();
  const panel = page.getByTestId("scan-error");
  await expect(panel).toContainText("การวัดครั้งนี้สิ้นสุดแล้ว");
  await expectAccessible(page);
  await panel.getByRole("button", { name: "วิเคราะห์ภาพเดิมทั้งสองภาพอีกครั้ง" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพด้านข้าง" })).toBeVisible();
  expect(calls.analyze).toHaveLength(2);
  expect(calls.profile).toHaveLength(2);
});

test.describe("reflow at 320 px and 200 % text (WCAG 1.4.4, 1.4.10)", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test("side guide, preview, retake, results and adjust", async ({ page, network }) => {
    await toProfileGuide(page, network, { profileOutcomes: ["contour_failed", "ok"] });
    await reflows(page);
    await choose(page, "fixtures/profile.jpg");
    await reflows(page);
    await page.getByRole("button", { name: "ใช้ภาพนี้" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "กรุณาถ่ายภาพใหม่" })).toBeVisible();
    await reflows(page);
    await send(page, "fixtures/profile.jpg");
    await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพด้านข้าง" })).toBeVisible();
    await reflows(page);
    await page.getByRole("link", { name: "ปรับตำแหน่งจุด" }).click();
    await expect(page.getByTestId("adjust-marker")).toBeVisible();
    await reflows(page);
  });
});
