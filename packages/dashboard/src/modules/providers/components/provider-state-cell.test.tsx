import type { DashboardProviderSummary } from "@aio-proxy/types";
import { describe, expect, rs, test } from "@rstest/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ProvidersPage } from "../templates/providers-page";
import { ProviderActionsMenu } from "./provider-actions-menu";
import { ProviderStateCell } from "./provider-state-cell";

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

rs.mock("./delete-provider-dialog", () => ({ DeleteProviderDialog: () => null }));

rs.mock("@tanstack/react-router", () => ({
  Link: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}));

const provider = (overrides: Partial<DashboardProviderSummary> = {}): DashboardProviderSummary => ({
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

describe("provider state cell", () => {
  test.each([
    ["ready", provider({ state: { status: "ready", catalog: "fresh" } }), /Ready|就绪/u],
    ["stale", provider({ state: { status: "ready", catalog: "stale" } }), /Stale|过期/u],
    [
      "unavailable",
      provider({
        state: {
          status: "unavailable",
          diagnostic: {
            code: "CATALOG_UNAVAILABLE",
            summary: "Catalog unavailable.",
            retryable: true,
            occurredAt: "2026-07-14T00:00:00.000Z",
            suggestedCommand: "aio-proxy provider login --provider provider-id",
          },
        },
      }),
      /Unavailable|不可用/u,
    ],
  ])("renders %s provider availability", (_label, value, expected) => {
    render(<ProviderStateCell provider={value} />);
    expect(screen.getByText(expected)).toBeTruthy();
  });

  test("renders safe diagnostic details", () => {
    render(
      <ProviderStateCell
        provider={provider({
          state: {
            status: "unavailable",
            diagnostic: {
              code: "CATALOG_UNAVAILABLE",
              summary: "Catalog unavailable.",
              retryable: true,
              occurredAt: "2026-07-14T00:00:00.000Z",
              suggestedCommand: "aio-proxy provider login --provider provider-id",
            },
          },
        })}
      />,
    );

    expect(screen.getByText("Catalog unavailable.")).toBeTruthy();
    expect(screen.getByText("aio-proxy provider login --provider provider-id")).toBeTruthy();
  });

  test("uses an explicit provider target for credential refresh failures", () => {
    render(
      <ProviderStateCell
        provider={provider({
          id: "chatgpt-personal",
          state: {
            status: "unavailable",
            diagnostic: {
              code: "CREDENTIAL_REFRESH_FAILED",
              summary: "Credential refresh failed.",
              retryable: true,
              occurredAt: "2026-07-14T00:00:00.000Z",
              suggestedCommand: "aio-proxy provider login default",
            },
          },
        })}
      />,
    );

    expect(screen.getByText("aio-proxy provider login --provider chatgpt-personal")).toBeTruthy();
    expect(screen.queryByText("aio-proxy provider login default")).toBeNull();
  });
});

describe("providers page diagnostics", () => {
  test("renders capability, account expiry, and catalog metadata without OAuth management controls", () => {
    queryMocks.providers.providers = [
      provider({
        id: "copilot-octocat",
        plugin: "@aio-proxy/plugin-github-copilot",
        capability: "default",
        accountLabel: "octocat",
        expiresAt: 1_900_000_000_000,
        catalogLastSuccessAt: "2026-07-14T00:00:00.000Z",
        state: { status: "ready", catalog: "stale" },
      }),
    ];

    render(<ProvidersPage />);

    const row = within(screen.getByTestId("provider-row-copilot-octocat"));
    expect(row.getByText("@aio-proxy/plugin-github-copilot/default")).toBeTruthy();
    expect(row.getByText("octocat")).toBeTruthy();
    expect(row.getByText(/2030-03-17T17:46:40.000Z/u)).toBeTruthy();
    expect(row.getByText(/2026-07-14T00:00:00.000Z/u)).toBeTruthy();
    expect(row.getAllByText(/Stale|过期/u).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Install|安装/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Configure|配置/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Login|登录/u })).toBeNull();
    expect(screen.queryByLabelText(/Secret|密钥/u)).toBeNull();
  });

  test("sorts providers from a column header control", () => {
    queryMocks.providers.providers = [provider({ id: "z-provider" }), provider({ id: "a-provider" })];
    render(<ProvidersPage />);

    fireEvent.click(screen.getByRole("button", { name: /^ID$/u }));

    const rows = screen.getAllByTestId(/^provider-row-/u);
    expect(rows[0]?.getAttribute("data-testid")).toBe("provider-row-a-provider");
  });

  test("filters providers from the table filter control", () => {
    queryMocks.providers.providers = [provider({ id: "keep-provider" }), provider({ id: "hide-provider" })];
    render(<ProvidersPage />);

    fireEvent.change(screen.getByRole("textbox", { name: /Filter providers|筛选提供商/u }), {
      target: { value: "keep" },
    });

    expect(screen.getByTestId("provider-row-keep-provider")).toBeTruthy();
    expect(screen.queryByTestId("provider-row-hide-provider")).toBeNull();
  });

  test("toggles provider columns from the column visibility control", async () => {
    queryMocks.providers.providers = [provider()];
    render(<ProvidersPage />);

    expect(screen.getByRole("columnheader", { name: /Name|名称/u })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Provider columns|提供商列/u }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Name|名称/u }));

    expect(screen.queryByRole("columnheader", { name: /Name|名称/u })).toBeNull();
  });

  test("pages forward and backward through more than one page of providers", () => {
    queryMocks.providers.providers = Array.from({ length: 11 }, (_, index) => provider({ id: `provider-${index}` }));
    render(<ProvidersPage />);
    const section = within(screen.getByRole("region", { name: /Provider diagnostics|提供商诊断/u }));

    expect(section.getByTestId("provider-row-provider-0")).toBeTruthy();
    expect(section.queryByTestId("provider-row-provider-10")).toBeNull();

    fireEvent.click(section.getByRole("button", { name: /Next|下一页/u }));
    expect(section.queryByTestId("provider-row-provider-0")).toBeNull();
    expect(section.getByTestId("provider-row-provider-10")).toBeTruthy();

    fireEvent.click(section.getByRole("button", { name: /Previous|上一页/u }));
    expect(section.getByTestId("provider-row-provider-0")).toBeTruthy();
  });
});

