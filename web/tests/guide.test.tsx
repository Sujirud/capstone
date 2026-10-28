/**
 * The capture guides: the core's steps verbatim, each with its drawing,
 * and the distance in the drawing from client-config. The side photo's facing choice.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import configEn from "../fixtures/client_config.en.json" with { type: "json" };
import configTh from "../fixtures/client_config.th.json" with { type: "json" };
import { ClientConfigSchema, type Facing } from "../src/api/schemas";
import { DRAWING_MIN_FONT } from "../src/components/illustrations/Guide";
import { AlarCreaseDrawing } from "../src/components/illustrations/Profile";
import { setupI18n } from "../src/i18n";
import { FacingChoice } from "../src/screens/scan/FacingChoice";
import { FRONTAL_STEP_COUNT, FrontalProtocol, PROFILE_STEP_COUNT, ProfileProtocol } from "../src/screens/scan/Protocol";

describe.each([
  ["th", configTh],
  ["en", configEn],
] as const)("frontal protocol (%s)", (language, raw) => {
  const config = ClientConfigSchema.parse(raw);

  beforeEach(async () => {
    await setupI18n(language);
  });

  it("has the six steps the drawings follow (request 7 in ASSUMPTIONS.md)", () => {
    expect(config.strings.capture.frontal.steps).toHaveLength(FRONTAL_STEP_COUNT);
  });

  it("shows every step verbatim with a drawing, the pair highlighted", () => {
    const { container } = render(<FrontalProtocol config={config} />);
    const items = container.querySelectorAll("ol > li");
    expect(items).toHaveLength(FRONTAL_STEP_COUNT);
    items.forEach((li, i) => {
      expect(li.textContent).toContain(config.strings.capture.frontal.steps[i]);
      expect(within(li as HTMLElement).getAllByRole("img").length).toBeGreaterThan(0);
    });
    expect(screen.getByText(language === "th" ? "แบบนี้" : "Like this")).toBeInTheDocument();
    expect(screen.getByText(language === "th" ? "ไม่ใช่แบบนี้" : "Not like this")).toBeInTheDocument();
  });

  it("takes the distance from client-config, in the drawing and the text", () => {
    const d = config.frontal.gates.camera_distance_recommended_m;
    const custom = { ...config, frontal: { ...config.frontal, gates: { ...config.frontal.gates, camera_distance_recommended_m: 2.25 } } };
    const { container } = render(<FrontalProtocol config={custom} />);
    expect(container.querySelector("svg text")?.textContent).toContain("2.25");
    expect(container.textContent).toContain(language === "th" ? "ประมาณ 2.25 เมตร" : "about 2.25 m");
    expect(d).toBe(1.5);
  });

  it("keeps text in the drawings at 14 px or more, the 2× zoom included", () => {
    const { container } = render(<FrontalProtocol config={config} />);
    const texts = [...container.querySelectorAll("svg text")];
    expect(texts.map((el) => el.textContent)).toEqual(expect.arrayContaining(["2×"]));
    for (const el of texts) {
      // Drawings are 240 units wide and shown at 240–256 px: one unit is at least 1 px.
      expect(el.closest("svg")!.getAttribute("viewBox")).toMatch(/^0 0 240 /);
      expect(Number(el.getAttribute("font-size"))).toBeGreaterThanOrEqual(DRAWING_MIN_FONT);
    }
  });
});

describe.each([
  ["th", configTh],
  ["en", configEn],
] as const)("profile protocol (%s)", (language, raw) => {
  const config = ClientConfigSchema.parse(raw);

  beforeEach(async () => {
    await setupI18n(language);
  });

  it("has the five steps the drawings follow (request 7 in ASSUMPTIONS.md)", () => {
    expect(config.strings.capture.profile.steps).toHaveLength(PROFILE_STEP_COUNT);
  });

  it("shows every step verbatim with its own named drawing", () => {
    const { container } = render(<ProfileProtocol config={config} />);
    const items = container.querySelectorAll("ol > li");
    expect(items).toHaveLength(PROFILE_STEP_COUNT);
    const names = new Set<string>();
    items.forEach((li, i) => {
      expect(li.textContent).toContain(config.strings.capture.profile.steps[i]);
      const drawing = within(li as HTMLElement).getByRole("img");
      names.add(drawing.getAttribute("aria-label") ?? "");
    });
    expect(names.size).toBe(PROFILE_STEP_COUNT);
  });

  it("takes the distance from client-config: the side photo is taken the same way as the front one", () => {
    const custom = { ...config, frontal: { ...config.frontal, gates: { ...config.frontal.gates, camera_distance_recommended_m: 2.25 } } };
    const { container } = render(<ProfileProtocol config={custom} />);
    const texts = [...container.querySelectorAll("svg text")].map((el) => el.textContent);
    expect(texts.some((text) => text?.includes("2.25"))).toBe(true);
    expect(screen.getAllByRole("img")[0]!.getAttribute("aria-label")).toContain("2.25");
  });

  it("keeps text in the drawings at 14 px or more", () => {
    const { container } = render(<ProfileProtocol config={config} />);
    const texts = [...container.querySelectorAll("svg text")];
    expect(texts.length).toBeGreaterThan(0);
    for (const el of texts) {
      expect(el.closest("svg")!.getAttribute("viewBox")).toMatch(/^0 0 240 /);
      expect(Number(el.getAttribute("font-size"))).toBeGreaterThanOrEqual(DRAWING_MIN_FONT);
    }
  });

  it("names the alar crease drawing by what it shows", () => {
    render(<AlarCreaseDrawing />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(language === "th" ? /ปีกจมูก/ : /side of the nose/);
  });
});

describe("facing choice", () => {
  beforeEach(async () => {
    await setupI18n("en");
  });

  function Harness() {
    const [facing, setFacing] = useState<Facing>("right");
    return (
      <>
        <FacingChoice value={facing} onChange={setFacing} />
        <output>{facing}</output>
      </>
    );
  }

  it("is one labelled radio group with two illustrated choices, arrow keys included", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const group = screen.getByRole("radiogroup", { name: "In the photo, the nose points" });
    expect(group).toHaveAccessibleDescription("The person being photographed turns so that the nose points this way.");
    const [left, right] = within(group).getAllByRole("radio");
    expect(left).toHaveAccessibleName("Left");
    expect(right).toHaveAccessibleName("Right");
    expect(right).toBeChecked();
    await user.click(screen.getByText("Left")); // the whole card is the label
    expect(screen.getByRole("status")).toHaveTextContent("left");
    left!.focus();
    // Held down: Radix moves focus a tick later and checks the radio only while an arrow key is down.
    await user.keyboard("{ArrowRight>}");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("right"));
    await user.keyboard("{/ArrowRight}");
  });
});
