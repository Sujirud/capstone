import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./mocks/server";

// jsdom has no ResizeObserver; Radix (radio items) and the action bar observe sizes.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

// jsdom cannot make object URLs for these blobs (Vitest's shim fails on them); the app
// only needs unique strings it can revoke.
let urlCount = 0;
URL.createObjectURL = () => `blob:test/${++urlCount}`;
URL.revokeObjectURL = () => undefined;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  cleanup();
  window.localStorage.clear();
  window.location.hash = "";
});
afterAll(() => server.close());
