import type { ComponentProps, ComponentType } from "react";

import { m } from "@aio-proxy/i18n";
import { Link, useLocation } from "@tanstack/react-router";
import { Boxes, ChartNoAxesCombined, HandPlatter, List } from "lucide-react";

import { AioProxyBrand } from "@/components/aio-proxy-brand";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

import { SidebarPreferences } from "./sidebar-preferences";

interface SideMenuItem {
  id: string;
  label: string;
  icon: ComponentType<ComponentProps<"svg">>;
  to: ComponentProps<typeof Link>["to"];
  badge?: string;
  isActive?: (pathname: string) => boolean;
}

interface SideMenuGroup {
  label: string;
  items: readonly SideMenuItem[];
}

export const SideMenu: React.FC = () => {
  const groups: readonly SideMenuGroup[] = [
    {
      label: m["dashboard.menus.overview"](),
      items: [
        {
          id: "dashboard",
          label: m["dashboard.menus.dashboard"](),
          icon: ChartNoAxesCombined,
          to: "/",
          isActive: (pathname) => pathname === "/",
        },
        {
          id: "logs",
          label: m["dashboard.menus.logs"](),
          icon: List,
          to: "/logs",
          isActive: (pathname) => pathname.startsWith("/logs"),
        },
      ],
    },
    {
      label: m["dashboard.menus.configuration"](),
      items: [
        {
          id: "providers",
          label: m["dashboard.menus.providers"](),
          icon: HandPlatter,
          to: "/providers",
          isActive: (pathname) => pathname.startsWith("/providers"),
        },
        {
          id: "models",
          label: m["dashboard.menus.models"](),
          icon: Boxes,
          to: "/models",
          badge: "1", // todo: fetch the number of models from the backend
          isActive: (pathname) => pathname.startsWith("/models"),
        },
      ],
    },
  ];

  const location = useLocation();

  return (
    <Sidebar variant="floating">
      <SidebarHeader>
        <div className="ml-3">
          <AioProxyBrand />
        </div>
      </SidebarHeader>
      <SidebarContent>
        {groups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const isActive = item.isActive ? item.isActive(location.pathname) : false;
                  return (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton isActive={isActive} render={<Link to={item.to!} />}>
                        <item.icon />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                      {item.badge ? <SidebarMenuBadge>{item.badge}</SidebarMenuBadge> : null}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarPreferences />
    </Sidebar>
  );
};