describe("provider diagnostics actions", () => {
  test.each(["oauth", "invalid"] as const)("keeps %s rows read-only except delete", async (kind) => {
    render(<ProviderActionsMenu provider={provider({ kind })} onDelete={() => {}} />);
    fireEvent.click(screen.getByTestId("provider-actions-trigger"));

    expect(await screen.findByTestId("provider-action-delete")).toBeTruthy();
    expect(screen.queryByTestId("provider-action-edit")).toBeNull();
    expect(screen.queryByRole("button", { name: /Login|登录/u })).toBeNull();
  });

  test.each(["api", "ai-sdk"] as const)("retains edit for %s rows", async (kind) => {
    render(<ProviderActionsMenu provider={provider({ kind })} onDelete={() => {}} />);
    fireEvent.click(screen.getByTestId("provider-actions-trigger"));

    expect(await screen.findByTestId("provider-action-edit")).toBeTruthy();
    expect(screen.getByTestId("provider-action-delete")).toBeTruthy();
  });

  test.each(["api", "ai-sdk"] as const)("retains edit for unavailable %s rows", async (kind) => {
    render(
      <ProviderActionsMenu
        provider={provider({
          kind,
          state: {
            status: "unavailable",
            diagnostic: {
              code: "RUNTIME_CREATE_FAILED",
              summary: "Runtime unavailable.",
              retryable: true,
              occurredAt: "2026-07-14T00:00:00.000Z",
            },
          },
        })}
        onDelete={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("provider-actions-trigger"));

    expect(await screen.findByTestId("provider-action-edit")).toBeTruthy();
    expect(screen.getByTestId("provider-action-delete")).toBeTruthy();
  });

  test.each(["api", "ai-sdk"] as const)("hides edit for inferred invalid %s rows", async (kind) => {
    render(
      <ProviderActionsMenu
        provider={provider({
          kind,
          enabled: false,
          state: {
            status: "unavailable",
            diagnostic: {
              code: "PROVIDER_CONFIG_INVALID",
              summary: "Provider configuration is invalid.",
              retryable: false,
              occurredAt: "2026-07-14T00:00:00.000Z",
            },
          },
        })}
        onDelete={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("provider-actions-trigger"));

    expect(await screen.findByTestId("provider-action-delete")).toBeTruthy();
    expect(screen.queryByTestId("provider-action-edit")).toBeNull();
  });
});
