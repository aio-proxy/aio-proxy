import { describe, expect, test } from "@rstest/core";
import { render, screen } from "@testing-library/react";

import { providerStub } from "../provider-fixtures";
import { ProviderStateCell } from "./provider-state-cell";

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
    expect(screen.queryByText("aio-proxy provider login --provider provider-id")).toBeNull();
    expect(screen.queryByText(/Reauthorize|重新授权/u)).toBeNull();
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

    expect(screen.queryByText("aio-proxy provider login --provider chatgpt-personal")).toBeNull();
    expect(screen.queryByText("aio-proxy provider login default")).toBeNull();
    expect(screen.queryByText(/Reauthorize|重新授权/u)).toBeNull();
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
