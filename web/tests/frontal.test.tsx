/**
 * The frontal flow through the real app, with the API mocked from the core's fixtures:
 * failed capture → retake → ok → adjust → save → reset.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import configEn from "../fixtures/client_config.en.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import configTh from "../fixtures/client_config.th.json" with { type: "json" };
import failedTh from "../fixtures/frontal_quality_failed.th.json" with { type: "json" };
import okTh from "../fixtures/frontal_ok.th.json" with { type: "json" };
import adjustedTh from "../fixtures/frontal_adjusted.th.json" with { type: "json" };
import { STORAGE_KEYS } from "../src/app/storage";
import i18n from "../src/i18n";
import { CORS_HEADERS, fixtureBytes, MOCK_API, newCalls, problem, scanHandlers, type AnalysisOutcome } from "./mocks/handlers";
import { server } from "./mocks/server";
import { renderApp } from "./renderApp";

const photo = () => new File([new Uint8Array(fixtureBytes("photo.jpg"))], "IMG_0001.JPG", { type: "image/jpeg" });

async function toGuide(outcomes: AnalysisOutcome[]) {
  const calls = newCalls();
  server.use(...scanHandlers({ outcomes, calls }));
  window.localStorage.setItem(STORAGE_KEYS.subject, JSON.stringify({ sex: "female", age: 21 }));
  const user = userEvent.setup();
  const { services } = await renderApp("/subject");
  await user.click(await screen.findByRole("button", { name: "ดำเนินการต่อ" }));
  await user.click(await screen.findByRole("button", { name: "ดำเนินการต่อ" }));
  await screen.findByRole("heading", { level: 1, name: configTh.strings.capture.frontal.title });
  return { user, calls, services };
}

async function takeAndSend(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByTestId("input-camera"), photo());
  await screen.findByRole("heading", { level: 1, name: "ตรวจสอบภาพ" });
  await user.click(screen.getByRole("button", { name: "ใช้ภาพนี้" }));
}

/** jsdom does not load images: report the photo's natural size as a browser would. */
function loadImage(img: HTMLElement, width: number, height: number) {
  Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
  fireEvent.load(img);
}

