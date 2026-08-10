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
