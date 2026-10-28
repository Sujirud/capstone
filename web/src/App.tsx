/**
 * Routes (hash routing: any static server, no rewrite rules). The landing page,
 * then the subject form (sex, age), the frontal screens, the optional side photo
 * (`/scan/<view>/<screen>` for both views, `/scan/frontal/live` for live mode) and the
 * report; "How it's measured" at `#/method`. The component review page is reachable at
 * `#/components`.
 */
import { lazy, Suspense, useState, type ReactNode } from "react";
import { createHashRouter, Navigate, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";
import type { ClientConfig } from "./api/schemas";
import { ConfigProvider } from "./app/ConfigContext";
import { ServicesProvider, type Services } from "./app/services";
import { ScanProvider } from "./scan/ScanContext";
import type { View } from "./scan/session";
import { RequireConfig } from "./screens/guards";
import { LandingScreen } from "./screens/LandingScreen";
import { MethodScreen } from "./screens/MethodScreen";
import { ReportScreen } from "./screens/ReportScreen";
import { AdjustScreen } from "./screens/scan/AdjustScreen";
import { AnalyzingScreen } from "./screens/scan/AnalyzingScreen";
import { GuideScreen } from "./screens/scan/GuideScreen";
import { LiveScreen } from "./screens/scan/LiveScreen";
import { PreviewScreen } from "./screens/scan/PreviewScreen";
import { ResultScreen } from "./screens/scan/ResultScreen";
import { RetakeScreen } from "./screens/scan/RetakeScreen";
import { SubjectAgeScreen, SubjectSexScreen } from "./screens/SubjectScreens";

// The review page carries the fixtures; it is loaded only when opened.
const ComponentsScreen = lazy(() => import("./screens/ComponentsScreen").then((m) => ({ default: m.ComponentsScreen })));

/** A scan screen: it needs the service's client-config. */
function Scan({ render }: { render: (config: ClientConfig) => ReactNode }) {
  return <RequireConfig>{render}</RequireConfig>;
}

/**
 * The same six screens for each view, and live mode for the front photo. Each route's
 * element is keyed by its path: going from one view's screen to the other's (the frontal
 * re-analysis that continues with the side photo) must mount a new screen, not reuse the
 * one before with its state and requests.
 */
function viewRoutes(view: View) {
  const screens: Array<[string, (config: ClientConfig) => ReactNode]> = [
    ["guide", (c) => <GuideScreen config={c} view={view} />],
    ["preview", (c) => <PreviewScreen config={c} view={view} />],
    ["analyzing", (c) => <AnalyzingScreen config={c} view={view} />],
    ["retake", (c) => <RetakeScreen config={c} view={view} />],
    ["result", () => <ResultScreen view={view} />],
    ["adjust", (c) => <AdjustScreen config={c} view={view} />],
  ];
  // Live mode is for the front photo only; the side photo uses photo mode.
  if (view === "frontal") screens.push(["live", (c) => <LiveScreen config={c} />]);
  return screens.map(([screen, render]) => {
    const path = `scan/${view}/${screen}`;
    return { path, element: <Scan key={path} render={render} /> };
  });
}

export function createAppRouter(services: Services) {
  function Root() {
    return (
      <ServicesProvider services={services}>
        <ConfigProvider>
          <ScanProvider>
            <Outlet />
          </ScanProvider>
        </ConfigProvider>
      </ServicesProvider>
    );
  }

  return createHashRouter([
    {
      element: <Root />,
      children: [
        { index: true, element: <Scan render={(c) => <LandingScreen config={c} />} /> },
        { path: "method", element: <Scan render={(c) => <MethodScreen config={c} />} /> },
        { path: "subject", element: <Scan render={() => <SubjectSexScreen />} /> },
        { path: "subject/age", element: <Scan render={() => <SubjectAgeScreen />} /> },
        ...viewRoutes("frontal"),
        ...viewRoutes("profile"),
        { path: "report", element: <Scan render={() => <ReportScreen />} /> },
        {
          path: "components",
          element: (
            <Suspense fallback={null}>
              <ComponentsScreen />
            </Suspense>
          ),
        },
        { path: "*", element: <Navigate to="/" replace /> },
      ],
    },
  ]);
}

export function App({ services }: { services: Services }) {
  const [router] = useState(() => createAppRouter(services));
  return <RouterProvider router={router} />;
}
