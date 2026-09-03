# Cursor OAuth Quota Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@aio-proxy/plugin-cursor`'s OAuth adapter a `quota` capability so the Cursor Provider card renders a quota ring.

**Architecture:** A new `src/quota/` directory. `cookie.ts` derives cursor.com's `WorkosCursorSessionToken` cookie from the access token's `sub` claim; `summary.ts` reads the required `GET /api/usage-summary` and maps it to `OAuthQuotaItem`s; `sand.ts` adds the Grok Bot weekly lane as swallow-all-failures enrichment with its own timeout; `quota.ts` refreshes the credential, runs both reads concurrently, and assembles the snapshot. One property on the adapter lights up the existing dashboard UI — no server or dashboard change.

**Tech Stack:** TypeScript, Bun test, `es-toolkit` (`isPlainObject` from `es-toolkit/predicate`, `clamp` from `es-toolkit/math`), Changesets.

**Spec:** [docs/superpowers/specs/2026-09-03-cursor-quota-design.md](../specs/2026-09-03-cursor-quota-design.md)

## Global Constraints

- Every snapshot must survive `validateOAuthQuotaSnapshot` (`packages/core/src/plugins/quota.ts`): plain objects only, no unknown keys, unique item ids, `remainingRatio` in `0..1`, `resetsAt` a safe integer, `plan` a trimmed non-empty string.
- The plugin must not depend on `@aio-proxy/core`. Assert snapshot shape directly in tests; do not import the validator.
- Every outbound fetch carries `aioProxy: { traffic: 'control' }`.
- Fetcher resolution is always `dependencies.fetch ?? context.fetch ?? globalThis.fetch`.
- The cookie separator is the literal seven-byte sequence `%3A%3A`, never `::`.
- The user id is the last **non-empty** `|`-separated segment of the JWT `sub` claim, charset-validated against `[A-Za-z0-9._-]`.
- Cursor's `*PercentUsed` fields are already percentage units even when fractional: `0.36` means 0.36%.
- A missing, non-finite, or non-positive limit yields **no item**, never a `0` or `1` ratio.
- `get-sand-usage-status` failures return `undefined` and must leave the monthly items intact.
- `quota.reset` stays undefined. `resetCredits` is never populated.
- Use `es-toolkit` narrow imports instead of hand-written helpers. Do not add a dependency; `es-toolkit` is already `"catalog:"` in `packages/plugins/cursor/package.json`.
- Colocated tests, directory grouping (`quota/index.ts` exports only). Non-test files stay well under 500 lines.
- Do NOT commit outside the listed per-task commits. Do NOT use `git stash`. Already on branch `claude/laughing-yonath-9fe10b`; do not create another worktree.
- Run everything from `/Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b`.

---

## File Structure

**Create**

| File | Responsibility |
| --- | --- |
| `packages/plugins/cursor/src/quota/index.ts` | Public entry point. Exports only. |
| `packages/plugins/cursor/src/quota/cookie.ts` | `cursorUserId`, `cursorSessionCookie`. No I/O. ~30 lines. |
| `packages/plugins/cursor/src/quota/cookie.test.ts` | Cookie byte sequence and `sub` split rules. |
| `packages/plugins/cursor/src/quota/summary.ts` | `usage-summary` fetch, wire-value parse helpers, item mapping, plan name. ~160 lines. |
| `packages/plugins/cursor/src/quota/summary.test.ts` | Percent scaling, fallback ladder, zero-limit handling, 401 message. |
| `packages/plugins/cursor/src/quota/sand.ts` | Grok Bot best-effort read. Own timeout, swallows everything. ~45 lines. |
| `packages/plugins/cursor/src/quota/quota.ts` | Orchestration: refresh, cookie, concurrent reads, assemble. ~45 lines. |
| `packages/plugins/cursor/src/quota/quota.test.ts` | End-to-end reader behavior including refresh and sand degradation. |
| `.changeset/cursor-oauth-quota.md` | Release note. |

**Modify**

