import { expect, test } from 'bun:test';

import {
  CURSOR_USAGE_SUMMARY_URL,
  isoTimestamp,
  readUsageSummary,
  remainingFromPercent,
  summaryQuota,
} from './summary';

const BILLING_CYCLE_END = '2026-09-08T12:00:00Z';
const BILLING_CYCLE_END_MS = Date.parse(BILLING_CYCLE_END);

const fullPayload = {
  billingCycleEnd: BILLING_CYCLE_END,
  membershipType: 'pro_plus',
  individualUsage: {
    plan: { used: 1600, limit: 2000, autoPercentUsed: 0.36, apiPercentUsed: 25, totalPercentUsed: 12.5 },
    onDemand: { used: 1250, limit: 5000 },
  },
};

// Cursor's percent fields are percentage units even below 1.0: 0.36 means 0.36%, not 36%.
// Reading them as a fraction mis-scales the ring by 100x with no other symptom.
test('inverts Cursor percent-used fields at percentage scale', () => {
  expect(remainingFromPercent(0.36)).toBe(0.9964);
  expect(remainingFromPercent(25)).toBe(0.75);
  expect(remainingFromPercent(140)).toBe(0);
  expect(remainingFromPercent(-5)).toBe(1);
  expect(remainingFromPercent('25')).toBeUndefined();
});

test('parses billing timestamps into epoch milliseconds', () => {
  expect(isoTimestamp('2026-09-05T00:00:00.000Z')).toBe(1_788_566_400_000);
  expect(isoTimestamp('not a date')).toBeUndefined();
  expect(isoTimestamp(undefined)).toBeUndefined();
});

test('maps the plan, auto, named-model, and on-demand lanes', () => {
  expect(summaryQuota(fullPayload)).toStrictEqual({
    items: [
      {
        id: 'plan',
        displayName: { default: 'Plan usage', 'zh-Hans': '套餐用量' },
        remainingRatio: 0.875,
        resetsAt: BILLING_CYCLE_END_MS,
      },
      {
        id: 'auto',
        displayName: { default: 'Auto models', 'zh-Hans': 'Auto 模型' },
        remainingRatio: 0.9964,
        resetsAt: BILLING_CYCLE_END_MS,
      },
      {
        id: 'api',
        displayName: { default: 'Named models', 'zh-Hans': '指定模型' },
        remainingRatio: 0.75,
        resetsAt: BILLING_CYCLE_END_MS,
      },
      {
        id: 'on-demand',
        displayName: { default: 'On-demand budget', 'zh-Hans': '按量预算' },
        remainingRatio: 0.75,
        resetsAt: BILLING_CYCLE_END_MS,
      },
    ],
    plan: 'Cursor Pro+',
  });
});

test('averages the auto and named lanes when no total percent is reported', () => {
  const payload = {
    individualUsage: { plan: { autoPercentUsed: 0.36, apiPercentUsed: 25 } },
  };
  expect(summaryQuota(payload).items[0]).toStrictEqual({
    id: 'plan',
    displayName: { default: 'Plan usage', 'zh-Hans': '套餐用量' },
    remainingRatio: 0.8732,
  });
});

// Enterprise and Team accounts get no `plan` block at all; without these rungs their ring is empty.
test('falls back to the personal cap and then the shared team pool', () => {
  expect(summaryQuota({ individualUsage: { overall: { used: 2500, limit: 10_000 } } }).items).toStrictEqual([
    { id: 'plan', displayName: { default: 'Plan usage', 'zh-Hans': '套餐用量' }, remainingRatio: 0.75 },
  ]);
  expect(summaryQuota({ teamUsage: { pooled: { used: 3000, limit: 4000 } } }).items).toStrictEqual([
    { id: 'plan', displayName: { default: 'Plan usage', 'zh-Hans': '套餐用量' }, remainingRatio: 0.25 },
  ]);
});

// A zero limit must not render as a full or empty bar; the lane simply does not exist.
test('drops lanes with a missing or non-positive limit', () => {
  expect(summaryQuota({ individualUsage: { plan: { used: 5, limit: 0 }, onDemand: { used: 400 } } })).toStrictEqual({
    items: [],
  });
});

test('passes an unknown membership type through with the Cursor prefix', () => {
  expect(
    summaryQuota({ membershipType: '  business  ', individualUsage: { plan: { totalPercentUsed: 0 } } }).plan,
  ).toBe('Cursor business');
  expect(
    summaryQuota({ membershipType: '   ', individualUsage: { plan: { totalPercentUsed: 0 } } }).plan,
  ).toBeUndefined();
});

test('names the rejected session so the user knows to sign in again', async () => {
  const fetcher = (async () => new Response('nope', { status: 401 })) as never;
  await expect(readUsageSummary(fetcher, 'cookie', new AbortController().signal)).rejects.toThrow(
    /sign in to Cursor again/,
  );
});

test('reports the status for any other rejection and rejects a non-object body', async () => {
  const failing = (async () => new Response('boom', { status: 503 })) as never;
  await expect(readUsageSummary(failing, 'cookie', new AbortController().signal)).rejects.toThrow(
    'Cursor usage summary request failed with 503',
  );
  const notAnObject = (async () => Response.json([1, 2])) as never;
  await expect(readUsageSummary(notAnObject, 'cookie', new AbortController().signal)).rejects.toThrow(
    'Cursor usage summary response is invalid',
  );
});

test('sends the session cookie as control traffic', async () => {
  let seen: { readonly url: string; readonly cookie: string | null; readonly traffic: unknown } | undefined;
  const fetcher = (async (input: string, init: { headers: HeadersInit; aioProxy?: unknown }) => {
    seen = {
      url: String(input),
      cookie: new Headers(init.headers).get('Cookie'),
      traffic: init.aioProxy,
    };
    return Response.json(fullPayload);
  }) as never;
  await readUsageSummary(fetcher, 'WorkosCursorSessionToken=u%3A%3At', new AbortController().signal);
  expect(seen).toEqual({
    url: CURSOR_USAGE_SUMMARY_URL,
    cookie: 'WorkosCursorSessionToken=u%3A%3At',
    traffic: { traffic: 'control' },
  });
});
