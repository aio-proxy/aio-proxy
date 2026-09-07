import { expect, test } from 'bun:test';

import { OAuthCallbackError, parseOAuthCallback } from './callback';

const expected = 'http://127.0.0.1:1455/auth/callback';

test('manual OAuth callback validates redirect and state without exposing the raw callback', () => {
  expect(parseOAuthCallback(`${expected}?code=accepted&state=expected`, expected, 'expected')).toEqual({
    code: 'accepted',
  });

  for (const raw of [
    `${expected}?code=secret-code&state=wrong`,
    'http://127.0.0.1:9999/auth/callback?code=secret-code&state=expected',
  ]) {
    try {
      parseOAuthCallback(raw, expected, 'expected');
      throw new Error('expected callback rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthCallbackError);
      expect(String(error)).not.toContain('secret-code');
    }
  }
});

test('defaults to requiring state when the fourth argument is omitted', () => {
  expect(() => parseOAuthCallback(`${expected}?code=stolen`, expected, 'expected')).toThrow(OAuthCallbackError);
});

test('accepts a matching callback URL that has a code and no state', () => {
  expect(
    parseOAuthCallback(`${expected}?code=openrouter-code`, expected, 'host-only-state', {
      stateRequired: false,
    }),
  ).toEqual({
    code: 'openrouter-code',
  });
});

test('accepts a pasted raw authorization code when the input is not a URL', () => {
  expect(parseOAuthCallback('auth_code_abc123', expected, 'host-only-state', { stateRequired: false })).toEqual({
    code: 'auth_code_abc123',
  });
  expect(
    parseOAuthCallback('code=auth_code_from_query', expected, 'host-only-state', { stateRequired: false }),
  ).toEqual({
    code: 'auth_code_from_query',
  });
});

test('rejects a pasted error= query that is not a URL', () => {
  for (const raw of ['error=access_denied', 'state=host-only-state&error=access_denied']) {
    try {
      parseOAuthCallback(raw, expected, 'host-only-state', { stateRequired: false });
      throw new Error('expected callback rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthCallbackError);
      expect((error as OAuthCallbackError).code).toBe('AUTHORIZATION_DENIED');
      expect(String(error)).not.toContain('access_denied');
    }
  }
});

test('rejects a missing-state callback that also has no code', () => {
  expect(() => parseOAuthCallback(expected, expected, 'host-only-state', { stateRequired: false })).toThrow(
    OAuthCallbackError,
  );
});

test('does not accept a missing-state error when state is required', () => {
  expect(() =>
    parseOAuthCallback(`${expected}?error=access_denied`, expected, 'expected', { stateRequired: true }),
  ).toThrow(OAuthCallbackError);
});
