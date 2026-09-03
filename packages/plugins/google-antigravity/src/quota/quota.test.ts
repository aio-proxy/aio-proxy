import { expect, test } from 'bun:test';

import type { AccountContext, RuntimeFetch } from '@aio-proxy/plugin-sdk';

import type { GoogleAntigravityAccountOptions, GoogleAntigravityCredential } from '../schema';
import { readGoogleAntigravityQuota } from './quota';

const QUOTA_PATH = '/v1internal:retrieveUserQuotaSummary';
const DAILY = `https://daily-cloudcode-pa.googleapis.com${QUOTA_PATH}`;
const SANDBOX = `https://daily-cloudcode-pa.sandbox.googleapis.com${QUOTA_PATH}`;
const PROD = `https://cloudcode-pa.googleapis.com${QUOTA_PATH}`;

function context(
  options: GoogleAntigravityAccountOptions = {},
): AccountContext<GoogleAntigravityCredential, GoogleAntigravityAccountOptions> {
  const value: GoogleAntigravityCredential = {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: Number.MAX_SAFE_INTEGER,
    email: 'person@example.com',
    projectId: 'project-1',
  };
  return {
    options,
    signal: new AbortController().signal,
    credentials: {
      read: async () => ({ value, revision: 1 }),
      refresh: async () => ({ status: 'superseded', snapshot: { value, revision: 1 } }),
    },
  };
}

const summaryPayload = {
  groups: [
    {
      displayName: 'Gemini Models',
      buckets: [
        { window: 'weekly', remaining_fraction: 0.42, resetTime: '2026-09-10T00:00:00Z' },
        { window: '5h', remainingFraction: 1.02, reset_time: '2026-09-03T20:00:00Z' },
        { window: '5h', remainingFraction: 0.5 },
        'not-an-object',
        { window: 'weekly', resetTime: '2026-09-10T00:00:00Z' },
      ],
    },
    {
      display_name: 'Claude and GPT models',
      buckets: [{ window: 'week', remainingFraction: '55%' }],
    },
  ],
};

// Only the quota endpoint answers; loadCodeAssist is Task 3's concern and 404s here.
function quotaResponder(routes: Readonly<Record<string, unknown>>, seen: string[] = []): RuntimeFetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    const headers = new Headers(init?.headers);
    if (url.endsWith(QUOTA_PATH)) {
      expect(init?.method).toBe('POST');
      expect(headers.get('Authorization')).toBe('Bearer access-token');
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(headers.get('User-Agent')).toBe('antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)');
      expect(init?.body).toBe(JSON.stringify({ project: 'project-1' }));
    }
    const route = routes[url];
    if (route === undefined) return new Response('missing', { status: 404 });
    return Response.json(route);
  }) as RuntimeFetch;
}

test('maps grouped buckets to five-hour-then-weekly items with localized labels', async () => {
  const snapshot = await readGoogleAntigravityQuota(context(), quotaResponder({ [DAILY]: summaryPayload }));

  // toStrictEqual, not toEqual: `toEqual` treats trailing `undefined` array holes as absent, so a
  // flatMap-to-map regression in the mapper would compare equal to the expected list.
  expect(snapshot.items).toStrictEqual([
    {
      id: 'gemini-models-5h',
      displayName: { default: 'Gemini Models · 5-hour limit', 'zh-Hans': 'Gemini Models · 5 小时额度' },
      remainingRatio: 1,
      resetsAt: Date.parse('2026-09-03T20:00:00Z'),
    },
    {
      id: 'gemini-models-5h-2',
      displayName: { default: 'Gemini Models · 5-hour limit', 'zh-Hans': 'Gemini Models · 5 小时额度' },
      remainingRatio: 0.5,
    },
    {
      id: 'gemini-models-weekly',
      displayName: { default: 'Gemini Models · Weekly limit', 'zh-Hans': 'Gemini Models · 周额度' },
      remainingRatio: 0.42,
      resetsAt: Date.parse('2026-09-10T00:00:00Z'),
    },
    {
      id: 'claude-and-gpt-models-weekly',
      displayName: {
        default: 'Claude and GPT models · Weekly limit',
        'zh-Hans': 'Claude and GPT models · 周额度',
      },
      remainingRatio: 0.55,
    },
  ]);
});

// Every bucket at 100% is a fresh account, not a placeholder: retrieveUserQuotaSummary has no
// availability-only mode. Blanking the card here would hide quota from healthy accounts.
test('reports a fully unused account rather than suppressing it', async () => {
  const snapshot = await readGoogleAntigravityQuota(
    context(),
    quotaResponder({
      [DAILY]: { groups: [{ displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 1 }] }] },
    }),
  );
  expect(snapshot.items).toStrictEqual([
    {
      id: 'gemini-models-5h',
      displayName: { default: 'Gemini Models · 5-hour limit', 'zh-Hans': 'Gemini Models · 5 小时额度' },
      remainingRatio: 1,
    },
  ]);
});

test('falls through to the sandbox base when daily rejects the account', async () => {
  const seen: string[] = [];
  const snapshot = await readGoogleAntigravityQuota(context(), quotaResponder({ [SANDBOX]: summaryPayload }, seen));
  expect(seen.filter((url) => url.endsWith(QUOTA_PATH))).toEqual([DAILY, SANDBOX]);
  expect(snapshot.items).toHaveLength(4);
});

test('falls through to prod when daily and the sandbox both reject', async () => {
  const seen: string[] = [];
  await readGoogleAntigravityQuota(context(), quotaResponder({ [PROD]: summaryPayload }, seen));
  expect(seen.filter((url) => url.endsWith(QUOTA_PATH))).toEqual([DAILY, SANDBOX, PROD]);
});

test('fails when every base rejects', async () => {
  await expect(readGoogleAntigravityQuota(context(), quotaResponder({}))).rejects.toThrow(
    'Antigravity quota request failed with 404',
  );
});

test('fails when no bucket carries a usable fraction', async () => {
  await expect(
    readGoogleAntigravityQuota(
      context(),
      quotaResponder({ [DAILY]: { groups: [{ displayName: 'Gemini Models', buckets: [{ window: '5h' }] }] } }),
    ),
  ).rejects.toThrow('Antigravity quota response contains no usable buckets');
});

test('contacts only the configured base URL', async () => {
  const seen: string[] = [];
  const relay = `https://relay.example.com${QUOTA_PATH}`;
  await readGoogleAntigravityQuota(
    context({ baseURL: 'https://relay.example.com' }),
    quotaResponder({ [relay]: summaryPayload }, seen),
  );
  expect(seen.every((url) => url.startsWith('https://relay.example.com'))).toBe(true);
});

// `validateOAuthQuotaSnapshot` lives in core, which a plugin must not depend on, so the
// invariants it enforces are asserted here directly: a snapshot that trips any of them is
// rejected wholesale and the dashboard card renders blank.
test('produces a snapshot the core quota validator accepts', async () => {
  const snapshot = await readGoogleAntigravityQuota(context(), quotaResponder({ [DAILY]: summaryPayload }));
  const ids = snapshot.items.map((item) => item.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const item of snapshot.items) {
    expect(Object.getPrototypeOf(item)).toBe(Object.prototype);
    expect(Object.keys(item).every((key) => ['id', 'displayName', 'remainingRatio', 'resetsAt'].includes(key))).toBe(
      true,
    );
    expect(item.remainingRatio).toBeGreaterThanOrEqual(0);
    expect(item.remainingRatio).toBeLessThanOrEqual(1);
    if (item.resetsAt !== undefined) expect(Number.isSafeInteger(item.resetsAt)).toBe(true);
  }
});
