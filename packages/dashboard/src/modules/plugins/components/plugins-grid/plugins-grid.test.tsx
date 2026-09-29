import type { DashboardPluginSummary } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';

import { PluginsGrid } from './plugins-grid';

const plugin = (values: Partial<DashboardPluginSummary>): DashboardPluginSummary => ({
  builtin: false,
  enabled: true,
  hasOptions: false,
  packageName: '@example/ok',
  state: { status: 'ready' },
  ...values,
});

const plugins: DashboardPluginSummary[] = [
  plugin({ builtin: true, displayName: 'OpenAI OAuth', packageName: '@aio-proxy/plugin-openai' }),
  plugin({ packageName: '@example/ok' }),
  plugin({
    packageName: '@example/broken',
    state: { status: 'failed', diagnostic: { code: 'PLUGIN_LOAD_FAILED', summary: 'entry missing' } as never },
  }),
];

const renderGrid = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PluginsGrid plugins={plugins} />
    </QueryClientProvider>,
  );

test('renders a plugin display name', () => {
  renderGrid();
  expect(screen.getByText('OpenAI OAuth')).toBeInTheDocument();
});

test('the failure summary jumps to only the failed Plugins', () => {
  renderGrid();
  expect(screen.getAllByRole('listitem')).toHaveLength(3);

  fireEvent.click(screen.getByRole('button', { name: /View|查看|檢視/u }));

  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByText('entry missing')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /View|查看|檢視/u })).toBeNull();
});
