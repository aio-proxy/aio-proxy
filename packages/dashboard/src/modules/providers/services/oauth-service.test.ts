import { expect, rs, test } from '@rstest/core';

import { oauthSessionQueryOptions, startOAuthSession } from './oauth-service';

test.each([true, undefined])(
  'the session request preserves localSignIn=%s at the API boundary',
  async (localSignIn) => {
    const session = { id: '550e8400-e29b-41d4-a716-446655440000', status: 'preparing' };
    const request = rs
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ session }), { headers: { 'content-type': 'application/json' } }),
      );
    const input = {
      targetProviderId: 'existing',
      publicValues: { tenant: 'work' },
      secrets: {},
      clearSecrets: [],
      ...(localSignIn === undefined ? {} : { localSignIn }),
    };
    try {
      await expect(startOAuthSession(input)).resolves.toEqual({ session });
      expect(request).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
      expect(body).toEqual(input);
      if (localSignIn === undefined) expect(body).not.toHaveProperty('localSignIn');
      else expect(body.localSignIn).toBe(true);
    } finally {
      request.mockRestore();
    }
  },
);

test('OAuth session polling stops after the query enters an error state', () => {
  const options = oauthSessionQueryOptions('0198bfc4-239e-7d62-bcb0-a9e0849cabaf');
  const interval = options.refetchInterval as (query: { state: { status: string } }) => number | false | undefined;

  expect(interval({ state: { status: 'error' } })).toBe(false);
});

test('keeps polling while awaiting browser authorization', () => {
  const options = oauthSessionQueryOptions('0198bfc4-239e-7d62-bcb0-a9e0849cabaf');
  const interval = options.refetchInterval as (query: {
    state: { status: string; data?: { session: { status: string } } };
  }) => number | false | undefined;

  expect(interval({ state: { status: 'success', data: { session: { status: 'authorize_url' } } } })).toBe(500);
});
