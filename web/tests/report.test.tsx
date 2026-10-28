/**
 * The report through the real app, with the API mocked from the real
 * API's report fixtures: the latest tokens are sent, every text appears verbatim and in the
 * API's order, the example-rules note, a report without considerations, the measurement
 * tables, keeping the report until the tokens change, an ended scan, and printing.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import configTh from "../fixtures/client_config.th.json" with { type: "json" };
import reportFrontalOnlyTh from "../fixtures/report_frontal_only.th.json" with { type: "json" };
import reportOkEn from "../fixtures/report_ok.en.json" with { type: "json" };
import reportOkTh from "../fixtures/report_ok.th.json" with { type: "json" };
import { STORAGE_KEYS } from "../src/app/storage";
import { AREA_TEXT } from "../src/i18n/areas";
import { CORS_HEADERS, fixtureBytes, MOCK_API, newCalls, problem, scanHandlers } from "./mocks/handlers";
import { server } from "./mocks/server";
import { renderApp } from "./renderApp";

const frontPhoto = () => new File([new Uint8Array(fixtureBytes("photo.jpg"))], "IMG_0001.JPG", { type: "image/jpeg" });
const sidePhoto = () => new File([new Uint8Array(fixtureBytes("profile.jpg"))], "IMG_0002.JPG", { type: "image/jpeg" });

async function toFrontalResults() {
  const calls = newCalls();
  server.use(...scanHandlers({ calls }));
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

async function toProfileResults() {
  const run = await toFrontalResults();
  await run.user.click(screen.getByRole("link", { name: "เพิ่มภาพด้านข้าง" }));
  await screen.findByRole("heading", { level: 1, name: configTh.strings.capture.profile.title });
  await run.user.upload(screen.getByTestId("input-camera"), sidePhoto());
  await run.user.click(await screen.findByRole("button", { name: "ใช้ภาพนี้" }));
  await screen.findByRole("heading", { level: 1, name: "ผลการวัดภาพด้านข้าง" });
  return run;
}

/** The report's texts in document order, to compare with the API's order. */
function textOrder(container: HTMLElement, texts: string[]): number[] {
  const all = container.textContent ?? "";
  return texts.map((text) => all.indexOf(text));
}

