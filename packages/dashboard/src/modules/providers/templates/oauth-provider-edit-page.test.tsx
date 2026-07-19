import type { DashboardOAuthProviderEdit, OAuthProvider } from "@aio-proxy/types";
import { expect, rs, test } from "@rstest/core";
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

rs.mock("@tanstack/react-query", () => ({
  queryOptions: <T,>(options: T) => options,
  useMutation: () => ({ mutate: rs.fn(), isPending: false }),
  useQuery: () => ({ data: undefined, refetch: rs.fn() }),
  useQueryClient: () => ({ invalidateQueries: rs.fn() }),
}));

rs.mock("@tanstack/react-router", () => ({
  Link: ({ children }: React.PropsWithChildren) => <button type="button">{children}</button>,
  useNavigate: () => rs.fn(),
}));

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
