/** The copy of the core's area names (request 1 in ASSUMPTIONS.md) must equal the locale files. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { AREA_TEXT } from "../src/i18n/areas";
import { REPO } from "./paths";

describe("area names", () => {
  it.each(["th", "en"] as const)("match facescan/config/locale_%s.yaml", (language) => {
    const locale = parse(readFileSync(join(REPO, `facescan/config/locale_${language}.yaml`), "utf8")) as {
      area: Record<string, string>;
    };
    expect(AREA_TEXT[language]).toEqual(locale.area);
  });
});
