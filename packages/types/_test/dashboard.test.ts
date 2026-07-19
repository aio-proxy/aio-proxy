import { describe, expect, test } from "bun:test";

import { type DashboardProviderSummary, dashboardProviderSuggestedCommand } from "../src/dashboard";

const unavailableProvider = (suggestedCommand?: string): DashboardProviderSummary => ({
  id: "chatgpt-personal",
  kind: "oauth",
  enabled: true,
  passthrough: false,
  last_status: "unknown",
  last_latency: null,
  clientModels: [],
  state: {
    status: "unavailable",
    diagnostic: {
      code: "CREDENTIALS_MISSING_OR_INVALID",
      summary: "Credentials missing or invalid.",
      retryable: false,
      occurredAt: "2026-07-14T00:00:00.000Z",
      ...(suggestedCommand === undefined ? {} : { suggestedCommand }),
    },
  },
});

describe("dashboardProviderSuggestedCommand", () => {
  test("does not synthesize targeted login when a credential diagnostic omits its command", () => {
    expect(dashboardProviderSuggestedCommand(unavailableProvider())).toBeUndefined();
  });

  test("canonicalizes an explicitly suggested targeted login for the provider id", () => {
    expect(dashboardProviderSuggestedCommand(unavailableProvider("aio-proxy provider login default"))).toBe(
      "aio-proxy provider login --provider chatgpt-personal",
    );
  });
});
