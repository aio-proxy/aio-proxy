import { expect, test } from 'bun:test';

import type { OAuthLoginContext, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { loginCursor } from './oauth';

const jwt = (payload: object) => ['h', Buffer.from(JSON.stringify(payload)).toString('base64url'), 's'].join('.');

const context = (over: Partial<OAuthLoginContext> = {}): { ctx: OAuthLoginContext; urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    ctx: {
      authorization: {
        async presentDeviceCode() {},
        async presentAuthorizeUrl(input) {
          urls.push(input.url);
        },
        async loopback() {
          throw new Error('unused');
        },
      },
      progress: () => {},
      signal: new AbortController().signal,
      ...over,
    },
  };
};

test('presents the login URL then returns credentials after a 404 then 200', async () => {
  const { ctx, urls } = context();
  const requestOptions: RequestInit[] = [];
  const responses = [
    new Response('', { status: 404 }),
    new Response(JSON.stringify({ accessToken: jwt({ sub: 'u1', exp: 4_000 }), refreshToken: 'r1' }), { status: 200 }),
    new Response('', { status: 503 }),
  ];
  const result = await loginCursor(
    ctx,
    { waiting: 'Waiting' },
    {
      now: () => 0,
      sleep: async () => {},
      uuid: () => 'uuid-1',
      fetch: async (_input, init) => {
        requestOptions.push(init ?? {});
        return responses.shift()!;
      },
    },
  );
  expect(urls[0]).toContain('https://cursor.com/loginDeepControl?');
  expect(urls[0]).toContain('mode=login');
  expect(urls[0]).toContain('redirectTarget=cli');
  expect(result.credentials.refreshToken).toBe('r1');
  expect(result.suggestedKey.startsWith('cursor-')).toBe(true);
  expect(result.accountLabel).toBe('Cursor');
  expect(requestOptions).toEqual([
    expect.objectContaining({ aioProxy: { traffic: 'control' } }),
    expect.objectContaining({ aioProxy: { traffic: 'control' } }),
    expect.objectContaining({ aioProxy: { traffic: 'control' } }),
  ]);
});

test('returns the JWT email as the Cursor account label', async () => {
  const { ctx } = context();
  const requests: string[] = [];
  const result = await loginCursor(
    ctx,
    { waiting: 'Waiting' },
    {
      now: () => 0,
      sleep: async () => {},
      uuid: () => 'uuid-1',
      fetch: async (input) => {
        requests.push(String(input));
        return new Response(
          JSON.stringify({ accessToken: jwt({ sub: 'u1', email: 'A@B.com', exp: 4_000 }), refreshToken: 'r1' }),
          { status: 200 },
        );
      },
    },
  );
  expect(result.accountLabel).toBe('a@b.com');
  expect(result.credentials.email).toBe('a@b.com');
  expect(result.fingerprint.startsWith('sha256:')).toBe(true);
  expect(requests).toHaveLength(1);
});

test('uses the authenticated profile email when the login JWT omits it', async () => {
  const accessToken = jwt({ sub: 'auth0|user_01ABC', exp: 4_000 });
  const requests: { url: string; init: RuntimeRequestInit | undefined }[] = [];
  const { ctx } = context({
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return String(input) === 'https://cursor.com/api/auth/me'
        ? Response.json({ sub: 'user_01ABC', email: ' Person@Example.COM ', email_verified: true })
        : Response.json({ accessToken, refreshToken: 'r1' });
    },
  });
  const result = await loginCursor(ctx, { waiting: 'Waiting' }, { now: () => 0, sleep: async () => {} });

  expect(result.accountLabel).toBe('person@example.com');
  expect(result.credentials).toMatchObject({ accessToken, refreshToken: 'r1', email: 'person@example.com' });
  expect(result.fingerprint).toBe('sha256:1bdd59906db922dfbc9759bcdac2692e5166c95c1bfcc27e08691ef118c1fff5');
  expect(result.suggestedKey).toBe('cursor-1bdd59906db9');
  expect(requests).toHaveLength(2);
  const profile = requests[1]!;
  expect(profile.url).toBe('https://cursor.com/api/auth/me');
  expect(new Headers(profile.init?.headers).get('Cookie')).toBe(
    `WorkosCursorSessionToken=user_01ABC%3A%3A${accessToken}`,
  );
  expect(profile.init?.aioProxy).toEqual({ traffic: 'control' });
  expect(profile.init?.redirect).toBe('error');
});

