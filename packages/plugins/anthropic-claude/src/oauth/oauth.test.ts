import { describe, expect, test } from 'bun:test';

import type { OAuthLoginContext, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import type { ClaudeCredential } from '../schema';
import { CLAUDE_CLIENT_ID, CLAUDE_LOOPBACK, CLAUDE_SCOPE, CLAUDE_TOKEN_URL } from './constants';
import {
  ClaudeIdentityMissingError,
  ClaudeTokenExchangeError,
  buildClaudeAuthorizationUrl,
  claudeLoginResult,
  loginClaude,
  normalizeClaudeEmail,
} from './oauth';

describe('Claude login identity', () => {
  test('fingerprints account uuid ahead of email', () => {
    const credentials: ClaudeCredential = {
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: 1_700_003_300_000,
      email: 'Person@Example.com',
      accountId: 'acct-uuid',
      organizationId: 'org-uuid',
      organizationName: 'Team',
    };
    const result = claudeLoginResult(credentials);
    const digest = new Bun.CryptoHasher('sha256').update('account:acct-uuid').digest('hex');
    expect(result.fingerprint).toBe(`sha256:${digest}`);
    expect(result.suggestedKey).toBe(`claude-${digest.slice(0, 12)}`);
    expect(result.accountLabel).toBe('person@example.com');
    expect(result.credentials.email).toBe('person@example.com');
    expect(result.expiresAt).toBe(1_700_003_300_000);
    expect(result.credentials.accessToken).toBe('access-secret');
    expect(result.fingerprint).not.toContain('access-secret');
    expect(result.fingerprint).not.toContain('refresh-secret');
    expect(result.suggestedKey).not.toContain('access-secret');
    expect(result.accountLabel).not.toContain('access-secret');
  });

  test('rejects email-only credentials and keeps fingerprint when email or refresh later appear', () => {
    expect(normalizeClaudeEmail(' Person@Example.com ')).toBe('person@example.com');
    expect(normalizeClaudeEmail('   ')).toBeUndefined();
    expect(() =>
      claudeLoginResult({
        accessToken: 'a',
        refreshToken: 'refresh-secret',
        expiresAt: 1,
        email: 'Person@Example.com',
      }),
    ).toThrow(ClaudeIdentityMissingError);
    const accountOnly = claudeLoginResult({
      accessToken: 'a',
      refreshToken: 'refresh-secret',
      expiresAt: 1,
      accountId: 'acct-uuid',
    });
    const digest = new Bun.CryptoHasher('sha256').update('account:acct-uuid').digest('hex');
    expect(accountOnly.fingerprint).toBe(`sha256:${digest}`);
    const laterEmail = claudeLoginResult({
      accessToken: 'b',
      refreshToken: 'other-refresh',
      expiresAt: 2,
      accountId: 'acct-uuid',
      email: 'Person@Example.com',
    });
    expect(laterEmail.fingerprint).toBe(accountOnly.fingerprint);
  });
});

test('builds the claude.ai authorize URL with PKCE and code=true', () => {
  const url = new URL(
    buildClaudeAuthorizationUrl({
      challenge: 'challenge-1',
      redirectUri: 'http://localhost:54545/callback',
      state: 'state-1',
    }),
  );
  expect(url.origin + url.pathname).toBe('https://claude.ai/oauth/authorize');
  expect(url.searchParams.get('client_id')).toBe(CLAUDE_CLIENT_ID);
  expect(url.searchParams.get('code')).toBe('true');
  expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:54545/callback');
  expect(url.searchParams.get('response_type')).toBe('code');
  expect(url.searchParams.get('scope')).toBe(CLAUDE_SCOPE);
  expect(url.searchParams.get('state')).toBe('state-1');
});

test('exchanges the loopback code as JSON without a beta header', async () => {
  const redirectUri = 'http://localhost:54545/callback';
  const requests: Request[] = [];
  const inits: Array<RuntimeRequestInit | undefined> = [];
  const signal = new AbortController().signal;
  const result = await loginClaude(
    loginContext({
      signal,
      loopback: async (request) => {
        expect(request.redirect).toEqual(CLAUDE_LOOPBACK);
        expect(request.allowManualCallbackUrl).toBe(true);
        const url = new URL(request.authorizationUrl({ redirectUri }));
        expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
        expect(url.searchParams.get('state')).toBe(request.state);
        expect(url.searchParams.get('code')).toBe('true');
        return { code: 'auth-code', redirectUri };
      },
    }),
    { waiting: 'Waiting for Claude authorization' },
    {
      now: () => 1_700_000_000_000,
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        inits.push(init);
        expect(init?.signal).toBe(signal);
        return Response.json({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          account: { uuid: 'acct-1', email_address: 'Person@Example.com' },
          organization: { uuid: 'org-1', name: 'Team' },
        });
      },
    },
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(CLAUDE_TOKEN_URL);
  expect(requests[0]?.headers.get('content-type')).toBe('application/json');
  expect(requests[0]?.headers.get('anthropic-beta')).toBeNull();
  expect(inits[0]?.aioProxy).toEqual({ traffic: 'control' });
  expect(JSON.parse(await requests[0]!.text())).toEqual({
    grant_type: 'authorization_code',
    code: 'auth-code',
    redirect_uri: redirectUri,
    client_id: CLAUDE_CLIENT_ID,
    code_verifier: expect.any(String),
    state: expect.any(String),
  });
  expect(result.credentials).toEqual({
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: 1_700_003_300_000,
    email: 'person@example.com',
    accountId: 'acct-1',
    organizationId: 'org-1',
    organizationName: 'Team',
  });
  expect(result.expiresAt).toBe(1_700_003_300_000);
  expect(result.suggestedKey.startsWith('claude-')).toBe(true);
});

test('does not leak the authorization code when exchange fails', async () => {
  let error: unknown;
  try {
    await loginClaude(
      loginContext({
        loopback: async () => ({ code: 'secret-code', redirectUri: 'http://localhost:54545/callback' }),
      }),
      { waiting: 'Waiting for Claude authorization' },
      {
        fetch: async () =>
          Response.json({ error: 'invalid_grant', authorization_code: 'secret-code' }, { status: 400 }),
      },
    );
  } catch (cause) {
    error = cause;
  }
  expect(error).toBeInstanceOf(ClaudeTokenExchangeError);
  expect(error).toMatchObject({ status: 400 });
  expect(JSON.stringify(error)).not.toContain('secret-code');
});

test('fails login when token and bootstrap omit accountId', async () => {
  const urls: string[] = [];
  await expect(
    loginClaude(
      loginContext({
        loopback: async () => ({ code: 'code', redirectUri: 'http://localhost:54545/callback' }),
      }),
      { waiting: 'Waiting for Claude authorization' },
      {
        fetch: async (input) => {
          const url = String(input);
          urls.push(url);
          if (url.includes('/oauth/token')) {
            return Response.json({
              access_token: 'access-1',
              refresh_token: 'refresh-1',
              expires_in: 3600,
              account: { email_address: 'person@example.com' },
            });
          }
          return new Response('nope', { status: 500 });
        },
      },
    ),
  ).rejects.toBeInstanceOf(ClaudeIdentityMissingError);
  expect(urls.some((url) => url.includes('/api/claude_cli/bootstrap'))).toBe(true);
});

function loginContext(
  overrides: Partial<OAuthLoginContext> & {
    loopback: OAuthLoginContext['authorization']['loopback'];
  },
): OAuthLoginContext {
  return {
    signal: overrides.signal ?? new AbortController().signal,
    progress: overrides.progress ?? (() => {}),
    authorization: {
      presentDeviceCode: async () => {
        throw new Error('Claude login must not start device-code');
      },
      presentAuthorizeUrl: async () => {
        throw new Error('Claude login must use loopback rather than presentAuthorizeUrl');
      },
      loopback: overrides.loopback,
    },
    ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
  };
}
