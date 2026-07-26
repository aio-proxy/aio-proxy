import { describe, expect, test } from 'bun:test';

import { loginXAIGrok, validateXAIEndpoint } from './oauth';
import { DEVICE, DISCOVERY, jwt, loginContext, sequenceFetch, TOKEN } from './oauth.test-support';

describe('xAI Grok OAuth', () => {
  test('performs device authorization and returns a stable private identity', async () => {
    const requests: Request[] = [];
    const presented: unknown[] = [];
    const accessToken = jwt({ sub: 'subject-1', email: 'Person@Example.com' });
    const fetcher = sequenceFetch(requests, [
      Response.json({ device_authorization_endpoint: DEVICE, token_endpoint: TOKEN }),
      Response.json({
        device_code: 'device-1',
        user_code: 'CODE-1',
        verification_uri: 'https://auth.x.ai/activate',
        verification_uri_complete: 'https://auth.x.ai/activate?user_code=CODE-1',
        expires_in: 600,
        interval: 1,
      }),
      Response.json({ error: 'authorization_pending' }, { status: 400 }),
      Response.json({ error: 'slow_down' }, { status: 400 }),
      Response.json({ access_token: accessToken, refresh_token: 'refresh-1', expires_in: 3600 }),
    ]);
    const sleeps: number[] = [];
    const result = await loginXAIGrok(loginContext(presented), {
      fetch: fetcher,
      now: () => 1_700_000_000_000,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      deviceInstructions: 'Enter code',
      waitingForAuthorization: 'Waiting for xAI authorization',
    });

    expect(requests.map((request) => request.url)).toEqual([DISCOVERY, DEVICE, TOKEN, TOKEN, TOKEN]);
    const deviceRequest = requests[1];
    if (deviceRequest === undefined) throw new Error('device request was not captured');
    expect(Object.fromEntries(await deviceRequest.formData())).toEqual({
      client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
      scope: 'openid profile email offline_access grok-cli:access api:access',
    });
    expect(presented).toEqual([
      {
        url: 'https://auth.x.ai/activate?user_code=CODE-1',
        userCode: 'CODE-1',
        instructions: 'Enter code CODE-1',
      },
    ]);
    expect(sleeps).toEqual([5_000, 10_000]);
    expect(result).toEqual({
      fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      suggestedKey: expect.stringMatching(/^grok-[a-f0-9]{12}$/u),
      label: 'Person@Example.com',
      credentials: {
        accessToken,
        refreshToken: 'refresh-1',
        expiresAt: 1_700_003_600_000,
        email: 'Person@Example.com',
        subject: 'subject-1',
      },
      expiresAt: 1_700_003_600_000,
    });
  });

  test('rejects discovered endpoints outside x.ai before sending credentials', () => {
    expect(() => validateXAIEndpoint('http://auth.x.ai/token', 'token_endpoint')).toThrow('Invalid xAI');
    expect(() => validateXAIEndpoint('https://x.ai.evil.test/token', 'token_endpoint')).toThrow('Invalid xAI');
    expect(validateXAIEndpoint(TOKEN, 'token_endpoint')).toBe(TOKEN);
  });

  test('propagates cancellation into discovery', async () => {
    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    controller.abort(reason);
    const context = loginContext([]);
    const login = loginXAIGrok(
      { ...context, signal: controller.signal },
      {
        fetch: async (_input, init) => {
          init?.signal?.throwIfAborted();
          throw new Error('aborted discovery must not return');
        },
      },
    );
    await expect(login).rejects.toBe(reason);
  });

  test('stops polling after the device code expires', async () => {
    let now = 0;
    const login = loginXAIGrok(loginContext([]), {
      fetch: sequenceFetch(
        [],
        [
          Response.json({ device_authorization_endpoint: DEVICE, token_endpoint: TOKEN }),
          Response.json({
            device_code: 'device-1',
            user_code: 'CODE-1',
            verification_uri: 'https://auth.x.ai/activate',
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
    });
    await expect(login).rejects.toThrow('timed out');
  });
});
