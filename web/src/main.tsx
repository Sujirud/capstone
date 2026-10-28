import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApiClient } from "./api/client";
import { createClientConfigLoader } from "./api/clientConfig";
import { App } from "./App";
import { API_BASE_URL } from "./app/env";
import { setupI18n } from "./i18n";
import "./styles/index.css";

await setupI18n();

const api = createApiClient({ baseUrl: API_BASE_URL });
const services = { api, configLoader: createClientConfigLoader(api) };

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);
