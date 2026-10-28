/**
 * Renders the whole app at a hash route, with the real API client against the MSW mocks, and
 * live mode's browser services when given (tests/liveScreen.test.tsx fakes the camera).
 */
import { render } from "@testing-library/react";
import { createApiClient } from "../src/api/client";
import { createClientConfigLoader } from "../src/api/clientConfig";
import { App } from "../src/App";
import type { LiveServices } from "../src/capture/live/services";
import { setupI18n, type Language } from "../src/i18n";
import { FetchXhr } from "./fetchXhr";
import { MOCK_API } from "./mocks/handlers";

export async function renderApp(route: string, { language = "th", live }: { language?: Language; live?: LiveServices } = {}) {
  window.location.hash = `#${route}`;
  await setupI18n(language);
  const api = createApiClient({
    baseUrl: MOCK_API,
    sleep: async () => {},
    xhr: () => new FetchXhr() as unknown as XMLHttpRequest,
  });
  const services = { api, configLoader: createClientConfigLoader(api), live };
  return { api, services, ...render(<App services={services} />) };
}
