import { m } from "@aio-proxy/i18n";
import { Outlet } from "@tanstack/react-router";

import { SideMenu } from "@/components/side-menu";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { useDashboardAuthSession } from "@/modules/auth/hooks/use-dashboard-auth-session";
import { DashboardUnavailable } from "@/modules/auth/templates/dashboard-unavailable";
import { LoginPage } from "@/modules/auth/templates/login-page";

export const RootLayoutContent: React.FC = () => {
  const session = useDashboardAuthSession();

  if (session.isPending) {
    return (
      <main
        aria-label={m["dashboard.auth.loading"]()}
        className="flex min-h-dvh items-center justify-center bg-background px-4"
      >
        <div className="w-full max-w-sm space-y-4" role="status">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-40 w-full rounded-4xl" />
        </div>
      </main>
    );
  }
  if (session.isError || session.data.status === "unavailable") return <DashboardUnavailable />;
  if (session.data.status === "unauthenticated") return <LoginPage reason={session.data.reason} />;

  return (
    <SidebarProvider className="bg-sidebar">
      <SideMenu />
      <SidebarInset className="h-dvh bg-transparent">
        <Outlet />
      </SidebarInset>
      <Toaster />
    </SidebarProvider>
  );
};
