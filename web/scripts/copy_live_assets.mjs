// Copies what live mode loads (no third-party requests) into public/:
//
// - models/face_landmarker.task: the server's model from ../models, checked against the
//   SHA-256 pinned in facescan/tools/download_models.py (get it with
//   `python facescan/tools/download_models.py --dest models` from the repository root);
// - mediapipe/: MediaPipe's WebAssembly files from the pinned @mediapipe/tasks-vision package.
//
// Both folders are generated, not committed. `pnpm build` runs this and fails without the
// model; `pnpm dev` and the end-to-end tests run it with --optional, which only warns (live
// mode then cannot start).
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(web, "..");
const optional = process.argv.includes("--optional");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fail(message) {
  if (optional) {
    console.warn(`warning: ${message}; live mode will not start`);
    return;
  }
  console.error(`error: ${message}`);
  process.exit(1);
}

// The model, as the core pins it.
const pins = readFileSync(join(repo, "facescan", "tools", "download_models.py"), "utf8");
const pin = /"face_landmarker\.task":\s*\(\s*"[^"]+",\s*"([0-9a-f]{64})"/.exec(pins)?.[1];
const model = join(repo, "models", "face_landmarker.task");
const target = join(web, "public", "models", "face_landmarker.task");
if (!pin) {
  fail("no SHA-256 pin for face_landmarker.task in facescan/tools/download_models.py");
} else if (!existsSync(model)) {
  fail(`${model} is missing (python facescan/tools/download_models.py --dest models)`);
} else if (sha256(model) !== pin) {
  fail(`${model} does not match the pinned SHA-256 ${pin}`);
} else if (!existsSync(target) || sha256(target) !== pin) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(model, target);
  console.log("copied models/face_landmarker.task");
}

// MediaPipe's WebAssembly (FilesetResolver picks the SIMD build where the browser has SIMD).
const pkg = join(web, "node_modules", "@mediapipe", "tasks-vision");
const out = join(web, "public", "mediapipe");
mkdirSync(out, { recursive: true });
for (const name of ["vision_wasm_internal", "vision_wasm_nosimd_internal"]) {
  for (const ext of [".js", ".wasm"]) {
    const src = join(pkg, "wasm", name + ext);
    const dst = join(out, name + ext);
    if (existsSync(dst) && sha256(dst) === sha256(src)) continue;
    copyFileSync(src, dst);
    console.log(`copied mediapipe/${name}${ext}`);
  }
}
const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
writeFileSync(join(out, "NOTICE.txt"), `MediaPipe Tasks Vision ${version} (@mediapipe/tasks-vision), Apache License 2.0.\n`);
