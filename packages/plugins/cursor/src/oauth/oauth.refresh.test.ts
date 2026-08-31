import { expect, test } from 'bun:test';

import { CredentialRefreshError } from '@aio-proxy/plugin-sdk';

import { currentCursorCredential, refreshCursorCredential } from './credential';

const jwt = (payload: object) => ['h', Buffer.from(JSON.stringify(payload)).toString('base64url'), 's'].join('.');
const okResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

test('keeps the old refresh token when the refresh response omits one', async () => {
  const next = await refreshCursorCredential(
    { accessToken: 'old', refreshToken: 'keep-me', expiresAt: 0 },
    { now: () => 0, fetch: async () => okResponse({ accessToken: jwt({ exp: 4_000 }) }) },
  );
  expect(next.refreshToken).toBe('keep-me');
  expect(next.expiresAt).toBe(4_000 * 1000 - 5 * 60_000);
});

test('rotates the refresh token when the response returns one', async () => {
  const next = await refreshCursorCredential(
    { accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 0 },
    { now: () => 0, fetch: async () => okResponse({ accessToken: jwt({ exp: 4_000 }), refreshToken: 'new-refresh' }) },
  );
  expect(next.refreshToken).toBe('new-refresh');
});

test('classifies auth failures as non-retryable and 5xx as retryable', async () => {
  await expect(
    refreshCursorCredential(
      { accessToken: 'a', refreshToken: 'r', expiresAt: 0 },
      { now: () => 0, fetch: async () => new Response('{}', { status: 401 }) },
    ),
  ).rejects.toMatchObject({ retryable: false });
  await expect(
    refreshCursorCredential(
      { accessToken: 'a', refreshToken: 'r', expiresAt: 0 },
      { now: () => 0, fetch: async () => new Response('{}', { status: 500 }) },
    ),
  ).rejects.toMatchObject({ retryable: true });
});

test('currentCursorCredential refreshes only when expiresAt <= now', async () => {
  const fresh = { accessToken: 'a', refreshToken: 'r', expiresAt: 10_000 };
  const port = {
    read: async () => ({ value: fresh, revision: 1 }),
    refresh: async () => {
      throw new Error('must not refresh a fresh credential');
    },
  };
  expect(await currentCursorCredential(port, { now: () => 5_000 })).toBe(fresh);
});

test('currentCursorCredential refreshes through the port when expiresAt <= now', async () => {
  const stale = { accessToken: 'a', refreshToken: 'r', expiresAt: 1_000 };
  const rotated = jwt({ exp: 10_000 });
  let metadata: { accountLabel?: string; expiresAt?: number } | undefined;
  let requestInit: RequestInit | undefined;
  const port = {
    read: async () => ({ value: stale, revision: 7 }),
    refresh: async (
      expectedRevision: number,
      exchange: (
        current: { value: typeof stale; revision: number },
        signal: AbortSignal,
      ) => Promise<{ value: { accessToken: string; refreshToken: string; expiresAt: number } }>,
    ) => {
      expect(expectedRevision).toBe(7);
      const result = await exchange({ value: stale, revision: 7 }, new AbortController().signal);
      metadata = Reflect.get(result, 'metadata');
      return { status: 'updated' as const, snapshot: { value: result.value, revision: 8 } };
    },
  };
  const result = await currentCursorCredential(port, {
    now: () => 5_000,
    fetch: async (_input, init) => {
      requestInit = init;
      return okResponse({ accessToken: rotated });
    },
  });
  expect(result.accessToken).toBe(rotated);
  expect(result.expiresAt).toBe(10_000 * 1000 - 5 * 60_000);
  expect(metadata).toEqual({ expiresAt: 10_000 * 1000 - 5 * 60_000 });
  expect(Reflect.get(requestInit ?? {}, 'aioProxy')).toEqual({ traffic: 'control' });
});

test('refreshCursorCredential produces a CredentialRefreshError on failure', async () => {
  const error = await refreshCursorCredential(
    { accessToken: 'a', refreshToken: 'r', expiresAt: 0 },
    { now: () => 0, fetch: async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }) },
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CredentialRefreshError);
  expect((error as CredentialRefreshError).retryable).toBe(false);
});

test('refresh keeps the current Cursor email when the new token omits one', async () => {
  const next = await refreshCursorCredential(
    { accessToken: 'old', refreshToken: 'keep-me', expiresAt: 0, email: 'stored@example.com' },
    { now: () => 0, fetch: async () => okResponse({ accessToken: jwt({ exp: 4_000, sub: 'u1' }) }) },
  );
  expect(next.email).toBe('stored@example.com');
});

test('refresh metadata omits accountLabel when no email is available', async () => {
  const stale = { accessToken: 'a', refreshToken: 'r', expiresAt: 1_000 };
  const rotated = jwt({ sub: 'u1', exp: 10_000 });
  let metadata: { accountLabel?: string; expiresAt?: number } | undefined;
  const port = {
    read: async () => ({ value: stale, revision: 7 }),
    refresh: async (
      expectedRevision: number,
      exchange: (
        current: { value: typeof stale; revision: number },
        signal: AbortSignal,
      ) => Promise<{ value: { accessToken: string; refreshToken: string; expiresAt: number; email?: string } }>,
    ) => {
      expect(expectedRevision).toBe(7);
      const result = await exchange({ value: stale, revision: 7 }, new AbortController().signal);
      metadata = Reflect.get(result, 'metadata');
      return { status: 'updated' as const, snapshot: { value: result.value, revision: 8 } };
    },
  };
  await currentCursorCredential(port, {
    now: () => 5_000,
    fetch: async () => okResponse({ accessToken: rotated }),
  });
  expect(metadata).toEqual({ expiresAt: 10_000 * 1000 - 5 * 60_000 });
});
