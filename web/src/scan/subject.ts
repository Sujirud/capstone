/**
 * The subject form: sex selects the reference, and age is part of the
 * analysis. The last form is kept on the device to prefill the next scan.
 */
import { z } from "zod";
import { readStored, STORAGE_KEYS, writeStored } from "../app/storage";

export const SEXES = ["female", "male", "unspecified"] as const;
export const AGE_MIN = 1;
export const AGE_MAX = 120;

export const SubjectSchema = z.object({
  sex: z.enum(SEXES),
  age: z.number().int().min(AGE_MIN).max(AGE_MAX),
});
export type Subject = z.infer<typeof SubjectSchema>;
export type Sex = Subject["sex"];

/** Whole years only; `null` when the text is not an age from 1 to 120. Thai numerals
 *  (๐–๙) count as digits, since a Thai keyboard or a paste may produce them. */
export function parseAge(text: string): number | null {
  const t = text.trim().replace(/[\u0e50-\u0e59]/g, (d) => String(d.charCodeAt(0) - 0x0e50));
  if (!/^\d{1,3}$/.test(t)) return null;
  const age = Number(t);
  return age >= AGE_MIN && age <= AGE_MAX ? age : null;
}

export function loadLastSubject(): Partial<Subject> {
  const raw = readStored(STORAGE_KEYS.subject);
  if (raw === null) return {};
  try {
    const parsed = SubjectSchema.partial().safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function saveLastSubject(subject: Subject): void {
  writeStored(STORAGE_KEYS.subject, JSON.stringify(SubjectSchema.parse(subject)));
}
