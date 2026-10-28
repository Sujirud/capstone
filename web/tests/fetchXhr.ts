/**
 * An XMLHttpRequest stand-in for jsdom tests. jsdom's XHR combined with MSW's interceptor
 * fails on FormData that holds a File, so this encodes the multipart body itself and sends
 * it with Node's fetch (which MSW intercepts), firing the same upload events. Real
 * browsers use the real XHR (the Playwright tests cover them).
 */
type Handler<E = ProgressEvent> = ((e: E) => void) | null;

async function multipart(form: FormData): Promise<{ body: Uint8Array; type: string }> {
  const boundary = `----facescan-test-${Math.random().toString(16).slice(2)}`;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    } else {
      const file = value as File;
      parts.push(
        enc.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${file.name}"\r\nContent-Type: ${file.type || "application/octet-stream"}\r\n\r\n`,
        ),
      );
      parts.push(new Uint8Array(await file.arrayBuffer()));
      parts.push(enc.encode("\r\n"));
    }
  }
  parts.push(enc.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    body.set(p, offset);
    offset += p.length;
  }
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

export class FetchXhr {
  upload: { onprogress: Handler; onload: Handler } = { onprogress: null, onload: null };
  onload: Handler<Event> = null;
  onerror: Handler<Event> = null;
  ontimeout: Handler<Event> = null;
  onabort: Handler<Event> = null;
  status = 0;
  response: ArrayBuffer | null = null;
  responseType = "arraybuffer";
  timeout = 0;
  withCredentials = false;
  private method = "GET";
  private url = "";
  private headers: Record<string, string> = {};
  private responseHeaders = "";
  private controller = new AbortController();

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
  abort() {
    this.controller.abort();
  }
  send(body: FormData | string | null) {
    void (async () => {
      try {
        const headers = { ...this.headers };
        let payload: Uint8Array | string | null = null;
        if (body instanceof FormData) {
          const encoded = await multipart(body);
          headers["Content-Type"] = encoded.type;
          // A Node Buffer: Node's fetch refuses typed arrays from jsdom's realm.
          payload = Buffer.from(encoded.body);
        } else payload = body;
        const size = typeof payload === "string" ? payload.length : (payload?.length ?? 0);
        this.upload.onprogress?.({ lengthComputable: true, loaded: size / 2, total: size } as ProgressEvent);
        const response = await fetch(this.url, { method: this.method, headers, body: payload as BodyInit, signal: this.controller.signal });
        this.upload.onprogress?.({ lengthComputable: true, loaded: size, total: size } as ProgressEvent);
        this.upload.onload?.({} as ProgressEvent);
        this.status = response.status;
        this.response = await response.arrayBuffer();
        this.responseHeaders = [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\r\n");
        this.onload?.(new Event("load"));
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") this.onabort?.(new Event("abort"));
        else this.onerror?.(new Event("error"));
      }
    })();
  }
}
