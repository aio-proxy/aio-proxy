import { describe, expect, test } from 'bun:test';

import { CredentialRefreshError, type RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import type { ClaudeCredential } from '../schema';
import { CLAUDE_CLIENT_ID, CLAUDE_OAUTH_BETA, CLAUDE_REFRESH_USER_AGENT, CLAUDE_TOKEN_URL } from './constants';
import { currentClaudeCredential, refreshClaudeCredential } from './credential';

const stored: ClaudeCredential = {
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  expiresAt: 0,
  email: 'person@example.com',
  accountId: 'acct-1',
  organizationId: 'org-1',
  organizationName: 'Team',
};

describe('Claude credential refresh', () => {
  test('posts JSON refresh with beta header and keeps an omitted refresh token', async () => {
    const requests: Request[] = [];
    const inits: Array<RuntimeRequestInit | undefined> = [];
    const refreshed = await refreshClaudeCredential(stored, {
      now: () => 1_700_000_000_000,
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        inits.push(init);
        return Response.json({ access_token: 'new-access', expires_in: 3600 });
      },
    });
    expect(requests[0]?.url).toBe(CLAUDE_TOKEN_URL);
    expect(requests[0]?.headers.get('anthropic-beta')).toBe(CLAUDE_OAUTH_BETA);
    expect(requests[0]?.headers.get('user-agent')).toBe(CLAUDE_REFRESH_USER_AGENT);
    expect(inits[0]?.aioProxy).toEqual({ traffic: 'control' });
    expect(JSON.parse(await requests[0]!.text())).toEqual({
      grant_type: 'refresh_token',
      client_id: CLAUDE_CLIENT_ID,
      refresh_token: 'old-refresh',
    });
    expect(refreshed).toEqual({
      ...stored,
      accessToken: 'new-access',
      refreshToken: 'old-refresh',
      expiresAt: 1_700_003_300_000,
    });
  });

  test('classifies invalid_grant as non-retryable and 503 as retryable', async () => {
    const invalid = refreshClaudeCredential(stored, {
      fetch: async () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
    });
    await expect(invalid).rejects.toBeInstanceOf(CredentialRefreshError);
    await expect(invalid).rejects.toMatchObject({ retryable: false, options: { reason: 'invalid_grant' } });

    const unavailable = refreshClaudeCredential(stored, {
      fetch: async () => new Response(null, { status: 503 }),
    });
    await expect(unavailable).rejects.toMatchObject({ retryable: true, options: { reason: 'upstream_5xx' } });
  });

  test('does not rewrite stored organization after refresh identity fill', async () => {
    const incomplete = { accessToken: 'old', refreshToken: 'refresh', expiresAt: 0 };
    const refreshed = await refreshClaudeCredential(incomplete, {
      now: () => 1_700_000_000_000,
      fetch: async (input) => {
        if (String(input).includes('/oauth/token')) {
          return Response.json({ access_token: 'new', refresh_token: 'rotated', expires_in: 60 });
        }
        return Response.json({
          oauth_account: {
            account_uuid: 'acct',
            account_email: 'boot@example.com',
            organization_uuid: 'should-not-store',
            organization_name: 'Nope',
          },
        });
      },
    });
    expect(refreshed.accountId).toBe('acct');
    expect(refreshed.email).toBe('boot@example.com');
    expect(refreshed.organizationId).toBeUndefined();
    expect(refreshed.refreshToken).toBe('rotated');
  });

  test('keeps stored organization when token JSON contains a different organization', async () => {
    const refreshed = await refreshClaudeCredential(stored, {
      now: () => 1_700_000_000_000,
      fetch: async () =>
        Response.json({
          access_token: 'new-access',
          expires_in: 3600,
          organization: { uuid: 'other', name: 'Other' },
        }),
    });
    expect(refreshed.organizationId).toBe('org-1');
    expect(refreshed.organizationName).toBe('Team');
    expect(refreshed.accessToken).toBe('new-access');
  });

  test('refreshes through the host port only when stored expiresAt has been reached', async () => {
    let exchanges = 0;
    const fresh = { ...stored, expiresAt: 1_700_000_000_001 };
    const kept = await currentClaudeCredential(
      {
        read: async () => ({ revision: 1, value: fresh }),
        refresh: async () => {
          throw new Error('unexpired credential must not refresh');
        },
      },
      { now: () => 1_700_000_000_000 },
    );
    expect(kept.accessToken).toBe('old-access');

    const expired = await currentClaudeCredential(
      {
        read: async () => ({ revision: 2, value: stored }),
        refresh: async (revision, exchange) => {
          const updated = await exchange({ revision, value: stored }, new AbortController().signal);
          exchanges += 1;
          return { status: 'updated', snapshot: { revision: revision + 1, value: updated.value } };
        },
      },
      {
        now: () => 1_700_000_000_000,
        fetch: async () => Response.json({ access_token: 'ported', expires_in: 60 }),
      },
    );
    expect(exchanges).toBe(1);
    expect(expired.accessToken).toBe('ported');
  });
});
