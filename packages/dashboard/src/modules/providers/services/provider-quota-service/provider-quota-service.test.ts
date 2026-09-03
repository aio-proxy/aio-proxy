import { beforeEach, describe, expect, rs, test } from '@rstest/core';

import { queryKeys } from '@/lib/query-keys';

import { getProviderQuota, providerQuotaQueryOptions } from '.';

const mocks = rs.hoisted(() => ({ quotaQuery: rs.fn() }));

rs.mock('@/lib/dashboard-client', () => ({
  dashboardClient: {
    dashboard: { api: { providers: { ':id': { quota: { $query: mocks.quotaQuery } } } } },
  },
}));

const entry = { snapshot: { items: [] }, sampledAt: 1_000, stale: false };

describe('Provider quota service', () => {
  beforeEach(() => mocks.quotaQuery.mockReset());

  test('a passive read asks the server not to bypass its cooldown', async () => {
    mocks.quotaQuery.mockResolvedValue(Response.json(entry));

    const options = providerQuotaQueryOptions('openai.main');

    expect(await options.queryFn?.({} as never)).toEqual(entry);
    expect(mocks.quotaQuery).toHaveBeenCalledWith({ param: { id: 'openai.main' }, json: { refresh: false } });
    // The card and the dialog must land on one cache entry, so `refresh` may not enter the key.
    expect(options.queryKey).toEqual(queryKeys.providerQuota('openai.main'));
  });

  test('an explicit refresh bypasses the cooldown', async () => {
    mocks.quotaQuery.mockResolvedValue(Response.json(entry));

    await getProviderQuota('openai.main', true);

    expect(mocks.quotaQuery).toHaveBeenCalledWith({ param: { id: 'openai.main' }, json: { refresh: true } });
  });

  test('rejects a failed quota response instead of returning an empty snapshot', async () => {
    mocks.quotaQuery.mockResolvedValue(new Response(null, { status: 404 }));

    await expect(getProviderQuota('openai.main', false)).rejects.toMatchObject({
      name: 'DashboardProviderQuotaRequestError',
      status: 404,
    });
  });
});
