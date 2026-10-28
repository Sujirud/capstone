/**
 * The glossary in DESIGN.md: every term must appear verbatim in the
 * core's locale files, so the web app's wording never drifts from the core's.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REPO, WEB } from "./paths";

function strings(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(strings);
  if (node && typeof node === "object") return Object.values(node).flatMap(strings);
  return [];
}

const design = readFileSync(join(WEB, "DESIGN.md"), "utf8");
const block = design.slice(design.indexOf("<!-- glossary:start -->"), design.indexOf("<!-- glossary:end -->"));
const rows = block
  .split("\n")
  .filter((line) => line.startsWith("|") && !line.startsWith("|---") && !line.includes("| Concept |"))
  .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));

const core = (language: "th" | "en") =>
  strings(parse(readFileSync(join(REPO, `facescan/config/locale_${language}.yaml`), "utf8"))).join("\n");

describe("glossary", () => {
  const th = core("th");
  const en = core("en").toLowerCase();

  it("has terms", () => {
    expect(rows.length).toBeGreaterThan(10);
  });

  it.each(rows.map((r) => [r[0], r[1], r[2]] as const))("%s: the core uses “%s” / “%s”", (_, thai, english) => {
    expect(th).toContain(thai);
    expect(en).toContain(english!.toLowerCase());
  });
});
