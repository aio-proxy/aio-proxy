import type { DashboardProviderSummary } from "@aio-proxy/types";

import { afterEach, describe, expect, rs, test } from "@rstest/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DeleteProviderDialogStub } from "../delete-provider-dialog-stub";
import { providerStub } from "../provider-fixtures";
import { RouterLinkStub } from "../router-link-stub";
import { ProvidersPage } from "./providers-page";

const queryMocks = rs.hoisted(() => ({
  providers: { providers: [] as DashboardProviderSummary[] },
}));

rs.mock("@tanstack/react-query", () => ({
  queryOptions: <T,>(options: T) => options,
  useQuery: () => ({
    data: queryMocks.providers,
    isLoading: false,
  }),
}));

rs.mock("../components/delete-provider-dialog", () => ({ DeleteProviderDialog: DeleteProviderDialogStub }));
rs.mock("@tanstack/react-router", () => ({
  Link: RouterLinkStub,
}));

afterEach(() => {
  rs.restoreAllMocks();
  queryMocks.providers.providers = [];
});

describe("providers page diagnostics", () => {
  test("removes the plugin inventory and offers OAuth from the new-provider menu", async () => {
    render(<ProvidersPage />);

    expect(screen.queryByTestId("plugins-table")).toBeNull();
    fireEvent.click(screen.getByTestId("new-provider-button"));
    expect(await screen.findByRole("menuitem", { name: /OAuth/u })).toBeTruthy();
  });

  test("renders capability, account expiry, and catalog metadata without OAuth management controls", () => {
    queryMocks.providers.providers = [
      providerStub({
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
    expect(row.getByText(/Expires|过期时间/u)).toBeTruthy();
    expect(row.getByText(/Last success|上次成功/u)).toBeTruthy();
    expect(row.getAllByText(/Stale|过期/u).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Install|安装/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Configure|配置/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Login|登录/u })).toBeNull();
    expect(screen.queryByLabelText(/Secret|密钥/u)).toBeNull();
  });

  test("renders expiry and catalog timestamps with the browser locale", () => {
    const localized = rs.spyOn(Date.prototype, "toLocaleString").mockImplementation(function () {
      return `browser:${this.toISOString()}`;
    });
    queryMocks.providers.providers = [
      providerStub({
        id: "copilot-octocat",
        accountLabel: "octocat",
        expiresAt: 1_900_000_000_000,
        catalogLastSuccessAt: "2026-07-14T00:00:00.000Z",
        state: { status: "ready", catalog: "stale" },
      }),
    ];

    render(<ProvidersPage />);

    const row = within(screen.getByTestId("provider-row-copilot-octocat"));
    expect(row.getByText(/browser:2030-03-17T17:46:40.000Z/u)).toBeTruthy();
    expect(row.getByText(/browser:2026-07-14T00:00:00.000Z/u)).toBeTruthy();
    expect(localized).toHaveBeenCalledTimes(2);
    expect(localized.mock.calls).toEqual([[], []]);
  });

  test("sorts providers from a column header control", () => {
    queryMocks.providers.providers = [providerStub({ id: "z-provider" }), providerStub({ id: "a-provider" })];
    render(<ProvidersPage />);

    fireEvent.click(screen.getByRole("button", { name: /^ID$/u }));

    const rows = screen.getAllByTestId(/^provider-row-/u);
    expect(rows[0]?.getAttribute("data-testid")).toBe("provider-row-a-provider");
  });

  test("filters providers from the table filter control", () => {
    queryMocks.providers.providers = [providerStub({ id: "keep-provider" }), providerStub({ id: "hide-provider" })];
    render(<ProvidersPage />);

    fireEvent.change(screen.getByRole("textbox", { name: /Filter providers|筛选提供商/u }), {
      target: { value: "keep" },
    });

    expect(screen.getByTestId("provider-row-keep-provider")).toBeTruthy();
    expect(screen.queryByTestId("provider-row-hide-provider")).toBeNull();
  });

  test("toggles provider columns from the column visibility control", async () => {
    queryMocks.providers.providers = [providerStub()];
    render(<ProvidersPage />);

    expect(screen.getByRole("columnheader", { name: /Name|名称/u })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Provider columns|提供商列/u }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Name|名称/u, checked: true }));

    expect(screen.queryByRole("columnheader", { name: /Name|名称/u })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Provider columns|提供商列/u }));
    expect(await screen.findByRole("menuitemcheckbox", { name: /Name|名称/u })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  test("pages forward and backward through more than one page of providers", () => {
    queryMocks.providers.providers = Array.from({ length: 11 }, (_, index) =>
      providerStub({ id: `provider-${index}` }),
    );
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

  test("locates and highlights a focused provider on another page", async () => {
    queryMocks.providers.providers = Array.from({ length: 11 }, (_, index) =>
      providerStub({ id: `provider-${index}` }),
    );

    render(<ProvidersPage focusProviderId="provider-10" />);

    await waitFor(() => {
      expect(screen.getByTestId("provider-row-provider-10")).toHaveAttribute("data-focused", "true");
    });
  });

  test("shows a catalog warning returned by OAuth login", () => {
    render(<ProvidersPage warning="catalog_unavailable" />);
    expect(screen.getByRole("status")).toHaveTextContent(/catalog|模型目录/u);
  });
});
