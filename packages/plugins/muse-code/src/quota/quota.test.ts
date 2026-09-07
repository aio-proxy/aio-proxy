import { expect, test } from 'bun:test';

import type { CredentialPort, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import type { MuseCodeCredential } from '../schema';
import { MuseCodeQuotaError, readMuseCodeQuota } from './quota';

const credential: MuseCodeCredential = {
  oauthAccessToken: 'oauth-secret',
  apiKey: 'minted-key',
  accountId: 'user-1',
};

test('maps window and weekly usage without reminting or persisting api_key', async () => {
  let body: unknown;
  let traffic: unknown;
  const snapshot = await readMuseCodeQuota(context(), {
    fetch: async (input, init) => {
      traffic = (init as RuntimeRequestInit | undefined)?.aioProxy;
      const request = new Request(input, init);
      expect(request.url).toBe('https://api.meta.ai/muse-code/key');
      expect(request.method).toBe('POST');
      expect(request.headers.get('authorization')).toBe('Bearer oauth-secret');
      expect(request.headers.get('x-api-version')).toBe('1.0.0');
      body = await request.json();
      return Response.json({
        api_key: 'must-not-be-used',
        is_subs_active: true,
        subs_tier_name: 'Pro',
        subs_usage: {
          window: { used_percent: 25, resets_at: '2027-01-15T00:00:00Z', window_duration_mins: 60 },
          weekly: { used_percent: 'nope', resets_at: 1_767_972_193 },
        },
      });
    },
  });
  expect(body).toEqual({});
  expect(traffic).toEqual({ traffic: 'control' });
  expect(snapshot).toEqual({
    plan: 'Pro',
    items: [
      {
        id: '60m',
        displayName: { default: '1 hour', 'zh-Hans': '1 小时' },
        remainingRatio: 0.75,
        resetsAt: Date.parse('2027-01-15T00:00:00Z'),
      },
    ],
  });
});

test('accepts weekly percent and unix-second resets', async () => {
  const snapshot = await readMuseCodeQuota(context(), {
    fetch: async () =>
      Response.json({
        is_subs_active: true,
        subs_usage: { weekly: { used_percent: 10, resets_at: 1_767_972_193 } },
      }),
  });
  expect(snapshot.items).toEqual([
    {
      id: 'weekly',
      displayName: { default: 'Weekly quota', 'zh-Hans': '周配额' },
      remainingRatio: 0.9,
      resetsAt: 1_767_972_193_000,
    },
  ]);
});

test('treats a negative used_percent as an invalid window', async () => {
  await expect(
    readMuseCodeQuota(context(), {
      fetch: async () =>
        Response.json({
          is_subs_active: true,
          subs_usage: { window: { used_percent: -1 } },
        }),
    }),
  ).rejects.toMatchObject({ name: MuseCodeQuotaError.name, retryable: false });
});

test('classifies 429 as retryable and inactive subscription as permanent', async () => {
  await expect(
    readMuseCodeQuota(context(), { fetch: async () => new Response(null, { status: 429 }) }),
  ).rejects.toMatchObject({ name: MuseCodeQuotaError.name, retryable: true, status: 429 });
  await expect(
    readMuseCodeQuota(context(), {
      fetch: async () => Response.json({ is_subs_active: false }),
    }),
  ).rejects.toMatchObject({ name: MuseCodeQuotaError.name, retryable: false });
  await expect(
    readMuseCodeQuota(context(), {
      fetch: async () => Response.json({ is_subs_active: true, subs_usage: {} }),
    }),
  ).rejects.toMatchObject({ name: MuseCodeQuotaError.name, retryable: false });
});

test('classifies timeout and 5xx as retryable quota failures', async () => {
  await expect(
    readMuseCodeQuota(context(), {
      fetch: async () => {
        throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
      },
    }),
  ).rejects.toMatchObject({ name: MuseCodeQuotaError.name, retryable: true });
  await expect(
    readMuseCodeQuota(context(), { fetch: async () => new Response(null, { status: 503 }) }),
  ).rejects.toMatchObject({ name: MuseCodeQuotaError.name, retryable: true, status: 503 });
  await expect(
    readMuseCodeQuota(context(), { fetch: async () => new Response('not-json', { status: 200 }) }),
  ).rejects.toMatchObject({ name: MuseCodeQuotaError.name, retryable: false });
});

test('classifies a 401 before a stalled error body is read', async () => {
  await expect(
    readMuseCodeQuota(context(), {
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('The connection was reset.'));
            },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    }),
  ).rejects.toMatchObject({ name: MuseCodeQuotaError.name, retryable: false, status: 401 });
});

test('classifies a key body-read transport failure as retryable', async () => {
  await expect(
    readMuseCodeQuota(context(), {
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('The connection was reset.'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    }),
  ).rejects.toMatchObject({ name: MuseCodeQuotaError.name, retryable: true });
});

test('formats every window of at least 60 minutes in hours', async () => {
  const snapshot = await readMuseCodeQuota(context(), {
    fetch: async () =>
      Response.json({
        is_subs_active: true,
        subs_usage: { window: { used_percent: 25, window_duration_mins: 90 } },
      }),
  });
  expect(snapshot.items).toEqual([
    {
      id: '90m',
      displayName: { default: '1.5 hours', 'zh-Hans': '1.5 小时' },
      remainingRatio: 0.75,
    },
  ]);
});

test('treats nonpositive window_duration_mins as a rolling window', async () => {
  const zero = await readMuseCodeQuota(context(), {
    fetch: async () =>
      Response.json({
        is_subs_active: true,
        subs_usage: { window: { used_percent: 25, window_duration_mins: 0 } },
      }),
  });
  expect(zero.items).toEqual([
    {
      id: 'window',
      displayName: { default: 'Rolling window', 'zh-Hans': '滚动窗口' },
      remainingRatio: 0.75,
    },
  ]);
  const negative = await readMuseCodeQuota(context(), {
    fetch: async () =>
      Response.json({
        is_subs_active: true,
        subs_usage: { window: { used_percent: 25, window_duration_mins: -60 } },
      }),
  });
  expect(negative.items[0]).toMatchObject({
    id: 'window',
    displayName: { default: 'Rolling window', 'zh-Hans': '滚动窗口' },
  });
});

function context() {
  const port: CredentialPort<MuseCodeCredential> = {
    read: async () => ({ revision: 1, value: credential }),
    refresh: async () => {
      throw new Error('quota must not refresh');
    },
  };
  return { credentials: port, options: {}, signal: new AbortController().signal };
}
