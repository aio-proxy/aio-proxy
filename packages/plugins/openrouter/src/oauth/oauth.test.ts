import { describe, expect, test } from 'bun:test';

import type { LoopbackRequest, OAuthLoginContext, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { loginOpenRouter, openRouterLoginResult } from './oauth';

const AUTHORIZE = 'https://openrouter.ai/auth';
const TOKEN = 'https://openrouter.ai/api/v1/auth/keys';
const REDIRECT = 'http://127.0.0.1:43123/callback';

describe('OpenRouter OAuth', () => {
  test('exchanges a loopback code for a durable key and a stable private identity', async () => {
    let loopback: LoopbackRequest | undefined;
    const requests: Request[] = [];
    const inits: RuntimeRequestInit[] = [];
    const result = await loginOpenRouter(
      loginContext({
        loopback: async (input) => {
          loopback = input;
          const authorize = new URL(input.authorizationUrl({ redirectUri: REDIRECT }));
          expect(authorize.origin + authorize.pathname).toBe(AUTHORIZE);
          expect(authorize.searchParams.get('callback_url')).toBe(REDIRECT);
          expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
          expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
          expect(authorize.searchParams.has('state')).toBe(false);
          expect(authorize.searchParams.has('redirect_uri')).toBe(false);
          expect(authorize.searchParams.has('client_id')).toBe(false);
          return { code: 'auth-code', redirectUri: REDIRECT };
        },
      }),
      {
        fetch: async (input, init) => {
          inits.push(init ?? {});
          const request = new Request(input, init);
          requests.push(request);
          return Response.json({ key: 'sk-or-v1-test-key', user_id: 'user_example' });
        },
      },
    );

    expect(loopback?.redirect).toEqual({ hostname: '127.0.0.1', port: 'dynamic', path: '/callback' });
    expect(loopback?.allowManualCallbackUrl).toBe(true);
    expect(loopback?.state).toMatch(/\S/u);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(TOKEN);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers.get('content-type')).toBe('application/json');
    expect(inits[0]?.aioProxy).toEqual({ traffic: 'control' });
    expect(await requests[0]!.json()).toEqual({
      code: 'auth-code',
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      code_challenge_method: 'S256',
    });
    const digest = new Bun.CryptoHasher('sha256').update('account:user_example').digest('hex');
    expect(result).toEqual({
      fingerprint: `sha256:${digest}`,
      suggestedKey: `openrouter-${digest.slice(0, 12)}`,
      accountLabel: 'OpenRouter',
      credentials: { apiKey: 'sk-or-v1-test-key', userId: 'user_example' },
    });
    expect(result).not.toHaveProperty('expiresAt');
    expect(openRouterLoginResult({ apiKey: 'sk-or-v1-other-key', userId: 'user_example' }).fingerprint).toBe(
      result.fingerprint,
    );
  });

  test('fails closed when the key exchange omits key', async () => {
    await expect(
      loginOpenRouter(
        loginContext({
          loopback: async () => ({ code: 'auth-code', redirectUri: REDIRECT }),
        }),
        {
          fetch: async () => Response.json({ user_id: 'user_example' }),
        },
      ),
    ).rejects.toThrow(/key/i);
  });

  test('propagates cancellation into the key exchange', async () => {
    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    controller.abort(reason);
    await expect(
      loginOpenRouter(
        {
          ...loginContext({
            loopback: async () => ({ code: 'auth-code', redirectUri: REDIRECT }),
          }),
          signal: controller.signal,
        },
        {
          fetch: async (_input, init) => {
            init?.signal?.throwIfAborted();
            return Response.json({ key: 'sk-or-v1-test-key' });
          },
        },
      ),
    ).rejects.toBe(reason);
  });

  test('builds the same identity for a stored key without userId', () => {
    const digest = new Bun.CryptoHasher('sha256').update('key:sk-or-v1-test-key').digest('hex');
    expect(openRouterLoginResult({ apiKey: 'sk-or-v1-test-key' })).toEqual({
      fingerprint: `sha256:${digest}`,
      suggestedKey: `openrouter-${digest.slice(0, 12)}`,
      accountLabel: 'OpenRouter',
      credentials: { apiKey: 'sk-or-v1-test-key' },
    });
  });
});

function loginContext(overrides: {
  readonly loopback: OAuthLoginContext['authorization']['loopback'];
}): OAuthLoginContext {
  return {
    authorization: {
      presentDeviceCode: async () => {
        throw new Error('OpenRouter must not use device code');
      },
      presentAuthorizeUrl: async () => {
        throw new Error('OpenRouter must use loopback, not presentAuthorizeUrl');
      },
      loopback: async (input) => {
        const response = await overrides.loopback(input);
        return response;
      },
    },
    progress: () => {},
    signal: new AbortController().signal,
  };
}
