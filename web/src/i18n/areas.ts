/**
 * Area headings for the measurement sheet: a copy of `area` in the core's
 * `facescan/config/locale_{th,en}.yaml` (request 1 in ASSUMPTIONS.md). Metrics carry `area` as a
 * key only, and `client-config` has no area strings. tests/areas.test.ts compares this
 * copy with the locale files, so it cannot drift. Remove it when the API sends area texts.
 */
import type { Language } from ".";

export const AREA_TEXT: Readonly<Record<Language, Readonly<Record<string, string>>>> = {
  th: {
    nose: "จมูก",
    lips: "ริมฝีปาก",
    mouth: "ปาก",
    eyes: "ดวงตา",
    brows: "คิ้ว",
    forehead: "หน้าผาก",
    chin: "คาง",
    profile: "ใบหน้าด้านข้าง",
    thirds: "สัดส่วนแนวตั้งของใบหน้า",
    lower_face: "ใบหน้าส่วนล่าง",
    fifths: "สัดส่วนแนวนอนของใบหน้า",
    proportions: "สัดส่วนใบหน้า",
    symmetry: "ความสมมาตรซ้าย–ขวา",
  },
  en: {
    nose: "Nose",
    lips: "Lips",
    mouth: "Mouth",
    eyes: "Eyes",
    brows: "Eyebrows",
    forehead: "Forehead",
    chin: "Chin",
    profile: "Side profile",
    thirds: "Vertical proportions",
    lower_face: "Lower face",
    fifths: "Horizontal proportions",
    proportions: "Facial proportions",
    symmetry: "Left–right symmetry",
  },
};

/** The heading for an area key, or null when the core has none for it. */
export function areaText(language: Language, area: string | null): string | null {
  return area === null ? null : (AREA_TEXT[language][area] ?? null);
}
