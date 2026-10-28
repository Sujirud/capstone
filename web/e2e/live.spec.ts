/**
 * Live mode in real browsers, without a camera: MediaPipe's web runtime
 * with the site's own model and WebAssembly finds what the core's Python runtime finds in the
 * same photo (the public-domain astronaut in tests/data), which also checks how its
 * transformation matrix is read; and the live screen's introduction (axe, reflow, keyboard).
 * The camera itself: live-camera.spec.ts.
 */
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import configTh from "../fixtures/client_config.th.json" with { type: "json" };
import fixture from "../fixtures/live_gates.json" with { type: "json" };
import { expect, expectAccessible, reflows, test } from "./fixtures";

/** What the browser's detector gives for the astronaut photo (image mode). */
async function detectInBrowser(page: Page) {
  await page.goto("/");
  const png = readFileSync("../tests/data/astronaut.png").toString("base64");
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    // The app's own modules, as the dev server serves them.
    const detectorModule = "/src/capture/live/detector.ts";
    const gatesModule = "/src/capture/live/gates.ts";
    const { createFaceDetector } = await import(/* @vite-ignore */ detectorModule);
    const { poseFromMatrix } = await import(/* @vite-ignore */ gatesModule);
    const detector = await createFaceDetector("image");
    const faces = detector.detect(bitmap, 0) as Array<{ xy: number[][]; blendshapes: Record<string, number>; matrix: number[][] }>;
    detector.close();
    return { count: faces.length, face: faces[0], pose: faces[0] ? poseFromMatrix(faces[0].matrix) : null };
  }, png);
}

test("MediaPipe in the browser finds the core's landmarks, pose and expression in the same photo", async ({ page }) => {
  test.setTimeout(120_000);
  const got = await detectInBrowser(page);
  expect(got.count).toBe(1);
  const want = fixture.images.small;
  const wantPose = fixture.cases.find((c) => c.name === "small")!.expected.checks;
  const angle = (id: string) => wantPose.find((c) => c.id === id)!.value!;
  // Two runtimes of one model: close, not equal. Landmarks within 2 px of 512.
  const worst = Math.max(...want.xy.map((p, i) => Math.hypot(p[0]! - got.face!.xy[i]![0]!, p[1]! - got.face!.xy[i]![1]!)));
  expect(worst).toBeLessThan(2);
  // The matrix read column-major gives the same head pose (within 2°).
  expect(Math.abs(got.pose!.yawDeg - angle("yaw_deg"))).toBeLessThan(2);
  expect(Math.abs(got.pose!.pitchDeg - angle("pitch_deg"))).toBeLessThan(2);
  expect(Math.abs(got.pose!.rollDeg - angle("roll_deg"))).toBeLessThan(2);
  expect(Math.abs(got.face!.blendshapes.mouthSmileLeft! - want.blendshapes.mouthSmileLeft)).toBeLessThan(0.05);
});

async function toLiveIntro(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("facescan.subject", JSON.stringify({ sex: "female", age: 21 })));
  await page.goto("/#/subject");
  await page.getByRole("button", { name: "ดำเนินการต่อ" }).click();
  await page.getByRole("button", { name: "ดำเนินการต่อ" }).click();
  await expect(page.getByRole("heading", { level: 1, name: configTh.strings.capture.frontal.title })).toBeVisible();
  await page.getByRole("button", { name: "ถ่ายภาพ", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "กล้องในหน้าเว็บ" })).toBeVisible();
}

test("“Take a photo” on the guide opens the live camera, and its introduction states the limits", async ({ page }) => {
  await toLiveIntro(page);
  await expect(page.getByRole("region", { name: "ก่อนเริ่ม" }).getByRole("listitem")).toHaveCount(4);
  await expect(page.getByText("รายงานจะไม่มีหัวข้อสำหรับปรึกษา")).toBeVisible();
  await expect(page.getByRole("button", { name: "เปิดกล้อง" })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "เลือกภาพแทน" }).click();
  await expect(page.getByRole("heading", { level: 1, name: configTh.strings.capture.frontal.title })).toBeVisible();
});

test.describe("reflow at 320 px and 200 % text (WCAG 1.4.4, 1.4.10)", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test("the live camera's introduction", async ({ page }) => {
    await toLiveIntro(page);
    await reflows(page);
  });
});
