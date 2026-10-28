/**
 * Milestone 1 flows with the API mocked: client-config, the subject form,
 * language, the component page, plus axe on every screen and reflow at 320 px and 200 %
 * text.
 */
import type { Page } from "@playwright/test";
import configEn from "../fixtures/client_config.en.json" with { type: "json" };
import configTh from "../fixtures/client_config.th.json" with { type: "json" };
import { clientConfig, clientConfigUnreachable } from "../tests/mocks/handlers";
import { expect, expectAccessible, reflows, test } from "./fixtures";

async function heading(page: Page, name: string) {
  const h1 = page.getByRole("heading", { level: 1, name });
  await expect(h1).toBeVisible();
  return h1;
}

test("landing → subject form → frontal guide", async ({ page }) => {
  await page.goto("/");
  await heading(page, "วัดสัดส่วนใบหน้า");
  await expectAccessible(page);
  await page.getByRole("link", { name: "เริ่มต้น" }).click();
  await heading(page, "เพศของคุณ");
  await expect(page.locator("html")).toHaveAttribute("lang", "th");
  await expect(page.getByText("ขั้นที่ 1 จาก 4 · ข้อมูลของคุณ")).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("radio", { name: "หญิง" }).click();
  await page.getByRole("button", { name: "ดำเนินการต่อ" }).click();

  await expect(await heading(page, "อายุของคุณ")).toBeFocused();
  await page.getByLabel("อายุ (ปี)").fill("21");
  await expectAccessible(page);
  await page.getByRole("button", { name: "ดำเนินการต่อ" }).click();

  await heading(page, configTh.strings.capture.frontal.title);
  await expect(page.getByText("ขั้นที่ 2 จาก 4 · ภาพหน้าตรง")).toBeVisible();
  for (const text of configTh.strings.capture.frontal.steps) await expect(page.getByText(text)).toBeVisible();
  await expectAccessible(page);

  const stored = await page.evaluate(() => ({ ...window.localStorage }));
  expect(Object.keys(stored)).toEqual(["facescan.subject"]);
  expect(JSON.parse(stored["facescan.subject"]!)).toEqual({ sex: "female", age: 21 });
});

test("the service is not reachable: no scan starts, retry recovers", async ({ page, network }) => {
  network.use(clientConfigUnreachable);
  await page.goto("/#/subject");
  await heading(page, "ติดต่อบริการไม่ได้");
  await expect(page.getByRole("radiogroup")).toHaveCount(0);
  await expectAccessible(page);
  network.use(clientConfig);
  await page.getByRole("button", { name: "ลองอีกครั้ง" }).click();
  await heading(page, "เพศของคุณ");
});

test("the language control switches the app and the service's strings", async ({ page }) => {
  await page.goto("/#/subject");
  await heading(page, "เพศของคุณ");
  await page.getByRole("button", { name: "English" }).click();
  await heading(page, "Your sex");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByRole("radio", { name: "Male", exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Age in years").fill("34");
  await page.getByRole("button", { name: "Continue" }).click();
  await heading(page, configEn.strings.capture.frontal.title);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("the component page renders in both languages without violations", async ({ page }) => {
  await page.goto("/#/components");
  await heading(page, "Components");
  await expect(page.getByRole("heading", { level: 2, name: "Measurement sheet (fixtures/frontal_ok)" })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("banner").getByRole("button", { name: "English" }).click();
  await expect(page.getByText("Upper third of the face").first()).toBeVisible();
  await expectAccessible(page);
});

test.describe("reflow at 320 px and 200 % text (WCAG 1.4.4, 1.4.10)", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  for (const [route, name] of [
    ["/#/subject", "เพศของคุณ"],
    ["/#/subject/age", "อายุของคุณ"],
    ["/#/components", "Components"],
  ] as const) {
    test(route, async ({ page }) => {
      await page.addInitScript(() =>
        window.localStorage.setItem("facescan.subject", JSON.stringify({ sex: "female", age: 21 })),
      );
      await page.goto(route);
      await heading(page, name);
      await reflows(page);
    });
  }
});

test("keyboard only: skip link, radio group, action bar", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "Safari and WebKit skip links on Tab unless full keyboard access is on");
  await page.goto("/#/subject");
  await heading(page, "เพศของคุณ");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "ข้ามไปยังเนื้อหาหลัก" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
  // Into the radio group: one tab stop, arrows move the choice.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio").first()).toBeFocused();
  // ARIA radio pattern: arrows move focus, Space checks the focused option.
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: "ชาย" })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.getByRole("radio", { name: "ชาย" })).toBeChecked();
  // On to the action bar's primary button, which stays in view.
  await page.keyboard.press("Tab");
  const next = page.getByRole("button", { name: "ดำเนินการต่อ" });
  await expect(next).toBeFocused();
  await expect(next).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(await heading(page, "อายุของคุณ")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("อายุ (ปี)")).toBeFocused();
  await page.keyboard.type("45");
  await page.keyboard.press("Enter");
  await heading(page, configTh.strings.capture.frontal.title);
});
