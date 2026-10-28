/**
 * Design-token contrast: text ≥ 4.5 : 1 on every background it is
 * used on; borders, ticks, markers and the focus ring ≥ 3 : 1. The pairs below are the
 * ones the components use; add a pair here when a component starts using it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO, WEB } from "./paths";

const css = readFileSync(join(WEB, "src/styles/tokens.css"), "utf8");
const root = css.slice(css.indexOf(":root"), css.indexOf("}", css.indexOf(":root")));
const tokens = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]));

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT: Record<string, string[]> = {
  ink: ["paper", "surface", "notice", "accent-band"],
  "ink-2": ["paper", "surface", "notice"],
  "ink-3": ["paper", "surface"],
  accent: ["paper", "surface", "notice", "accent-band"],
  error: ["paper", "surface"],
  surface: ["ink", "ink-2", "viewer"], // primary button (and its hover), text on the photo surround
};

const NON_TEXT: Record<string, string[]> = {
  "line-strong": ["paper", "surface", "accent-band"], // input borders, range-bar ticks
  accent: ["paper", "surface", "accent-band"], // focus ring, selected state, out-of-range marker
  "ink-2": ["paper", "surface", "notice", "accent-band"], // in-range marker, notice rule
  error: ["surface"], // invalid input border
};

// The print palette: black on white, in a second :root block under @media print.
const printBlock = css.slice(css.indexOf("@media print"), css.indexOf("@theme inline"));
const printTokens = Object.fromEntries([...printBlock.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]));

describe("print tokens", () => {
  it("print black on white, with the accent as black", () => {
    expect(printTokens).toMatchObject({ paper: "#ffffff", surface: "#ffffff", ink: "#000000", accent: "#000000", notice: "#ffffff" });
  });

  it("keep text readable and borders visible on paper", () => {
    for (const text of ["ink", "ink-2", "ink-3", "accent"]) expect(contrast(printTokens[text]!, printTokens.paper!), text).toBeGreaterThanOrEqual(7);
    expect(contrast(printTokens["line-strong"]!, printTokens.paper!)).toBeGreaterThanOrEqual(3);
  });

  it("override only tokens the screen palette defines", () => {
    for (const name of Object.keys(printTokens)) expect(tokens, name).toHaveProperty(name);
  });
});

describe("design tokens", () => {
  it("defines the palette", () => {
    expect(tokens).toEqual({
      paper: "#f6f4ef",
      surface: "#ffffff",
      ink: "#1b1e22",
      "ink-2": "#4d535b",
      "ink-3": "#656a72",
      line: "#ddd9d0",
      "line-strong": "#7d8289",
      accent: "#1c64c4",
      "accent-band": "#dce7f7",
      notice: "#ece8df",
      viewer: "#2a2d31",
      error: "#a33a2b",
      point: "#f5f5f5",
      "point-low": "#c8c8c8",
      "point-shadow": "#282828",
    });
  });

  it("draws points in the overlay's user palette (facescan/render/overlay.py)", () => {
    const overlay = readFileSync(join(REPO, "facescan/render/overlay.py"), "utf8");
    const user = overlay.slice(overlay.indexOf('"user": Palette('), overlay.indexOf('"clinical": Palette('));
    const rgb = (name: string) => {
      const m = user.match(new RegExp(`${name}=\\((\\d+), (\\d+), (\\d+)\\)`));
      expect(m, name).not.toBeNull();
      return `#${m!.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
    };
    expect(tokens.point).toBe(rgb("point"));
    expect(tokens["point-low"]).toBe(rgb("point_low"));
    expect(tokens["point-shadow"]).toBe(rgb("shadow"));
  });

  it.each(Object.entries(TEXT).flatMap(([fg, bgs]) => bgs.map((bg) => [fg, bg] as const)))(
    "text %s on %s is at least 4.5 : 1",
    (fg, bg) => {
      expect(contrast(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(Object.entries(NON_TEXT).flatMap(([fg, bgs]) => bgs.map((bg) => [fg, bg] as const)))(
    "graphic %s on %s is at least 3 : 1",
    (fg, bg) => {
      expect(contrast(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(3);
    },
  );

  it("matches the ratios quoted in DESIGN.md", () => {
    expect(contrast(tokens.accent!, tokens.paper!)).toBeCloseTo(5.2, 1);
    expect(contrast(tokens.accent!, tokens["accent-band"]!)).toBeCloseTo(4.6, 1);
    expect(contrast(tokens["line-strong"]!, tokens.paper!)).toBeCloseTo(3.5, 1);
  });

  it("keeps the accent in the overlay's hue (USER_ACCENT #409CFF)", () => {
    const hue = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
      const max = Math.max(r, g, b);
      const d = max - Math.min(r, g, b);
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const overlay = readFileSync(join(REPO, "facescan/render/overlay.py"), "utf8");
    const m = overlay.match(/USER_ACCENT: RGB = \((\d+), (\d+), (\d+)\)/);
    expect(m).not.toBeNull();
    const toHex = (n: string) => Number(n).toString(16).padStart(2, "0");
    const overlayHex = `#${toHex(m![1]!)}${toHex(m![2]!)}${toHex(m![3]!)}`;
    expect(Math.abs(hue(tokens.accent!) - hue(overlayHex))).toBeLessThan(6);
  });
});
