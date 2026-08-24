import { m } from '@aio-proxy/i18n';
import { SidebarInset, SidebarProvider } from '@aio-proxy/ui/components/sidebar';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { Toaster } from '@aio-proxy/ui/components/toast';
import { Outlet, useRouterState } from '@tanstack/react-router';

import { SideMenu } from '@/components/side-menu';
import { useDashboardAuthSession } from '@/modules/auth/hooks/use-dashboard-auth-session';
import { DashboardUnavailable } from '@/modules/auth/templates/dashboard-unavailable';
import { LoginPage } from '@/modules/auth/templates/login-page';

const standalonePath = (pathname: string): boolean =>
  pathname === '/oauth/complete' || pathname === '/agents/authorize';

export const RootLayoutContent: React.FC = () => {
  const session = useDashboardAuthSession();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  if (standalonePath(pathname)) {
    return (
      <div className="min-h-dvh bg-page-background">
        <Outlet />
      </div>
    );
  }

  if (session.isPending) {
    return (
      <main
        aria-label={m['dashboard.auth.loading']?.() ?? 'Loading Dashboard'}
        className="flex min-h-dvh items-center justify-center bg-page-background px-4"
      >
        <div className="w-full max-w-sm space-y-4" role="status">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-40 w-full rounded-4xl" />
        </div>
      </main>
    );
  }
  if (session.isError || session.data.status === 'unavailable') return <DashboardUnavailable />;
  if (session.data.status === 'unauthenticated')
    return session.data.reason === undefined ? <LoginPage /> : <LoginPage reason={session.data.reason} />;

  return (
    <SidebarProvider className="overflow-x-hidden overflow-y-hidden bg-page-background">
      <SideMenu />
      <SidebarInset className="h-dvh overflow-hidden bg-transparent">
        <Outlet />
      </SidebarInset>
      <Toaster />
    </SidebarProvider>
  );
};
