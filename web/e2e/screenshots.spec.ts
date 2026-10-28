/**
 * Screenshots for DESIGN.md: every screen in th and en, at 360 px and
 * 1280 px, against the mocked API (the core's fixtures; the "photo" is the line drawing of
 * the synthetic face). Written to docs/screenshots/. Run: pnpm screenshots
 */
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { delay, http } from "msw";
import en from "../src/i18n/en.json" with { type: "json" };
import th from "../src/i18n/th.json" with { type: "json" };
import { clientConfigUnreachable, MOCK_API, problem, scanHandlers, type ScanMockOptions } from "../tests/mocks/handlers";
import { expect, test } from "./fixtures";

const WIDTHS = [360, 1280] as const;
const LANGUAGES = ["th", "en"] as const;
type Lang = (typeof LANGUAGES)[number];
const STRINGS = { th, en };
type Network = { use: (...handlers: never[]) => void };

interface Shot {
  name: string;
  route: string;
  unreachable?: boolean;
  scan?: ScanMockOptions;
  /** Screenshot the viewport only (states with an open dialog or a drag in progress). */
  viewport?: boolean;
  /** Only these language × width pairs. */
  only?: Array<[Lang, number]>;
  /** The print view: A4 width, print media, and a PDF next to the picture. Once per language. */
  print?: boolean;
  setup?: (page: Page, s: typeof th, network: Network) => Promise<void>;
}

async function submit(page: Page) {
  await page.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit());
}

async function toGuide(page: Page) {
  await submit(page);
  await submit(page);
  await page.waitForURL(/scan\/frontal\/guide/);
}

async function toLive(page: Page, s: typeof th) {
  await toGuide(page);
  await page.getByRole("button", { name: s.guide.takePhoto, exact: true }).click();
  await page.waitForURL(/frontal\/live/);
  // "Start the camera" takes the place of "Take a photo": no hover on it.
  await page.mouse.move(0, 0);
}

async function startLive(page: Page, s: typeof th) {
  await toLive(page, s);
  await page.getByRole("button", { name: s.live.start }).click();
  // The first processed frame: a hint (or "hold still") and the face-size notice.
  await expect(page.getByTestId("live-face-size")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("live-hint").locator("p.text-2xl")).not.toBeEmpty();
}

async function choosePhoto(page: Page, file = "photo.jpg") {
  await page.getByTestId("input-camera").setInputFiles({ name: file, mimeType: "image/jpeg", buffer: readFileSync(`fixtures/${file}`) });
  await page.waitForURL(/preview/);
}

async function toResults(page: Page, s: typeof th) {
  await toGuide(page);
  await choosePhoto(page);
  await page.getByRole("button", { name: s.preview.use }).click();
  await page.waitForURL(/result/);
  await expect(page.getByRole("img", { name: s.viewer.altOverlay })).toHaveJSProperty("complete", true);
}

async function toAdjust(page: Page, s: typeof th) {
  await toResults(page, s);
  await page.getByRole("link", { name: s.results.adjust }).click();
  await expect(page.getByTestId("adjust-marker")).toBeVisible();
}

async function toProfileGuide(page: Page, s: typeof th) {
  await toResults(page, s);
  await page.getByRole("link", { name: s.results.addProfile }).click();
  await page.waitForURL(/profile\/guide/);
}

async function toReport(page: Page, s: typeof th, withProfile: boolean) {
  if (withProfile) await toProfileResults(page, s);
  else await toResults(page, s);
  await page.getByRole("link", { name: s.report.see }).click();
  await page.waitForURL(/report/);
  await expect(page.getByTestId(withProfile ? "example-rules" : "no-considerations")).toBeVisible();
  for (const img of await page.getByRole("img", { name: s.viewer.altOverlay }).all()) await expect(img).toHaveJSProperty("complete", true);
}

async function toProfileResults(page: Page, s: typeof th) {
  await toProfileGuide(page, s);
  await choosePhoto(page, "profile.jpg");
  await page.getByRole("button", { name: s.preview.use }).click();
  await page.waitForURL(/profile\/result/);
  await expect(page.getByRole("img", { name: s.viewer.altOverlay })).toHaveJSProperty("complete", true);
}

