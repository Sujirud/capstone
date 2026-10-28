import { join } from "node:path";

/** The web app's directory and the repository root (jsdom's URL cannot build file paths). */
export const WEB = join(import.meta.dirname, "..");
export const REPO = join(WEB, "..");
