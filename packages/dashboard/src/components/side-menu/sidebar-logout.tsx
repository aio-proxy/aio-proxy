import { m } from "@aio-proxy/i18n";
import { LogOut } from "lucide-react";

import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useDashboardAuthSession } from "@/modules/auth/hooks/use-dashboard-auth-session";
import { useDashboardLogout } from "@/modules/auth/hooks/use-dashboard-logout";

export const SidebarLogout: React.FC = () => {
  const session = useDashboardAuthSession();
  const logout = useDashboardLogout();
  if (session.data?.status !== "authenticated") return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton disabled={logout.isPending} onClick={() => logout.mutate()}>
        <LogOut />
        <span>{m["dashboard.auth.logout"]()}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};
