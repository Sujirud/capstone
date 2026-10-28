/**
 * Results rendering from the real core's fixtures: text appears
 * verbatim, grouped by area, with secondary metrics under "More details".
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import frontalEn from "../fixtures/frontal_ok.en.json" with { type: "json" };
import frontalTh from "../fixtures/frontal_ok.th.json" with { type: "json" };
import profileAdjustedEn from "../fixtures/profile_adjusted.en.json" with { type: "json" };
import profileAdjustedTh from "../fixtures/profile_adjusted.th.json" with { type: "json" };
import profileEn from "../fixtures/profile_ok.en.json" with { type: "json" };
import profileTh from "../fixtures/profile_ok.th.json" with { type: "json" };
import { AnalyzeResponseSchema, type Metric, type Result } from "../src/api/schemas";
import { MeasurementSheet } from "../src/components/results/MeasurementSheet";
import { MeasurementTable } from "../src/components/results/MeasurementTable";
import { MetricRow } from "../src/components/results/MetricRow";
import { rangeGeometry } from "../src/components/results/RangeBar";
import { setupI18n, type Language } from "../src/i18n";
import { AREA_TEXT } from "../src/i18n/areas";

function result(language: Language): Result {
  const r = AnalyzeResponseSchema.parse(language === "th" ? frontalTh : frontalEn);
  if (r.status !== "ok") throw new Error("fixture is not ok");
  return r.result;
}

describe("range bar geometry", () => {
  it("places the band in the middle half and the value on the same scale", () => {
    const g = rangeGeometry(0.333, 0.317, 0.35);
    expect(g.bandStart).toBeCloseTo(0.25);
    expect(g.bandEnd).toBeCloseTo(0.75);
    expect(g.marker).toBeCloseTo((0.333 - 0.3005) / 0.066, 5);
    expect(g.pinned).toBeNull();
  });

  it("pins values beyond the scale to the edge", () => {
    expect(rangeGeometry(0.84, 0.95, 1.05)).toMatchObject({ marker: 0, pinned: "low" });
    expect(rangeGeometry(9, 0.95, 1.05)).toMatchObject({ marker: 1, pinned: "high" });
  });

  it("gives a zero-width band a visible scale", () => {
    const g = rangeGeometry(1, 1, 1);
    expect(g.bandStart).toBeCloseTo(0.5);
    expect(g.pinned).toBeNull();
  });
});

describe.each(["th", "en"] as const)("measurement sheet (%s)", (language) => {
  const r = result(language);
  const metrics = Object.entries(r.metrics);

  beforeEach(async () => {
    await setupI18n(language);
  });

  it("renders every metric's texts verbatim", async () => {
    const user = userEvent.setup();
    const { container } = render(<MeasurementSheet metrics={r.metrics} />);
    await user.click(screen.getByRole("button", { name: language === "th" ? "ข้อมูลเพิ่มเติม" : "More details" }));
    const text = container.textContent ?? "";
    for (const [id, m] of metrics) {
      expect(text, id).toContain(m.name);
      if (m.value_text) expect(text, id).toContain(m.value_text);
      expect(text, id).toContain(m.status_text);
      if (m.reference) expect(text, id).toContain(`${m.reference.label} ${m.reference.text}`);
      if (m.confidence === "low") expect(text, id).toContain(m.confidence_text);
    }
  });

  it("groups primary metrics by area in the API's order, with the core's area names", () => {
    render(<MeasurementSheet metrics={r.metrics} />);
    const expected = [...new Set(metrics.filter(([, m]) => m.role === "primary").map(([, m]) => m.area!))].map(
      (area) => AREA_TEXT[language][area],
    );
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(expected);
  });

  it("keeps secondary metrics collapsed under More details", async () => {
    const user = userEvent.setup();
    render(<MeasurementSheet metrics={r.metrics} />);
    const secondary = metrics.filter(([, m]) => m.role === "secondary").map(([, m]) => m.name);
    expect(secondary.length).toBeGreaterThan(0);
    for (const name of secondary) expect(screen.queryByText(name)).toBeNull();
    await user.click(screen.getByRole("button", { name: language === "th" ? "ข้อมูลเพิ่มเติม" : "More details" }));
    for (const name of secondary) expect(screen.getByText(name)).toBeInTheDocument();
  });

  it("draws range bars only for within / above / below metrics with a range", () => {
    render(<MeasurementSheet metrics={r.metrics} />);
    const rows = screen.getAllByRole("listitem");
    for (const row of rows) {
      const status = row.getAttribute("data-status");
      const hasBar = within(row).queryByTestId("range-bar") !== null;
      expect(hasBar, status ?? "").toBe(status === "within" || status === "above" || status === "below");
    }
  });
});

describe.each([
  ["profile_ok", "th", profileTh],
  ["profile_ok", "en", profileEn],
  ["profile_adjusted", "th", profileAdjustedTh],
  ["profile_adjusted", "en", profileAdjustedEn],
] as const)("side-photo sheet (%s, %s)", (_, language, raw) => {
  const r = AnalyzeResponseSchema.parse(raw);
  if (r.status !== "ok") throw new Error("fixture is not ok");
  const metrics = Object.entries(r.result.metrics);

  beforeEach(async () => {
    await setupI18n(language);
  });

  it("renders every metric's texts verbatim, flags included, grouped under the core's area names", async () => {
    const user = userEvent.setup();
    const { container } = render(<MeasurementSheet metrics={r.result.metrics} />);
    await user.click(screen.getByRole("button", { name: language === "th" ? "ข้อมูลเพิ่มเติม" : "More details" }));
    const text = container.textContent ?? "";
    for (const [id, m] of metrics) {
      expect(text, id).toContain(m.name);
      if (m.value_text) expect(text, id).toContain(m.value_text);
      expect(text, id).toContain(m.status_text);
      if (m.reference) expect(text, id).toContain(`${m.reference.label} ${m.reference.text}`);
      for (const flag of m.flags) expect(text, id).toContain(flag.text);
    }
    const areas = [...new Set(metrics.filter(([, m]) => m.role === "primary").map(([, m]) => m.area!))];
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(areas.map((a) => AREA_TEXT[language][a]));
  });
});

describe("measurement table (the report)", () => {
  beforeEach(async () => {
    await setupI18n("en");
  });

  const metrics = result("en").metrics;

  it("puts a reference label shared by every row in the column header, once", () => {
    const { container } = render(<MeasurementTable metrics={metrics} labelledBy="x" />);
    const label = Object.values(metrics).find((m) => m.reference)!.reference!.label;
    expect(screen.getByRole("columnheader", { name: label })).toBeInTheDocument();
    const wideCells = [...container.querySelectorAll("td")].filter((td) => td.className.includes("md:table-cell"));
    expect(wideCells.some((td) => td.textContent?.includes(label))).toBe(false);
    // Narrow screens have no column header: the label stays with each range there.
    expect(container.querySelector("th[scope=row] .md\\:hidden")?.textContent).toContain(label);
  });

  it("keeps each row's label when the labels differ", () => {
    const [first, ...rest] = Object.entries(metrics).filter(([, m]) => m.reference);
    const mixed = Object.fromEntries([
      [first![0], { ...first![1], reference: { ...first![1].reference!, basis: "population" as const, label: "Typical range" } }],
      ...rest,
    ]);
    const { container } = render(<MeasurementTable metrics={mixed} labelledBy="x" />);
    expect(screen.getByRole("columnheader", { name: "Reference range" })).toBeInTheDocument();
    const wideText = [...container.querySelectorAll("td")].map((td) => td.textContent).join("\n");
    expect(wideText).toContain("Typical range");
    expect(wideText).toContain(rest[0]![1].reference!.label);
  });
});

describe("metric row", () => {
  beforeEach(async () => {
    await setupI18n("en");
  });

  const base: Metric = result("en").metrics.F1_upper_third!;

  it("emphasises out-of-range status text with the accent and weight, never an icon", () => {
    render(
      <ul>
        <MetricRow metric={{ ...base, status: "above", status_text: "Above the reference range" }} />
      </ul>,
    );
    const status = screen.getByText("Above the reference range");
    expect(status).toHaveClass("text-accent", "font-semibold");
    expect(screen.getByRole("listitem").querySelectorAll("svg:not([aria-hidden])").length).toBe(0);
  });

  it("shows flag texts and the description on request", async () => {
    const user = userEvent.setup();
    const flagged: Metric = {
      ...base,
      flags: [{ key: "large_user_adjustment", text: "You moved this point far from where it was detected." }],
    };
    render(
      <ul>
        <MetricRow metric={flagged} />
      </ul>,
    );
    expect(screen.getByText("You moved this point far from where it was detected.")).toBeInTheDocument();
    expect(screen.queryByText(base.description)).toBeNull();
    const trigger = screen.getByRole("button", { name: `${base.name} ${base.value_text}` });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(screen.getByText(base.description)).toBeInTheDocument();
  });

  it("shows no value and no range bar for an unavailable metric", () => {
    render(
      <ul>
        <MetricRow metric={{ ...base, value: null, value_text: null, status: "unavailable", status_text: "Could not be measured from this photo" }} />
      </ul>,
    );
    expect(screen.getByText("No value")).toHaveClass("sr-only");
    expect(screen.queryByTestId("range-bar")).toBeNull();
  });
});
