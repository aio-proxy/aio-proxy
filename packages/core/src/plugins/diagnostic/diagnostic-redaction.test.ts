import { describe, expect, test } from 'bun:test';

import { redactPluginError } from '.';

describe('redactPluginError', () => {
  test('removes OAuth material, URLs, causes, stacks, and arbitrary third-party secrets', () => {
    const thirdPartySecret = 'third-party-secret-value';
    const error = new Error(
      `Bearer bearer-value access_token=access-value refresh_token=refresh-value authorization_code=auth-code code=callback-code code_verifier=verifier-value state=oauth-state accessToken=camel-access refreshToken=camel-refresh https://example.test/callback?code=query-code raw=https://example.test/callback?state=query-state ${thirdPartySecret}`,
      { cause: new Error('raw cause') },
    );
    error.stack = `Error: ${error.message}\n at plugin (${thirdPartySecret})`;

    const redacted = redactPluginError(error, { secretValues: [thirdPartySecret] });
    const serialized = JSON.stringify(redacted);
    for (const secret of [
      'bearer-value',
      'access-value',
      'refresh-value',
      'auth-code',
      'callback-code',
      'verifier-value',
      'oauth-state',
      'camel-access',
      'camel-refresh',
      'query-code',
      'query-state',
      thirdPartySecret,
      'raw cause',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(redacted.name).toBe('Error');
    expect(redacted.message).toContain('[REDACTED]');
    expect(redacted.stack).toContain('[REDACTED]');
    expect(redacted).not.toHaveProperty('cause');
  });

  test('redacts arbitrary secret values from error names', () => {
    const error = new Error('safe message');
    error.name = 'PluginFailure: name-secret';

    expect(redactPluginError(error, { secretValues: ['name-secret'] }).name).toBe('PluginFailure: [REDACTED]');
  });

  test('uses collision-safe exact-value redaction', () => {
    const redacted = redactPluginError(new Error('marker [REDACTED], Ax, and Bearer abc'), {
      secretValues: ['[REDACTED]', 'A[R', 'x'],
    });

    expect(redacted.message).not.toContain('[REDACTED]');
    expect(redacted.message).not.toContain('A[R');
    expect(redacted.message).not.toContain('x');
  });

  test('redacts OAuth values from JSON quoted keys', () => {
    const values = {
      access_token: 'json-access',
      refresh_token: 'json-refresh',
      authorization_code: 'json-code',
      code: 'json-short-code',
      code_verifier: 'json-verifier',
      state: 'json-state',
      accessToken: 'json-camel-access',
      refreshToken: 'json-camel-refresh',
    };
    const error = new Error(JSON.stringify(values));
    error.stack = `Error: ${JSON.stringify(values)}`;

    const serialized = JSON.stringify(redactPluginError(error));
    for (const value of Object.values(values)) expect(serialized).not.toContain(value);
  });

  test('redacts escape-aware JSON string values from message and stack', () => {
    const secrets = ['quote-secret-suffix', 'backslash-secret', 'state-secret', 'second-code-secret'];
    const payload = JSON.stringify({
      access_token: `prefix"${secrets[0]}`,
      refresh_token: `path\\${secrets[1]}`,
      state: secrets[2],
      code: secrets[3],
    });
    const error = new Error(payload);
    error.stack = `Error: ${payload}\n at plugin (plugin.ts:1:1)`;

    const redacted = redactPluginError(error);
    for (const secret of secrets) {
      expect(redacted.message).not.toContain(secret);
      expect(redacted.stack).not.toContain(secret);
    }
  });

  test.each([
    ['single-quoted key and value', "{'access_token':'single-quoted-secret'}", 'single-quoted-secret'],
    ['double-quoted key and single-quoted value', `"access_token":'mixed-single-secret'`, 'mixed-single-secret'],
    ['single-quoted key and double-quoted value', `'access_token':"mixed-double-secret"`, 'mixed-double-secret'],
    ['unquoted assignment', 'access_token=assignment-token-secret', 'assignment-token-secret'],
  ])('redacts %s fallback form from message and stack', (_name, payload, secret) => {
    const error = new Error(payload);
    error.stack = `Error: ${payload}\n at plugin (plugin.ts:1:1)`;

    const redacted = redactPluginError(error);
    expect(redacted.message).not.toContain(secret);
    expect(redacted.stack).not.toContain(secret);
  });
});
