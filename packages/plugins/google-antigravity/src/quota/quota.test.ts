import { expect, spyOn, test } from 'bun:test';

import type { AccountContext, RuntimeFetch } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import type { GoogleAntigravityAccountOptions, GoogleAntigravityCredential } from '../schema';
import { readGoogleAntigravityQuota } from './quota';

const QUOTA_PATH = '/v1internal:retrieveUserQuotaSummary';
const DAILY = `https://daily-cloudcode-pa.googleapis.com${QUOTA_PATH}`;
const SANDBOX = `https://daily-cloudcode-pa.sandbox.googleapis.com${QUOTA_PATH}`;
const PLAN_PATH = '/v1internal:loadCodeAssist';
const DAILY_PLAN = `https://daily-cloudcode-pa.googleapis.com${PLAN_PATH}`;

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

// Only the routes a test names answer; everything else 404s.
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
    if (url.endsWith(PLAN_PATH)) {
      expect(init?.method).toBe('POST');
      expect(headers.get('Authorization')).toBe('Bearer access-token');
      expect(init?.body).toBe(
        JSON.stringify({ cloudaicompanionProject: 'project-1', metadata: { ideType: 'ANTIGRAVITY' } }),
      );
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

test('prefers the paid tier name for the plan label', async () => {
  const snapshot = await readGoogleAntigravityQuota(
    context(),
    quotaResponder({
      [DAILY]: summaryPayload,
      [DAILY_PLAN]: {
        currentTier: { id: 'free-tier', name: 'Free' },
        paidTier: { id: 'g1-ultra-tier', name: 'Antigravity Ultra' },
      },
    }),
  );
  expect(snapshot.plan).toBe('Antigravity Ultra');
});

test('falls back to the current tier and to the built-in tier label', async () => {
  const snapshot = await readGoogleAntigravityQuota(
    context(),
    quotaResponder({ [DAILY]: summaryPayload, [DAILY_PLAN]: { current_tier: { id: 'free-tier' } } }),
  );
  expect(snapshot.plan).toEqual({ default: 'Free', 'zh-Hans': '免费版' });
});

// The plan read is enrichment. A dead loadCodeAssist must never blank the quota ring.
test('keeps the quota items when the plan read fails', async () => {
  const snapshot = await readGoogleAntigravityQuota(context(), quotaResponder({ [DAILY]: summaryPayload }));
  expect(snapshot.plan).toBeUndefined();
  expect(snapshot.items).toHaveLength(4);
});

// A tier id naming a prototype member must not read the inherited value: a function or object
// here trips the core validator, which rejects the whole snapshot and blanks the quota ring.
test('treats a prototype-named tier id as a plain label', async () => {
  const snapshot = await readGoogleAntigravityQuota(
    context(),
    quotaResponder({ [DAILY]: summaryPayload, [DAILY_PLAN]: { paidTier: { id: '__proto__' } } }),
  );
  expect(snapshot.plan).toBe('__proto__');
});

// Upstream answers the project-less `loadCodeAssist` with the current/free tier and no `paidTier`,
// which is why `oauth/project.ts` repeats the request with `cloudaicompanionProject`. The credential
// already carries the project, so this read must name it or a paid account displays "Free".
test('names the project so a paid seat is not reported as its current tier', async () => {
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === DAILY) return Response.json(summaryPayload);
    if (url !== DAILY_PLAN) return new Response('missing', { status: 404 });
    const body: unknown = JSON.parse(String(init?.body));
    const named = isPlainObject(body) && body.cloudaicompanionProject === 'project-1';
    return Response.json(
      named
        ? { currentTier: { id: 'free-tier' }, paidTier: { id: 'g1-ultra-tier', name: 'Antigravity Ultra' } }
        : { currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'project-1' },
    );
  }) as RuntimeFetch;

  const snapshot = await readGoogleAntigravityQuota(context(), fetcher);
  expect(snapshot.plan).toBe('Antigravity Ultra');
});

test('sends the ideType metadata body to the first quota base only', async () => {
  const seen: string[] = [];
  await readGoogleAntigravityQuota(
    context(),
    quotaResponder({ [SANDBOX]: summaryPayload, [DAILY_PLAN]: { paidTier: { id: 'g1-pro-tier' } } }, seen),
  );
  expect(seen.filter((url) => url.endsWith(PLAN_PATH))).toEqual([DAILY_PLAN]);
});

// The plan read is started before the loop, so the first timeout belongs to it and the rest are
// the base walk.
function recordAttemptTimeouts() {
  const observed: number[] = [];
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    observed.push(Number(milliseconds));
    return new AbortController().signal;
  });
  return { walk: () => observed.slice(1), restore: () => timeout.mockRestore() };
}

// The server aborts the whole read at 15s (READ_TIMEOUT_MS in the server's quota cache, which is
// module-private, so this test is the only thing holding the two numbers together). The walk must
// fit under that with room for the untimed credential refresh ahead of it, or the last base is
// never reached when the earlier ones are slow rather than dead — the only reason the list exists.
const SERVER_READ_TIMEOUT_MS = 15_000;

test('fits every quota attempt inside the server read budget', async () => {
  const recorder = recordAttemptTimeouts();
  try {
    // The sandbox is the last base, so every attempt in the walk is made.
    await readGoogleAntigravityQuota(context(), quotaResponder({ [SANDBOX]: summaryPayload }));
  } finally {
    recorder.restore();
  }
  const walk = recorder.walk();
  expect(walk).toHaveLength(2);
  expect(walk.reduce((total, value) => total + value, 0)).toBeLessThan(SERVER_READ_TIMEOUT_MS);
});

// A custom base is a one-element list, so it gets the whole walk budget rather than a share sized
// for the default list: a slow-but-healthy relay must not be cut short by someone else's divisor.
test('gives a custom base the whole walk budget', async () => {
  const base = 'https://relay.example.com';
  const recorder = recordAttemptTimeouts();
  try {
    await readGoogleAntigravityQuota(
      context({ baseURL: base }),
      quotaResponder({ [`${base}${QUOTA_PATH}`]: summaryPayload }),
    );
  } finally {
    recorder.restore();
  }
  const walk = recorder.walk();
  expect(walk).toHaveLength(1);
  expect(walk[0]).toBeLessThan(SERVER_READ_TIMEOUT_MS);
  // Strictly more than the default per-base share, i.e. the divisor really tracked the list length.
  expect(walk[0]).toBeGreaterThan(SERVER_READ_TIMEOUT_MS / 2);
});
