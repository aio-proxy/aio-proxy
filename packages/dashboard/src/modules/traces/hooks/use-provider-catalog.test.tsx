import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { providerStub } from '@/lib/provider-fixtures';
import { queryKeys } from '@/lib/query-keys';

import { useProviderCatalog } from './use-provider-catalog';

const mocks = rs.hoisted(() => ({
  plugins: rs.fn(),
  providers: rs.fn(),
}));

rs.mock('@/lib/dashboard-client', () => ({
  dashboardClient: {
    dashboard: {
      api: {
        plugins: { $get: mocks.plugins },
        providers: { $get: mocks.providers },
      },
    },
  },
}));

const catalog = {
  providers: [providerStub({ id: 'provider-a', name: 'Carpool' })],
  routingRevision: '1',
};

test('drops a cached catalog after a failed refresh', async () => {
  mocks.providers.mockResolvedValue({ ok: true, json: () => Promise.resolve(catalog) });
  mocks.plugins.mockResolvedValue({ ok: true, json: () => Promise.resolve({ plugins: [] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useProviderCatalog(), { wrapper });

  await waitFor(() => expect(result.current.providers?.[0]?.name).toBe('Carpool'));

  mocks.providers.mockResolvedValue({
    ok: false,
    status: 503,
    json: () => Promise.resolve({ error: 'dashboard_unavailable' }),
  });
  await queryClient.invalidateQueries({ queryKey: queryKeys.providers }).catch(() => undefined);

  await waitFor(() => expect(result.current.providers).toBeUndefined());
  expect(result.current.plugins).toEqual([]);
});
