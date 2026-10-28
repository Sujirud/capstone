/**
 * `GET /v1/client-config`, once per language per page load.
 *
 * `cache: "no-cache"` makes the browser revalidate its stored copy with the response's
 * `ETag` (`If-None-Match` → 304), so a redeployed API is picked up at the next start and
 * an unchanged one costs one small request. Within a page load, configs are kept in
 * memory per language.
 */
import { ApiError, type ApiClient } from "./client";
import { CLIENT_CODES } from "./problems";
import { ClientConfigSchema, type ClientConfig } from "./schemas";

export type Locale = ClientConfig["locale"];

export interface ClientConfigLoader {
  load(locale: Locale, signal?: AbortSignal): Promise<ClientConfig>;
  /** Already loaded in this page load, else undefined. */
  peek(locale: Locale): ClientConfig | undefined;
}

export function createClientConfigLoader(api: ApiClient): ClientConfigLoader {
  const loaded = new Map<Locale, ClientConfig>();
  return {
    peek: (locale) => loaded.get(locale),
    async load(locale, signal) {
      const hit = loaded.get(locale);
      if (hit) return hit;
      const { data, response } = await api.request({
        path: "/v1/client-config",
        query: { locale },
        schema: ClientConfigSchema,
        cache: "no-cache",
        signal,
      });
      if (data.locale !== locale) {
        throw new ApiError({
          code: CLIENT_CODES.badResponse,
          status: response.status,
          requestId: response.headers.get("X-Request-ID"),
          retryAfterS: null,
        });
      }
      loaded.set(locale, data);
      return data;
    },
  };
}
