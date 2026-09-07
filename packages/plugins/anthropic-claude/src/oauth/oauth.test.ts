import { describe, expect, test } from 'bun:test';

import type { ClaudeCredential } from '../schema';
import { CLAUDE_CLIENT_ID, CLAUDE_SCOPE } from './constants';
import {
  ClaudeIdentityMissingError,
  buildClaudeAuthorizationUrl,
  claudeLoginResult,
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
