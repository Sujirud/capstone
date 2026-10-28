/**
 * The web app's own strings: the same keys in Thai and
 * English, and no hype, blame, gendered particles or the core's banned terms.
 */
import { describe, expect, it } from "vitest";
import en from "../src/i18n/en.json" with { type: "json" };
import th from "../src/i18n/th.json" with { type: "json" };

function flatten(node: unknown, prefix = ""): Array<[string, string]> {
  if (typeof node === "string") return [[prefix, node]];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
}

const TH = flatten(th);
const EN = flatten(en);
const ALL = [...TH, ...EN];

// Hype words, in both languages.
const HYPE = [
  "ai-powered", "ai powered", "smart", "magic", "unlock", "revolutionary", "in seconds", "precision ai",
  "discover your perfect", "congratulations", "perfect", "amazing", "instant",
  "อัจฉริยะ", "มหัศจรรย์", "ปลดล็อก", "ปฏิวัติ", "ในไม่กี่วินาที", "ยินดีด้วย", "สมบูรณ์แบบ", "ทันที",
];
// tests/test_schema_views.py in the core: wording rules and promotional terms.
const CORE_BANNED = [
  "defect", "flaw", "abnormal", "ugly", "deformity", "deformed", "unattractive", "attractiveness", "you need",
  "you must", "fix your", "beauty score", "ผิดปกติ", "ข้อบกพร่อง", "บกพร่อง", "น่าเกลียด", "ไม่สวย", "ผิดรูป",
  "พิการ", "คุณต้อง", "price", "discount", "promotion", "limited time", "hurry", "urgent", "act now", "book now",
  "free consultation", "before and after", "guarantee", "baht", "฿", "ideal face", "score", "rank", "celebrity",
  "ราคา", "ส่วนลด", "โปรโมชั่น", "ด่วน", "จำนวนจำกัด", "รับประกัน", "ก่อนและหลัง", "บาท", "ดารา", "คะแนน", "อันดับ",
];

function containsTerm(text: string, term: string): boolean {
  const low = text.toLowerCase();
  // Latin words match whole words; Thai has no spaces between words, so it matches anywhere.
  return /^[a-z]/.test(term) ? new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(low) : low.includes(term);
}

describe("web strings", () => {
  it("have the same keys in Thai and English", () => {
    expect(TH.map(([k]) => k).sort()).toEqual(EN.map(([k]) => k).sort());
  });

  it("are never empty", () => {
    for (const [key, text] of ALL) expect(text.trim(), key).not.toBe("");
  });

  it("have the same placeholders in both languages", () => {
    const vars = (s: string) => [...s.matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]).sort();
    const en = Object.fromEntries(EN);
    for (const [key, text] of TH) expect(vars(text), key).toEqual(vars(en[key] ?? ""));
  });

  it("contain no hype words or the core's banned terms", () => {
    for (const [key, text] of ALL) {
      for (const term of [...HYPE, ...CORE_BANNED]) expect(containsTerm(text, term), `${key}: ${term}`).toBe(false);
    }
  });

  it("contain no exclamation marks", () => {
    for (const [key, text] of ALL) expect(text, key).not.toMatch(/[!！]/);
  });

  it("keep ๆ on the line of the word it repeats: a no-break space before it", () => {
    for (const [key, text] of TH) expect(text, key).not.toMatch(/ ๆ/);
  });

  it("use no gendered Thai particles", () => {
    for (const [key, text] of TH) expect(text, key).not.toMatch(/ครับ|ค่ะ|คะ|นะคะ|จ้ะ/);
  });

  it("write English headings in sentence case", () => {
    const titles = EN.filter(([k]) => /(^|\.)(title|heading|[a-zA-Z]+Heading)$/.test(k));
    expect(titles.length).toBeGreaterThan(3);
    for (const [key, text] of titles) {
      const words = text.split(/\s+/).slice(1).filter((w) => /^[A-Za-z]/.test(w));
      expect(words.filter((w) => /^[A-Z][a-z]/.test(w)), key).toEqual([]);
    }
  });
});
