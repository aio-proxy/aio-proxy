import { afterEach, describe, expect, test } from 'bun:test';

import { LoopbackCallbackMismatchError, LoopbackStateMismatchError, runLoopbackAuthorization } from './index';
import { copy, createDeps, expectPortAvailable, request, resetInteractive, setInteractive } from './test-support';

afterEach(resetInteractive);

describe('loopback manual callback handling', () => {
  test('accepts a manually pasted complete callback URL', async () => {
    setInteractive(true);
    let redirectUri = '';
    const { deps } = createDeps({
      readManualCallbackUrl: async () => `${redirectUri}?code=manual-code&state=expected-state`,
    });
    await expect(
      runLoopbackAuthorization(
        request({
          allowManualCallbackUrl: true,
          authorizationUrl: (input) => {
            redirectUri = input.redirectUri;
            return 'https://identity.example/authorize';
          },
        }),
        deps,
      ),
    ).resolves.toEqual({ code: 'manual-code', redirectUri: expect.any(String) });
    await expectPortAvailable(Number(new URL(redirectUri).port));
  });

  test('reports safe manual callback errors and retries until a valid URL is pasted', async () => {
    setInteractive(true);
    const secret = 'secret-code-and-state';
    let redirectUri = '';
    const values = [
      `https://attacker.example/callback?code=${secret}&state=${secret}`,
      () => `${redirectUri}?code=manual-code&state=expected-state`,
    ];
    const { deps, printed } = createDeps({
      readManualCallbackUrl: async () => {
        const value = values.shift();
        return typeof value === 'function' ? value() : (value ?? '');
      },
    });
    await runLoopbackAuthorization(
      request({
        allowManualCallbackUrl: true,
        authorizationUrl: (input) => {
          redirectUri = input.redirectUri;
          return 'https://identity.example/authorize';
        },
      }),
      deps,
    );
    expect(printed).toHaveLength(3);
    expect(printed[0]).toContain('https://identity.example/authorize');
    expect(printed[1]).toBe(copy.openedAuthorizationPage);
    expect(printed[2]).toBe(new LoopbackCallbackMismatchError().message);
    expect(printed.join(' ')).not.toContain(secret);
  });

  test.each([
    [
      'scheme',
      (uri: URL) => `https://${uri.host}${uri.pathname}?code=x&state=expected-state`,
      LoopbackCallbackMismatchError,
    ],
    [
      'hostname',
      (uri: URL) => `http://127.0.0.2:${uri.port}${uri.pathname}?code=x&state=expected-state`,
      LoopbackCallbackMismatchError,
    ],
    [
      'port',
      (uri: URL) => `http://${uri.hostname}:1${uri.pathname}?code=x&state=expected-state`,
      LoopbackCallbackMismatchError,
    ],
    ['path', (uri: URL) => `${uri.origin}/wrong?code=x&state=expected-state`, LoopbackCallbackMismatchError],
    ['state', (uri: URL) => `${uri.href}?code=x&state=wrong`, LoopbackStateMismatchError],
  ] as const)('rejects a manual callback with a mismatched %s and retries', async (_name, invalid, ErrorType) => {
    setInteractive(true);
    let redirectUri = '';
    let calls = 0;
    const { deps, printed } = createDeps({
      readManualCallbackUrl: async () => {
        calls += 1;
        const uri = new URL(redirectUri);
        return calls === 1 ? invalid(uri) : `${uri.href}?code=valid&state=expected-state`;
      },
    });
    const result = await runLoopbackAuthorization(
      request({
        allowManualCallbackUrl: true,
        authorizationUrl: (input) => {
          redirectUri = input.redirectUri;
          return 'https://identity.example/authorize';
        },
      }),
      deps,
    );
    expect(result.code).toBe('valid');
    expect(printed[0]).toContain('https://identity.example/authorize');
    expect(printed[1]).toBe(copy.openedAuthorizationPage);
    expect(printed[2]).toBe(new ErrorType().message);
  });
});
