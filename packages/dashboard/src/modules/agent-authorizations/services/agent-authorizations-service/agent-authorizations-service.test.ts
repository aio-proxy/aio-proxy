import { beforeEach, expect, rs, test } from '@rstest/core';

import { decideAgentAuthorization, resolveAgentAuthorization } from './agent-authorizations-service';

const mocks = rs.hoisted(() => ({ approve: rs.fn(), deny: rs.fn(), resolve: rs.fn() }));
rs.mock('@/lib/dashboard-client', () => ({
  dashboardClient: {
    dashboard: {
      api: {
        'agent-authorizations': {
          resolve: { $post: mocks.resolve },
          ':deviceId': { approve: { $post: mocks.approve }, deny: { $post: mocks.deny } },
        },
      },
    },
  },
}));

beforeEach(() => {
  mocks.resolve.mockReset();
  mocks.approve.mockReset();
  mocks.deny.mockReset();
});

test('uses the typed resolve and decision routes', async () => {
  mocks.resolve.mockResolvedValue(Response.json({ status: 'expired' }));
  mocks.approve.mockResolvedValue(Response.json({ status: 'approved' }));
  await expect(resolveAgentAuthorization('ABCD-EFGH')).resolves.toEqual({ status: 'expired' });
  await expect(decideAgentAuthorization('device-id', 'approve')).resolves.toEqual({ status: 'approved' });
  expect(mocks.resolve).toHaveBeenCalledWith({ json: { userCode: 'ABCD-EFGH' } });
  expect(mocks.approve).toHaveBeenCalledWith({ param: { deviceId: 'device-id' } });
});

test.each([
  [503, { error: 'authorization_unavailable' }, 'authorization_unavailable'],
  [404, { error: 'not_found' }, 'not_found'],
  [429, { error: 'rate_limited' }, 'rate_limited'],
] as const)('preserves stable error code for status %s', async (status, body, code) => {
  mocks.resolve.mockResolvedValue(Response.json(body, { status }));
  await expect(resolveAgentAuthorization('ABCD-EFGH')).rejects.toMatchObject({ status, code });
});