const SHOTS: Shot[] = [
  { name: "landing", route: "/#/" },
  { name: "method", route: "/#/method" },
  { name: "subject-sex", route: "/#/subject" },
  {
    name: "subject-age-error",
    route: "/#/subject/age",
    setup: async (page) => {
      await page.locator("#main").getByRole("textbox").fill("130");
      await submit(page);
    },
  },
  { name: "frontal-guide", route: "/#/subject", setup: (page) => toGuide(page) },
  // Live mode. The camera is Chromium's fake one, playing the drawing (playwright.config.ts).
  { name: "live-intro", route: "/#/subject", setup: (page, s) => toLive(page, s) },
  { name: "live-camera", route: "/#/subject", setup: (page, s) => startLive(page, s) },
  {
    name: "live-calibration",
    route: "/#/subject",
    only: [["th", 360], ["en", 1280]],
    setup: async (page, s) => {
      await startLive(page, s);
      await page.getByRole("button", { name: s.live.calibrate }).click();
      await expect(page.getByRole("heading", { level: 2, name: s.live.calibration.heading })).toBeFocused();
    },
  },
  {
    name: "live-denied",
    route: "/#/subject",
    only: [["th", 360], ["en", 1280]],
    setup: async (page, s) => {
      await page.evaluate(() => {
        navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
      });
      await toLive(page, s);
      await page.getByRole("button", { name: s.live.start }).click();
      await expect(page.getByRole("alert")).toBeVisible();
    },
  },
  {
    name: "preview",
    route: "/#/subject",
    setup: async (page) => {
      await toGuide(page);
      await choosePhoto(page);
    },
  },
  {
    name: "analyzing",
    route: "/#/subject",
    setup: async (page, s, network) => {
      network.use(http.post(`${MOCK_API}/v1/frontal/analyze`, () => delay("infinite")) as never);
      await toGuide(page);
      await choosePhoto(page);
      await page.getByRole("button", { name: s.preview.use }).click();
      await page.waitForURL(/analyzing/);
    },
  },
  {
    name: "retake",
    route: "/#/subject",
    scan: { outcomes: ["quality_failed"] },
    setup: async (page, s) => {
      await toGuide(page);
      await choosePhoto(page);
      await page.getByRole("button", { name: s.preview.use }).click();
      await page.waitForURL(/retake/);
    },
  },
  {
    name: "retake-protocol",
    route: "/#/subject",
    scan: { outcomes: ["no_face"] },
    setup: async (page, s) => {
      await toGuide(page);
      for (let i = 0; i < 3; i++) {
        await choosePhoto(page);
        await page.getByRole("button", { name: s.preview.use }).click();
        await page.waitForURL(/retake/);
      }
      await expect(page.getByTestId("full-protocol")).toBeVisible();
    },
  },
  { name: "results", route: "/#/subject", setup: (page, s) => toResults(page, s) },
  { name: "adjust", route: "/#/subject", setup: (page, s) => toAdjust(page, s) },
  {
    name: "adjust-dragging",
    route: "/#/subject",
    viewport: true,
    setup: async (page, s) => {
      await toAdjust(page, s);
      await page.getByTestId("adjust-marker").scrollIntoViewIfNeeded();
      const b = (await page.getByTestId("adjust-marker").boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 - 30, { steps: 4 });
      await expect(page.getByTestId("loupe")).toBeVisible();
    },
  },
  {
    name: "results-adjusted",
    route: "/#/subject",
    viewport: true,
    setup: async (page, s) => {
      await toAdjust(page, s);
      await page.getByTestId("adjust-marker").focus();
      for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowUp");
      await page.getByRole("button", { name: s.adjust.save_one }).click();
      await page.waitForURL(/result/);
      await expect(page.getByRole("img", { name: s.viewer.altOverlay })).toHaveAttribute("src", /^blob:/);
    },
  },
  {
    name: "language-dialog",
    route: "/#/subject",
    viewport: true,
    setup: async (page, s) => {
      await toResults(page, s);
      await page.getByRole("banner").getByRole("button", { name: s.nav.otherLanguage }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  },
  {
    name: "error-rate-limited",
    route: "/#/subject",
    setup: async (page, s, network) => {
      network.use(http.post(`${MOCK_API}/v1/frontal/analyze`, () => problem("rate_limited", 429, { retryAfter: 540 })) as never);
      await toGuide(page);
      await choosePhoto(page);
      await page.getByRole("button", { name: s.preview.use }).click();
      await expect(page.getByTestId("scan-error")).toBeVisible();
    },
  },
  { name: "profile-guide", route: "/#/subject", setup: (page, s) => toProfileGuide(page, s) },
  {
    name: "profile-preview",
    route: "/#/subject",
    setup: async (page, s) => {
      await toProfileGuide(page, s);
      await choosePhoto(page, "profile.jpg");
    },
  },
  {
    name: "profile-retake",
    route: "/#/subject",
    scan: { profileOutcomes: ["contour_failed"] },
    setup: async (page, s) => {
      await toProfileGuide(page, s);
      await choosePhoto(page, "profile.jpg");
      await page.getByRole("button", { name: s.preview.use }).click();
      await page.waitForURL(/profile\/retake/);
    },
  },
  { name: "profile-results", route: "/#/subject", setup: (page, s) => toProfileResults(page, s) },
  // Variants of screens shown above in full: one language per width (keeps the folder small).
  {
    name: "profile-results-no-scale",
    route: "/#/subject",
    viewport: true,
    only: [["th", 360], ["en", 1280]],
    scan: { profileOutcomes: ["no_scale"] },
    setup: async (page, s) => {
      await toProfileResults(page, s);
      await page.locator("[data-warning=no_scale]").scrollIntoViewIfNeeded();
    },
  },
  {
    name: "profile-adjust-alar",
    route: "/#/subject",
    setup: async (page, s) => {
      await toProfileResults(page, s);
      await page.getByTestId("alar-prompt").getByRole("link", { name: s.profile.alar.action }).click();
      await expect(page.getByTestId("adjust-surface").locator("svg")).toBeAttached();
    },
  },
  {
    name: "profile-adjust-outline",
    route: "/#/subject",
    only: [["th", 360], ["en", 1280]],
    setup: async (page, s) => {
      await toProfileResults(page, s);
      await page.getByRole("link", { name: s.results.adjust }).click();
      await page.getByLabel(s.adjust.pointGroup).selectOption("pronasale");
      await expect(page.getByTestId("adjust-track")).toBeAttached();
    },
  },
  {
    name: "profile-results-adjusted",
    route: "/#/subject",
    viewport: true,
    only: [["th", 360], ["en", 1280]],
    setup: async (page, s) => {
      await toProfileResults(page, s);
      await page.getByTestId("alar-prompt").getByRole("link", { name: s.profile.alar.action }).click();
      const surface = page.getByTestId("adjust-surface");
      await expect(surface.locator("svg")).toBeAttached();
      await surface.evaluate((el) => el.scrollIntoView({ block: "center" })); // clear of the action bar
      const img = (await surface.boundingBox())!;
      await page.mouse.click(img.x + img.width * 0.5, img.y + img.height * 0.45);
      await expect(page.getByTestId("adjust-marker")).toBeVisible();
      await page.getByRole("button", { name: s.adjust.save_other }).click();
      await page.waitForURL(/profile\/result/);
      await expect(page.getByRole("img", { name: s.viewer.altOverlay })).toHaveAttribute("src", /^blob:/);
    },
  },
  { name: "report", route: "/#/subject", setup: (page, s) => toReport(page, s, true) },
  { name: "report-no-topics", route: "/#/subject", only: [["th", 360], ["en", 1280]], setup: (page, s) => toReport(page, s, false) },
  { name: "report-print", route: "/#/subject", print: true, setup: (page, s) => toReport(page, s, true) },
  { name: "service-unreachable", route: "/#/subject", unreachable: true },
  // A review tool, not a product screen: one language per width is enough.
  { name: "components", route: "/#/components", only: [["th", 360], ["en", 1280]] },
];

for (const language of LANGUAGES) {
  for (const width of WIDTHS) {
    for (const shot of SHOTS) {
      if (shot.only && !shot.only.some(([l, w]) => l === language && w === width)) continue;
      if (shot.print && width !== 1280) continue;
      test(`${shot.name} ${language} ${shot.print ? "a4" : width}`, async ({ page, network }) => {
        const s = STRINGS[language as Lang];
        // A4 at 96 px per inch for the print view.
        await page.setViewportSize(shot.print ? { width: 794, height: 1123 } : { width, height: width === 360 ? 780 : 900 });
        await page.addInitScript((language) => {
          window.localStorage.setItem("facescan.language", language);
          window.localStorage.setItem("facescan.subject", JSON.stringify({ sex: "female", age: 21 }));
        }, language);
        network.use(...(scanHandlers(shot.scan) as never[]));
        if (shot.unreachable) network.use(clientConfigUnreachable);
        await page.goto(shot.route);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await shot.setup?.(page, s, network as unknown as Network);
        await page.evaluate(() => document.fonts.ready);
        // Animated progress lines and carets are frozen for a stable picture.
        await page.addStyleTag({ content: "*{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}" });
        if (shot.print) {
          await page.emulateMedia({ media: "print" });
          await page.screenshot({ path: `docs/screenshots/${shot.name}.${language}.a4.png`, fullPage: true });
          await page.pdf({ path: `docs/screenshots/${shot.name}.${language}.pdf`, preferCSSPageSize: true, printBackground: true });
          return;
        }
        await page.screenshot({ path: `docs/screenshots/${shot.name}.${language}.${width}.png`, fullPage: !shot.viewport });
      });
    }
  }
}
