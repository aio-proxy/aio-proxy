import { expect, rs, test } from '@rstest/core';

import { providersQueryOptions } from './providers-query';

const mocks = rs.hoisted(() => ({
  list: rs.fn(),
}));

rs.mock('@/lib/dashboard-client', () => ({
  dashboardClient: {
    dashboard: {
      api: {
        providers: { $get: mocks.list },
      },
    },
  },
}));

test('rejects a non-2xx provider list instead of resolving the error body', async () => {
  mocks.list.mockResolvedValue({
    ok: false,
    status: 503,
    json: () => Promise.resolve({ error: 'dashboard_unavailable' }),
  });

  await expect(providersQueryOptions().queryFn?.({} as never)).rejects.toThrow(
    'Dashboard provider request failed with status 503',
  );
  expect(mocks.list).toHaveBeenCalledOnce();
});