test.each([
  ['invalid JSON', () => new Response('not-json')],
  ['non-object payload', () => Response.json([{ email: 'wrong@example.com' }])],
  ['non-string email', () => Response.json({ email: 42 })],
  ['blank email', () => Response.json({ email: '  ' })],
  [
    'network failure',
    () => {
      throw new Error('unavailable');
    },
  ],
] as const)('keeps the login usable after a profile %s', async (_name, profile) => {
  const { ctx } = context();
  const result = await loginCursor(
    ctx,
    { waiting: 'Waiting' },
    {
      now: () => 0,
      sleep: async () => {},
      fetch: async (input) =>
        String(input) === 'https://cursor.com/api/auth/me'
          ? profile()
          : Response.json({ accessToken: jwt({ sub: 'u1' }), refreshToken: 'r1' }),
    },
  );
  expect(result.accountLabel).toBe('Cursor');
  expect(result.credentials.refreshToken).toBe('r1');
  expect(result.credentials.email).toBeUndefined();
});

test('propagates login cancellation while reading the profile body', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  const { ctx } = context({ signal: controller.signal });
  await expect(
    loginCursor(
      ctx,
      { waiting: 'Waiting' },
      {
        now: () => 0,
        sleep: async () => {},
        fetch: async (input) =>
          String(input) === 'https://cursor.com/api/auth/me'
            ? new Response(
                new ReadableStream({
                  pull(stream) {
                    controller.abort(reason);
                    stream.error(reason);
                  },
                }),
              )
            : Response.json({ accessToken: jwt({ sub: 'u1' }), refreshToken: 'r1' }),
      },
    ),
  ).rejects.toBe(reason);
});

test('finishes login when the profile body stalls until its deadline', async () => {
  let profileSignal: AbortSignal | null | undefined;
  const { ctx } = context();
  const result = await loginCursor(
    ctx,
    { waiting: 'Waiting' },
    {
      now: () => 0,
      sleep: async () => {},
      fetch: async (input, init) => {
        if (String(input) !== 'https://cursor.com/api/auth/me') {
          return Response.json({ accessToken: jwt({ sub: 'u1' }), refreshToken: 'r1' });
        }
        profileSignal = init?.signal;
        return new Response(
          new ReadableStream({
            start(stream) {
              profileSignal?.addEventListener('abort', () => stream.error(profileSignal?.reason), { once: true });
            },
          }),
        );
      },
    },
  );
  expect(profileSignal?.aborted).toBe(true);
  expect(ctx.signal.aborted).toBe(false);
  expect(result.accountLabel).toBe('Cursor');
  expect(result.credentials.refreshToken).toBe('r1');
});

test('rejects login when Cursor returns no stable account identifier', async () => {
  const { ctx } = context();
  await expect(
    loginCursor(
      ctx,
      { waiting: 'Waiting' },
      {
        now: () => 0,
        sleep: async () => {},
        uuid: () => 'uuid-1',
        fetch: async () =>
          new Response(JSON.stringify({ accessToken: jwt({ exp: 4_000 }), refreshToken: 'rotating' }), {
            status: 200,
          }),
      },
    ),
  ).rejects.toThrow(/stable account identifier/i);
});

test('fails after three consecutive poll errors', async () => {
  const { ctx } = context();
  await expect(
    loginCursor(
      ctx,
      { waiting: 'Waiting' },
      { now: () => 0, sleep: async () => {}, uuid: () => 'u', fetch: async () => new Response('x', { status: 500 }) },
    ),
  ).rejects.toThrow();
});

test('abort during sleep rejects with the abort reason', async () => {
  const controller = new AbortController();
  const { ctx } = context({ signal: controller.signal });
  const reason = new Error('aborted');
  await expect(
    loginCursor(
      ctx,
      { waiting: 'Waiting' },
      {
        now: () => 0,
        uuid: () => 'u',
        fetch: async () => new Response('', { status: 404 }),
        sleep: async () => {
          controller.abort(reason);
          throw reason;
        },
      },
    ),
  ).rejects.toBe(reason);
});
