import { describe, expect, test } from 'bun:test';

import { resolveOAuthLoopbackCallback } from './oauth-loopback-callback';

const expected = 'http://127.0.0.1:1455/auth/callback';

describe('resolveOAuthLoopbackCallback when state is required', () => {
  test('accepts a matching URL with code and state', () => {
    expect(
      resolveOAuthLoopbackCallback(`${expected}?code=accepted&state=expected`, expected, 'expected', {
        stateRequired: true,
      }),
    ).toEqual({ ok: true, code: 'accepted' });
  });

  test('mismatches a missing state even when a code is present', () => {
    expect(
      resolveOAuthLoopbackCallback(`${expected}?code=stolen`, expected, 'expected', { stateRequired: true }),
    ).toEqual({ ok: false, reason: 'state_mismatch' });
  });

  test('mismatches a missing state before treating error as denied', () => {
    expect(
      resolveOAuthLoopbackCallback(`${expected}?error=access_denied`, expected, 'expected', {
        stateRequired: true,
      }),
    ).toEqual({ ok: false, reason: 'state_mismatch' });
  });

  test('rejects loose-code paste as invalid', () => {
    expect(resolveOAuthLoopbackCallback('auth_code_abc123', expected, 'expected', { stateRequired: true })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  test('rejects a loose error= paste as invalid, not denied', () => {
    expect(resolveOAuthLoopbackCallback('error=access_denied', expected, 'expected', { stateRequired: true })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('resolveOAuthLoopbackCallback when state is not required', () => {
  test('accepts a matching URL that has a code and no state', () => {
    expect(
      resolveOAuthLoopbackCallback(`${expected}?code=openrouter-code`, expected, 'host-only-state', {
        stateRequired: false,
      }),
    ).toEqual({ ok: true, code: 'openrouter-code' });
  });

  test('denies a matching URL that has error and no state', () => {
    expect(
      resolveOAuthLoopbackCallback(`${expected}?error=access_denied`, expected, 'host-only-state', {
        stateRequired: false,
      }),
    ).toEqual({ ok: false, reason: 'denied' });
  });

  test('mismatches a present but wrong state', () => {
    expect(
      resolveOAuthLoopbackCallback(`${expected}?code=x&state=wrong`, expected, 'host-only-state', {
        stateRequired: false,
      }),
    ).toEqual({ ok: false, reason: 'state_mismatch' });
  });

  test('accepts a pasted raw authorization code when the input is not a URL', () => {
    expect(
      resolveOAuthLoopbackCallback('auth_code_abc123', expected, 'host-only-state', { stateRequired: false }),
    ).toEqual({
      ok: true,
      code: 'auth_code_abc123',
    });
  });

  test('accepts a pasted code= query that is not a URL', () => {
    expect(
      resolveOAuthLoopbackCallback('code=auth_code_from_query', expected, 'host-only-state', {
        stateRequired: false,
      }),
    ).toEqual({ ok: true, code: 'auth_code_from_query' });
  });

  test('denies a pasted error= query before treating it as a bare token', () => {
    expect(
      resolveOAuthLoopbackCallback('error=access_denied', expected, 'host-only-state', { stateRequired: false }),
    ).toEqual({ ok: false, reason: 'denied' });
  });

  test('denies a pasted state+error query before treating it as a bare token', () => {
    expect(
      resolveOAuthLoopbackCallback('state=host-only-state&error=access_denied', expected, 'host-only-state', {
        stateRequired: false,
      }),
    ).toEqual({ ok: false, reason: 'denied' });
  });

  test('rejects a missing-state callback that also has no code', () => {
    expect(resolveOAuthLoopbackCallback(expected, expected, 'host-only-state', { stateRequired: false })).toEqual({
      ok: false,
      reason: 'code_missing',
    });
  });
});

describe('resolveOAuthLoopbackCallback origin checks', () => {
  test('rejects a URL with a mismatched origin', () => {
    expect(
      resolveOAuthLoopbackCallback(
        'http://127.0.0.1:9999/auth/callback?code=secret-code&state=expected',
        expected,
        'expected',
        { stateRequired: true },
      ),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });
});