| File | Change |
| --- | --- |
| `packages/plugins/cursor/src/plugin/plugin.ts` | One `quota: { read: ... }` property on the adapter. |
| `packages/plugins/cursor/src/plugin/plugin.test.ts` | Add a behavior test that the wired capability reads through the injected fetcher. |
| `packages/plugins/cursor/src/index.ts` | `export * from './quota/index';` |

Split rationale: the two endpoints have different failure contracts (one throws, one never does), so they are separate files. `sand.ts` imports `remainingFromPercent` / `isoTimestamp` from `./summary` — both parse the same flavor of cursor.com wire values, so those helpers belong to Cursor wire parsing rather than a generic `utils.ts`. Nothing outside `quota/` imports anything but `quota/index.ts`.

`packages/plugins/cursor/package.json`'s `test:unit` is already a bare `bun test`, so colocated tests run with no script change.

---

### Task 1: Session cookie derivation

**Files:**
- Create: `packages/plugins/cursor/src/quota/cookie.ts`
- Create: `packages/plugins/cursor/src/quota/cookie.test.ts`

**Interfaces:**
- Consumes: `readCursorClaims(token: string): Record<string, unknown>` from `packages/plugins/cursor/src/jwt/index`.
- Produces:
  - `cursorUserId(accessToken: string, fallbackSubject?: string): string` — throws on a missing or unusable subject.
  - `cursorSessionCookie(accessToken: string, fallbackSubject?: string): string` — the full `Cookie` header value.

- [ ] **Step 1: Write the failing test**

Create `packages/plugins/cursor/src/quota/cookie.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { cursorSessionCookie, cursorUserId } from './cookie';

const token = (payload: object) => ['h', Buffer.from(JSON.stringify(payload)).toString('base64url'), 's'].join('.');

test('takes the last non-empty pipe segment of the sub claim', () => {
  expect(cursorUserId(token({ sub: 'auth0|user_01ABC' }))).toBe('user_01ABC');
  // `omittingEmptySubsequences` in the Swift source: a trailing pipe must not yield an empty id.
  expect(cursorUserId(token({ sub: 'auth0|user_01ABC|' }))).toBe('user_01ABC');
  expect(cursorUserId(token({ sub: 'user_01ABC' }))).toBe('user_01ABC');
});

// Credentials stored before `subject` existed still work, because the id comes from the live token.
test('prefers the live token claim and falls back to the stored subject', () => {
  expect(cursorUserId(token({ sub: 'auth0|from_token' }), 'auth0|from_storage')).toBe('from_token');
  expect(cursorUserId(token({}), 'auth0|from_storage')).toBe('from_storage');
});

test('rejects a subject the cursor.com cookie cannot carry', () => {
  expect(() => cursorUserId(token({ sub: 'auth0|user 01' }))).toThrow(/invalid account subject/i);
  expect(() => cursorUserId(token({}))).toThrow(/no account subject/i);
});

// A wrong separator or a wrong sub split is a silent 401 with no other symptom.
test('sends the percent-encoded separator verbatim', () => {
  const accessToken = token({ sub: 'auth0|user_01ABC' });
  expect(cursorSessionCookie(accessToken)).toBe(`WorkosCursorSessionToken=user_01ABC%3A%3A${accessToken}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/plugins/cursor && bun test ./src/quota/cookie.test.ts`
Expected: FAIL — `Cannot find module './cookie'`.

- [ ] **Step 3: Write the implementation**

Create `packages/plugins/cursor/src/quota/cookie.ts`:

```ts
import { readCursorClaims } from '../jwt/index';

// cursor.com only accepts ids in this charset; a claim outside it means an opaque upstream 401.
const USER_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;

/**
 * cursor.com keys its session cookie on the last `|`-separated segment of the JWT `sub`
 * (`auth0|user_01ABC` -> `user_01ABC`). Empty segments are dropped, so a trailing `|` is ignored.
 */
