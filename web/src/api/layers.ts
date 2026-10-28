/**
 * Overlay layers per view (request 4 in ASSUMPTIONS.md). `client-config.overlay.layers` is one
 * list for every view and includes `golden_ratio`, which the app never requests.
 * Until the API lists layers per view, the view's fixed list is intersected with it.
 */
import type { ClientConfig } from "./schemas";

export type View = "frontal" | "profile";

export const VIEW_LAYERS: Readonly<Record<View, readonly string[]>> = {
  frontal: ["landmarks", "thirds", "fifths", "eyes_brows", "nose_lips", "labels"],
  profile: ["landmarks", "profile_lines", "labels"],
};

const NEVER = new Set(["golden_ratio"]);

export function overlayLayers(view: View, config: Pick<ClientConfig, "overlay">): string[] {
  const offered = new Set(config.overlay.layers);
  return VIEW_LAYERS[view].filter((layer) => offered.has(layer) && !NEVER.has(layer));
}
