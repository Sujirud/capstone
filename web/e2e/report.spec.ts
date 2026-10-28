/**
 * Milestone 4 in real browsers, with the API mocked from
 * the real core's and API's fixtures: the whole scan from the landing page to the report,
 * the printed report (A4, no navigation or buttons), the landing and method pages, axe,
 * reflow and the keyboard.
 */
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import configTh from "../fixtures/client_config.th.json" with { type: "json" };
import reportOkTh from "../fixtures/report_ok.th.json" with { type: "json" };
import { newCalls, scanHandlers, type ScanMockOptions } from "../tests/mocks/handlers";
import { expect, expectAccessible, reflows, test } from "./fixtures";

type Network = { use: (...h: never[]) => void };

async function send(page: Page, file: string) {
  await page.getByTestId("input-camera").setInputFiles({ name: file.split("/").pop()!, mimeType: "image/jpeg", buffer: readFileSync(file) });
  await expect(page.getByRole("heading", { level: 1, name: "ตรวจสอบภาพ" })).toBeVisible();
  await page.getByRole("button", { name: "ใช้ภาพนี้" }).click();
}

/** Landing → subject → frontal → side → report, with the default outcomes. */
async function toReport(page: Page, network: Network, options: ScanMockOptions = {}) {
  const calls = options.calls ?? newCalls();
  network.use(...(scanHandlers({ ...options, calls }) as never[]));
  await page.addInitScript(() => window.localStorage.setItem("facescan.subject", JSON.stringify({ sex: "female", age: 21 })));
  await page.goto("/");
  await page.getByRole("link", { name: "เริ่มต้น" }).click();
  await page.getByRole("button", { name: "ดำเนินการต่อ" }).click();
  await page.getByRole("button", { name: "ดำเนินการต่อ" }).click();
  await send(page, "fixtures/photo.jpg");
  await page.getByRole("link", { name: "เพิ่มภาพด้านข้าง" }).click();
  await send(page, "fixtures/profile.jpg");
  await page.getByRole("link", { name: "ดูรายงาน" }).click();
  await expect(page.getByTestId("example-rules")).toBeVisible();
  return calls;
}