export function cursorUserId(accessToken: string, fallbackSubject?: string): string {
  const claim = readCursorClaims(accessToken)['sub'];
  const subject = typeof claim === 'string' && claim.trim() !== '' ? claim.trim() : fallbackSubject;
  if (subject === undefined) throw new Error('Cursor access token has no account subject');
  const userId = subject.split('|').filter((segment) => segment !== '').at(-1);
  if (userId === undefined || !USER_ID_PATTERN.test(userId)) {
    throw new Error('Cursor access token has an invalid account subject');
  }
  return userId;
}

/** The separator is stored percent-encoded on cursor.com, so it is sent as the literal `%3A%3A`. */
export function cursorSessionCookie(accessToken: string, fallbackSubject?: string): string {
  return `WorkosCursorSessionToken=${cursorUserId(accessToken, fallbackSubject)}%3A%3A${accessToken}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/plugins/cursor && bun test ./src/quota/cookie.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/cursor/src/quota/cookie.ts packages/plugins/cursor/src/quota/cookie.test.ts
git commit -m "feat(cursor): derive the cursor.com session cookie from the access token"
```

---

### Task 2: Usage summary read and item mapping

**Files:**
- Create: `packages/plugins/cursor/src/quota/summary.ts`
- Create: `packages/plugins/cursor/src/quota/summary.test.ts`

**Interfaces:**
- Consumes: `RuntimeFetch`, `OAuthQuotaItem`, `LocalizedText` from `@aio-proxy/plugin-sdk`.
- Produces:
  - `CURSOR_USAGE_SUMMARY_URL: 'https://cursor.com/api/usage-summary'`
  - `readUsageSummary(fetcher: RuntimeFetch, cookie: string, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>>`
  - `summaryQuota(payload: Readonly<Record<string, unknown>>): { readonly items: readonly OAuthQuotaItem[]; readonly plan?: string }`
  - `remainingFromPercent(value: unknown): number | undefined`
  - `isoTimestamp(value: unknown): number | undefined`

- [ ] **Step 1: Write the failing test**

Create `packages/plugins/cursor/src/quota/summary.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { CURSOR_USAGE_SUMMARY_URL, isoTimestamp, readUsageSummary, remainingFromPercent, summaryQuota } from './summary';

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
  expect(summaryQuota(fullPayload)).toEqual({
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
  expect(summaryQuota(payload).items[0]).toEqual({
    id: 'plan',
    displayName: { default: 'Plan usage', 'zh-Hans': '套餐用量' },
    remainingRatio: 0.8732,
  });
});

// Enterprise and Team accounts get no `plan` block at all; without these rungs their ring is empty.
test('falls back to the personal cap and then the shared team pool', () => {
  expect(summaryQuota({ individualUsage: { overall: { used: 2500, limit: 10_000 } } }).items).toEqual([
    { id: 'plan', displayName: { default: 'Plan usage', 'zh-Hans': '套餐用量' }, remainingRatio: 0.75 },
  ]);
  expect(summaryQuota({ teamUsage: { pooled: { used: 3000, limit: 4000 } } }).items).toEqual([
    { id: 'plan', displayName: { default: 'Plan usage', 'zh-Hans': '套餐用量' }, remainingRatio: 0.25 },
  ]);
});

// A zero limit must not render as a full or empty bar; the lane simply does not exist.
test('drops lanes with a missing or non-positive limit', () => {
  expect(summaryQuota({ individualUsage: { plan: { used: 5, limit: 0 }, onDemand: { used: 400 } } })).toEqual({
    items: [],
  });
});

test('passes an unknown membership type through with the Cursor prefix', () => {
  expect(summaryQuota({ membershipType: '  business  ', individualUsage: { plan: { totalPercentUsed: 0 } } }).plan).toBe(
    'Cursor business',
  );
  expect(summaryQuota({ membershipType: '   ', individualUsage: { plan: { totalPercentUsed: 0 } } }).plan).toBeUndefined();
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/plugins/cursor && bun test ./src/quota/summary.test.ts`
Expected: FAIL — `Cannot find module './summary'`.

- [ ] **Step 3: Write the implementation**

Create `packages/plugins/cursor/src/quota/summary.ts`:

```ts
import type { LocalizedText, OAuthQuotaItem, RuntimeFetch } from '@aio-proxy/plugin-sdk';
import { clamp } from 'es-toolkit/math';
import { isPlainObject } from 'es-toolkit/predicate';

export const CURSOR_USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary';

const PLAN_LABEL: LocalizedText = { default: 'Plan usage', 'zh-Hans': '套餐用量' };
const AUTO_LABEL: LocalizedText = { default: 'Auto models', 'zh-Hans': 'Auto 模型' };
const API_LABEL: LocalizedText = { default: 'Named models', 'zh-Hans': '指定模型' };
const ON_DEMAND_LABEL: LocalizedText = { default: 'On-demand budget', 'zh-Hans': '按量预算' };

// Cursor's own dashboard copy for each `membershipType` enum value.
const MEMBERSHIP_NAMES: Readonly<Record<string, string>> = {
  enterprise: 'Enterprise',
  express: 'Start',
  free: 'Free',
  free_trial: 'Pro Trial',
  hobby: 'Hobby',
  pro: 'Pro',
  pro_plus: 'Pro+',
  pro_student: 'Pro',
  team: 'Team',
  ultra: 'Ultra',
};

export type CursorSummaryQuota = {
  readonly items: readonly OAuthQuotaItem[];
  readonly plan?: string;
};

export async function readUsageSummary(
  fetcher: RuntimeFetch,
  cookie: string,
  signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  const response = await fetcher(CURSOR_USAGE_SUMMARY_URL, {
    headers: { Accept: 'application/json', Cookie: cookie },
    signal,
    aioProxy: { traffic: 'control' },
  });
  // The wrong-subject and expired-session cases land here and need a legible instruction.
  if (response.status === 401 || response.status === 403) {
    throw new Error('Cursor rejected the session cookie; sign in to Cursor again');
  }
  if (!response.ok) throw new Error(`Cursor usage summary request failed with ${response.status}`);
  const payload: unknown = await response.json();
  if (!isPlainObject(payload)) throw new Error('Cursor usage summary response is invalid');
  return payload;
}

export function summaryQuota(payload: Readonly<Record<string, unknown>>): CursorSummaryQuota {
  const individual = record(Reflect.get(payload, 'individualUsage'));
  const plan = record(individual === undefined ? undefined : Reflect.get(individual, 'plan'));
  const resetsAt = isoTimestamp(Reflect.get(payload, 'billingCycleEnd'));

  const auto = plan === undefined ? undefined : remainingFromPercent(Reflect.get(plan, 'autoPercentUsed'));
  const api = plan === undefined ? undefined : remainingFromPercent(Reflect.get(plan, 'apiPercentUsed'));
  const onDemand = ratioFromCents(individual === undefined ? undefined : Reflect.get(individual, 'onDemand'));

  const items = [
    item('plan', PLAN_LABEL, planRatio(payload, plan, auto, api), resetsAt),
    item('auto', AUTO_LABEL, auto, resetsAt),
    item('api', API_LABEL, api, resetsAt),
    item('on-demand', ON_DEMAND_LABEL, onDemand, resetsAt),
  ].filter((entry): entry is OAuthQuotaItem => entry !== undefined);

  const membership = membershipPlan(Reflect.get(payload, 'membershipType'));
  return { items, ...(membership === undefined ? {} : { plan: membership }) };
}

/**
 * Cursor reports the headline number in six different places depending on plan shape.
 * Enterprise and Team accounts have no `plan` block at all, so the last two rungs are load-bearing.
 */
function planRatio(
  payload: Readonly<Record<string, unknown>>,
  plan: Readonly<Record<string, unknown>> | undefined,
  auto: number | undefined,
  api: number | undefined,
): number | undefined {
  if (plan !== undefined) {
    const total = remainingFromPercent(Reflect.get(plan, 'totalPercentUsed'));
    if (total !== undefined) return total;
    if (auto !== undefined && api !== undefined) return (auto + api) / 2;
    if (api !== undefined) return api;
    if (auto !== undefined) return auto;
    const planCents = ratioFromCents(plan);
    if (planCents !== undefined) return planCents;
  }
  const individual = record(Reflect.get(payload, 'individualUsage'));
  const overall = ratioFromCents(individual === undefined ? undefined : Reflect.get(individual, 'overall'));
  if (overall !== undefined) return overall;
  const team = record(Reflect.get(payload, 'teamUsage'));
  return ratioFromCents(team === undefined ? undefined : Reflect.get(team, 'pooled'));
}

/** Percent fields are percentage units even when fractional: `0.36` means 0.36%. */
export function remainingFromPercent(value: unknown): number | undefined {
  const percent = finite(value);
  return percent === undefined ? undefined : 1 - clamp(percent, 0, 100) / 100;
}

export function isoTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** `used` / `limit` blocks are denominated in cents; only the ratio survives into the snapshot. */
function ratioFromCents(value: unknown): number | undefined {
  const block = record(value);
  if (block === undefined) return undefined;
  const limit = finite(Reflect.get(block, 'limit'));
  const used = finite(Reflect.get(block, 'used'));
  if (limit === undefined || limit <= 0 || used === undefined) return undefined;
  return 1 - clamp(used / limit, 0, 1);
}

// An item with no ratio renders an empty bar, which reads as "nothing left". Omit it instead.
function item(
  id: string,
  displayName: LocalizedText,
  remainingRatio: number | undefined,
  resetsAt: number | undefined,
): OAuthQuotaItem | undefined {
  if (remainingRatio === undefined) return undefined;
  return { id, displayName, remainingRatio, ...(resetsAt === undefined ? {} : { resetsAt }) };
}

// `LocalizedTextSchema` rejects untrimmed strings, so an untrimmed enum would fail the whole snapshot.
function membershipPlan(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return `Cursor ${MEMBERSHIP_NAMES[trimmed.toLowerCase()] ?? trimmed}`;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isPlainObject(value) ? value : undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/plugins/cursor && bun test ./src/quota/summary.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/cursor/src/quota/summary.ts packages/plugins/cursor/src/quota/summary.test.ts
git commit -m "feat(cursor): map the cursor.com usage summary to quota items"
```

---

### Task 3: Grok Bot enrichment and the reader

**Files:**
- Create: `packages/plugins/cursor/src/quota/sand.ts`
- Create: `packages/plugins/cursor/src/quota/quota.ts`
- Create: `packages/plugins/cursor/src/quota/index.ts`
- Create: `packages/plugins/cursor/src/quota/quota.test.ts`
- Modify: `packages/plugins/cursor/src/index.ts`

**Interfaces:**
- Consumes:
  - `cursorSessionCookie(accessToken, fallbackSubject?)` (Task 1)
  - `readUsageSummary(fetcher, cookie, signal)`, `summaryQuota(payload)`, `remainingFromPercent(value)`, `isoTimestamp(value)` (Task 2)
  - `currentCursorCredential(port: CredentialPort<CursorCredential>, options?: CursorOAuthDependencies): Promise<CursorCredential>` from `packages/plugins/cursor/src/oauth/index`
- Produces:
  - `CURSOR_SAND_USAGE_URL: 'https://cursor.com/api/dashboard/get-sand-usage-status'`
  - `readGrokBotItem(fetcher: RuntimeFetch, cookie: string, signal: AbortSignal): Promise<OAuthQuotaItem | undefined>` — never rejects.
  - `readCursorQuota(context: AccountContext<CursorCredential, Record<string, never>>, dependencies?: CursorOAuthDependencies): Promise<OAuthQuotaSnapshot>`

- [ ] **Step 1: Write the failing test**

Create `packages/plugins/cursor/src/quota/quota.test.ts`:

```ts
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

type Seen = { readonly url: string; readonly method: string; readonly cookie: string | null; readonly origin: string | null };

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

  expect(snapshot).toEqual({
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
    fetch: responder({ sand: async () => { throw new Error('socket hang up'); } }),
  });
  expect(failed.items.map((entry) => entry.id)).toEqual(['plan']);

  const noAllowance = await readCursorQuota(context(), {
    fetch: responder({ sand: async () => Response.json({ ...sandBody, hasNonZeroIncludedLimit: false }) }),
  });
  expect(noAllowance.items.map((entry) => entry.id)).toEqual(['plan']);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/plugins/cursor && bun test ./src/quota/quota.test.ts`
Expected: FAIL — `Cannot find module './quota'`.

- [ ] **Step 3: Write the implementation**

Create `packages/plugins/cursor/src/quota/sand.ts`:

```ts
import type { OAuthQuotaItem, RuntimeFetch } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { isoTimestamp, remainingFromPercent } from './summary';

export const CURSOR_SAND_USAGE_URL = 'https://cursor.com/api/dashboard/get-sand-usage-status';
// Enrichment only: a stalled dashboard route must not hold the monthly bars open.
const SAND_TIMEOUT_MS = 4_000;

/**
 * Grok Bot (internally "Sand") weekly included usage. Never rejects: a failure, a timeout,
 * a malformed body, or an account with no Bot allowance all leave the monthly items intact.
 */
export async function readGrokBotItem(
  fetcher: RuntimeFetch,
  cookie: string,
  signal: AbortSignal,
): Promise<OAuthQuotaItem | undefined> {
  try {
    const response = await fetcher(CURSOR_SAND_USAGE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Cookie: cookie,
        // cursor.com gates its dashboard routes on a matching Origin.
        Origin: 'https://cursor.com',
      },
      body: '{}',
      signal: AbortSignal.any([signal, AbortSignal.timeout(SAND_TIMEOUT_MS)]),
      aioProxy: { traffic: 'control' },
    });
    if (!response.ok) return undefined;
    const payload: unknown = await response.json();
    if (!isPlainObject(payload)) return undefined;
    if (Reflect.get(payload, 'hasNonZeroIncludedLimit') !== true) return undefined;
    const remainingRatio = remainingFromPercent(Reflect.get(payload, 'usagePercent'));
    if (remainingRatio === undefined) return undefined;
    const resetsAt = isoTimestamp(Reflect.get(payload, 'nextResetTimestampUtc'));
    return { id: 'grok-bot', displayName: 'Grok Bot', remainingRatio, ...(resetsAt === undefined ? {} : { resetsAt }) };
  } catch {
    return undefined;
  }
}
```

Create `packages/plugins/cursor/src/quota/quota.ts`:

```ts
import type { AccountContext, OAuthQuotaSnapshot, RuntimeFetch } from '@aio-proxy/plugin-sdk';

import { currentCursorCredential, type CursorOAuthDependencies } from '../oauth/index';
import type { CursorCredential } from '../schema';
import { cursorSessionCookie } from './cookie';
import { readGrokBotItem } from './sand';
import { readUsageSummary, summaryQuota } from './summary';

export async function readCursorQuota(
  context: AccountContext<CursorCredential, Record<string, never>>,
  dependencies: CursorOAuthDependencies = {},
): Promise<OAuthQuotaSnapshot> {
  const fetcher: RuntimeFetch = dependencies.fetch ?? context.fetch ?? globalThis.fetch;
  // The cookie carries the access token, so an expired one is a 401 rather than a retry.
  const credential = await currentCursorCredential(context.credentials, {
    ...dependencies,
    fetch: fetcher,
    signal: context.signal,
  });
  const cookie = cursorSessionCookie(credential.accessToken, credential.subject);

  // `readGrokBotItem` never rejects, so this settles on the summary alone.
  const [summary, grokBot] = await Promise.all([
    readUsageSummary(fetcher, cookie, context.signal),
    readGrokBotItem(fetcher, cookie, context.signal),
  ]);
  context.signal.throwIfAborted();

  const { items, plan } = summaryQuota(summary);
  const allItems = grokBot === undefined ? items : [...items, grokBot];
  if (allItems.length === 0) throw new Error('Cursor usage summary contains no usable quota');
  return { items: allItems, ...(plan === undefined ? {} : { plan }) };
}
```

Create `packages/plugins/cursor/src/quota/index.ts`:

```ts
export { readCursorQuota } from './quota';
```

Modify `packages/plugins/cursor/src/index.ts` — add the export in alphabetical position, after the `./plugin/index` line and before `./runtime`:

```ts
export * from './quota/index';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/plugins/cursor && bun test ./src/quota/`
Expected: PASS — all three quota test files, 20 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/cursor/src/quota/ packages/plugins/cursor/src/index.ts
git commit -m "feat(cursor): read Cursor OAuth quota including the Grok Bot lane"
```

---

### Task 4: Wire the quota capability onto the adapter

**Files:**
- Modify: `packages/plugins/cursor/src/plugin/plugin.ts`
- Modify: `packages/plugins/cursor/src/plugin/plugin.test.ts`

**Interfaces:**
- Consumes: `readCursorQuota` (Task 3).
- Produces: `adapter.quota` is defined, so `prepareOAuthPluginAccount` (`packages/server/src/plugin-account.ts:119`) sets `DashboardProviderSummary.hasQuota` and the Provider card renders the ring. No server or dashboard change is required.

- [ ] **Step 1: Write the failing test**

Append to `packages/plugins/cursor/src/plugin/plugin.test.ts`:

```ts
// `hasQuota` on the dashboard card is `adapter.quota !== undefined`, and the reader has to
// receive the plugin's injected fetch or the capability is dead on arrival.
test('exposes a quota capability that reads through the injected fetcher', async () => {
  const accessToken = ['h', Buffer.from(JSON.stringify({ sub: 'auth0|user_01ABC' })).toString('base64url'), 's'].join(
    '.',
  );
  const adapter = await adapterFrom(
    createCursorPlugin(englishPresentationText, {
      fetch: (async (input: string | URL) => {
        if (String(input) === 'https://cursor.com/api/usage-summary') {
          return Response.json({ membershipType: 'ultra', individualUsage: { plan: { totalPercentUsed: 20 } } });
        }
        return new Response('nope', { status: 404 });
      }) as never,
    }),
  );

  const snapshot = await adapter.quota!.read({
    credentials: {
      read: async () => ({
        value: { accessToken, refreshToken: 'r', expiresAt: Number.MAX_SAFE_INTEGER },
        revision: 1,
      }),
      refresh: async () => {
        throw new Error('unused');
      },
    },
    options: {},
    signal: new AbortController().signal,
  });

  expect(snapshot).toEqual({
    items: [{ id: 'plan', displayName: { default: 'Plan usage', 'zh-Hans': '套餐用量' }, remainingRatio: 0.8 }],
    plan: 'Cursor Ultra',
  });
  // Cursor has no redeem endpoint, so there is nothing to reset.
  expect(adapter.quota?.reset).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/plugins/cursor && bun test ./src/plugin/plugin.test.ts`
Expected: FAIL — `adapter.quota` is undefined, so `adapter.quota!.read` throws `TypeError`.

- [ ] **Step 3: Write the implementation**

In `packages/plugins/cursor/src/plugin/plugin.ts`, add the import next to the existing `../oauth` import:

```ts
import { readCursorQuota } from '../quota/index';
```

and add one property to the adapter literal, immediately after `createRuntime`:

```ts
    createRuntime: (context) => createCursorRuntime(context, dependencies),
    quota: { read: (context) => readCursorQuota(context, dependencies) },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/plugins/cursor && bun test`
Expected: PASS — the whole plugin suite, including the pre-existing adapter and runtime tests.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/cursor/src/plugin/plugin.ts packages/plugins/cursor/src/plugin/plugin.test.ts
git commit -m "feat(cursor): register the OAuth quota capability on the adapter"
```

---

### Task 5: Changeset and preflight

**Files:**
- Create: `.changeset/cursor-oauth-quota.md`

The changeset must name **both** `@aio-proxy/plugin-cursor` (where the code lives) and `aio-proxy` (the published CLI). All workspace packages are `fixed` in `.changeset/config.json`, so a changeset naming only the plugin still bumps `aio-proxy`, but its CHANGELOG entry would be empty, `scripts/release.ts` would skip its GitHub Release, and the note would silently vanish.

- [ ] **Step 1: Write the changeset**

Create `.changeset/cursor-oauth-quota.md`:

```md
---
'@aio-proxy/plugin-cursor': minor
'aio-proxy': minor
---

cursor: report Cursor OAuth quota in the dashboard

The Cursor OAuth adapter now reads `cursor.com/api/usage-summary`, so its Provider card shows the quota ring: plan usage, the Auto and named-model lanes, the on-demand budget when the account has a cap, and the Cursor subscription tier, all resetting at the billing-cycle end. Accounts with a Grok Bot allowance also get its weekly lane; that read is best-effort and never blocks the monthly bars. No re-login is needed — the session is derived from the access token already on file.
```

- [ ] **Step 2: Build sibling packages if their `dist/` is stale**

The plugin imports `@aio-proxy/plugin-sdk` through its built `dist/`. If type checking fails on SDK types, run this first:

Run: `bun run build`
Expected: turbo builds every package except the website.

- [ ] **Step 3: Run preflight**

Run: `bun run preflight`
Expected: PASS — `lint:types`, `format:check`, and every package's tests.

Known pre-existing flake: `packages/core/src/plugins/config-file/lock-identity.recovery.test.ts` can fail under full parallel load. If it is the only failure, re-run it alone with `cd packages/core && bun test ./src/plugins/config-file/lock-identity.recovery.test.ts` and treat a pass as green. Any failure inside `packages/plugins/cursor` is real and must be fixed.

If `oxfmt` reports formatting differences, run `bun run format` and amend.

- [ ] **Step 4: Commit**

```bash
git add .changeset/cursor-oauth-quota.md
git commit -m "chore: changeset for Cursor OAuth quota"
```

---

## Self-review

**Spec coverage**

| Spec section | Task |
| --- | --- |
| Cookie construction, `%3A%3A`, `sub` last-segment split, charset guard | 1 |
| Missing `subject` re-derived from the access token | 1 (helper), 3 (end-to-end) |
| `GET /api/usage-summary` as the one required call | 2 |
| Percent-unit conversion and `remainingRatio` inversion | 2 |
| Zero / missing limit yields no item | 2 |
| Six-rung `plan` fallback ladder including `overall` and `teamUsage.pooled` | 2 |
| On-demand as a ratio only, no currency | 2 |
| `membershipType` -> trimmed `Cursor <Name>` plan string | 2 |
| 401/403 sign-in-again message, other statuses, non-object body | 2 |
| `POST /api/dashboard/get-sand-usage-status` with `Origin`, own 4s timeout, swallow-all | 3 |
| Grok failure leaves monthly bars intact | 3 |
| Refresh-before-use via `currentCursorCredential` | 3 |
| Concurrency, `throwIfAborted`, throw when no item resolves | 3 |
| No `dedupeItemIds` (ids are compile-time constants, collision unreachable) | 2, 3 — no helper written |
| Adapter wiring, `hasQuota`, `quota.reset` absent | 4 |
| `auth/me` and `/api/usage` deliberately not called | Not implemented, by design — no task |
| Cursor.app SQLite, browser cookie jars, account switcher, CSV, manual cookie | Not implemented, by design — no task |
| Changeset targets the plugin **and** `aio-proxy` | 5 |

**Placeholder scan:** none. Every code step carries complete, runnable source; every test step carries the assertions; every run step names the command and the expected outcome.

**Type consistency:** `cursorUserId` / `cursorSessionCookie` (Task 1) are consumed by name in Task 3. `readUsageSummary` / `summaryQuota` / `remainingFromPercent` / `isoTimestamp` (Task 2) are consumed by name in Tasks 2 and 3 — `summaryQuota` is used consistently (not `summaryItems`), and `sand.ts` imports only the two exported parse helpers. `readGrokBotItem` (Task 3) is used only inside `quota.ts`. `readCursorQuota(context, dependencies)` (Task 3) matches the call site in Task 4. `dependencies` at the Task 4 call site is `CursorRuntimeDependencies`, which extends `CursorOAuthDependencies` and is passed as a variable, so no excess-property check applies.
