import type React from "react";

import { m } from "@aio-proxy/i18n";
import {
  type DashboardProviderSummary,
  dashboardProviderNeedsReauthorization,
  dashboardProviderSuggestedCommand,
} from "@aio-proxy/types";

import { DiagnosticDetails } from "./diagnostic-details";

const availabilityLabel = (provider: DashboardProviderSummary): string => {
  if (provider.state.status === "unavailable") return m["dashboard.providers.state.unavailable"]();
  return m["dashboard.providers.state.ready"]();
};

export const ProviderStateCell: React.FC<{
  readonly provider: DashboardProviderSummary;
}> = ({ provider }) => {
  const diagnostic = provider.state.diagnostic;
  const needsReauthorization = dashboardProviderNeedsReauthorization(provider);
  const command = needsReauthorization ? undefined : dashboardProviderSuggestedCommand(provider);

  return (
    <fieldset
      className="m-0 space-y-1 border-0 p-0"
      aria-label={m["dashboard.providers.state.details"]({ id: provider.id })}
    >
      <div>{availabilityLabel(provider)}</div>
      {provider.state.status === "ready" && provider.state.catalog !== undefined ? (
        <div className="text-xs text-muted-foreground">
          {provider.state.catalog === "fresh"
            ? m["dashboard.providers.state.catalog_fresh"]()
            : m["dashboard.providers.state.catalog_stale"]()}
        </div>
      ) : null}
      {diagnostic === undefined ? null : (
        <>
          <DiagnosticDetails diagnostic={diagnostic} suggestedCommand={command} />
        </>
      )}
    </fieldset>
  );
};
