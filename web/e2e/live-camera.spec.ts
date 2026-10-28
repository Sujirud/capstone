/**
 * Live mode with a camera, in Chromium only: its fake camera plays a still
 * of the public-domain astronaut photo, enlarged 2× (fixtures/live/camera_astronaut.mjpeg), and
 * the real model, gate port and hints run on it. The photo does not pass the gates (the chin
 * is down, she smiles, and the face is small), so the core's hint shows; auto-capture is
 * covered in tests/liveScreen.test.tsx. WebKit's test browser has no camera to fake.
 */
import type { Page } from "@playwright/test";
import configTh from "../fixtures/client_config.th.json" with { type: "json" };
import { expect, expectAccessible, reflows, test } from "./fixtures";

async function startCamera(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("facescan.subject", JSON.stringify({ sex: "female", age: 21 })));
  await page.goto("/#/subject");
  await page.getByRole("button", { name: "ดำเนินการต่อ" }).click();
  await page.getByRole("button", { name: "ดำเนินการต่อ" }).click();
  await page.getByRole("button", { name: "ถ่ายภาพ", exact: true }).click();
  await page.getByRole("button", { name: "เปิดกล้อง" }).click();
}

test("the core's hint for the camera view, with the face-size and distance notices", async ({ page }) => {
  test.setTimeout(120_000);
  await startCamera(page);
  const video = page.getByLabel("ภาพจากกล้อง");
  await expect(video).toBeVisible();
  // The first failing gate in the core's order: the chin (pitch about −14°).
  await expect(page.getByTestId("live-hint")).toContainText(configTh.strings.hint.chin_up, { timeout: 60_000 });
  // The stream is the fake camera's still: 1024 × 1024, shown unmirrored (rear camera).
  expect(await video.evaluate((v: HTMLVideoElement) => [v.videoWidth, v.videoHeight, getComputedStyle(v).transform])).toEqual([1024, 1024, "none"]);
  // A 1024-px stream cannot show a face large enough at 1.5 m; no focal length without calibration.
  await expect(page.getByTestId("live-face-size")).toContainText("ที่ระยะประมาณ 1.5 เมตร");
  await expect(page.getByTestId("live-distance")).toBeVisible();
  await expectAccessible(page);
  // Screen readers hear the hint once it has held.
  await expect(page.locator("[aria-live=polite]", { hasText: configTh.strings.hint.chin_up })).toHaveCount(1, { timeout: 10_000 });
  // Leaving stops the camera: the stream's tracks end.
  const stream = await video.evaluateHandle((v: HTMLVideoElement) => v.srcObject as MediaStream);
  await page.getByRole("button", { name: "เลือกภาพแทน" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: configTh.strings.capture.frontal.title })).toBeVisible();
  expect(await stream.evaluate((s) => s.getTracks().map((t) => t.readyState))).toEqual(["ended"]);
});

test("calibration counts only frames that pass every gate", async ({ page }) => {
  test.setTimeout(120_000);
  await startCamera(page);
  await page.getByRole("button", { name: "ปรับเทียบระยะ" }).click();
  const heading = page.getByRole("heading", { level: 2, name: "ปรับเทียบระยะ" });
  await expect(heading).toBeFocused();
  await expect(page.getByText("0 จาก 30 เฟรม")).toBeVisible();
  // The astronaut does not pass (chin, smile, face size): the count stays at 0, the hint shows.
  await expect(page.getByTestId("live-hint")).toContainText(configTh.strings.hint.chin_up, { timeout: 60_000 });
  await expect(page.getByText("0 จาก 30 เฟรม")).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "ยกเลิกการปรับเทียบ" }).click();
  await expect(heading).toHaveCount(0);
});

test.describe("reflow at 320 px and 200 % text (WCAG 1.4.4, 1.4.10)", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test("the live camera running", async ({ page }) => {
    test.setTimeout(120_000);
    await startCamera(page);
    await expect(page.getByTestId("live-hint")).toContainText(configTh.strings.hint.chin_up, { timeout: 60_000 });
    await reflows(page);
  });
});
