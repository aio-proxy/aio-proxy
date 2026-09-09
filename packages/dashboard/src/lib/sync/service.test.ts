import { afterEach, expect, rs, test } from '@rstest/core';

import { clearDashboardAuthToken } from '@/lib/dashboard-auth-token';

import { previewSync, syncBackendsQueryOptions, syncQueryOptions } from './service';

afterEach(() => {
  rs.restoreAllMocks();
  clearDashboardAuthToken();
});

test('uses the shared sync query namespace and wraps the typed status endpoint', () => {
  expect(syncQueryOptions().queryKey).toEqual(['sync']);
  expect(syncBackendsQueryOptions().queryKey).toEqual(['sync', 'backends']);
});

test('preserves the stable server error code without exposing native response text', async () => {
  rs.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ ok: false, error: { code: 'preview-stale' }, detail: 'native secret' }, { status: 409 }),
  );

  await expect(previewSync({ kind: 'join', providerId: 'work' })).rejects.toMatchObject({
    code: 'preview-stale',
    status: 409,
  });
});
