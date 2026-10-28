/**
 * Spoken hints (optional): for a phone on a stand, the person being measured
 * hears the hint from where they stand. The Web Speech API, in the scan's language, and only
 * with a voice for it: a Thai hint read by an English voice would not help.
 */
import type { Language } from "../../i18n";

const LANG_TAGS: Record<Language, string> = { th: "th-TH", en: "en-GB" };

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
}

/** A voice for the language, if the device has one (voices can load late: call again on `voiceschanged`). */
export function voiceFor(language: Language): SpeechSynthesisVoice | null {
  const voices = synth()?.getVoices() ?? [];
  const tag = LANG_TAGS[language].toLowerCase();
  return voices.find((v) => v.lang.toLowerCase().replace("_", "-") === tag) ?? voices.find((v) => v.lang.toLowerCase().startsWith(language)) ?? null;
}

/** Calls `onChange` when the list of voices changes; returns the unsubscribe function. */
export function watchVoices(onChange: () => void): () => void {
  const s = synth();
  if (!s) return () => undefined;
  s.addEventListener("voiceschanged", onChange);
  return () => s.removeEventListener("voiceschanged", onChange);
}

/** Says `text`, interrupting what was being said. */
export function speak(text: string, language: Language, voice: SpeechSynthesisVoice): void {
  const s = synth();
  if (!s) return;
  s.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = LANG_TAGS[language];
  u.voice = voice;
  s.speak(u);
}

export function stopSpeaking(): void {
  synth()?.cancel();
}
