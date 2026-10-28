import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, createApiClient, parseRetryAfter } from "../src/api/client";
import { createClientConfigLoader } from "../src/api/clientConfig";
import { CORS_HEADERS, MOCK_API, problem } from "./mocks/handlers";
import { server } from "./mocks/server";

const Ok = z.object({ ok: z.literal(true) });

function client() {
  const sleep = vi.fn(async () => {});
  const api = createApiClient({ baseUrl: MOCK_API, sleep });
  return { api, sleep };
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected an ApiError");
}

describe("parseRetryAfter", () => {
  it("reads delta-seconds and HTTP dates", () => {
    expect(parseRetryAfter("120")).toBe(120);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    const now = Date.parse("2026-09-28T00:00:00Z");
    expect(parseRetryAfter("Mon, 28 Sep 2026 00:01:30 GMT", now)).toBe(90);
  });
});

describe("api client", () => {
  it("turns a problem into its code, request id and Retry-After, and drops detail", async () => {
    server.use(http.get(`${MOCK_API}/p`, () => problem("rate_limited", 429, { retryAfter: 600, requestId: "req_42" })));
    const err = await failure(client().api.request({ path: "/p", schema: Ok }));
    expect(err).toMatchObject({ code: "rate_limited", status: 429, requestId: "req_42", retryAfterS: 600 });
    expect(JSON.stringify(err)).not.toContain("mock detail");
    expect(err.message).not.toContain("mock detail");
  });

  it("retries a busy service once after Retry-After (≤ 10 s)", async () => {
    let calls = 0;
    server.use(
      http.get(`${MOCK_API}/p`, () => {
        calls += 1;
        return calls === 1 ? problem("overloaded", 503, { retryAfter: 2 }) : HttpResponse.json({ ok: true }, { headers: CORS_HEADERS });
      }),
    );
    const { api, sleep } = client();
    await expect(api.request({ path: "/p", schema: Ok })).resolves.toMatchObject({ data: { ok: true } });
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledWith(2000, undefined);
  });

  it("asks after the second busy answer, and never waits longer than 10 s on its own", async () => {
    let calls = 0;
    server.use(
      http.get(`${MOCK_API}/p`, () => {
        calls += 1;
        return problem("not_ready", 503, { retryAfter: 5 });
      }),
      http.get(`${MOCK_API}/slow`, () => problem("overloaded", 503, { retryAfter: 30 })),
    );
    const { api, sleep } = client();
    expect((await failure(api.request({ path: "/p", schema: Ok }))).code).toBe("not_ready");
    expect(calls).toBe(2);
    sleep.mockClear();
    expect((await failure(api.request({ path: "/slow", schema: Ok }))).code).toBe("overloaded");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("reports network failures and bodies that fail validation", async () => {
    server.use(
      http.get(`${MOCK_API}/down`, () => HttpResponse.error()),
      http.get(`${MOCK_API}/odd`, () => HttpResponse.json({ ok: "yes" }, { headers: CORS_HEADERS })),
    );
    const { api } = client();
    expect((await failure(api.request({ path: "/down", schema: Ok }))).code).toBe("network");
    expect((await failure(api.request({ path: "/odd", schema: Ok }))).code).toBe("bad_response");
  });

  it("classifies gateway answers without a problem document by status", async () => {
    server.use(
      http.post(`${MOCK_API}/big`, () => new HttpResponse("<html>413</html>", { status: 413, headers: CORS_HEADERS })),
      http.get(`${MOCK_API}/teapot`, () => new HttpResponse("no", { status: 418, headers: CORS_HEADERS })),
    );
    const { api } = client();
    expect((await failure(api.request({ path: "/big", method: "POST", json: {}, schema: Ok }))).code).toBe(
      "payload_too_large",
    );
    expect((await failure(api.request({ path: "/teapot", schema: Ok }))).code).toBe("bad_response");
  });
});

describe("client-config loader", () => {
  it("loads each language once and validates it", async () => {
    let calls = 0;
    server.events.on("request:start", ({ request }) => {
      if (request.url.includes("client-config")) calls += 1;
    });
    const loader = createClientConfigLoader(client().api);
    const th = await loader.load("th");
    expect(th.locale).toBe("th");
    expect(th.strings.capture.frontal.steps.length).toBeGreaterThan(0);
    await loader.load("th");
    expect(loader.peek("th")).toBe(th);
    expect((await loader.load("en")).locale).toBe("en");
    expect(calls).toBe(2);
    server.events.removeAllListeners();
  });

  it("refuses a config in another language", async () => {
    server.use(
      http.get(`${MOCK_API}/v1/client-config`, async () => {
        const { default: body } = await import("../fixtures/client_config.en.json");
        return HttpResponse.json(body, { headers: CORS_HEADERS });
      }),
    );
    const err = await failure(createClientConfigLoader(client().api).load("th"));
    expect(err.code).toBe("bad_response");
  });
});