describe("report", () => {
  it("sends the latest tokens and renders the report verbatim, in the API's order", async () => {
    const { user, calls } = await toProfileResults();
    await user.click(screen.getByRole("link", { name: "ดูรายงาน" }));
    await screen.findByRole("heading", { level: 1, name: "รายงาน" });
    expect(screen.getByText("ขั้นที่ 4 จาก 4 · รายงาน")).toBeInTheDocument();
    await screen.findByTestId("example-rules");
    expect(calls.report).toEqual([{ frontal_token: "fixture-token-frontal", profile_token: "fixture-token-profile", locale: "th" }]);

    const r = reportOkTh.report;
    const main = screen.getByRole("main");
    // The example-rules note first, then the intro, each consideration, and the disclaimer last.
    expect(screen.getByTestId("example-rules")).toHaveTextContent("กฎตัวอย่าง");
    expect(screen.getByRole("heading", { level: 2, name: r.consideration_intro })).toBeInTheDocument();
    const c = r.considerations[0]!;
    const article = screen.getByRole("article", { name: c.area_text });
    for (const text of [c.severity_text, c.finding, ...c.considerations, c.consult]) expect(article).toHaveTextContent(text);
    for (const m of c.measurements) {
      expect(article).toHaveTextContent(m.name);
      expect(article).toHaveTextContent(m.value_text!);
      expect(article).toHaveTextContent(`${m.reference!.label} ${m.reference!.text}`);
      expect(article).toHaveTextContent(m.status_text);
    }
    const order = textOrder(main, [r.consideration_intro, c.area_text, c.finding, c.consult, r.disclaimer]);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(screen.queryByTestId("no-considerations")).toBeNull();
    // The disclaimer is the report's last text; only the footer (date, versions, links) follows.
    const disclaimer = screen.getByText(r.disclaimer);
    expect(disclaimer.nextElementSibling?.tagName).toBe("FOOTER");
  });

  it("shows every measurement of both photos in tables, verbatim, with their photos", async () => {
    const { user } = await toProfileResults();
    await user.click(screen.getByRole("link", { name: "ดูรายงาน" }));
    await screen.findByTestId("example-rules");
    const r = reportOkTh.report;
    for (const [view, result] of [["ภาพหน้าตรง", r.frontal], ["ภาพด้านข้าง", r.profile!]] as const) {
      const table = screen.getByRole("table", { name: view });
      const rows = [...table.querySelectorAll("th[scope=row]")];
      for (const m of Object.values(result.metrics)) {
        const row = rows.find((th) => th.firstElementChild?.textContent === m.name)!.closest("tr")!;
        if (m.value_text) expect(row).toHaveTextContent(m.value_text);
        if (m.reference) expect(row).toHaveTextContent(m.reference.text);
        expect(row).toHaveTextContent(m.status_text);
        for (const f of m.flags as Array<{ text: string }>) expect(row).toHaveTextContent(f.text);
      }
      const areas = [...new Set(Object.values(result.metrics).filter((m) => m.role === "primary").map((m) => m.area!))];
      const groups = within(table).getAllByRole("rowheader").filter((h) => h.getAttribute("scope") === "rowgroup").map((h) => h.textContent);
      expect(groups.slice(0, areas.length)).toEqual(areas.map((a) => AREA_TEXT.th[a]));
    }
    expect(screen.getAllByRole("img", { name: "ภาพของคุณพร้อมเส้นการวัด" })).toHaveLength(2);
  });

  it("without a side photo: no profile token, and the core's note when there are no topics", async () => {
    const { user, calls } = await toFrontalResults();
    await user.click(screen.getByRole("link", { name: "ดูรายงาน" }));
    expect(await screen.findByTestId("no-considerations")).toHaveTextContent(reportFrontalOnlyTh.report.no_considerations_note!);
    expect(calls.report).toEqual([{ frontal_token: "fixture-token-frontal", locale: "th" }]);
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.queryByRole("table", { name: "ภาพด้านข้าง" })).toBeNull();
    expect(screen.getByRole("table", { name: "ภาพหน้าตรง" })).toBeInTheDocument();
  });

  it("shows no example-rules note for other rules", async () => {
    const { user } = await toFrontalResults();
    const real = { ...reportFrontalOnlyTh, report: { ...reportFrontalOnlyTh.report, rules_version: "2026-10" } };
    server.use(http.post(`${MOCK_API}/v1/report`, () => HttpResponse.json(real, { headers: CORS_HEADERS })));
    await user.click(screen.getByRole("link", { name: "ดูรายงาน" }));
    await screen.findByTestId("no-considerations");
    expect(screen.queryByTestId("example-rules")).toBeNull();
  });

  it("keeps the report until an adjustment changes a token, then sends the latest", async () => {
    const { user, calls } = await toProfileResults();
    await user.click(screen.getByRole("link", { name: "ดูรายงาน" }));
    await screen.findByTestId("example-rules");
    // Back and forth: the same tokens, no new request.
    await user.click(within(screen.getByRole("banner")).getByRole("button", { name: "ย้อนกลับ" }));
    await screen.findByRole("heading", { level: 1, name: "ผลการวัดภาพด้านข้าง" });
    await user.click(screen.getByRole("link", { name: "ดูรายงาน" }));
    await screen.findByTestId("example-rules");
    expect(calls.report).toHaveLength(1);
    // A side adjustment: the new side token goes with the next report.
    await user.click(within(screen.getByRole("banner")).getByRole("button", { name: "ย้อนกลับ" }));
    await user.click(await screen.findByRole("link", { name: "ปรับตำแหน่งจุด" }));
    const img = await screen.findByRole("img", { name: /สำหรับวางจุด/ });
    Object.defineProperty(img, "naturalWidth", { value: 1000 });
    Object.defineProperty(img, "naturalHeight", { value: 1300 });
    fireEvent.load(img);
    screen.getByTestId("adjust-marker").focus();
    await user.keyboard("{ArrowDown}");
    await user.click(screen.getByRole("button", { name: "บันทึกตำแหน่ง" }));
    await screen.findByRole("heading", { level: 1, name: "ผลการวัดภาพด้านข้าง" });
    await user.click(screen.getByRole("link", { name: "ดูรายงาน" }));
    await waitFor(() => expect(calls.report).toHaveLength(2));
    expect(calls.report[1]).toEqual({ frontal_token: "fixture-token-frontal", profile_token: "fixture-token-profile-adjusted", locale: "th" });
  });

  it("an ended scan analyzes both photos again and comes back to the report", async () => {
    const { user, calls } = await toProfileResults();
    let stale = true;
    server.use(
      http.post(`${MOCK_API}/v1/report`, () => {
        if (!stale) return undefined;
        stale = false;
        return problem("token_stale", 400);
      }),
    );
    await user.click(screen.getByRole("link", { name: "ดูรายงาน" }));
    const panel = await screen.findByTestId("scan-error");
    await user.click(within(panel).getByRole("button", { name: "วิเคราะห์ภาพเดิมทั้งสองภาพอีกครั้ง" }));
    await screen.findByTestId("example-rules", {}, { timeout: 3000 });
    expect(screen.getByRole("heading", { level: 1, name: "รายงาน" })).toBeInTheDocument();
    expect(calls.analyze).toHaveLength(2);
    expect(calls.profile).toHaveLength(2);
    expect(calls.report).toHaveLength(1);
  });

  it("a session mismatch offers to start over", async () => {
    const { user } = await toFrontalResults();
    server.use(http.post(`${MOCK_API}/v1/report`, () => problem("session_mismatch", 400)));
    await user.click(screen.getByRole("link", { name: "ดูรายงาน" }));
    const panel = await screen.findByTestId("scan-error");
    expect(panel).toHaveTextContent("เกิดข้อผิดพลาดที่ไม่คาดคิด");
    await user.click(within(panel).getByRole("button", { name: "เริ่มใหม่" }));
    await screen.findByRole("heading", { level: 1, name: "เพศของคุณ" });
  });

  it("saves as PDF or prints through the browser, and switching language gets the report in that language", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    const { user, calls } = await toProfileResults();
    await user.click(screen.getByRole("link", { name: "ดูรายงาน" }));
    await screen.findByTestId("example-rules");
    await user.click(screen.getByRole("button", { name: "บันทึกเป็น PDF หรือพิมพ์" }));
    expect(print).toHaveBeenCalledTimes(1);
    await user.click(within(screen.getByRole("banner")).getByRole("button", { name: "English" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "เปลี่ยนภาษาและวิเคราะห์อีกครั้ง" }));
    await screen.findByRole("heading", { level: 2, name: reportOkEn.report.consideration_intro }, { timeout: 3000 });
    expect(screen.getByRole("heading", { level: 1, name: "Report" })).toBeInTheDocument();
    expect(calls.report.map((b) => b.locale)).toEqual(["th", "en"]);
    // No counts or summaries of findings.
    expect(screen.getByRole("main").textContent).not.toMatch(/\b\d+ (topics?|features?|findings?|considerations?)\b/i);
    expect(calls.analyze.map((c) => c.meta.locale)).toEqual(["th", "en"]);
  });
});
