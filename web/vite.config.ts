import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The site and the API share one origin: the dev and preview servers forward
// /v1 to the API at API_URL, so one tunnel brings both to phones. The tunnel's hostnames are
// allowed; localhost and IP addresses always are.
const proxy = { "/v1": process.env.API_URL ?? "http://127.0.0.1:8000" };
const allowedHosts = [".trycloudflare.com"];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true, proxy, allowedHosts },
  preview: { port: 4173, strictPort: true, proxy, allowedHosts },
  build: { target: "es2022" },
  // Live mode loads MediaPipe on demand; prebundled, so opening it does not reload the dev page.
  optimizeDeps: { include: ["@mediapipe/tasks-vision"] },
});
