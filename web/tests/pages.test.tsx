/**
 * The landing page and "How it's measured", in both languages: the core's
 * disclaimer and numbers verbatim, who made it, and the links between them.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import configEn from "../fixtures/client_config.en.json" with { type: "json" };
import configTh from "../fixtures/client_config.th.json" with { type: "json" };
import { ABOUT } from "../src/app/about";
import en from "../src/i18n/en.json" with { type: "json" };
import th from "../src/i18n/th.json" with { type: "json" };
import { renderApp } from "./renderApp";

describe.each([
  ["th", configTh, th],
  ["en", configEn, en],
] as const)("landing and method pages (%s)", (language, config, s) => {
  it("the landing page: what it does, the core's disclaimer, a drawing, who made it, Start", async () => {
    const user = userEvent.setup();
    await renderApp("/", { language });
    await screen.findByRole("heading", { level: 1, name: s.app.name });
    expect(screen.getByText(s.landing.lead)).toBeInTheDocument();
    expect(screen.getByText(config.strings.disclaimer.general)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: s.landing.illustration })).toBeInTheDocument();
    expect(screen.getByText(s.landing.madeBy.replace("{{course}}", ABOUT.course[language]))).toBeInTheDocument();
    // One action, and the way to the method page.
    const bar = screen.getByRole("link", { name: s.landing.start });
    expect(bar).toHaveAttribute("href", "#/subject");
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([s.nav.otherLanguage]);
    await user.click(screen.getByRole("link", { name: s.method.link }));
    await screen.findByRole("heading", { level: 1, name: s.method.title });
  });

  it("the method page: short sections with the core's numbers and words verbatim", async () => {
    await renderApp("/method", { language });
    await screen.findByRole("heading", { level: 1, name: s.method.title });
    const main = screen.getByRole("main");
    const text = main.textContent ?? "";
    expect(text).toContain(String(config.frontal.iris_diameter_mm));
    expect(text).toContain(`“${config.strings.status.inconclusive}”`);
    expect(text).toContain(`“${config.strings.reference.canon}”`);
    expect(text).toContain(config.strings.disclaimer.general);
    const headings = within(main).getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      s.method.landmarks.heading,
      s.method.hairline.heading,
      s.method.axes.heading,
      s.method.scale.heading,
      s.method.profile.heading,
      s.method.uncertainty.heading,
      s.method.reference.heading,
      s.method.limits.heading,
      s.method.privacy.heading,
    ]);
    // getByText collapses whitespace (the no-break space before ๆ included) in the page's text.
    for (const item of [s.method.limits.diagnose, s.method.limits.photo, s.method.limits.protocol]) {
      expect(within(main).getByText(item.replace(/\s+/g, " "))).toBeInTheDocument();
    }
  });
});
