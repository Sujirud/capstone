/**
 * The web app's own strings: Thai first, English second. The API's
 * strings are never duplicated here, except the area names (see areas.ts).
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { readStored, STORAGE_KEYS, writeStored } from "../app/storage";
import en from "./en.json";
import th from "./th.json";

export const LANGUAGES = ["th", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

export function initialLanguage(): Language {
  const saved = readStored(STORAGE_KEYS.language);
  return isLanguage(saved) ? saved : "th";
}

export function currentLanguage(): Language {
  return isLanguage(i18n.resolvedLanguage) ? i18n.resolvedLanguage : "th";
}

/** `lang` on the document follows the language. */
function applyDocumentLanguage(language: string): void {
  if (typeof document !== "undefined") document.documentElement.lang = language;
}

export async function setupI18n(language: Language = initialLanguage()): Promise<typeof i18n> {
  if (!i18n.isInitialized) {
    i18n.on("languageChanged", applyDocumentLanguage);
    await i18n.use(initReactI18next).init({
      resources: { th: { translation: th }, en: { translation: en } },
      lng: language,
      fallbackLng: false,
      supportedLngs: [...LANGUAGES],
      interpolation: { escapeValue: false }, // React escapes
      returnNull: false,
    });
  } else if (i18n.language !== language) {
    await i18n.changeLanguage(language);
  }
  applyDocumentLanguage(language);
  return i18n;
}

export async function changeLanguage(language: Language): Promise<void> {
  writeStored(STORAGE_KEYS.language, language);
  await i18n.changeLanguage(language);
}

export default i18n;
