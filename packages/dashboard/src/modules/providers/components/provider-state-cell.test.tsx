import { describe, expect, rs, test } from "@rstest/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { providerStub, RouterLinkStub } from "../test-doubles";
import { ProviderActionsMenu } from "./provider-actions-menu";
import { ProviderStateCell } from "./provider-state-cell";

rs.mock("@tanstack/react-router", () => ({
  Link: RouterLinkStub,
}));

describe("provider state cell", () => {
  test.each([
    ["ready", providerStub({ state: { status: "ready", catalog: "fresh" } }), /Ready|就绪/u],
    ["stale", providerStub({ state: { status: "ready", catalog: "stale" } }), /Stale|过期/u],
    [
      "unavailable",
      providerStub({
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
        provider={providerStub({
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
        provider={providerStub({
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

  test("does not render targeted login when a credential diagnostic omits its command", () => {
    render(
      <ProviderStateCell
        provider={providerStub({
          id: "chatgpt-personal",
          state: {
            status: "unavailable",
            diagnostic: {
              code: "CREDENTIALS_MISSING_OR_INVALID",
              summary: "Credentials missing or invalid.",
              retryable: false,
              occurredAt: "2026-07-14T00:00:00.000Z",
            },
          },
        })}
      />,
    );

    expect(screen.getByText("Credentials missing or invalid.")).toBeTruthy();
    expect(screen.queryByText("aio-proxy provider login --provider chatgpt-personal")).toBeNull();
  });
});

describe("provider diagnostics actions", () => {
  test.each(["oauth", "invalid"] as const)("keeps %s rows read-only except delete", async (kind) => {
    render(<ProviderActionsMenu provider={providerStub({ kind })} onDelete={() => {}} />);
    fireEvent.click(screen.getByTestId("provider-actions-trigger"));

    expect(await screen.findByTestId("provider-action-delete")).toBeTruthy();
    expect(screen.queryByTestId("provider-action-edit")).toBeNull();
    expect(screen.queryByRole("button", { name: /Login|登录/u })).toBeNull();
  });

  test.each(["api", "ai-sdk"] as const)("retains edit for %s rows", async (kind) => {
    render(<ProviderActionsMenu provider={providerStub({ kind })} onDelete={() => {}} />);
    fireEvent.click(screen.getByTestId("provider-actions-trigger"));

    expect(await screen.findByTestId("provider-action-edit")).toBeTruthy();
    expect(screen.getByTestId("provider-action-delete")).toBeTruthy();
  });

  test.each(["api", "ai-sdk"] as const)("retains edit for unavailable %s rows", async (kind) => {
    render(
      <ProviderActionsMenu
        provider={providerStub({
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
        provider={providerStub({
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
