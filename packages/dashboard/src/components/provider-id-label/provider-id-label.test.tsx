import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';

import { queryKeys } from '@/lib/query-keys';
import { providerStub } from '@/modules/providers/lib/provider-fixtures';

import { ProviderIdLabel } from './provider-id-label';

const renderLabel = (providerId: string, providers = [providerStub({ id: providerId })]) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.providers, { providers, routingRevision: '1' });
  client.setQueryData(queryKeys.plugins, { plugins: [] });
  return render(
    <QueryClientProvider client={client}>
      <ProviderIdLabel providerId={providerId} />
    </QueryClientProvider>,
  );
};

test('shows the configured name and keeps the Provider ID on the hover title', () => {
  renderLabel('grok-f3495225242e', [providerStub({ id: 'grok-f3495225242e', name: 'Grok' })]);

  expect(screen.getByTitle('grok-f3495225242e')).toHaveTextContent('Grok');
  expect(screen.queryByText('grok-f3495225242e')).toBeNull();
});

test('falls back to the account label, then to the Provider ID', () => {
  const { unmount } = renderLabel('grok-f3495225242e', [
    providerStub({ id: 'grok-f3495225242e', accountLabel: 'a@b.com' }),
  ]);
  expect(screen.getByTitle('grok-f3495225242e')).toHaveTextContent('a@b.com');
  unmount();

  renderLabel('grok-f3495225242e');
  expect(screen.getByTitle('grok-f3495225242e')).toHaveTextContent('grok-f3495225242e');
});

test('draws an API Provider with the same protocol stack as the providers page', () => {
  renderLabel('gateway', [
    providerStub({
      id: 'gateway',
      name: 'Gateway',
      kind: ProviderKind.Api,
      protocols: [ProviderProtocol.OpenAICompatible],
    }),
  ]);

  expect(screen.getByTestId('provider-protocol-stack')).toBeTruthy();
  expect(screen.getByTitle('gateway')).toHaveTextContent('Gateway');
});

test('leaves an ID that is no longer in the catalog as text', () => {
  renderLabel('deleted-provider', []);

  expect(screen.getByTitle('deleted-provider')).toHaveTextContent('deleted-provider');
});
