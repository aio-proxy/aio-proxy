import type { DashboardOAuthProviderEdit, OAuthProvider } from "@aio-proxy/types";

import { afterEach, expect, rs, test } from "@rstest/core";
import { render, screen } from "@testing-library/react";

import { OAuthProviderEditPage } from "./oauth-provider-edit-page";

const provider: OAuthProvider = {
  kind: "oauth",
  id: "person",
  plugin: "@example/oauth",
  capability: "default",
  name: "Personal",
  enabled: true,
  weight: 2,
  options: { tenant: "work" },
  alias: { chat: { model: "model-2", preserve: false } },
};

const oauth: DashboardOAuthProviderEdit = {
  accountLabel: "person@example.com",
  publicValues: { tenant: "work" },
  form: [
    { type: "text", key: "tenant", label: "Tenant" },
    { type: "secret", key: "token", label: "Token", configured: true },
  ],
  models: ["model-1", "model-2"],
};

const mocks = rs.hoisted(() => ({ sessionError: false }));

rs.mock("@tanstack/react-query", () => ({
  queryOptions: <T,>(options: T) => options,
  useMutation: () => ({ mutate: rs.fn(), isPending: false }),
  useQuery: () => ({ data: undefined, isError: mocks.sessionError, refetch: rs.fn() }),
  useQueryClient: () => ({ invalidateQueries: rs.fn() }),
}));

rs.mock("@tanstack/react-router", () => ({
  Link: ({ children }: React.PropsWithChildren) => <button type="button">{children}</button>,
  useNavigate: () => rs.fn(),
}));

afterEach(() => {
  mocks.sessionError = false;
});

test("OAuth edit page keeps identity immutable and exposes account fields, models, aliases, and reauthorization", () => {
  render(<OAuthProviderEditPage provider={provider} oauth={oauth} sessionId={undefined} onSessionIdChange={rs.fn()} />);

  expect(screen.getByLabelText(/Provider ID|提供商 ID/u)).toBeDisabled();
  expect(screen.getByLabelText(/OAuth service|OAuth 服务/u)).toBeDisabled();
  expect(screen.getByLabelText(/Account|账户/u)).toBeDisabled();
  expect(screen.getByLabelText("Tenant")).toHaveValue("work");
  expect(screen.getByLabelText("Token")).toHaveAttribute("type", "password");
  expect(screen.getByText("model-1")).toBeTruthy();
  expect(screen.getByText("model-2")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Edit Aliases|编辑别名/u })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Reauthorize|重新授权/u })).toBeTruthy();
});

test("OAuth edit page hides edit actions while an existing session loads", () => {
  render(
    <OAuthProviderEditPage
      provider={provider}
      oauth={oauth}
      sessionId="0198bfc4-239e-7d62-bcb0-a9e0849cabaf"
      onSessionIdChange={rs.fn()}
    />,
  );

  expect(screen.queryByRole("button", { name: /Reauthorize|重新授权/u })).toBeNull();
});

test("OAuth edit page offers a restart when an existing session cannot be loaded", () => {
  mocks.sessionError = true;
  const changeSession = rs.fn();
  render(
    <OAuthProviderEditPage
      provider={provider}
      oauth={oauth}
      sessionId="0198bfc4-239e-7d62-bcb0-a9e0849cabaf"
      onSessionIdChange={changeSession}
    />,
  );

  expect(screen.getByText(/session is unavailable|授权会话不可用/u)).toBeTruthy();
  screen.getByRole("button", { name: /Start over|重新开始/u }).click();
  expect(changeSession).toHaveBeenCalledWith(undefined);
});
