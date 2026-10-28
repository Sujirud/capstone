/**
 * Every Tailwind class used in src/ must generate CSS from our theme (tokens.css).
 *
 * Tailwind's default theme is not loaded, so a class that relies on it (a default
 * colour, font, shadow or spacing step) silently produces nothing. The test compiles the
 * classes found in src/ with our stylesheet and with Tailwind's defaults: a class that
 * works only with the defaults is a mistake, either a missing token or the default
 * palette leaking in.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __unstable__loadDesignSystem } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { describe, expect, it } from "vitest";
import { WEB } from "./paths";

// Words in prose or code that happen to be default-theme utilities.
const NOT_CLASSES = new Set<string>([]);

describe("Tailwind classes", () => {
  it("all generate CSS from the design tokens", async () => {
    const styles = join(WEB, "src/styles");
    const ours = await __unstable__loadDesignSystem(readFileSync(join(styles, "index.css"), "utf8"), { base: styles });
    const defaults = await __unstable__loadDesignSystem('@import "tailwindcss";', { base: WEB });
    const candidates = new Scanner({ sources: [{ base: join(WEB, "src"), pattern: "**/*.{ts,tsx}", negated: false }] })
      .scan()
      .filter((c) => !NOT_CLASSES.has(c));
    const withOurs = ours.candidatesToCss(candidates);
    const withDefaults = defaults.candidatesToCss(candidates);
    const onlyDefault = candidates.filter((_, i) => withDefaults[i] && !withOurs[i]);
    expect(candidates.length).toBeGreaterThan(100);
    expect(onlyDefault).toEqual([]);
  });
});