describe("frontal flow (photo mode)", () => {
  it("failed capture → retake → results → adjust → save → reset", async () => {
    const { user, calls } = await toGuide(["quality_failed", "ok"]);
    await takeAndSend(user);

    // The capture did not pass: the core's hints verbatim, check names once each, warnings.
    await screen.findByRole("heading", { level: 1, name: "กรุณาถ่ายภาพใหม่" });
    const hints = within(screen.getByTestId("hints")).getAllByRole("listitem").map((li) => li.textContent);
    expect(hints).toEqual(failedTh.hints);
    const names = failedTh.failed_checks.map((id) => configTh.strings.check[id as keyof typeof configTh.strings.check]);
    const checks = within(screen.getByRole("region", { name: "รายการที่ยังไม่ผ่าน" })).getAllByRole("listitem").map((li) => li.textContent);
    expect(checks).toEqual([...new Set(names)]);
    expect(screen.getByText(configTh.strings.warning.distance_unverified)).toBeInTheDocument();

    // What was sent: the file unchanged, the subject, Thai, the frontal layers, no camera.
    const first = calls.analyze[0]!;
    expect(first.frames).toEqual([{ name: "IMG_0001.JPG", type: "image/jpeg", size: fixtureBytes("photo.jpg").length, head: [0xff, 0xd8, 0xff, 0xe0] }]);
    expect(first.meta).toEqual({
      subject: { sex: "female", age: 21 },
      locale: "th",
      overlay: { layers: ["landmarks", "thirds", "fifths", "eyes_brows", "nose_lips", "labels"] },
    });

    // Retake: the second analysis passes.
    await user.upload(screen.getByTestId("input-camera"), photo());
    await screen.findByRole("heading", { level: 1, name: "ตรวจสอบภาพ" });
    await user.click(screen.getByRole("button", { name: "ใช้ภาพนี้" }));
    await screen.findByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" });
    const overlay = screen.getByRole("img", { name: "ภาพของคุณพร้อมเส้นการวัด" });
    expect(overlay.getAttribute("src")).toMatch(/^data:image\/jpeg;base64,/);
    expect(screen.getByText(okTh.result.side_note)).toBeInTheDocument();
    expect(screen.getByText(okTh.result.disclaimer)).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).length).toBeGreaterThan(5);

    // Adjust the hairline with the keyboard: 6 × Shift+↑ = 60 px up.
    await user.click(screen.getByRole("link", { name: "ปรับตำแหน่งจุด" }));
    await screen.findByRole("heading", { level: 1, name: "ปรับตำแหน่งจุด" });
    const point = okTh.result.adjustable_points[0]!;
    expect(screen.getByRole("heading", { level: 2, name: point.name })).toBeInTheDocument();
    expect(screen.getByText(point.instruction)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "บันทึกตำแหน่ง" })).toBeDisabled();
    loadImage(screen.getByRole("img", { name: `ภาพของคุณ สำหรับวางจุด${point.name}` }), 1600, 1800);
    const marker = await screen.findByRole("button", { name: point.name });
    marker.focus();
    for (let i = 0; i < 6; i++) await user.keyboard("{Shift>}{ArrowUp}{/Shift}");
    await user.click(screen.getByRole("button", { name: "บันทึกตำแหน่ง" }));

    await screen.findByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" });
    expect(calls.adjust).toEqual([{ result_token: "fixture-token-frontal", overrides: { trichion: { x: 800, y: 490 } }, locale: "th" }]);
    expect(calls.overlay).toEqual([
      {
        result_token: "fixture-token-frontal-adjusted",
        layers: ["landmarks", "thirds", "fifths", "eyes_brows", "nose_lips", "labels"],
        locale: "th",
      },
    ]);
    await waitFor(() => expect(screen.getByRole("status", { name: "" })).toHaveTextContent("บันทึกตำแหน่งแล้ว"), { timeout: 2000 });
    const flag = adjustedTh.result.metrics.F1_upper_third.flags[0]!.text;
    expect(screen.getAllByText(flag).length).toBeGreaterThan(0);
    expect(screen.getByRole("img", { name: "ภาพของคุณพร้อมเส้นการวัด" }).getAttribute("src")).toMatch(/^blob:/);

    // Reset to automatic: the original result again, and no request.
    await user.click(screen.getByRole("link", { name: "ปรับตำแหน่งจุด" }));
    await user.click(await screen.findByRole("button", { name: "กลับไปใช้ตำแหน่งอัตโนมัติ" }));
    await screen.findByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" });
    expect(screen.queryByText(flag)).toBeNull();
    expect(calls.adjust).toHaveLength(1);
    expect(calls.overlay).toHaveLength(1);
    expect(screen.getByRole("img", { name: "ภาพของคุณพร้อมเส้นการวัด" }).getAttribute("src")).toMatch(/^data:/);

    // Nothing about the face was stored.
    expect(Object.keys({ ...window.localStorage })).toEqual([STORAGE_KEYS.subject]);
  });

  it("shows the full protocol after three failures in a row", async () => {
    const { user } = await toGuide(["no_face"]);
    for (let i = 1; i <= 3; i++) {
      await takeAndSend(user);
      await screen.findByRole("heading", { level: 1, name: "กรุณาถ่ายภาพใหม่" });
      if (i < 3) expect(screen.queryByTestId("full-protocol")).toBeNull();
    }
    const protocol = screen.getByTestId("full-protocol");
    for (const text of configTh.strings.capture.frontal.steps) expect(within(protocol).getByText(text)).toBeInTheDocument();
  });

  it("refuses a file that is not a photo before sending anything", async () => {
    const { user, calls } = await toGuide(["ok"]);
    // On a desktop: how to move a photo from the phone without losing its camera details.
    expect(screen.getByText(/แอปแชตมักย่อขนาดภาพหรือลบข้อมูลกล้อง/)).toBeInTheDocument();
    await user.upload(screen.getByTestId("input-library"), new File(["%PDF-1.7"], "scan.jpg", { type: "image/jpeg" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ไฟล์นี้ไม่ใช่ภาพที่บริการใช้ได้");
    expect(calls.analyze).toHaveLength(0);
  });

  it("warns about a front-camera photo and lets it through", async () => {
    const { user } = await toGuide(["ok"]);
    await user.upload(screen.getByTestId("input-camera"), new File([new Uint8Array(fixtureBytes("photo_front.jpg"))], "selfie.jpg", { type: "image/jpeg" }));
    await screen.findByRole("heading", { level: 1, name: "ตรวจสอบภาพ" });
    expect(screen.getByText(/น่าจะถ่ายด้วยกล้องหน้า/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ใช้ภาพนี้" })).toBeEnabled();
  });

  it("asks to place a point the core could not find", async () => {
    const { user } = await toGuide(["ok_no_hairline"]);
    await takeAndSend(user);
    await screen.findByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" });
    await user.click(screen.getByRole("link", { name: "ปรับตำแหน่งจุด" }));
    expect(await screen.findByText(/กรุณาแตะภาพเพื่อวางจุด/)).toBeInTheDocument();
    loadImage(screen.getByRole("img", { name: /สำหรับวางจุด/ }), 1600, 1800);
    expect(screen.queryByTestId("adjust-marker")).toBeNull();
  });

  it("moves the point one pixel per arrow-button press, from any input (WCAG 2.5.7)", async () => {
    const { user, calls } = await toGuide(["ok"]);
    await takeAndSend(user);
    await user.click(await screen.findByRole("link", { name: "ปรับตำแหน่งจุด" }));
    loadImage(screen.getByRole("img", { name: /สำหรับวางจุด/ }), 1600, 1800);
    const pad = await screen.findByRole("group", { name: "เลื่อนจุด" });
    const auto = okTh.result.landmarks.trichion;
    // A pointer press (pointerdown, pointerup, click) counts once.
    await user.click(within(pad).getByRole("button", { name: "ขึ้น" }));
    // TalkBack, Voice Access and screen readers in browse mode send a click alone.
    fireEvent.click(within(pad).getByRole("button", { name: "ซ้าย" }));
    // The keyboard: Enter on the focused button.
    within(pad).getByRole("button", { name: "ขึ้น" }).focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "บันทึกตำแหน่ง" }));
    await screen.findByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" });
    expect(calls.adjust[0]).toMatchObject({ overrides: { trichion: { x: auto.x! - 1, y: auto.y! - 2 } } });
  });

  it("keeps the hints' language on them when the interface switches (no results yet)", async () => {
    const { user } = await toGuide(["quality_failed"]);
    await takeAndSend(user);
    await screen.findByRole("heading", { level: 1, name: "กรุณาถ่ายภาพใหม่" });
    await user.click(within(screen.getByRole("banner")).getByRole("button", { name: "English" }));
    await screen.findByRole("heading", { level: 1, name: "Please take the photo again" });
    expect(document.documentElement.lang).toBe("en");
    expect(screen.getByTestId("hints")).toHaveAttribute("lang", "th");
    expect(within(screen.getByTestId("hints")).getAllByRole("listitem").map((li) => li.textContent)).toEqual(failedTh.hints);
  });

  it("a language switch loads that language's settings first, so the photo is sent once", async () => {
    // Switching before the new language's client-config had arrived unmounted the analyzing
    // screen; when the config came before React Router's pending navigation, the screen came
    // back and sent its photo again. The switch now waits for the config (slow here).
    server.use(
      http.get(`${MOCK_API}/v1/client-config`, async ({ request }) => {
        if (new URL(request.url).searchParams.get("locale") !== "en") return undefined;
        await delay(150);
        return HttpResponse.json(configEn, { headers: CORS_HEADERS });
      }),
    );
    const { user, calls, services } = await toGuide(["ok"]);
    const ready: boolean[] = [];
    const onChange = (lng: string) => ready.push(services.configLoader.peek(lng as "th" | "en") !== undefined);
    i18n.on("languageChanged", onChange);
    await takeAndSend(user);
    await screen.findByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" });
    await user.click(within(screen.getByRole("banner")).getByRole("button", { name: "English" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "เปลี่ยนภาษาและวิเคราะห์อีกครั้ง" }));
    await screen.findByRole("heading", { level: 1, name: "Front photo results" }, { timeout: 3000 });
    i18n.off("languageChanged", onChange);
    expect(ready).toEqual([true]);
    expect(calls.analyze.map((c) => c.meta.locale)).toEqual(["th", "en"]);
  });

  it("refuses to adjust when the shown photo does not match the result's size", async () => {
    const { user } = await toGuide(["ok"]);
    await takeAndSend(user);
    await user.click(await screen.findByRole("link", { name: "ปรับตำแหน่งจุด" }));
    loadImage(screen.getByRole("img", { name: /สำหรับวางจุด/ }), 1800, 1600);
    expect(await screen.findByRole("alert")).toHaveTextContent("ภาพที่แสดงไม่ตรงกับภาพที่วิเคราะห์");
    expect(screen.queryByTestId("adjust-marker")).toBeNull();
    expect(screen.getByRole("button", { name: "บันทึกตำแหน่ง" })).toBeDisabled();
  });
});

