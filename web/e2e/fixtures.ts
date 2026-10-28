/** Playwright fixtures: the MSW network (shared handlers from tests/mocks) and axe. */
import AxeBuilder from "@axe-core/playwright";
import { defineNetworkFixture, type NetworkFixture } from "@msw/playwright";
import { test as base, expect, type Page } from "@playwright/test";
import type { AnyHandler } from "msw";
import { handlers } from "../tests/mocks/handlers";

interface Fixtures {
  handlers: AnyHandler[];
  network: NetworkFixture;
}

export const test = base.extend<Fixtures>({
  handlers: [handlers, { option: true }],
  network: [
    async ({ context, handlers }, use) => {
      const network = defineNetworkFixture({ context, handlers });
      await network.enable();
      await use(network);
      await network.disable();
    },
    { auto: true },
  ],
});

export { expect };

/** axe with WCAG 2.2 AA rules: no serious or critical violations. */
export async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** The page does not scroll sideways (reflow, WCAG 1.4.10). */
export async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/** No horizontal scroll at the current size, and none with the text at 200 % (WCAG 1.4.4). */
export async function reflows(page: Page): Promise<void> {
  await noHorizontalScroll(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await noHorizontalScroll(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
}
