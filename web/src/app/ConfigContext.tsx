/**
 * `client-config` for the current language. It is fetched at start-up; if it
 * fails, the scan screens show "the service is not reachable" with a retry, and no scan
 * starts.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/client";
import { CLIENT_CODES } from "../api/problems";
import type { ClientConfig } from "../api/schemas";
import { isLanguage, type Language } from "../i18n";
import { useServices } from "./services";

export type ConfigState =
  | { status: "loading" }
  | { status: "ready"; config: ClientConfig }
  | { status: "error"; error: ApiError };

interface ConfigValue {
  state: ConfigState;
  retry(): void;
}

const ConfigContext = createContext<ConfigValue | null>(null);

function asApiError(err: unknown): ApiError {
  return err instanceof ApiError
    ? err
    : new ApiError({ code: CLIENT_CODES.badResponse, status: null, requestId: null, retryAfterS: null, cause: err });
}

export function ConfigProvider({ children }: { children: ReactNode }) {
  const { configLoader } = useServices();
  const { i18n } = useTranslation();
  const language: Language = isLanguage(i18n.resolvedLanguage) ? i18n.resolvedLanguage : "th";
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; state: ConfigState } | null>(null);
  const key = `${language}:${attempt}`;
  const cached = configLoader.peek(language);

  useEffect(() => {
    if (configLoader.peek(language)) return;
    const controller = new AbortController();
    configLoader.load(language, controller.signal).then(
      (config) => setResult({ key, state: { status: "ready", config } }),
      (err: unknown) => {
        if (!controller.signal.aborted) setResult({ key, state: { status: "error", error: asApiError(err) } });
      },
    );
    return () => controller.abort();
  }, [configLoader, language, key]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const value = useMemo<ConfigValue>(() => {
    const state: ConfigState = cached
      ? { status: "ready", config: cached }
      : result?.key === key
        ? result.state
        : { status: "loading" };
    return { state, retry };
  }, [cached, result, key, retry]);
  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export function useConfigState(): ConfigValue {
  const value = useContext(ConfigContext);
  if (!value) throw new Error("useConfigState outside ConfigProvider");
  return value;
}
