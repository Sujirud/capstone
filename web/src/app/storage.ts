/**
 * The only data this app keeps on the device: the language, the
 * last subject form, and live mode's camera calibrations (a focal length per camera,
 * resolution and zoom). Nothing about a face is ever stored.
 *
 * Storage can be unavailable (private mode, blocked site data) or throw; every call
 * degrades to "nothing saved".
 */
export const STORAGE_KEYS = {
  language: "facescan.language",
  subject: "facescan.subject",
  calibration: "facescan.calibration",
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

export function readStored(key: StorageKey): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: StorageKey, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // not saved: the app keeps working for this page load
  }
}
