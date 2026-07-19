import type { DashboardOAuthCapability } from "@aio-proxy/types";
import { afterEach, expect, rs, test } from "@rstest/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { OAuthProviderCreatePage } from "./oauth-provider-create-page";

const capability: DashboardOAuthCapability = {
  plugin: "@example/oauth",
  capability: "default",
  label: "Example OAuth",
  description: "Example account",
  defaults: {},
  form: [
    { type: "text", key: "tenant", label: "Tenant" },
    { type: "secret", key: "token", label: "Token", configured: false },
  ],
};

const mocks = rs.hoisted(() => ({ start: rs.fn(), navigate: rs.fn() }));

rs.mock("@tanstack/react-query", () => ({
  queryOptions: <T,>(options: T) => options,
  useQuery: (options: { queryKey: readonly string[] }) => ({
    data: options.queryKey[0] === "oauth-capabilities" ? { capabilities: [capability] } : undefined,
    isLoading: false,
  }),
  useMutation: () => ({ mutate: mocks.start, isPending: false }),
}));

rs.mock("@tanstack/react-router", () => ({
  Link: ({ children }: React.PropsWithChildren) => <button type="button">{children}</button>,
  useNavigate: () => mocks.navigate,
}));

afterEach(() => rs.restoreAllMocks());

test("OAuth create page selects a capability and renders its account fields before authorization", async () => {
  render(<OAuthProviderCreatePage sessionId={undefined} onSessionIdChange={rs.fn()} />);

  const picker = screen.getByRole("combobox", { name: /OAuth provider|OAuth 提供商/u });
  fireEvent.keyDown(picker, { key: "ArrowDown" });
  fireEvent.change(picker, { target: { value: "Example" } });
  fireEvent.click(await screen.findByRole("option", { name: /Example OAuth/u }));

  expect(screen.getByLabelText("Tenant")).toBeTruthy();
  expect(screen.getByLabelText("Token")).toHaveAttribute("type", "password");
  expect(screen.getByRole("button", { name: /Continue authorization|继续授权/u })).toBeTruthy();
});

test("OAuth create page hides the setup form while an existing session loads", () => {
  render(<OAuthProviderCreatePage sessionId="0198bfc4-239e-7d62-bcb0-a9e0849cabaf" onSessionIdChange={rs.fn()} />);

  expect(screen.queryByRole("button", { name: /Continue authorization|继续授权/u })).toBeNull();
});
