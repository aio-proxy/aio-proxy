import type { DashboardPluginSummary } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';

import { PluginsTable } from './plugins-table';

test('renders a plugin display name', () => {
  const plugins: DashboardPluginSummary[] = [
    {
      builtin: true,
      displayName: 'OpenAI OAuth',
      enabled: true,
      hasOptions: false,
      packageName: '@aio-proxy/plugin-openai',
      state: { status: 'ready' },
    },
  ];

  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PluginsTable plugins={plugins} />
    </QueryClientProvider>,
  );

  expect(screen.getByText('OpenAI OAuth')).toBeInTheDocument();
});
