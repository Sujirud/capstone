/**
 * The side-photo flow through the real app, with the API mocked from the core's fixtures:
 * frontal results → guide with the facing choice →
 * contour failed → retake → ok → the alar crease placed by a tap, a silhouette point slid
 * along the contour → save → overlay redraw → reset.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import configEn from "../fixtures/client_config.en.json" with { type: "json" };
import configTh from "../fixtures/client_config.th.json" with { type: "json" };
import contourFailedTh from "../fixtures/profile_contour_failed.th.json" with { type: "json" };
import profileAdjustedTh from "../fixtures/profile_adjusted.th.json" with { type: "json" };
import profileOkTh from "../fixtures/profile_ok.th.json" with { type: "json" };
import { STORAGE_KEYS } from "../src/app/storage";
import { makeTrack, projectOntoTrack, slideAlong, type Polyline } from "../src/components/adjust/contour";
import { fixtureBytes, MOCK_API, newCalls, problem, scanHandlers, type ProfileOutcome } from "./mocks/handlers";
import { server } from "./mocks/server";
import { renderApp } from "./renderApp";

const LAYERS = ["landmarks", "profile_lines", "labels"];
const frontPhoto = () => new File([new Uint8Array(fixtureBytes("photo.jpg"))], "IMG_0001.JPG", { type: "image/jpeg" });
const sidePhoto = () => new File([new Uint8Array(fixtureBytes("profile.jpg"))], "IMG_0002.JPG", { type: "image/jpeg" });
type User = ReturnType<typeof userEvent.setup>;

/** Subject → frontal photo → frontal results. */
async function toFrontalResults(profileOutcomes: ProfileOutcome[] = ["ok"]) {
  const calls = newCalls();
  server.use(...scanHandlers({ profileOutcomes, calls }));
  window.localStorage.setItem(STORAGE_KEYS.subject, JSON.stringify({ sex: "female", age: 21 }));
  const user = userEvent.setup();
  await renderApp("/subject");
  await user.click(await screen.findByRole("button", { name: "ดำเนินการต่อ" }));
  await user.click(await screen.findByRole("button", { name: "ดำเนินการต่อ" }));
  await screen.findByRole("heading", { level: 1, name: configTh.strings.capture.frontal.title });
  await user.upload(screen.getByTestId("input-camera"), frontPhoto());
  await user.click(await screen.findByRole("button", { name: "ใช้ภาพนี้" }));
  await screen.findByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" });
  return { user, calls };
}

async function sendSidePhoto(user: User) {
  await user.upload(screen.getByTestId("input-camera"), sidePhoto());
  await screen.findByRole("heading", { level: 1, name: "ตรวจสอบภาพ" });
  await user.click(screen.getByRole("button", { name: "ใช้ภาพนี้" }));
}

async function toProfileResults(profileOutcomes: ProfileOutcome[] = ["ok"]) {
  const run = await toFrontalResults(profileOutcomes);
  await run.user.click(screen.getByRole("link", { name: "เพิ่มภาพด้านข้าง" }));
  await screen.findByRole("heading", { level: 1, name: configTh.strings.capture.profile.title });
  await sendSidePhoto(run.user);
  return run;
}

/** jsdom does not load images: report the photo's natural size as a browser would. */
function loadImage(img: HTMLElement, width: number, height: number) {
  Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
  fireEvent.load(img);
}

/** jsdom does no layout: give the photo surface a size (half the photo's) at the page's origin. */
function layOut(surface: HTMLElement, width: number, height: number) {
  Object.defineProperty(surface, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(surface, "clientHeight", { value: height, configurable: true });
  surface.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON: () => ({}) });
}

