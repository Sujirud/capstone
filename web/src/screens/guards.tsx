/**
 * Route guard. Scan screens need a loaded `client-config`; without it the service is "not
 * reachable" and no scan starts.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CLIENT_CODES } from "../api/problems";
import type { ClientConfig } from "../api/schemas";
import { useConfigState } from "../app/ConfigContext";
import { Screen } from "../components/layout/Screen";
import { Button } from "../components/ui/Button";
import { ErrorMessage } from "../components/ui/ErrorMessage";

export function RequireConfig({ children }: { children: (config: ClientConfig) => ReactNode }) {
  const { t } = useTranslation();
  const { state, retry } = useConfigState();
  if (state.status === "ready") return <>{children(state.config)}</>;
  if (state.status === "loading") {
    return (
      <Screen title={t("app.name")}>
        <p role="status" className="text-ink-2">
          {t("service.loading")}
        </p>
      </Screen>
    );
  }
  return (
    <Screen
      title={t("service.unreachableTitle")}
      actions={
        <Button variant="primary" onClick={retry}>
          {t("service.retry")}
        </Button>
      }
    >
      {state.error.code === CLIENT_CODES.network ? (
        <p>{t("service.unreachableBody")}</p>
      ) : (
        <ErrorMessage error={state.error} />
      )}
    </Screen>
  );
}
