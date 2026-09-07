import { describe, expect, test } from 'bun:test';

import type { RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { CLAUDE_BOOTSTRAP_MODEL, CLAUDE_OAUTH_BETA } from './constants';
import { resolveClaudeIdentity } from './identity';

describe('Claude identity', () => {
  test('skips bootstrap when token already has account, email, and org', async () => {
    let calls = 0;
    const identity = await resolveClaudeIdentity(
      {
        access_token: 'access',
        account: { uuid: 'acct', email_address: 'Person@Example.com' },
        organization: { uuid: 'org', name: 'Team' },
      },
      {
        fetch: async () => {
          calls += 1;
          throw new Error('bootstrap must not run');
        },
        phase: 'login',
      },
    );
    expect(calls).toBe(0);
    expect(identity).toEqual({
      accountId: 'acct',
      email: 'person@example.com',
      organizationId: 'org',
      organizationName: 'Team',
    });
  });

  test('bootstraps when any login identity field is missing', async () => {
    const withoutAccount = await resolveClaudeIdentity(
      {
        access_token: 'access',
        account: { email_address: 'Person@Example.com' },
        organization: { uuid: 'org', name: 'Team' },
      },
      {
        fetch: async () =>
          Response.json({
            oauth_account: {
              account_uuid: 'boot-acct',
              account_email: 'ignored@example.com',
              organization_uuid: 'boot-org',
              organization_name: 'Boot Team',
            },
          }),
        phase: 'login',
      },
    );
    expect(withoutAccount).toEqual({
      accountId: 'boot-acct',
      email: 'person@example.com',
      organizationId: 'org',
      organizationName: 'Team',
    });

    let orgCalls = 0;
    const withoutOrg = await resolveClaudeIdentity(
      {
        access_token: 'access',
        account: { uuid: 'acct', email_address: 'Person@Example.com' },
      },
      {
        fetch: async () => {
          orgCalls += 1;
          return Response.json({
            oauth_account: {
              account_uuid: 'ignored-acct',
              account_email: 'ignored@example.com',
              organization_uuid: 'boot-org',
              organization_name: 'Boot Team',
            },
          });
        },
        phase: 'login',
      },
    );
    expect(orgCalls).toBe(1);
    expect(withoutOrg).toEqual({
      accountId: 'acct',
      email: 'person@example.com',
      organizationId: 'boot-org',
      organizationName: 'Boot Team',
    });
  });

  test('bootstraps missing login identity and ignores org on refresh', async () => {
    const requests: Request[] = [];
    const inits: Array<RuntimeRequestInit | undefined> = [];
    const login = await resolveClaudeIdentity(
      { access_token: 'access' },
      {
        fetch: async (input, init) => {
          requests.push(new Request(input, init));
          inits.push(init);
          return Response.json({
            oauth_account: {
              account_uuid: 'boot-acct',
              account_email: 'boot@example.com',
              organization_uuid: 'boot-org',
              organization_name: 'Boot Team',
            },
          });
        },
        phase: 'login',
        signal: new AbortController().signal,
      },
    );
    expect(requests[0]?.url).toBe(
      `https://api.anthropic.com/api/claude_cli/bootstrap?entrypoint=cli&model=${encodeURIComponent(CLAUDE_BOOTSTRAP_MODEL)}`,
    );
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer access');
    expect(requests[0]?.headers.get('anthropic-beta')).toBe(CLAUDE_OAUTH_BETA);
    expect(inits[0]?.aioProxy).toEqual({ traffic: 'control' });
    expect(login).toEqual({
      accountId: 'boot-acct',
      email: 'boot@example.com',
      organizationId: 'boot-org',
      organizationName: 'Boot Team',
    });

    const refresh = await resolveClaudeIdentity(
      { access_token: 'access' },
      {
        fetch: async () =>
          Response.json({
            oauth_account: {
              account_uuid: 'boot-acct',
              account_email: 'boot@example.com',
              organization_uuid: 'boot-org',
              organization_name: 'Boot Team',
            },
          }),
        phase: 'refresh',
      },
    );
    expect(refresh.organizationId).toBeUndefined();
    expect(refresh.organizationName).toBeUndefined();
    expect(refresh.accountId).toBe('boot-acct');
  });

  test('keeps token fields when bootstrap fails', async () => {
    let calls = 0;
    const identity = await resolveClaudeIdentity(
      { access_token: 'access', account: { uuid: 'acct' } },
      {
        fetch: async () => {
          calls += 1;
          return new Response('nope', { status: 500 });
        },
        phase: 'login',
      },
    );
    expect(calls).toBe(1);
    expect(identity).toEqual({ accountId: 'acct' });
  });

  test('rethrows abort when bootstrap is canceled', async () => {
    const reason = new DOMException('cancelled', 'AbortError');
    await expect(
      resolveClaudeIdentity(
        { access_token: 'access' },
        {
          fetch: async (_input, _init) => {
            throw reason;
          },
          phase: 'login',
          signal: AbortSignal.abort(reason),
        },
      ),
    ).rejects.toBe(reason);
  });
});
