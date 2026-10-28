/**
 * End-to-end tests: WebKit and Chromium mobile emulation against the dev
 * server with the API mocked by MSW (@msw/playwright), the DESIGN.md screenshots, and the
 * real-stack checks against a running API, reached through the dev server's /v1 proxy.
 *
 *   pnpm e2e              mocked flows and axe, both engines; live mode's camera in Chromium
 *   pnpm screenshots      docs/screenshots for DESIGN.md
 *   pnpm e2e:real         real API at E2E_API_URL (default http://127.0.0.1:8000)
 */
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const MOCK_PORT = 5174;
const REAL_PORT = 5175;
export const MOCK_API = "http://api.test";
const realStack = process.env.E2E_REAL_STACK === "1";
const ci = Boolean(process.env.CI);

/** Chromium's fake camera, playing a still frame (live mode). */
function fakeCamera(file: string): string[] {
  const path = fileURLToPath(new URL(`fixtures/live/${file}`, import.meta.url));
  return ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${path}`];
}
// Live mode's model and WebAssembly are served from public/ (scripts/copy_live_assets.mjs).
const liveAssets = "node scripts/copy_live_assets.mjs --optional";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure" },
  webServer: [
    {
      command: `${liveAssets} && vite --port ${MOCK_PORT} --strictPort`,
      env: { VITE_API_BASE_URL: MOCK_API },
      url: `http://localhost:${MOCK_PORT}`,
      reuseExistingServer: !ci,
    },
    ...(realStack
      ? [
          {
            command: `${liveAssets} && vite --port ${REAL_PORT} --strictPort`,
            env: { API_URL: process.env.E2E_API_URL ?? "http://127.0.0.1:8000" },
            url: `http://localhost:${REAL_PORT}`,
            reuseExistingServer: !ci,
          },
        ]
      : []),
  ],
  projects: [
    {
      name: "chromium-mobile",
      use: { ...devices["Pixel 7"], baseURL: `http://localhost:${MOCK_PORT}` },
      testIgnore: [/screenshots\.spec/, /real-stack\.spec/, /live-camera\.spec/],
    },
    {
      name: "webkit-mobile",
      use: { ...devices["iPhone 15"], baseURL: `http://localhost:${MOCK_PORT}` },
      testIgnore: [/screenshots\.spec/, /real-stack\.spec/, /live-camera\.spec/],
    },
    {
      // Live mode with a camera: Chromium's fake one (WebKit's test browser has none to fake).
      name: "chromium-camera",
      use: {
        ...devices["Pixel 7"],
        baseURL: `http://localhost:${MOCK_PORT}`,
        launchOptions: { args: fakeCamera("camera_astronaut.mjpeg") },
      },
      testMatch: /live-camera\.spec/,
    },
    {
      name: "screenshots",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://localhost:${MOCK_PORT}`,
        launchOptions: { args: fakeCamera("camera_drawing.mjpeg") },
      },
      testMatch: /screenshots\.spec/,
    },
    {
      name: "real-stack",
      use: { ...devices["Pixel 7"], baseURL: `http://localhost:${REAL_PORT}` },
      testMatch: /real-stack\.spec/,
    },
    {
      // WebKit against the real API: its XHR must deliver the photo's bytes.
      name: "real-stack-webkit",
      use: { ...devices["iPhone 15"], baseURL: `http://localhost:${REAL_PORT}` },
      testMatch: /real-stack\.spec/,
    },
  ],
});