describe("errors during the scan", () => {
  async function failWith(code: string, status: number, retryAfter?: number) {
    const { user, calls } = await toGuide(["ok"]);
    server.use(http.post(`${MOCK_API}/v1/frontal/analyze`, () => problem(code, status, { retryAfter })));
    await takeAndSend(user);
    return { user, calls, panel: await screen.findByTestId("scan-error") };
  }

  it("rate limited: says when, and waits", async () => {
    const { panel } = await failWith("rate_limited", 429, 540);
    expect(panel).toHaveTextContent("กรุณาลองอีกครั้งในอีกประมาณ 9 นาที");
    expect(within(panel).getByRole("button", { name: "ลองอีกครั้ง" })).toBeDisabled();
  });

  it("a photo the service refuses goes back to capture", async () => {
    const { panel } = await failWith("too_many_pixels", 422);
    expect(panel).toHaveTextContent("ภาพมีจำนวนพิกเซลมากกว่าที่บริการรับได้");
    expect(within(panel).getByRole("button", { name: "ถ่ายใหม่" })).toBeInTheDocument();
  });

  it("too long: one retry is offered, then another photo", async () => {
    const { user, panel } = await failWith("analysis_timeout", 504);
    expect(panel).toHaveTextContent("การวิเคราะห์ใช้เวลานานเกินไป");
    expect(within(panel).queryByRole("button", { name: "ถ่ายใหม่" })).toBeNull();
    await user.click(within(panel).getByRole("button", { name: "ลองอีกครั้ง" }));
    const again = await screen.findByTestId("scan-error");
    await waitFor(() => expect(within(again).queryByRole("button", { name: "ลองอีกครั้ง" })).toBeNull());
    expect(within(again).getByRole("button", { name: "ถ่ายใหม่" })).toBeInTheDocument();
  });
});
