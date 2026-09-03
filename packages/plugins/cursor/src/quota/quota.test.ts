import { expect, test } from 'bun:test';

import type { AccountContext } from '@aio-proxy/plugin-sdk';

import type { CursorCredential } from '../schema';
import { readCursorQuota } from './quota';

const token = (payload: object) => ['h', Buffer.from(JSON.stringify(payload)).toString('base64url'), 's'].join('.');

const ACCESS_TOKEN = token({ sub: 'auth0|user_01ABC', exp: 4_000_000_000 });
const REFRESHED_TOKEN = token({ sub: 'auth0|user_01ABC', exp: 4_100_000_000 });
const EXPECTED_COOKIE = `WorkosCursorSessionToken=user_01ABC%3A%3A${ACCESS_TOKEN}`;

const credential: CursorCredential = {
  accessToken: ACCESS_TOKEN,
  refreshToken: 'cursor-refresh-token',
  expiresAt: Number.MAX_SAFE_INTEGER,
  email: 'a@b.com',
  subject: 'auth0|user_01ABC',
};

function context(
  value: CursorCredential = credential,
  refreshed: CursorCredential = credential,
): AccountContext<CursorCredential, Record<string, never>> {
  return {
    credentials: {
      read: async () => ({ value, revision: 1 }),
      refresh: async () => ({ status: 'updated', snapshot: { value: refreshed, revision: 2 } }),
    },
    options: {},
    signal: new AbortController().signal,
  };
}

const summaryBody = {
  billingCycleEnd: '2026-09-08T12:00:00Z',
  membershipType: 'pro',
  individualUsage: { plan: { totalPercentUsed: 12.5 } },
};

const sandBody = {
  hasNonZeroIncludedLimit: true,
  usagePercent: 75,
  nextResetTimestampUtc: '2026-09-05T00:00:00.000Z',
};

type Seen = {
  readonly url: string;
  readonly method: string;
  readonly cookie: string | null;
  readonly origin: string | null;
};

function responder(
  options: {
    readonly summary?: Response | (() => Response);
    readonly sand?: () => Promise<Response>;
    readonly seen?: Seen[];
  } = {},
) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    options.seen?.push({
      url,
      method: init?.method ?? 'GET',
      cookie: headers.get('Cookie'),
      origin: headers.get('Origin'),
    });
    if (url === 'https://cursor.com/api/usage-summary') {
      const summary = options.summary;
      if (summary === undefined) return Response.json(summaryBody);
      return typeof summary === 'function' ? summary() : summary;
    }
    expect(url).toBe('https://cursor.com/api/dashboard/get-sand-usage-status');
    return options.sand === undefined ? new Response('nope', { status: 404 }) : await options.sand();
  }) as never;
}

// A wrong separator or a wrong sub split is a silent 401, so both requests are pinned exactly.
test('cookie-authenticates both reads and sends Origin on the dashboard route', async () => {
  const seen: Seen[] = [];
  await readCursorQuota(context(), { fetch: responder({ seen, sand: async () => Response.json(sandBody) }) });

  expect(seen).toEqual(
    expect.arrayContaining([
      { url: 'https://cursor.com/api/usage-summary', method: 'GET', cookie: EXPECTED_COOKIE, origin: null },
      {
        url: 'https://cursor.com/api/dashboard/get-sand-usage-status',
        method: 'POST',
        cookie: EXPECTED_COOKIE,
        origin: 'https://cursor.com',
      },
    ]),
  );
  expect(seen).toHaveLength(2);
});

test('reports the plan lane and the weekly Grok Bot allowance', async () => {
  const snapshot = await readCursorQuota(context(), {
    fetch: responder({ sand: async () => Response.json(sandBody) }),
  });

  expect(snapshot).toStrictEqual({
    items: [
      {
        id: 'plan',
        displayName: { default: 'Plan usage', 'zh-Hans': '套餐用量' },
        remainingRatio: 0.875,
        resetsAt: Date.parse('2026-09-08T12:00:00Z'),
      },
      {
        id: 'grok-bot',
        displayName: 'Grok Bot',
        remainingRatio: 0.25,
        resetsAt: Date.parse('2026-09-05T00:00:00.000Z'),
      },
    ],
    plan: 'Cursor Pro',
  });
});

// CodexBar: a Grok Bot failure must leave Cursor's monthly bars intact.
test('keeps the monthly items when the Grok Bot read fails or reports no allowance', async () => {
  const failed = await readCursorQuota(context(), {
    fetch: responder({
      sand: async () => {
        throw new Error('socket hang up');
      },
    }),
  });
  expect(failed.items.map((entry) => entry.id)).toStrictEqual(['plan']);

  const noAllowance = await readCursorQuota(context(), {
    fetch: responder({ sand: async () => Response.json({ ...sandBody, hasNonZeroIncludedLimit: false }) }),
  });
  expect(noAllowance.items.map((entry) => entry.id)).toStrictEqual(['plan']);
});

// Credentials stored before the optional `subject` field existed must still work.
test('derives the user id from the token when the credential has no subject', async () => {
  const seen: Seen[] = [];
  const { subject: _subject, ...withoutSubject } = credential;
  await readCursorQuota(context(withoutSubject), { fetch: responder({ seen }) });
  expect(seen[0]?.cookie).toBe(EXPECTED_COOKIE);
});

test('refreshes an expired credential and cookies with the new token', async () => {
  const seen: Seen[] = [];
  const expired = { ...credential, accessToken: 'stale.token.value', expiresAt: 1_000 };
  const refreshed = { ...credential, accessToken: REFRESHED_TOKEN };
  await readCursorQuota(context(expired, refreshed), { fetch: responder({ seen }), now: () => 2_000 });
  expect(seen[0]?.cookie).toBe(`WorkosCursorSessionToken=user_01ABC%3A%3A${REFRESHED_TOKEN}`);
});

test('fails when the summary rejects the session', async () => {
  await expect(
    readCursorQuota(context(), { fetch: responder({ summary: () => new Response('no', { status: 401 }) }) }),
  ).rejects.toThrow(/sign in to Cursor again/);
});

test('fails when no lane reports a usable number', async () => {
  await expect(
    readCursorQuota(context(), { fetch: responder({ summary: () => Response.json({ membershipType: 'pro' }) }) }),
  ).rejects.toThrow('Cursor usage summary contains no usable quota');
});
