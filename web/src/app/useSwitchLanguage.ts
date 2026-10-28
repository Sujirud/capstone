/**
 * Switches the interface language once that language's `client-config` is loaded.
 * Otherwise every scan screen would give way to "loading" while it loads, and come
 * back mounted anew: React Router applies a navigation made meanwhile in a transition, so
 * the screen that comes back can be the one being left (an analyzing screen would send its
 * photo again). If the config cannot be loaded, the language still switches, and the scan
 * screens show that the service is not reachable.
 */
import { useCallback } from "react";
import { changeLanguage, type Language } from "../i18n";
import { useServices } from "./services";

export function useSwitchLanguage(): (language: Language) => Promise<void> {
  const { configLoader } = useServices();
  return useCallback(
    async (language: Language) => {
      try {
        await configLoader.load(language);
      } catch {
        // shown by the scan screens after the switch
      }
      await changeLanguage(language);
    },
    [configLoader],
  );
}