test("the whole scan: failed frontal → retake → adjust → reset → side photo → adjust → report", async ({ page, network }) => {
  const calls = newCalls();
  network.use(...(scanHandlers({ outcomes: ["quality_failed", "ok"], calls }) as never[]));
  await page.addInitScript(() => window.localStorage.setItem("facescan.subject", JSON.stringify({ sex: "female", age: 21 })));
  await page.goto("/");
  await expectAccessible(page);
  await page.getByRole("link", { name: "เริ่มต้น" }).click();
  await page.getByRole("button", { name: "ดำเนินการต่อ" }).click();
  await page.getByRole("button", { name: "ดำเนินการต่อ" }).click();
  await expect(page.getByRole("heading", { level: 1, name: configTh.strings.capture.frontal.title })).toBeVisible();

  // Frontal: failed, retaken, adjusted (overlay redrawn), then reset to automatic.
  await send(page, "fixtures/photo.jpg");
  await expect(page.getByRole("heading", { level: 1, name: "กรุณาถ่ายภาพใหม่" })).toBeVisible();
  await send(page, "fixtures/photo.jpg");
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" })).toBeVisible();
  await page.getByRole("link", { name: "ปรับตำแหน่งจุด" }).click();
  await page.getByTestId("adjust-marker").focus();
  await page.keyboard.press("Shift+ArrowUp");
  await page.getByRole("button", { name: "บันทึกตำแหน่ง" }).click();
  await expect(page.getByRole("img", { name: "ภาพของคุณพร้อมเส้นการวัด" })).toHaveAttribute("src", /^blob:/);
  await page.getByRole("link", { name: "ปรับตำแหน่งจุด" }).click();
  await page.getByRole("button", { name: "กลับไปใช้ตำแหน่งอัตโนมัติ" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" })).toBeVisible();

  // Side photo: adjusted (the alar crease placed with the keyboard-free tap).
  await page.getByRole("link", { name: "เพิ่มภาพด้านข้าง" }).click();
  await send(page, "fixtures/profile.jpg");
  await expect(page.getByRole("heading", { level: 1, name: "ผลการวัดภาพด้านข้าง" })).toBeVisible();
  await page.getByTestId("alar-prompt").getByRole("link", { name: "วางจุด" }).click();
  const surface = page.getByTestId("adjust-surface");
  await expect(surface.locator("svg")).toBeAttached();
  await surface.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const box = (await surface.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.45);
  await page.getByRole("button", { name: "บันทึกตำแหน่ง" }).click();
  await expect(page.getByTestId("alar-prompt")).toHaveCount(0);

  // The report: the latest tokens (the frontal reset, the side adjusted).
  await page.getByRole("link", { name: "ดูรายงาน" }).click();
  await expect(page.getByText("ขั้นที่ 4 จาก 4 · รายงาน")).toBeVisible();
  await expect(page.getByTestId("example-rules")).toBeVisible();
  expect(calls.report).toEqual([
    { frontal_token: "fixture-token-frontal", profile_token: "fixture-token-profile-adjusted", locale: "th" },
  ]);
  const c = reportOkTh.report.considerations[0]!;
  await expect(page.getByRole("heading", { level: 2, name: reportOkTh.report.consideration_intro })).toBeVisible();
  await expect(page.getByRole("article", { name: c.area_text })).toContainText(c.finding);
  await expect(page.getByRole("table", { name: "ภาพหน้าตรง" })).toBeVisible();
  await expect(page.getByRole("table", { name: "ภาพด้านข้าง" })).toBeVisible();
  for (const img of await page.getByRole("img", { name: "ภาพของคุณพร้อมเส้นการวัด" }).all()) {
    await expect(img).toHaveJSProperty("complete", true);
  }
  await expectAccessible(page);
});

test("the printed report: A4, black on white, no navigation or buttons, disclaimer last", async ({ page, network, browserName }) => {
  await toReport(page, network);
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("banner")).toBeHidden();
  for (const button of await page.getByRole("button").all()) await expect(button).toBeHidden();
  await expect(page.getByRole("link", { name: "วิธีการวัด" })).toBeHidden();
  // The header: the scan's date and the versions; the photos, the tables, the disclaimer.
  await expect(page.getByText(/API 0\.1\.0 · core 0\.1\.0 · schema 2\.0/).first()).toBeVisible();
  await expect(page.getByRole("img", { name: "ภาพของคุณพร้อมเส้นการวัด" })).toHaveCount(2);
  await expect(page.getByRole("table")).toHaveCount(2);
  // In print, every column is shown; the shared reference label heads its column.
  await expect(page.getByRole("columnheader", { name: configTh.strings.reference.canon }).first()).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "สถานะ" }).first()).toBeVisible();
  const colors = await page.evaluate(() => {
    const s = getComputedStyle(document.body);
    const accent = document.querySelector(".text-accent");
    return { bg: getComputedStyle(document.documentElement).backgroundColor, text: s.color, accent: accent && getComputedStyle(accent).color, weight: accent && getComputedStyle(accent).fontWeight };
  });
  expect(colors).toEqual({ bg: "rgb(255, 255, 255)", text: "rgb(0, 0, 0)", accent: "rgb(0, 0, 0)", weight: "600" });
  const last = await page.locator("main").evaluate((main) => {
    const visible = Array.from(main.querySelectorAll("p, li, td, th, h1, h2, h3")).filter((el) => (el as HTMLElement).offsetParent !== null);
    return visible.at(-1)?.textContent;
  });
  expect(last).toBe(reportOkTh.report.disclaimer);
  if (browserName === "chromium") {
    // The page size comes from the stylesheet's @page: A4 (595 × 842 pt).
    const pdf = (await page.pdf({ preferCSSPageSize: true, printBackground: true })).toString("latin1");
    const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf)!;
    expect(Math.round(Number(box[1]))).toBe(595);
    expect(Math.round(Number(box[2]))).toBe(842);
  }
});

test("the method page is linked from the landing page and the results, with the core's words", async ({ page, network }) => {
  await toReport(page, network);
  await page.getByRole("link", { name: "วิธีการวัด" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "วิธีการวัด" })).toBeVisible();
  await expect(page.getByText(`“${configTh.strings.status.inconclusive}”`, { exact: false })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "ย้อนกลับ" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "รายงาน" })).toBeVisible();
});

test("keyboard only: from the landing page to the subject form", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "Safari and WebKit skip links on Tab unless full keyboard access is on");
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "วัดสัดส่วนใบหน้า" })).toBeVisible();
  // Skip link, then the method link in the page, then Start in the action bar (in view).
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "ข้ามไปยังเนื้อหาหลัก" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "วิธีการวัด" })).toBeFocused();
  await page.keyboard.press("Tab");
  const start = page.getByRole("link", { name: "เริ่มต้น" });
  await expect(start).toBeFocused();
  await expect(start).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "เพศของคุณ" })).toBeFocused();
});

test.describe("reflow at 320 px and 200 % text (WCAG 1.4.4, 1.4.10)", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test("landing, method and report", async ({ page, network }) => {
    await toReport(page, network);
    await reflows(page);
    await page.goto("/#/method");
    await expect(page.getByRole("heading", { level: 1, name: "วิธีการวัด" })).toBeVisible();
    await reflows(page);
    await page.goto("/#/");
    await expect(page.getByRole("heading", { level: 1, name: "วัดสัดส่วนใบหน้า" })).toBeVisible();
    await reflows(page);
  });
});
