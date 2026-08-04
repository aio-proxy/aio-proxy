import { afterEach, expect, rs, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';
import { within } from '@testing-library/react';

import { PageContainer } from './page-container';

rs.mock('@tanstack/react-router', () => ({
  Link: ({ to, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props} />
  ),
}));

afterEach(() => {
  rs.restoreAllMocks();
});

test('renders back navigation as a link without native-button warnings', () => {
  const consoleError = rs.spyOn(console, 'error').mockImplementation(() => undefined);

  render(
    <PageContainer title="Edit Provider" backTo="/providers">
      Content
    </PageContainer>,
  );

  expect(screen.getByRole('link', { name: /Back|返回/u })).toHaveAttribute('href', '/providers');
  expect(consoleError.mock.calls.flat().join(' ')).not.toContain('expected a native <button>');
});

test('renders an optional subtitle directly with the page heading', () => {
  render(<PageContainer title="Edit Provider" subtitle="carpool · API" />);

  expect(screen.getByRole('heading', { level: 1, name: 'Edit Provider' })).toBeInTheDocument();
  expect(screen.getByText('carpool · API')).toBeInTheDocument();
});

test('renders breadcrumbs before the page title', () => {
  render(
    <PageContainer title="Dashboard" breadcrumbs={[{ label: '观测' }, { label: 'Dashboard' }]}>
      Content
    </PageContainer>,
  );

  const breadcrumb = screen.getByRole('navigation', { name: /^Breadcrumbs$|^面包屑$/u });
  expect(within(breadcrumb).getByText('观测')).toBeInTheDocument();
  expect(within(breadcrumb).getByText('Dashboard')).toBeInTheDocument();
  expect(
    breadcrumb.compareDocumentPosition(screen.getByRole('heading', { level: 1, name: 'Dashboard' })) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
