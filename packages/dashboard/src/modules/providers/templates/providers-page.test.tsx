import type { DashboardProviderSummary } from "@aio-proxy/types";
import { afterEach, expect, rs, test } from "@rstest/core";
import { render, screen, within } from "@testing-library/react";
import { ProvidersPage } from "./providers-page";

const queryMocks = rs.hoisted(() => ({
  plugins: { plugins: [] },
  providers: { providers: [] as DashboardProviderSummary[] },
}));

rs.mock("@tanstack/react-query", () => ({
  queryOptions: <T,>(options: T) => options,
  useQuery: (options: { queryKey: readonly string[] }) => ({
    data: options.queryKey[0] === "plugins" ? queryMocks.plugins : queryMocks.providers,
    isLoading: false,
  }),
}));

rs.mock("../components/delete-provider-dialog", () => ({ DeleteProviderDialog: () => null }));
rs.mock("@tanstack/react-router", () => ({
  Link: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}));

afterEach(() => {
  rs.restoreAllMocks();
  queryMocks.providers.providers = [];
});

test("renders expiry and catalog timestamps with the browser locale", () => {
  const localized = rs.spyOn(Date.prototype, "toLocaleString").mockImplementation(function () {
    return `browser:${this.toISOString()}`;
  });
  queryMocks.providers.providers = [
    {
      id: "copilot-octocat",
      kind: "oauth",
      enabled: true,
      passthrough: false,
      last_status: "unknown",
      last_latency: null,
      clientModels: [],
      accountLabel: "octocat",
      expiresAt: 1_900_000_000_000,
      catalogLastSuccessAt: "2026-07-14T00:00:00.000Z",
      state: { status: "ready", catalog: "stale" },
    },
  ];

  render(<ProvidersPage />);

  const row = within(screen.getByTestId("provider-row-copilot-octocat"));
  expect(row.getByText(/browser:2030-03-17T17:46:40.000Z/u)).toBeTruthy();
  expect(row.getByText(/browser:2026-07-14T00:00:00.000Z/u)).toBeTruthy();
  expect(localized).toHaveBeenCalledTimes(2);
  expect(localized.mock.calls).toEqual([[], []]);
});
