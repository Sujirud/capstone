/**
 * The API client and the client-config loader, created once in main.tsx, and live mode's
 * browser services (the real ones unless given). Tests pass fakes.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { ApiClient } from "../api/client";
import type { ClientConfigLoader } from "../api/clientConfig";
import { browserLive, type LiveServices } from "../capture/live/services";

export interface Services {
  api: ApiClient;
  configLoader: ClientConfigLoader;
  live?: LiveServices;
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("useServices outside ServicesProvider");
  return services;
}

export function useLiveServices(): LiveServices {
  return useServices().live ?? browserLive;
}
