import { describe, expect, test } from 'bun:test';

import { currentXAIGrokCredential, refreshXAIGrokCredential } from './oauth';
import { DEVICE, sequenceFetch, TOKEN } from './oauth.test-support';

describe('xAI Grok OAuth', () => {
  test('keeps an omitted refresh token and classifies refresh failures', async () => {
    const credential = {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: 0,
      email: 'person@example.com',
      subject: 'subject-1',
    };
    const refreshed = await refreshXAIGrokCredential(credential, {
      fetch: sequenceFetch(
        [],
        [
          Response.json({ device_authorization_endpoint: DEVICE, token_endpoint: TOKEN }),
          Response.json({ access_token: 'new-access', expires_in: 60 }),
        ],
      ),
      now: () => 1_700_000_000_000,
    });
    expect(refreshed).toEqual({ ...credential, accessToken: 'new-access', expiresAt: 1_700_000_060_000 });

    const rejected = refreshXAIGrokCredential(credential, {
      fetch: sequenceFetch(
        [],
        [
          Response.json({ device_authorization_endpoint: DEVICE, token_endpoint: TOKEN }),
          Response.json({ error: 'invalid_grant' }, { status: 400 }),
        ],
      ),
    });
    await expect(rejected).rejects.toMatchObject({ retryable: false, options: { reason: 'invalid_grant' } });

    const unavailable = refreshXAIGrokCredential(credential, {
      fetch: sequenceFetch(
        [],
        [
          Response.json({ device_authorization_endpoint: DEVICE, token_endpoint: TOKEN }),
          new Response(null, { status: 503 }),
        ],
      ),
    });
    await expect(unavailable).rejects.toMatchObject({ retryable: true, options: { reason: 'upstream_5xx' } });
  });

  test('refreshes through the host credential port inside the five-minute window', async () => {
    let metadata: unknown;
    const expired = { accessToken: 'old', refreshToken: 'refresh', expiresAt: 0 };
    const value = await currentXAIGrokCredential(
      {
        read: async () => ({ revision: 4, value: expired }),
        refresh: async (revision, exchange) => {
          const updated = await exchange({ revision, value: expired }, new AbortController().signal);
          metadata = updated.metadata;
          return { status: 'updated', snapshot: { revision: revision + 1, value: updated.value } };
        },
      },
      {
        fetch: sequenceFetch(
          [],
          [
            Response.json({ device_authorization_endpoint: DEVICE, token_endpoint: TOKEN }),
            Response.json({ access_token: 'new', expires_in: 60 }),
          ],
        ),
        now: () => 1_700_000_000_000,
      },
    );
    expect(value.accessToken).toBe('new');
    expect(metadata).toEqual({ expiresAt: 1_700_000_060_000 });
  });
});
