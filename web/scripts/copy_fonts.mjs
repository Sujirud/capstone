// Copies IBM Plex Sans Thai (Thai + Latin subsets, weights 400/500/600) from the pinned
// @fontsource package into public/fonts, so the site serves its own fonts (no
// third-party requests). src/styles/fonts.css declares them with the same
// unicode ranges as the package. Run after upgrading the package: pnpm fonts
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(web, "node_modules", "@fontsource", "ibm-plex-sans-thai");
const out = join(web, "public", "fonts");
mkdirSync(out, { recursive: true });

for (const subset of ["thai", "latin"]) {
  for (const weight of [400, 500, 600]) {
    const name = `ibm-plex-sans-thai-${subset}-${weight}-normal.woff2`;
    copyFileSync(join(pkg, "files", name), join(out, name));
    console.log(`copied ${name}`);
  }
}
const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
writeFileSync(
  join(out, "LICENSE.txt"),
  `IBM Plex Sans Thai, from @fontsource/ibm-plex-sans-thai ${version}.\n\n` +
    readFileSync(join(pkg, "LICENSE"), "utf8"),
);
console.log("copied LICENSE.txt");
