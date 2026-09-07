import { describe, expect, test } from 'bun:test';

import type { RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { loginMuseCode } from './oauth';
import { DEVICE, KEY, TOKEN, loginContext, sequenceFetch } from './oauth.test-support';

function deviceAuthorization(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    device_code: 'device-1',
    user_code: 'CODE-1',
    verification_uri: 'https://auth.meta.com/activate',
    expires_in: 600,
    interval: 1,
    ...overrides,
  });
}

function mintedKey(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    api_key: 'minted-key',
    user_email: 'Person@Example.com',
    user_id: 'user-1',
    is_subs_active: true,
    ...overrides,
  });
}

describe('Muse Code device login', () => {
  test('polls pending and slow_down then mints a key with onboard true', async () => {
    const requests: Request[] = [];
    const presented: unknown[] = [];
    const progress: unknown[] = [];
    const sleeps: number[] = [];
    const result = await loginMuseCode(loginContext(presented, progress), {
      fetch: sequenceFetch(requests, [
        Response.json({
          device_code: 'device-1',
          user_code: 'CODE-1',
          verification_uri: 'https://auth.meta.com/activate',
          verification_uri_complete: 'https://auth.meta.com/activate?user_code=CODE-1',
          expires_in: 600,
          interval: 1,
        }),
        Response.json({ error: 'authorization_pending' }, { status: 400 }),
        Response.json({ error: 'slow_down' }, { status: 400 }),
        Response.json({ access_token: 'oauth-access' }),
        Response.json({
          api_key: 'minted-key',
          user_email: 'Person@Example.com',
          user_id: 'user-1',
          is_subs_active: true,
        }),
      ]),
      now: () => 1_700_000_000_000,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      deviceInstructions: 'Enter code',
      waitingForAuthorization: 'Waiting for Muse authorization',
    });

    expect(requests.map((request) => request.url)).toEqual([DEVICE, TOKEN, TOKEN, TOKEN, KEY]);
    expect(requests[0]?.headers.get('accept')).toBe('application/json');
    expect(requests[0]?.headers.get('x-api-version')).toBe('1.0.0');
    expect(Object.fromEntries(await requests[0]!.formData())).toEqual({ client_id: '1031625952748946' });
    expect(Object.fromEntries(await requests[1]!.formData())).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: '1031625952748946',
      device_code: 'device-1',
    });
    expect(await requests[4]!.json()).toEqual({ onboard: true });
    expect(requests[4]?.headers.get('authorization')).toBe('Bearer oauth-access');
    expect(presented).toEqual([
      {
        url: 'https://auth.meta.com/activate?user_code=CODE-1',
        userCode: 'CODE-1',
        instructions: 'Enter code\n\nCODE-1',
      },
    ]);
    expect(sleeps).toEqual([5_000, 10_000]);
    expect(progress).toEqual(['Waiting for Muse authorization']);
    const digest = new Bun.CryptoHasher('sha256').update('account:user-1').digest('hex');
    expect(result).toEqual({
      fingerprint: `sha256:${digest}`,
      suggestedKey: `muse-${digest.slice(0, 12)}`,
      accountLabel: 'person@example.com',
      credentials: {
        oauthAccessToken: 'oauth-access',
        apiKey: 'minted-key',
        email: 'person@example.com',
        accountId: 'user-1',
      },
    });
    expect(result).not.toHaveProperty('expiresAt');
  });

  test('fails login when the subscription is inactive or api_key is missing', async () => {
    await expect(
      loginMuseCode(loginContext([]), {
        fetch: sequenceFetch(
          [],
          [
            Response.json({
              device_code: 'device-1',
              user_code: 'CODE-1',
              verification_uri: 'https://auth.meta.com/activate',
              expires_in: 600,
              interval: 1,
            }),
            Response.json({ access_token: 'oauth-access' }),
            Response.json({ is_subs_active: false, api_key: 'ignored' }),
          ],
        ),
        sleep: async () => {},
      }),
    ).rejects.toThrow('inactive');

    let paymentError: unknown;
    try {
      await loginMuseCode(loginContext([]), {
        fetch: sequenceFetch(
          [],
          [
            Response.json({
              device_code: 'device-1',
              user_code: 'CODE-1',
              verification_uri: 'https://auth.meta.com/activate',
              expires_in: 600,
              interval: 1,
            }),
            Response.json({ access_token: 'oauth-access' }),
            Response.json({
              require_payment: true,
              action_url: 'https://meta.ai/pay',
            }),
          ],
        ),
        sleep: async () => {},
      });
    } catch (cause) {
      paymentError = cause;
    }
    expect(paymentError).toBeInstanceOf(Error);
    expect(String(paymentError)).toMatch(/payment_required/);
    expect(String(paymentError)).not.toContain('https://meta.ai/pay');
    expect(String(paymentError)).not.toContain('oauth-access');
  });

  test('classifies denied, expired, timeout, and abort', async () => {
    await expect(
      loginMuseCode(loginContext([]), {
        fetch: sequenceFetch(
          [],
          [
            Response.json({
              device_code: 'device-1',
              user_code: 'CODE-1',
              verification_uri: 'https://auth.meta.com/activate',
              expires_in: 600,
              interval: 1,
            }),
            Response.json({ error: 'access_denied' }),
          ],
        ),
      }),
    ).rejects.toThrow('denied');

    await expect(
      loginMuseCode(loginContext([]), {
        fetch: sequenceFetch(
          [],
          [
            Response.json({
              device_code: 'device-1',
              user_code: 'CODE-1',
              verification_uri: 'https://auth.meta.com/activate',
              expires_in: 600,
              interval: 1,
            }),
            Response.json({ error: 'expired_token' }),
          ],
        ),
      }),
    ).rejects.toThrow('expired');

    let now = 0;
    await expect(
      loginMuseCode(loginContext([]), {
        fetch: sequenceFetch(
          [],
          [
            Response.json({
              device_code: 'device-1',
              user_code: 'CODE-1',
              verification_uri: 'https://auth.meta.com/activate',
              expires_in: 1,
              interval: 1,
            }),
            Response.json({ error: 'authorization_pending' }, { status: 400 }),
          ],
        ),
        now: () => {
          now += 1_000;
          return now;
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow('timed out');

    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    controller.abort(reason);
    await expect(
      loginMuseCode(
        { ...loginContext([]), signal: controller.signal },
        {
          fetch: async (_input, init) => {
            init?.signal?.throwIfAborted();
            throw new Error('aborted request must not return');
          },
        },
      ),
    ).rejects.toBe(reason);
  });

  test('fails login when api_key is blank after a successful device token', async () => {
    await expect(
      loginMuseCode(loginContext([]), {
        fetch: sequenceFetch(
          [],
          [deviceAuthorization(), Response.json({ access_token: 'oauth-access' }), mintedKey({ api_key: '   ' })],
        ),
        sleep: async () => {},
      }),
    ).rejects.toThrow('api_key');
  });

  test('appends the user code to localized device instructions', async () => {
    const presented: unknown[] = [];
    await loginMuseCode(loginContext(presented), {
      fetch: sequenceFetch(
        [],
        [
          deviceAuthorization({
            verification_uri_complete: 'https://auth.meta.com/activate?user_code=CODE-1',
          }),
          Response.json({ access_token: 'oauth-access' }),
          mintedKey(),
        ],
      ),
      now: () => 1_700_000_000_000,
      sleep: async () => {},
      deviceInstructions: { default: 'Enter code', 'zh-CN': '输入代码' },
    });
    expect(presented).toEqual([
      {
        url: 'https://auth.meta.com/activate?user_code=CODE-1',
        userCode: 'CODE-1',
        instructions: { default: 'Enter code\n\nCODE-1', 'zh-CN': '输入代码\n\nCODE-1' },
      },
    ]);
  });

  test.each([408, 429, 500])('retries transient token HTTP %i without parsing its body', async (status) => {
    const requests: Request[] = [];
    const result = await loginMuseCode(loginContext([]), {
      fetch: sequenceFetch(requests, [
        deviceAuthorization(),
        new Response('secret-upstream-body', { status }),
        Response.json({ access_token: 'oauth-access' }),
        mintedKey(),
      ]),
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    expect(result.credentials.apiKey).toBe('minted-key');
    expect(requests.map((request) => request.url)).toEqual([DEVICE, TOKEN, TOKEN, KEY]);
  });

  test('retries a token body-read transport failure then mints', async () => {
    const requests: Request[] = [];
    const result = await loginMuseCode(loginContext([]), {
      fetch: sequenceFetch(requests, [
        deviceAuthorization(),
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('The connection was reset.'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
        Response.json({ access_token: 'oauth-access' }),
        mintedKey(),
      ]),
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    expect(result.credentials.apiKey).toBe('minted-key');
    expect(requests.map((request) => request.url)).toEqual([DEVICE, TOKEN, TOKEN, KEY]);
  });

  test('does not retry a completed invalid token JSON body', async () => {
    await expect(
      loginMuseCode(loginContext([]), {
        fetch: sequenceFetch([], [deviceAuthorization(), new Response('not-json', { status: 200 })]),
        now: () => 1_700_000_000_000,
        sleep: async () => {},
      }),
    ).rejects.toThrow('Muse Code device authorization failed');
  });

  test('retries retryable token network errors then mints', async () => {
    const requests: Request[] = [];
    const responses = [deviceAuthorization(), Response.json({ access_token: 'oauth-access' }), mintedKey()];
    let tokenAttempts = 0;
    const result = await loginMuseCode(loginContext([]), {
      fetch: async (input, init) => {
        expect((init as RuntimeRequestInit | undefined)?.aioProxy).toEqual({ traffic: 'control' });
        const request = new Request(input, init);
        requests.push(request);
        if (request.url === TOKEN) {
          tokenAttempts += 1;
          if (tokenAttempts === 1) throw new TypeError('temporary network');
        }
        const response = responses.shift();
        if (response === undefined) throw new Error('unexpected request');
        return response;
      },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    expect(result.credentials.apiKey).toBe('minted-key');
    expect(tokenAttempts).toBe(2);
    expect(requests.map((request) => request.url)).toEqual([DEVICE, TOKEN, TOKEN, KEY]);
  });

  test('fails immediately on device-authorization 5xx without leaking the body', async () => {
    let error: unknown;
    try {
      await loginMuseCode(loginContext([]), {
        fetch: sequenceFetch([], [new Response('secret-upstream-body', { status: 503 })]),
      });
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('secret-upstream-body');
  });
});
