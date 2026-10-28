/** Uploads through XMLHttpRequest: progress, problems, retry, cancel. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, createApiClient } from "../src/api/client";

type Listener = ((e: ProgressEvent) => void) | null;

/** A scripted XMLHttpRequest: each send() plays the next answer. */
function fakeXhr(answers: Array<{ status: number; body: unknown; headers?: Record<string, string>; progress?: number[] } | "network">) {
  const sent: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }> = [];
  class FakeXhr {
    upload: { onprogress: Listener; onload: Listener } = { onprogress: null, onload: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 0;
    response: ArrayBuffer | null = null;
    responseType = "";
    timeout = 0;
    withCredentials = false;
    private method = "";
    private url = "";
    private headers: Record<string, string> = {};
    private responseHeaders = "";
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v;
    }
    getAllResponseHeaders() {
      return this.responseHeaders;
    }
    private aborted = false;
    abort() {
      this.aborted = true; // like a real XHR: no onload after abort
      queueMicrotask(() => this.onabort?.());
    }
    send(body: unknown) {
      sent.push({ method: this.method, url: this.url, headers: this.headers, body });
      const answer = answers.shift()!;
      queueMicrotask(() => {
        if (this.aborted) return;
        if (answer === "network") return this.onerror?.();
        for (const p of answer.progress ?? [0.5, 1]) this.upload.onprogress?.({ lengthComputable: true, loaded: p * 100, total: 100 } as ProgressEvent);
        this.upload.onload?.({} as ProgressEvent);
        this.status = answer.status;
        this.response = new TextEncoder().encode(JSON.stringify(answer.body)).buffer as ArrayBuffer;
        this.responseHeaders = Object.entries({ "Content-Type": "application/json", ...answer.headers })
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n");
        this.onload?.();
      });
    }
  }
  return { make: () => new FakeXhr() as unknown as XMLHttpRequest, sent };
}

const Ok = z.object({ ok: z.literal(true) });
const problem = (code: string, status: number) => ({ type: "about:blank", title: "x", status, detail: "d", code, request_id: "req_x" });

function client(xhr: ReturnType<typeof fakeXhr>) {
  const sleep = vi.fn(async () => {});
  const api = createApiClient({ baseUrl: "http://api.test", xhr: xhr.make, sleep });
  return { api, sleep };
}

function upload(api: ReturnType<typeof client>["api"], extra: { signal?: AbortSignal } = {}) {
  const progress: number[] = [];
  const uploaded = vi.fn();
  const form = new FormData();
  form.append("meta", "{}");
  const promise = api.request({
    path: "/v1/frontal/analyze",
    method: "POST",
    form,
    schema: Ok,
    onUploadProgress: (f) => progress.push(f),
    onUploaded: uploaded,
    ...extra,
  });
  return { promise, progress, uploaded };
}

describe("uploads", () => {
  it("report real progress, then the body is done", async () => {
    const xhr = fakeXhr([{ status: 200, body: { ok: true }, progress: [0.1, 0.45, 1] }]);
    const { promise, progress, uploaded } = upload(client(xhr).api);
    await expect(promise).resolves.toMatchObject({ data: { ok: true } });
    expect(progress).toEqual([0.1, 0.45, 1, 1]);
    expect(uploaded).toHaveBeenCalledOnce();
    expect(xhr.sent[0]).toMatchObject({ method: "POST", url: "http://api.test/v1/frontal/analyze" });
    expect(xhr.sent[0]!.body).toBeInstanceOf(FormData);
  });

  it("map problems like fetch does", async () => {
    const xhr = fakeXhr([{ status: 413, body: problem("payload_too_large", 413) }]);
    const a = await upload(client(xhr).api).promise.catch((e: unknown) => e);
    expect(a).toBeInstanceOf(ApiError);
    expect(a).toMatchObject({ code: "payload_too_large", requestId: "req_x" });
  });

  it("send the photo again once when the service is busy", async () => {
    const xhr = fakeXhr([{ status: 503, body: problem("overloaded", 503), headers: { "Retry-After": "2" } }, { status: 200, body: { ok: true } }]);
    const c = client(xhr);
    await expect(upload(c.api).promise).resolves.toMatchObject({ data: { ok: true } });
    expect(xhr.sent).toHaveLength(2);
    expect(c.sleep).toHaveBeenCalledWith(2000, undefined);
  });

  it("report a network failure", async () => {
    const e = await upload(client(fakeXhr(["network"])).api).promise.catch((err: unknown) => err);
    expect(e).toMatchObject({ code: "network" });
  });

  it("can be cancelled", async () => {
    const controller = new AbortController();
    const xhr = fakeXhr([{ status: 200, body: { ok: true } }]);
    const { promise } = upload(client(xhr).api, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});
