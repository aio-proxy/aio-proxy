import { SidebarProvider } from '@aio-proxy/ui/components/sidebar';
import { expect, rs, test } from '@rstest/core';
import { render, screen, within } from '@testing-library/react';

import { SideMenu } from './side-menu';

rs.mock('@tanstack/react-router', () => ({
  Link: ({ to, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props} />
  ),
  useLocation: () => ({ pathname: '/' }),
}));

rs.mock('./sidebar-preferences', () => ({ SidebarPreferences: () => null }));

test('groups Dashboard and Traces under Observability', () => {
  render(
    <SidebarProvider>
      <SideMenu />
    </SidebarProvider>,
  );

  const label = screen.getByText(/Observability|观测/u);
  const group = label.closest('[data-sidebar="group"]');
  expect(group).not.toBeNull();
  expect(within(group as HTMLElement).getByRole('link', { name: /Dashboard|控制台/u })).toHaveAttribute('href', '/');
  expect(within(group as HTMLElement).getByRole('link', { name: /Traces|追踪/u })).toHaveAttribute('href', '/traces');
});

test('groups Providers, Routing, Plugins, and Settings under Configuration', () => {
  render(
    <SidebarProvider>
      <SideMenu />
    </SidebarProvider>,
  );

  const label = screen.getByText(/Configuration|配置|設定|구성/u);
  const group = label.closest('[data-sidebar="group"]');
  expect(group).not.toBeNull();
  const configuration = group as HTMLElement;
  expect(
    within(configuration).getByRole('link', { name: /Providers|提供商|プロバイダー|프로바이더/u }),
  ).toHaveAttribute('href', '/providers');
  expect(within(configuration).getByRole('link', { name: /Routing|路由|ルーティング|라우팅/u })).toHaveAttribute(
    'href',
    '/routing',
  );
  expect(within(configuration).getByRole('link', { name: /Plugins|插件|プラグイン|플러그인|外掛/u })).toHaveAttribute(
    'href',
    '/plugins',
  );
  expect(within(configuration).getByRole('link', { name: /Settings|设置|設定|설정/u })).toHaveAttribute(
    'href',
    '/settings',
  );
});
