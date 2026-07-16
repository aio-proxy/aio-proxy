import type { DashboardProviderSummary } from "@aio-proxy/types";

export const providerStub = (overrides: Partial<DashboardProviderSummary> = {}): DashboardProviderSummary => ({
  id: "provider-id",
  kind: "oauth",
  enabled: true,
  passthrough: false,
  last_status: "unknown",
  last_latency: null,
  clientModels: [],
  state: { status: "ready" },
  ...overrides,
});
