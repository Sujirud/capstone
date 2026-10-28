/**
 * The API's origin. The site and the API share one origin: Vite's dev and
 * preview servers forward `/v1` to the API. `VITE_API_BASE_URL` points the app at a
 * separate origin instead, which only the mocked end-to-end tests do.
 */
export const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL ?? window.location.origin).replace(/\/+$/, "");
