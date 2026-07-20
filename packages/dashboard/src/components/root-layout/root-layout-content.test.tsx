import { expect, rs, test } from "@rstest/core";
import { render, screen } from "@testing-library/react";

import { RootLayoutContent } from "./root-layout-content";

const mocks = rs.hoisted(() => ({ status: "unauthenticated" }));

rs.mock("@aio-proxy/i18n", () => ({ m: { "dashboard.auth.loading": () => "Loading Dashboard" } }));
rs.mock("@tanstack/react-router", () => ({ Outlet: () => <div>Protected content</div> }));
rs.mock("@/components/side-menu", () => ({ SideMenu: () => <nav>Sidebar</nav> }));
rs.mock("@/components/ui/sidebar", () => ({
  SidebarInset: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SidebarProvider: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));
rs.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
rs.mock("@/modules/auth/hooks/use-dashboard-auth-session", () => ({
  useDashboardAuthSession: () => ({ data: { status: mocks.status }, isError: false, isPending: false }),
}));
rs.mock("@/modules/auth/templates/dashboard-unavailable", () => ({
  DashboardUnavailable: () => <div>Dashboard unavailable</div>,
}));
rs.mock("@/modules/auth/templates/login-page", () => ({ LoginPage: () => <div>Dashboard sign in</div> }));

test("renders only the surface allowed by the Dashboard auth status", () => {
  const view = render(<RootLayoutContent />);
  expect(screen.getByText("Dashboard sign in")).toBeInTheDocument();
  expect(screen.queryByText("Sidebar")).not.toBeInTheDocument();

  mocks.status = "unavailable";
  view.rerender(<RootLayoutContent />);
  expect(screen.getByText("Dashboard unavailable")).toBeInTheDocument();

  mocks.status = "authenticated";
  view.rerender(<RootLayoutContent />);
  expect(screen.getByText("Sidebar")).toBeInTheDocument();
  expect(screen.getByText("Protected content")).toBeInTheDocument();
});
