import { beforeEach, expect, rs, test } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SidebarProvider } from "@/components/ui/sidebar";

import { SidebarLogout } from "./sidebar-logout";

const mocks = rs.hoisted(() => ({
  logoutDashboard: rs.fn().mockResolvedValue(undefined),
  status: "authenticated" as "authenticated" | "disabled",
  toastError: rs.fn(),
}));

rs.mock("@aio-proxy/i18n", () => ({
  m: {
    "dashboard.auth.logout": () => "Sign out",
    "dashboard.auth.logout_failed": () => "Could not sign out.",
  },
}));

rs.mock("@/modules/auth/hooks/use-dashboard-auth-session", () => ({
  useDashboardAuthSession: () => ({ data: { status: mocks.status } }),
}));

rs.mock("@/modules/auth/services/auth-service", () => ({ logoutDashboard: mocks.logoutDashboard }));
rs.mock("sonner", () => ({ toast: { error: mocks.toastError } }));

const renderLogout = () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SidebarProvider>
        <SidebarLogout />
      </SidebarProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  mocks.logoutDashboard.mockReset().mockResolvedValue(undefined);
  mocks.toastError.mockReset();
  mocks.status = "authenticated";
});

test("logs out the authenticated Dashboard session", async () => {
  mocks.status = "authenticated";
  renderLogout();

  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

  await waitFor(() => expect(mocks.logoutDashboard).toHaveBeenCalledTimes(1));
});

test("reports a logout failure", async () => {
  mocks.status = "authenticated";
  mocks.logoutDashboard.mockRejectedValueOnce(new Error("offline"));
  renderLogout();

  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

  await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Could not sign out."));
});

test("disables logout while the request is pending", async () => {
  mocks.status = "authenticated";
  let finishLogout: (() => void) | undefined;
  mocks.logoutDashboard.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishLogout = resolve;
      }),
  );
  renderLogout();

  const button = screen.getByRole("button", { name: "Sign out" });
  fireEvent.click(button);

  await waitFor(() => expect(button).toBeDisabled());
  finishLogout?.();
  await waitFor(() => expect(button).not.toBeDisabled());
});

test("stays hidden when Dashboard authentication is disabled", () => {
  mocks.status = "disabled";
  renderLogout();

  expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
});
