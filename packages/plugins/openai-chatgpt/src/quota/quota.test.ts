import { expect, test } from 'bun:test';

import type { AccountContext } from '@aio-proxy/plugin-sdk';

import type { ChatGPTCredential } from '../schema';
import { readOpenAIChatGPTQuota } from './quota';

const credential: ChatGPTCredential = {
  accessToken: 'quota-access-token',
  accountId: 'account-123',
  expiresAt: Number.MAX_SAFE_INTEGER,
  refreshToken: 'quota-refresh-token',
};

function context(value: ChatGPTCredential = credential): AccountContext<ChatGPTCredential, Record<string, never>> {
  return {
    credentials: {
      read: async () => ({ value, revision: 1 }),
      refresh: async () => ({ status: 'superseded', snapshot: { value: credential, revision: 2 } }),
    },
    options: {},
    signal: new AbortController().signal,
  };
}

const usagePayload = {
  plan_type: 'free_workspace',
  rate_limit: {
    primary_window: { used_percent: 15, reset_at: 1_767_972_193, limit_window_seconds: 18_000 },
    secondary_window: { used_percent: 5, reset_at: 1_768_972_193, limit_window_seconds: 604_800 },
  },
  additional_rate_limits: [
    {
      limit_name: 'GPT-5.3-Codex-Spark',
      metered_feature: 'codex_spark',
      rate_limit: {
        primary_window: { used_percent: 40, reset_at: 1_767_900_000, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 90, reset_at: 1_768_900_000, limit_window_seconds: 604_800 },
      },
    },
    'not-an-object',
    { limit_name: 'Broken', rate_limit: null },
  ],
};

function usageResponder(
  usage: unknown,
  resetCredits?: { readonly status?: number; readonly body?: unknown },
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer quota-access-token');
    expect(headers.get('ChatGPT-Account-Id')).toBe('account-123');
    if (url === 'https://chatgpt.com/backend-api/wham/usage') return Response.json(usage);
    expect(url).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
    if (resetCredits === undefined) return new Response('nope', { status: 404 });
    return Response.json(resetCredits.body ?? {}, { status: resetCredits.status ?? 200 });
  };
}

test('maps the session, weekly, and model-specific windows', async () => {
  const snapshot = await readOpenAIChatGPTQuota(context(), usageResponder(usagePayload));

  expect(snapshot).toEqual({
    items: [
      {
        id: 'primary',
        displayName: { default: '5-hour limit', 'zh-Hans': '5 小时额度' },
        remainingRatio: 0.85,
        resetsAt: 1_767_972_193_000,
      },
      {
        id: 'secondary',
        displayName: { default: 'Weekly limit', 'zh-Hans': '周额度' },
        remainingRatio: 0.95,
        resetsAt: 1_768_972_193_000,
      },
      {
        id: 'codex-spark',
        displayName: {
          default: 'GPT-5.3-Codex-Spark · 5-hour limit',
          'zh-Hans': 'GPT-5.3-Codex-Spark · 5 小时额度',
        },
        remainingRatio: 0.6,
        resetsAt: 1_767_900_000_000,
      },
      {
        id: 'codex-spark-secondary',
        displayName: {
          default: 'GPT-5.3-Codex-Spark · Weekly limit',
          'zh-Hans': 'GPT-5.3-Codex-Spark · 周额度',
        },
        remainingRatio: 0.09999999999999998,
        resetsAt: 1_768_900_000_000,
      },
    ],
    plan: 'Free Workspace',
  });
});

test('reports reset credits when the inventory endpoint answers', async () => {
  const snapshot = await readOpenAIChatGPTQuota(
    context(),
    usageResponder(usagePayload, {
      body: {
        available_count: 2,
        credits: [
          { id: 'credit-1', expires_at: '2026-02-01T00:00:00Z' },
          { id: 'credit-1', expires_at: '2026-03-01T00:00:00Z' },
          { id: '   ' },
        ],
      },
    }),
  );

  expect(snapshot.resetCredits).toEqual({
    availableCount: 2,
    items: [{ id: 'credit-1', expiresAt: Date.parse('2026-02-01T00:00:00Z') }],
  });
});

// A spent or expired grant still ships in `credits[]`, and each listed entry renders as an upcoming
// expiry, so only redeemable ones may survive. `available_count` stays the count authority.
test('lists only redeemable reset credits', async () => {
  const snapshot = await readOpenAIChatGPTQuota(
    context(),
    usageResponder(usagePayload, {
      body: {
        available_count: 1,
        credits: [
          { id: 'spent', status: 'redeemed', reset_type: 'codex_rate_limits', expires_at: '2026-02-01T00:00:00Z' },
          { id: 'other-product', status: 'available', reset_type: 'sora_credits', expires_at: '2026-02-01T00:00:00Z' },
          { id: 'usable', status: 'available', reset_type: 'codex_rate_limits', expires_at: '2026-04-01T00:00:00Z' },
        ],
      },
    }),
  );

  expect(snapshot.resetCredits).toEqual({
    availableCount: 1,
    items: [{ id: 'usable', expiresAt: Date.parse('2026-04-01T00:00:00Z') }],
  });
});

// The inventory is enrichment: the ring must still render when only the usage read succeeds.
test('keeps the snapshot when the reset-credit inventory fails', async () => {
  const snapshot = await readOpenAIChatGPTQuota(context(), usageResponder(usagePayload));
  expect(snapshot.resetCredits).toBeUndefined();
  expect(snapshot.items).toHaveLength(4);
});

test('fails when the usage response carries no window', async () => {
  await expect(readOpenAIChatGPTQuota(context(), usageResponder({ plan_type: 'pro' }))).rejects.toThrow(
    'no rate limit windows',
  );
});

test('fails when the usage request is rejected', async () => {
  const fetcher = async (): Promise<Response> => new Response('denied', { status: 401 });
  await expect(readOpenAIChatGPTQuota(context(), fetcher as never)).rejects.toThrow(
    'ChatGPT usage request failed with 401',
  );
});
