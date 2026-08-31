import { expect, test } from 'bun:test';

import type { OAuthLoginContext } from '@aio-proxy/plugin-sdk';

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
  ]);
});

test('returns the JWT email as the Cursor account label', async () => {
  const { ctx } = context();
  const result = await loginCursor(
    ctx,
    { waiting: 'Waiting' },
    {
      now: () => 0,
      sleep: async () => {},
      uuid: () => 'uuid-1',
      fetch: async () =>
        new Response(
          JSON.stringify({ accessToken: jwt({ sub: 'u1', email: 'A@B.com', exp: 4_000 }), refreshToken: 'r1' }),
          { status: 200 },
        ),
    },
  );
  expect(result.accountLabel).toBe('a@b.com');
  expect(result.credentials.email).toBe('a@b.com');
  expect(result.fingerprint.startsWith('sha256:')).toBe(true);
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
