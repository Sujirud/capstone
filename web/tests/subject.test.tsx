import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import configTh from "../fixtures/client_config.th.json" with { type: "json" };
import { STORAGE_KEYS } from "../src/app/storage";
import { loadLastSubject, parseAge } from "../src/scan/subject";
import { clientConfig, clientConfigUnreachable, MOCK_API, problem } from "./mocks/handlers";
import { server } from "./mocks/server";
import { renderApp } from "./renderApp";

describe("age parsing", () => {
  it("accepts whole years from 1 to 120 only", () => {
    expect(parseAge("21")).toBe(21);
    expect(parseAge(" 1 ")).toBe(1);
    expect(parseAge("120")).toBe(120);
    expect(parseAge("๒๑")).toBe(21);
    for (const bad of ["", "0", "121", "20.5", "-3", "๒๑๑", "1e2", "abc"]) expect(parseAge(bad), bad).toBeNull();
  });
});

describe("subject form", () => {
  it("asks one question per screen, validates inline, saves the form and shows the guide verbatim", async () => {
    const user = userEvent.setup();
    await renderApp("/subject");
    expect(await screen.findByRole("heading", { level: 1, name: "เพศของคุณ" })).toBeInTheDocument();
    expect(screen.getByText("ขั้นที่ 1 จาก 4 · ข้อมูลของคุณ")).toBeInTheDocument();
    const group = screen.getByRole("radiogroup", { name: "เพศของคุณ" });
    expect(group).toHaveAccessibleDescription("ใช้เพื่อเลือกค่าอ้างอิงเท่านั้น");

    await user.click(screen.getByRole("button", { name: "ดำเนินการต่อ" }));
    expect(screen.getByText("กรุณาเลือกหนึ่งตัวเลือก")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "ไม่ระบุ" }));
    await user.click(screen.getByRole("button", { name: "ดำเนินการต่อ" }));

    expect(await screen.findByRole("heading", { level: 1, name: "อายุของคุณ" })).toHaveFocus();
    const age = screen.getByLabelText("อายุ (ปี)");
    expect(age).toHaveAttribute("inputmode", "numeric");
    await user.type(age, "130");
    await user.click(screen.getByRole("button", { name: "ดำเนินการต่อ" }));
    expect(age).toHaveAttribute("aria-invalid", "true");
    expect(age).toHaveAccessibleDescription(expect.stringContaining("กรุณากรอกอายุเป็นจำนวนเต็มปี"));
    await user.clear(age);
    await user.type(age, "21");
    await user.click(screen.getByRole("button", { name: "ดำเนินการต่อ" }));

    const guide = configTh.strings.capture.frontal;
    expect(await screen.findByRole("heading", { level: 1, name: guide.title })).toBeInTheDocument();
    for (const text of guide.steps) expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByText("ระยะห่างที่แนะนำ: ประมาณ 1.5 เมตร")).toBeInTheDocument();
    expect(loadLastSubject()).toEqual({ sex: "unspecified", age: 21 });
  });

  it("is prefilled from the last scan on this device", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(STORAGE_KEYS.subject, JSON.stringify({ sex: "male", age: 34 }));
    await renderApp("/subject", { language: "en" });
    expect(await screen.findByRole("radio", { name: "Male" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByLabelText("Age in years")).toHaveValue("34");
  });

  it("ignores a stored form that is not valid", () => {
    window.localStorage.setItem(STORAGE_KEYS.subject, "{\"sex\":\"other\",\"age\":500}");
    expect(loadLastSubject()).toEqual({});
    window.localStorage.setItem(STORAGE_KEYS.subject, "not json");
    expect(loadLastSubject()).toEqual({});
  });

  it("follows the landing page's Start", async () => {
    const user = userEvent.setup();
    await renderApp("/");
    await screen.findByRole("heading", { level: 1, name: "วัดสัดส่วนใบหน้า" });
    await user.click(screen.getByRole("link", { name: "เริ่มต้น" }));
    expect(await screen.findByRole("heading", { level: 1, name: "เพศของคุณ" })).toBeInTheDocument();
    await user.click(within(screen.getByRole("banner")).getByRole("button", { name: "ย้อนกลับ" }));
    expect(await screen.findByRole("heading", { level: 1, name: "วัดสัดส่วนใบหน้า" })).toBeInTheDocument();
  });
});

describe("client-config", () => {
  it("shows that the service is not reachable, with a retry, and does not start a scan", async () => {
    const user = userEvent.setup();
    server.use(clientConfigUnreachable);
    await renderApp("/subject", { language: "en" });
    expect(await screen.findByRole("heading", { level: 1, name: "The service is not reachable" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    server.use(clientConfig);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Your sex" })).toBeInTheDocument();
  });

  it("shows the problem's message and request id when the service answers with an error", async () => {
    server.use(http.get(`${MOCK_API}/v1/client-config`, () => problem("internal_error", 500, { requestId: "req_abc" })));
    await renderApp("/subject", { language: "en" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Something unexpected went wrong. Please try again.");
    expect(alert).toHaveTextContent("Request ID: req_abc");
    expect(alert).not.toHaveTextContent("mock detail");
  });

  it("refuses a config that lacks what the UI reads", async () => {
    server.use(http.get(`${MOCK_API}/v1/client-config`, () => HttpResponse.json({ ...configTh, strings: {} })));
    await renderApp("/subject");
    expect(await screen.findByRole("heading", { level: 1, name: "ติดต่อบริการไม่ได้" })).toBeInTheDocument();
  });
});