describe("profile flow (photo mode)", () => {
  it("guide → contour failed → retake → results → place the alar crease → slide the nose tip → save → reset", async () => {
    const { user, calls } = await toFrontalResults(["contour_failed", "ok"]);

    // The side photo is offered after the frontal results.
    await user.click(screen.getByRole("link", { name: "เพิ่มภาพด้านข้าง" }));
    await screen.findByRole("heading", { level: 1, name: configTh.strings.capture.profile.title });
    expect(screen.getByText("ขั้นที่ 3 จาก 4 · ภาพด้านข้าง")).toBeInTheDocument();
    for (const text of configTh.strings.capture.profile.steps) expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByText(/แอปแชตมักย่อขนาดภาพหรือลบข้อมูลกล้อง/)).toBeInTheDocument();
    // Which way the nose points: right by default; the person turns the other way here.
    const facing = screen.getByRole("radiogroup", { name: "ในภาพ ปลายจมูกชี้ไปทาง" });
    expect(within(facing).getByRole("radio", { name: "ขวา" })).toBeChecked();
    await user.click(within(facing).getByRole("radio", { name: "ซ้าย" }));

    // The preview shows the choice again, to check it against the photo.
    await user.upload(screen.getByTestId("input-camera"), sidePhoto());
    await screen.findByRole("heading", { level: 1, name: "ตรวจสอบภาพ" });
    expect(screen.getByText("ตรวจสอบว่าปลายจมูกในภาพชี้ไปทางนี้")).toBeInTheDocument();
    expect(within(screen.getByRole("radiogroup")).getByRole("radio", { name: "ซ้าย" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "ใช้ภาพนี้" }));

    // contour_failed is handled like quality_failed: the core's hints, the checks, retake.
    await screen.findByRole("heading", { level: 1, name: "กรุณาถ่ายภาพใหม่" });
    const hints = within(screen.getByTestId("hints")).getAllByRole("listitem").map((li) => li.textContent);
    expect(hints).toEqual(contourFailedTh.hints);
    const names = contourFailedTh.failed_checks.map((id) => configTh.strings.check[id as keyof typeof configTh.strings.check]);
    const checks = within(screen.getByRole("region", { name: "รายการที่ยังไม่ผ่าน" })).getAllByRole("listitem").map((li) => li.textContent);
    expect(checks).toEqual(names);
    expect(screen.getByRole("radiogroup", { name: "ในภาพ ปลายจมูกชี้ไปทาง" })).toBeInTheDocument();

    // What was sent: the photo unchanged, the facing chosen, the latest frontal token, the
    // profile layers, and no subject.
    expect(calls.profile[0]).toEqual({
      meta: { facing: "left", locale: "th", overlay: { layers: LAYERS }, frontal_token: "fixture-token-frontal" },
      image: { name: "IMG_0002.JPG", type: "image/jpeg", size: fixtureBytes("profile.jpg").length, head: [0xff, 0xd8, 0xff, 0xe0] },
      parts: ["image", "meta"],
    });

    await sendSidePhoto(user);
    await screen.findByRole("heading", { level: 1, name: "ผลการวัดภาพด้านข้าง" });
    expect(screen.getByRole("img", { name: "ภาพของคุณพร้อมเส้นการวัด" }).getAttribute("src")).toMatch(/^data:image\/jpeg;base64,/);
    for (const m of Object.values(profileOkTh.result.metrics).filter((m) => m.role === "primary")) {
      expect(screen.getAllByText(m.name).length).toBeGreaterThan(0);
    }
    expect(screen.getByText(profileOkTh.result.disclaimer)).toBeInTheDocument();
    expect(screen.queryByText(/ไม่สามารถใช้มาตราส่วนจากภาพหน้าตรง/)).toBeNull(); // the scale was transferred

    // The alar crease is asked for, by the core's name, because P3a needs it.
    const alar = profileOkTh.result.adjustable_points.find((p) => p.id === "alar_crease")!;
    const prompt = screen.getByTestId("alar-prompt");
    expect(within(prompt).getByRole("heading", { level: 2, name: alar.name })).toBeInTheDocument();
    expect(prompt).toHaveTextContent(profileOkTh.result.metrics.P3a_tip_projection_goode.name);
    expect(within(prompt).getByRole("img")).toBeInTheDocument();
    await user.click(within(prompt).getByRole("link", { name: "วางจุด" }));

    // The adjustment starts on the alar crease: placed by hand, with the drawing.
    await screen.findByRole("heading", { level: 1, name: "ปรับตำแหน่งจุด" });
    expect(screen.getByRole("heading", { level: 2, name: alar.name })).toBeInTheDocument();
    expect(screen.getByText(alar.instruction)).toBeInTheDocument();
    expect(screen.getByText("แตะภาพเพื่อวางจุดนี้ ค่าที่ใช้จุดนี้จะเป็นค่าโดยประมาณ")).toBeInTheDocument();
    const chooser = screen.getByRole("combobox", { name: "จุดที่ต้องการปรับ" });
    expect(within(chooser).getAllByRole("option").map((o) => o.textContent)).toEqual(profileOkTh.result.adjustable_points.map((p) => p.name));
    expect(chooser).toHaveValue("alar_crease");
    loadImage(screen.getByRole("img", { name: `ภาพของคุณ สำหรับวางจุด${alar.name}` }), 1000, 1300);
    await waitFor(() => expect(screen.getByTestId("adjust-surface").querySelector("svg")).not.toBeNull());
    expect(screen.queryByTestId("adjust-marker")).toBeNull(); // not placed yet
    expect(screen.queryByTestId("adjust-track")).toBeNull(); // placed freely, not on the outline

    // A tap places it, where it was tapped (it is not on the silhouette).
    const surface = screen.getByTestId("adjust-surface");
    layOut(surface, 500, 650);
    await user.pointer([
      { keys: "[MouseLeft>]", target: surface, coords: { clientX: 300, clientY: 283.5 } },
      { keys: "[/MouseLeft]", target: surface, coords: { clientX: 300, clientY: 283.5 } },
    ]);
    expect(await screen.findByRole("button", { name: alar.name })).toBeInTheDocument();

    // The nose tip slides along the outline: 3 × Shift+↓ = 30 px toward the chin.
    const tip = profileOkTh.result.adjustable_points.find((p) => p.id === "pronasale")!;
    await user.selectOptions(chooser, tip.name);
    expect(screen.getByRole("heading", { level: 2, name: tip.name })).toBeInTheDocument();
    expect(screen.getByTestId("adjust-track")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "เลื่อนตามเส้นขอบ" })).toBeInTheDocument();
    const marker = screen.getByRole("button", { name: tip.name });
    marker.focus();
    for (let i = 0; i < 3; i++) await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    await user.keyboard("{ArrowLeft}"); // no sideways move off the outline
    await user.click(screen.getByRole("button", { name: "บันทึกตำแหน่ง" }));

    await screen.findByRole("heading", { level: 1, name: "ผลการวัดภาพด้านข้าง" });
    const track = makeTrack(profileOkTh.result.contour as unknown as Polyline);
    const auto = profileOkTh.result.landmarks.pronasale;
    const expected = slideAlong({ x: auto.x!, y: auto.y! }, 30, track);
    expect(calls.adjust).toHaveLength(1);
    const sent = calls.adjust[0] as { result_token: string; locale: string; overrides: Record<string, { x: number; y: number }> };
    expect(sent.result_token).toBe("fixture-token-profile");
    expect(sent.locale).toBe("th");
    expect(Object.keys(sent.overrides).sort()).toEqual(["alar_crease", "pronasale"]);
    expect(sent.overrides.alar_crease).toEqual({ x: 600, y: 567 });
    expect(Object.keys(sent.overrides.pronasale!).sort()).toEqual(["x", "y"]); // never a source
    expect(sent.overrides.pronasale!.x).toBeCloseTo(expected.x, 6);
    expect(sent.overrides.pronasale!.y).toBeCloseTo(expected.y, 6);
    const onOutline = projectOntoTrack(sent.overrides.pronasale!, track).point;
    expect(Math.hypot(onOutline.x - sent.overrides.pronasale!.x, onOutline.y - sent.overrides.pronasale!.y)).toBeLessThan(1e-6);

    // The overlay is redrawn for the new token on the side photo, as uploaded.
    expect(calls.overlay).toEqual([{ result_token: "fixture-token-profile-adjusted", layers: LAYERS, locale: "th" }]);
    expect(calls.overlayImages).toEqual([
      { name: "IMG_0002.JPG", type: "image/jpeg", size: fixtureBytes("profile.jpg").length, head: [0xff, 0xd8, 0xff, 0xe0] },
    ]);
    await waitFor(() => expect(screen.getByRole("status", { name: "" })).toHaveTextContent("บันทึกตำแหน่งแล้ว"), { timeout: 2000 });
    expect(screen.getByRole("img", { name: "ภาพของคุณพร้อมเส้นการวัด" }).getAttribute("src")).toMatch(/^blob:/);
    expect(screen.queryByTestId("alar-prompt")).toBeNull();
    const flag = profileAdjustedTh.result.metrics.P3a_tip_projection_goode.flags[0]!.text;
    expect(screen.getAllByText(flag).length).toBeGreaterThan(0);

    // Reset to automatic: the original result again (the alar crease unplaced), no request.
    await user.click(screen.getByRole("link", { name: "ปรับตำแหน่งจุด" }));
    await user.click(await screen.findByRole("button", { name: "กลับไปใช้ตำแหน่งอัตโนมัติ" }));
    await screen.findByRole("heading", { level: 1, name: "ผลการวัดภาพด้านข้าง" });
    expect(screen.getByTestId("alar-prompt")).toBeInTheDocument();
    expect(screen.queryByText(flag)).toBeNull();
    expect(calls.adjust).toHaveLength(1);
    expect(calls.overlay).toHaveLength(1);

    // Back to the frontal results, which now lead to these results; nothing was stored.
    await user.click(within(screen.getByRole("banner")).getByRole("button", { name: "ย้อนกลับ" }));
    await screen.findByRole("heading", { level: 1, name: "ผลการวัดภาพหน้าตรง" });
    expect(screen.getByRole("link", { name: "ดูผลการวัดภาพด้านข้าง" })).toBeInTheDocument();
    expect(Object.keys({ ...window.localStorage })).toEqual([STORAGE_KEYS.subject]);
  });

  it("notes that millimetre values are missing when the frontal scale could not be used (request 3 in ASSUMPTIONS.md)", async () => {
    await toProfileResults(["no_scale"]);
    await screen.findByRole("heading", { level: 1, name: "ผลการวัดภาพด้านข้าง" });
    expect(screen.getByText("ไม่สามารถใช้มาตราส่วนจากภาพหน้าตรงกับภาพนี้ได้ จึงไม่แสดงค่าที่เป็นมิลลิเมตร")).toBeInTheDocument();
    expect(screen.getByText(configTh.strings.warning.distance_unverified)).toBeInTheDocument();
  });

  it("shows the full side-photo protocol after three failures in a row", async () => {
    const { user } = await toFrontalResults(["contour_failed"]);
    await user.click(screen.getByRole("link", { name: "เพิ่มภาพด้านข้าง" }));
    await screen.findByRole("heading", { level: 1, name: configTh.strings.capture.profile.title });
    for (let i = 1; i <= 3; i++) {
      await sendSidePhoto(user);
      await screen.findByRole("heading", { level: 1, name: "กรุณาถ่ายภาพใหม่" });
      if (i < 3) expect(screen.queryByTestId("full-protocol")).toBeNull();
    }
    const protocol = screen.getByTestId("full-protocol");
    expect(within(protocol).getByRole("heading", { level: 2, name: configTh.strings.capture.profile.title })).toBeInTheDocument();
    for (const text of configTh.strings.capture.profile.steps) expect(within(protocol).getByText(text)).toBeInTheDocument();
  });

  it("switching language with side results analyzes both photos again, then shows the side results", async () => {
    const { user, calls } = await toProfileResults();
    await screen.findByRole("heading", { level: 1, name: "ผลการวัดภาพด้านข้าง" });
    await user.click(within(screen.getByRole("banner")).getByRole("button", { name: "English" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("วิเคราะห์ภาพเดิมทั้งสองภาพอีกครั้ง");
    await user.click(within(dialog).getByRole("button", { name: "เปลี่ยนภาษาและวิเคราะห์อีกครั้ง" }));
    await screen.findByRole("heading", { level: 1, name: "Side photo results" }, { timeout: 3000 });
    expect(calls.analyze.map((c) => c.meta.locale)).toEqual(["th", "en"]);
    expect(calls.profile.map((c) => c.meta.locale)).toEqual(["th", "en"]);
    expect(calls.profile[1]!.meta.frontal_token).toBe("fixture-token-frontal");
    expect(screen.getAllByText(configEn.strings.reference.canon, { exact: false }).length).toBeGreaterThan(0);
  });

  it("a scan that ended while sending the side photo analyzes both photos again", async () => {
    const { user, calls } = await toFrontalResults();
    let stale = true;
    server.use(
      http.post(`${MOCK_API}/v1/profile/analyze`, () => {
        if (!stale) return undefined;
        stale = false;
        return problem("token_stale", 400);
      }),
    );
    await user.click(screen.getByRole("link", { name: "เพิ่มภาพด้านข้าง" }));
    await sendSidePhoto(user);
    const panel = await screen.findByTestId("scan-error");
    expect(panel).toHaveTextContent("การวัดครั้งนี้สิ้นสุดแล้ว วิเคราะห์ภาพเดิมทั้งสองภาพอีกครั้งหรือเริ่มใหม่ได้");
    await user.click(within(panel).getByRole("button", { name: "วิเคราะห์ภาพเดิมทั้งสองภาพอีกครั้ง" }));
    await screen.findByRole("heading", { level: 1, name: "ผลการวัดภาพด้านข้าง" }, { timeout: 3000 });
    expect(calls.analyze).toHaveLength(2);
    expect(calls.profile).toHaveLength(1);
  });

  it("needs the frontal results first", async () => {
    server.use(...scanHandlers());
    window.localStorage.setItem(STORAGE_KEYS.subject, JSON.stringify({ sex: "female", age: 21 }));
    await renderApp("/scan/profile/guide");
    await screen.findByRole("heading", { level: 1, name: "เพศของคุณ" });
  });
});
