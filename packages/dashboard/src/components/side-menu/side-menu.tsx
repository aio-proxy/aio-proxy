import { m } from '@aio-proxy/i18n';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@aio-proxy/ui/components/sidebar';
import { Link, useLocation } from '@tanstack/react-router';
import { Blocks, ChartNoAxesCombined, HandPlatter, Settings2, Shuffle, Waypoints } from 'lucide-react';
import type { ComponentProps, ComponentType } from 'react';

import { AioProxyBrand } from '@/components/aio-proxy-brand';

import { SidebarLogout } from './sidebar-logout';

interface SideMenuItem {
  id: string;
  label: string;
  icon: ComponentType<ComponentProps<'svg'>>;
  to: ComponentProps<typeof Link>['to'];
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
      label: m['dashboard.menus.observability'](),
      items: [
        {
          id: 'dashboard',
          label: m['dashboard.menus.dashboard'](),
          icon: ChartNoAxesCombined,
          to: '/',
          isActive: (pathname) => pathname === '/',
        },
        {
          id: 'traces',
          label: m['dashboard.menus.traces'](),
          icon: Waypoints,
          to: '/traces',
          isActive: (pathname) => pathname.startsWith('/traces'),
        },
      ],
    },
    {
      label: m['dashboard.menus.configuration'](),
      items: [
        {
          id: 'providers',
          label: m['dashboard.menus.providers'](),
          icon: HandPlatter,
          to: '/providers',
          isActive: (pathname) => pathname.startsWith('/providers'),
        },
        {
          id: 'routing',
          label: m['dashboard.menus.routing'](),
          icon: Shuffle,
          to: '/routing',
          isActive: (pathname) => pathname.startsWith('/routing'),
        },
        {
          id: 'plugins',
          label: m['dashboard.menus.plugins'](),
          icon: Blocks,
          to: '/plugins',
          isActive: (pathname) => pathname.startsWith('/plugins'),
        },
        {
          id: 'settings',
          label: m['dashboard.menus.settings'](),
          icon: Settings2,
          to: '/settings',
          isActive: (pathname) => pathname.startsWith('/settings'),
        },
        // {
        //   id: 'models',
        //   label: m['dashboard.menus.models'](),
        //   icon: Boxes,
        //   to: '/models',
        //   badge: '1', // todo: fetch the number of models from the backend
        //   isActive: (pathname) => pathname.startsWith('/models'),
        // },
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
      <SidebarFooter>
        <SidebarMenu>
          <SidebarLogout />
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
};
