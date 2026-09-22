import { expect, rs, test } from '@rstest/core';

import { providerCatalogPluginsQueryOptions, providerCatalogQueryOptions } from './provider-catalog';

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

test('rejects a non-2xx provider catalog instead of resolving the error body', async () => {
  mocks.providers.mockResolvedValue({
    ok: false,
    status: 503,
    json: () => Promise.resolve({ error: 'dashboard_unavailable' }),
  });

  await expect(providerCatalogQueryOptions().queryFn?.({} as never)).rejects.toThrow(
    'Dashboard provider request failed with status 503',
  );
  expect(mocks.providers).toHaveBeenCalledOnce();
});

test('rejects a non-2xx plugin catalog instead of resolving the error body', async () => {
  mocks.plugins.mockResolvedValue({
    ok: false,
    status: 503,
    json: () => Promise.resolve({ error: 'dashboard_unavailable' }),
  });

  await expect(providerCatalogPluginsQueryOptions().queryFn?.({} as never)).rejects.toThrow(
    'Dashboard plugin request failed with status 503',
  );
  expect(mocks.plugins).toHaveBeenCalledOnce();
});
