# Google Antigravity OAuth Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@aio-proxy/plugin-google-antigravity` an `OAuthAdapter.quota.read` capability so the dashboard Provider card renders a real quota ring for Antigravity accounts.

**Architecture:** One new `src/quota/` directory in the plugin, mirroring `packages/plugins/openai-chatgpt/src/quota/`: `index.ts` (exports only), `quota.ts` (the reader), `quota.test.ts` (colocated). The reader refreshes the credential through the existing `currentGoogleCredential`, `POST`s `v1internal:retrieveUserQuotaSummary` against the endpoint list from `antigravityEndpoints(options, 'quota')` until one answers, maps `groups[].buckets[]` to `OAuthQuotaItem[]`, and enriches with a best-effort, separately-timed `v1internal:loadCodeAssist` plan read. `plugin.ts` wires `quota: { read }` onto the adapter.

**Tech Stack:** Bun, TypeScript, `bun:test`, `es-toolkit/predicate`, `@aio-proxy/plugin-sdk`, Changesets.

**Spec:** [docs/superpowers/specs/2026-09-03-google-antigravity-quota-design.md](../specs/2026-09-03-google-antigravity-quota-design.md)

## Global Constraints

- Run everything from the worktree `/Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b`. Do not create another worktree. Do not `git stash`.
- Every snapshot must survive `validateOAuthQuotaSnapshot` (`packages/core/src/plugins/quota.ts`): plain object literals only (no proxies, no `Object.create(null)`, no class instances), no unknown keys, no duplicate item ids, `remainingRatio` inside `0..1`, `resetsAt` a safe integer, every `LocalizedText` string trimmed and non-empty. Optional fields are spread in conditionally (`...(x === undefined ? {} : { x })`), never assigned `undefined`.
- `quota.reset` is **not** implemented. There is no Antigravity redeem endpoint.
- `resetCredits` is **not** implemented. There is no credit inventory in this payload.
- Every outbound fetch passes `aioProxy: { traffic: 'control' }`.
- The reader takes an injected `fetcher: RuntimeFetch = context.fetch ?? globalThis.fetch` as its second parameter, so tests never touch the network.
- Wire payloads are guarded with `isPlainObject` from `es-toolkit/predicate`. Narrow imports only. No new dependency — `es-toolkit` is already in the plugin's `package.json`.
- Colocated tests, directory grouping: `quota/index.ts`, `quota/quota.ts`, `quota/quota.test.ts`. Do not add files under `_test/`.
- Handwritten non-test implementation files stay under 500 lines; re-evaluate for a split at 400.
- Tests protect user-visible behavior. Do not add a test that restates a literal.
- Quota base URLs, in order: `https://daily-cloudcode-pa.googleapis.com`, `https://daily-cloudcode-pa.sandbox.googleapis.com`, `https://cloudcode-pa.googleapis.com`. A configured account `baseURL` replaces the whole list.
- CLI User-Agent literal, exact: `antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)`.
- One commit per task.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/plugins/google-antigravity/src/oauth/constants.ts` (modify) | Add `ANTIGRAVITY_SANDBOX` base and `ANTIGRAVITY_CLI_USER_AGENT`. Endpoint/UA literals already live here. |
| `packages/plugins/google-antigravity/src/runtime/endpoints.ts` (modify) | Add the `'quota'` operation to `AntigravityOperation` and its three-base list. Single source of truth for "which host do I call, given the account override". |
| `packages/plugins/google-antigravity/src/quota/quota.ts` (create) | The whole reader: credential refresh, base-URL failover, payload → `OAuthQuotaSnapshot` mapping, plan enrichment. ~200 lines. |
| `packages/plugins/google-antigravity/src/quota/index.ts` (create) | Public entry point. Exports only. |
| `packages/plugins/google-antigravity/src/quota/quota.test.ts` (create) | Colocated behavior tests for the reader. |
| `packages/plugins/google-antigravity/src/plugin.ts` (modify) | Wire `quota: { read }` onto the `OAuthAdapter`. |
| `.changeset/google-antigravity-quota.md` (create) | Release note targeting `@aio-proxy/plugin-google-antigravity` + `aio-proxy`. |

Task 1 owns constants + endpoints (they are one decision: where the quota call goes). Task 2 owns the mapping-only core of the reader with the HTTP loop. Task 3 owns the plan enrichment. Task 4 wires the adapter. Task 5 is the changeset and preflight. Tasks 2 and 3 are separate because a reviewer can reasonably accept the quota mapping and reject the enrichment's failure semantics.

---

### Task 1: Quota endpoint list and CLI User-Agent

**Files:**
- Modify: `packages/plugins/google-antigravity/src/oauth/constants.ts`
- Modify: `packages/plugins/google-antigravity/src/runtime/endpoints.ts`
- Create: `packages/plugins/google-antigravity/src/runtime/endpoints.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `ANTIGRAVITY_SANDBOX: 'https://daily-cloudcode-pa.sandbox.googleapis.com'`
  - `ANTIGRAVITY_CLI_USER_AGENT: 'antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)'`
  - `antigravityEndpoints(options, 'quota') => readonly string[]` — the three bases in order, or `[baseURL]` when the account overrides it.
  - `AntigravityOperation` gains the `'quota'` member.

- [ ] **Step 1: Write the failing test**

Create `packages/plugins/google-antigravity/src/runtime/endpoints.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { ANTIGRAVITY_DAILY, ANTIGRAVITY_PROD, ANTIGRAVITY_SANDBOX } from '../oauth/constants';
import { antigravityEndpoints } from './endpoints';

test('quota tries daily, then the sandbox, then prod', () => {
  expect(antigravityEndpoints({}, 'quota')).toEqual([ANTIGRAVITY_DAILY, ANTIGRAVITY_SANDBOX, ANTIGRAVITY_PROD]);
});

// A user who points the account at a relay must not have quota traffic leak to Google.
test('an account baseURL replaces the whole quota list', () => {
  expect(antigravityEndpoints({ baseURL: 'https://relay.example.com/' }, 'quota')).toEqual([
    'https://relay.example.com',
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b/packages/plugins/google-antigravity
bun test ./src/runtime/endpoints.test.ts
```

Expected: FAIL — `ANTIGRAVITY_SANDBOX` is not exported, and `'quota'` is not an `AntigravityOperation`.

- [ ] **Step 3: Write the minimal implementation**

In `packages/plugins/google-antigravity/src/oauth/constants.ts`, add below the existing `ANTIGRAVITY_PROD` line:

```ts
export const ANTIGRAVITY_SANDBOX = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
// The v1internal quota surface answers the Antigravity CLI client string, not the desktop hub UA
// that `antigravityUserAgent()` builds. The CLI version is pinned upstream, so this is a literal.
export const ANTIGRAVITY_CLI_USER_AGENT = 'antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)';
```

Replace `packages/plugins/google-antigravity/src/runtime/endpoints.ts` in full:

```ts
import { ANTIGRAVITY_DAILY, ANTIGRAVITY_PROD, ANTIGRAVITY_SANDBOX } from '../oauth/constants';
import type { GoogleAntigravityAccountOptions } from '../schema';
import { normalizeBaseURL } from '../schema';

export type AntigravityOperation = 'project-load' | 'onboarding' | 'discovery' | 'inference' | 'count' | 'quota';

export function antigravityEndpoints(
  options: GoogleAntigravityAccountOptions,
  operation: AntigravityOperation,
): readonly string[] {
  const custom = normalizeBaseURL(options.baseURL);
  if (custom !== undefined) return [custom];
  if (operation === 'project-load') return [ANTIGRAVITY_PROD];
  if (operation === 'onboarding') return [ANTIGRAVITY_DAILY];
  if (operation === 'quota') return [ANTIGRAVITY_DAILY, ANTIGRAVITY_SANDBOX, ANTIGRAVITY_PROD];
  return [ANTIGRAVITY_DAILY, ANTIGRAVITY_PROD];
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b/packages/plugins/google-antigravity
bun test ./src/runtime/endpoints.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Confirm nothing else regressed**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b/packages/plugins/google-antigravity
bun run test:unit
```

Expected: PASS. Existing discovery / inference endpoint order is untouched.

- [ ] **Step 6: Commit**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b
git add packages/plugins/google-antigravity/src/oauth/constants.ts packages/plugins/google-antigravity/src/runtime/endpoints.ts packages/plugins/google-antigravity/src/runtime/endpoints.test.ts
git commit -m "feat(google-antigravity): add quota endpoint list and CLI user agent"
```

---

### Task 2: Quota reader — payload mapping and base-URL failover

**Files:**
- Create: `packages/plugins/google-antigravity/src/quota/quota.ts`
- Create: `packages/plugins/google-antigravity/src/quota/index.ts`
- Create: `packages/plugins/google-antigravity/src/quota/quota.test.ts`

**Interfaces:**
- Consumes: `antigravityEndpoints(options, 'quota')`, `ANTIGRAVITY_CLI_USER_AGENT` (Task 1); `currentGoogleCredential(source, options)` from `../oauth/refresh`, which returns `Promise<CredentialSnapshot<GoogleAntigravityCredential>>` (read `.value.accessToken` and `.value.projectId`).
- Produces:
  - `readGoogleAntigravityQuota(context: AccountContext<GoogleAntigravityCredential, GoogleAntigravityAccountOptions>, fetcher?: RuntimeFetch): Promise<OAuthQuotaSnapshot>` — exported from `./quota` and re-exported from `./index`.

- [ ] **Step 1: Write the failing test**

Create `packages/plugins/google-antigravity/src/quota/quota.test.ts`:

```ts
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
function quotaResponder(
  routes: Readonly<Record<string, unknown>>,
  seen: string[] = [],
): RuntimeFetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    const headers = new Headers(init?.headers);
    if (url.endsWith(QUOTA_PATH)) {
      expect(init?.method).toBe('POST');
      expect(headers.get('Authorization')).toBe('Bearer access-token');
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(headers.get('User-Agent')).toBe(
        'antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)',
      );
      expect(init?.body).toBe(JSON.stringify({ project: 'project-1' }));
    }
    const route = routes[url];
    if (route === undefined) return new Response('missing', { status: 404 });
    return Response.json(route);
  }) as RuntimeFetch;
}

test('maps grouped buckets to five-hour-then-weekly items with localized labels', async () => {
  const snapshot = await readGoogleAntigravityQuota(context(), quotaResponder({ [DAILY]: summaryPayload }));

  expect(snapshot.items).toEqual([
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
  expect(snapshot.items).toEqual([
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b/packages/plugins/google-antigravity
bun test ./src/quota/quota.test.ts
```

Expected: FAIL — `Cannot find module './quota'`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/plugins/google-antigravity/src/quota/quota.ts`:

```ts
import type {
  AccountContext,
  LocalizedText,
  OAuthQuotaItem,
  OAuthQuotaSnapshot,
  RuntimeFetch,
} from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { ANTIGRAVITY_CLI_USER_AGENT } from '../oauth/constants';
import { currentGoogleCredential } from '../oauth/refresh';
import { antigravityEndpoints } from '../runtime/endpoints';
import type { GoogleAntigravityAccountOptions, GoogleAntigravityCredential } from '../schema';

const QUOTA_PATH = '/v1internal:retrieveUserQuotaSummary';
const QUOTA_ENDPOINT_TIMEOUT_MS = 10_000;

const FIVE_HOUR_WINDOWS = new Set(['5h', 'five-hour', 'five_hour']);
const WEEKLY_WINDOWS = new Set(['weekly', 'week']);

const FIVE_HOUR_LABEL: LocalizedText = { default: '5-hour limit', 'zh-Hans': '5 小时额度' };
const WEEKLY_LABEL: LocalizedText = { default: 'Weekly limit', 'zh-Hans': '周额度' };

export async function readGoogleAntigravityQuota(
  context: AccountContext<GoogleAntigravityCredential, GoogleAntigravityAccountOptions>,
  fetcher: RuntimeFetch = context.fetch ?? globalThis.fetch,
): Promise<OAuthQuotaSnapshot> {
  const credential = await currentGoogleCredential(context.credentials, {
    fetch: fetcher,
    signal: context.signal,
  });
  const headers = {
    Authorization: `Bearer ${credential.value.accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': ANTIGRAVITY_CLI_USER_AGENT,
  };
  const body = JSON.stringify({ project: credential.value.projectId });
  const endpoints = antigravityEndpoints(context.options, 'quota');

  let lastError: Error | undefined;
  for (const endpoint of endpoints) {
    context.signal.throwIfAborted();
    try {
      return { items: await readSummary(fetcher, `${endpoint}${QUOTA_PATH}`, headers, body, context.signal) };
    } catch (error) {
      context.signal.throwIfAborted();
      lastError = error instanceof Error ? error : new Error('Antigravity quota request failed');
    }
  }
  throw lastError ?? new Error('Antigravity quota request failed');
}

async function readSummary(
  fetcher: RuntimeFetch,
  url: string,
  headers: Readonly<Record<string, string>>,
  body: string,
  signal: AbortSignal,
): Promise<readonly OAuthQuotaItem[]> {
  const response = await fetcher(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(QUOTA_ENDPOINT_TIMEOUT_MS)]),
    aioProxy: { traffic: 'control' },
  });
  if (!response.ok) throw new Error(`Antigravity quota request failed with ${response.status}`);
  const payload: unknown = await response.json();
  if (!isPlainObject(payload)) throw new Error('Antigravity quota response is invalid');
  const items = dedupeItemIds(groupItems(Reflect.get(payload, 'groups')));
  if (items.length === 0) throw new Error('Antigravity quota response contains no usable buckets');
  return items;
}

/** `groups[]` in payload order; one malformed group must not discard its siblings. */
function groupItems(value: unknown): readonly OAuthQuotaItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((group, groupIndex): OAuthQuotaItem[] => {
    if (!isPlainObject(group)) return [];
    const label = nonEmpty(Reflect.get(group, 'displayName') ?? Reflect.get(group, 'display_name'));
    const slug = slugify(label ?? '') || `group-${groupIndex + 1}`;
    const buckets = Reflect.get(group, 'buckets');
    if (!Array.isArray(buckets)) return [];
    return buckets
      .flatMap((bucket, bucketIndex): OAuthQuotaItem[] => {
        const item = bucketItem(bucket, slug, label, bucketIndex);
        return item === undefined ? [] : [item];
      })
      .sort((left, right) => windowOrder(left.id, slug) - windowOrder(right.id, slug));
  });
}

function bucketItem(
  value: unknown,
  groupSlug: string,
  groupLabel: string | undefined,
  index: number,
): OAuthQuotaItem | undefined {
  if (!isPlainObject(value)) return undefined;
  // A row with no fraction renders as an empty ring, which reads as "nothing left". Drop it.
  const fraction = quotaFraction(Reflect.get(value, 'remainingFraction') ?? Reflect.get(value, 'remaining_fraction'));
  if (fraction === undefined) return undefined;
  const window = nonEmpty(Reflect.get(value, 'window'))?.toLowerCase();
  const bucketSlug =
    windowSlug(window) ??
    slugify(nonEmpty(Reflect.get(value, 'bucketId') ?? Reflect.get(value, 'bucket_id')) ?? '');
  const id = `${groupSlug}-${bucketSlug === '' ? `bucket-${index + 1}` : bucketSlug}`;
  const upstreamLabel = nonEmpty(Reflect.get(value, 'displayName') ?? Reflect.get(value, 'display_name'));
  // An unrecognized window with no upstream label has no name to render at all; drop it.
  const label = windowLabel(window, upstreamLabel);
  if (label === undefined) return undefined;
  const resetsAt = timestamp(Reflect.get(value, 'resetTime') ?? Reflect.get(value, 'reset_time'));
  return {
    id,
    displayName: groupLabel === undefined ? label : prefixed(groupLabel, label),
    remainingRatio: Math.min(1, Math.max(0, fraction)),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/** The two known windows get a translated label; anything else keeps the upstream string. */
function windowLabel(window: string | undefined, upstreamLabel: string | undefined): LocalizedText | undefined {
  const slug = windowSlug(window);
  if (slug === '5h') return FIVE_HOUR_LABEL;
  if (slug === 'weekly') return WEEKLY_LABEL;
  return upstreamLabel === undefined ? undefined : { default: upstreamLabel };
}

/** Canonical slug for the two windows Antigravity actually reports, in either spelling. */
function windowSlug(window: string | undefined): '5h' | 'weekly' | undefined {
  if (window === undefined) return undefined;
  if (FIVE_HOUR_WINDOWS.has(window)) return '5h';
  return WEEKLY_WINDOWS.has(window) ? 'weekly' : undefined;
}

/** Five-hour first, weekly next, unrecognized windows last in payload order (sort is stable). */
function windowOrder(id: string, groupSlug: string): number {
  if (id === `${groupSlug}-5h`) return 0;
  if (id === `${groupSlug}-weekly`) return 1;
  return 2;
}

function prefixed(prefix: string, label: LocalizedText): LocalizedText {
  const values = typeof label === 'string' ? { default: label } : label;
  return Object.fromEntries(
    Object.entries(values).map(([locale, text]) => [locale, `${prefix} · ${text}`]),
  ) as LocalizedText;
}

// The core validator rejects duplicate item ids outright, which would blank the whole card. Two
// buckets naming the same window in one group must both survive, so a suffix beats a throw.
function dedupeItemIds(items: readonly OAuthQuotaItem[]): readonly OAuthQuotaItem[] {
  const taken = new Set<string>();
  return items.map((item) => {
    if (!taken.has(item.id)) {
      taken.add(item.id);
      return item;
    }
    let count = 2;
    while (taken.has(`${item.id}-${count}`)) count += 1;
    const id = `${item.id}-${count}`;
    taken.add(id);
    return { ...item, id };
  });
}

/** `remaining_fraction` is 0..1, but some payloads spell it as a `"55%"` string. */
function quotaFraction(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const text = nonEmpty(value);
  if (text === undefined) return undefined;
  const parsed = Number(text.endsWith('%') ? text.slice(0, -1) : text);
  if (!Number.isFinite(parsed)) return undefined;
  return text.endsWith('%') ? parsed / 100 : parsed;
}

/** `resetTime` is ISO-8601; tolerate over-precise fractional seconds some payloads emit. */
function timestamp(value: unknown): number | undefined {
  const text = nonEmpty(value);
  if (text === undefined) return undefined;
  const parsed = Date.parse(text.replace(/(\.\d{6})\d+/u, '$1'));
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '');
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
```

Create `packages/plugins/google-antigravity/src/quota/index.ts`:

```ts
export { readGoogleAntigravityQuota } from './quota';
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b/packages/plugins/google-antigravity
bun test ./src/quota/quota.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Verify the snapshot survives the core validator**

The reader's whole reason to exist is a snapshot `validateOAuthQuotaSnapshot` accepts, so prove it once against the real validator rather than trusting the shape by eye. Append to `quota.test.ts`:

```ts
import { validateOAuthQuotaSnapshot } from '@aio-proxy/core/plugins/quota';

test('produces a snapshot the core quota validator accepts', async () => {
  const snapshot = await readGoogleAntigravityQuota(context(), quotaResponder({ [DAILY]: summaryPayload }));
  expect(validateOAuthQuotaSnapshot(snapshot)).toEqual(snapshot);
});
```

If `@aio-proxy/core` is not a dependency of this plugin, **do not add it** — a plugin must not depend on core. Instead delete that import and inline the invariants the validator enforces:

```ts
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
```

Check first:

```bash
grep -n '"@aio-proxy/core"' /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b/packages/plugins/google-antigravity/package.json
```

No output means core is not a dependency — use the inlined variant.

- [ ] **Step 6: Re-run the tests**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b/packages/plugins/google-antigravity
bun test ./src/quota/quota.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 7: Commit**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b
git add packages/plugins/google-antigravity/src/quota
git commit -m "feat(google-antigravity): read grouped OAuth quota buckets"
```

---

### Task 3: Best-effort subscription plan enrichment

**Files:**
- Modify: `packages/plugins/google-antigravity/src/quota/quota.ts`
- Modify: `packages/plugins/google-antigravity/src/quota/quota.test.ts`

**Interfaces:**
- Consumes: `readGoogleAntigravityQuota` and its private helpers from Task 2 (`nonEmpty`, `isPlainObject` usage, the `headers` / `endpoints` locals).
- Produces: no new export. `readGoogleAntigravityQuota` now returns `plan` when `loadCodeAssist` answers.

- [ ] **Step 1: Write the failing test**

Add to `packages/plugins/google-antigravity/src/quota/quota.test.ts`, next to the existing constants:

```ts
const PLAN_PATH = '/v1internal:loadCodeAssist';
const DAILY_PLAN = `https://daily-cloudcode-pa.googleapis.com${PLAN_PATH}`;
```

and these tests:

```ts
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

test('sends the ideType metadata body to the first quota base only', async () => {
  const seen: string[] = [];
  await readGoogleAntigravityQuota(
    context(),
    quotaResponder({ [SANDBOX]: summaryPayload, [DAILY_PLAN]: { paidTier: { id: 'g1-pro-tier' } } }, seen),
  );
  expect(seen.filter((url) => url.endsWith(PLAN_PATH))).toEqual([DAILY_PLAN]);
});
```

Extend the `quotaResponder` assertion block so the plan request body is checked too — replace the `if (url.endsWith(QUOTA_PATH)) { ... }` block's closing brace with an added branch:

```ts
    if (url.endsWith(PLAN_PATH)) {
      expect(init?.method).toBe('POST');
      expect(headers.get('Authorization')).toBe('Bearer access-token');
      expect(init?.body).toBe(JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }));
    }
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b/packages/plugins/google-antigravity
bun test ./src/quota/quota.test.ts
```

Expected: FAIL — `snapshot.plan` is `undefined` in the first two new tests, and no `loadCodeAssist` request is made.

- [ ] **Step 3: Write the minimal implementation**

In `packages/plugins/google-antigravity/src/quota/quota.ts`, add the constants below `QUOTA_ENDPOINT_TIMEOUT_MS`:

```ts
const PLAN_PATH = '/v1internal:loadCodeAssist';
const PLAN_BODY = JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } });
// The tier read is enrichment, so a slow endpoint must not hold up the quota read.
const PLAN_TIMEOUT_MS = 4_000;

const PLAN_BY_TIER_ID: Readonly<Record<string, LocalizedText>> = {
  'free-tier': { default: 'Free', 'zh-Hans': '免费版' },
  'g1-pro-tier': { default: 'Pro', 'zh-Hans': '专业版' },
  'g1-ultra-tier': { default: 'Ultra', 'zh-Hans': '旗舰版' },
  'g1-ultra-lite-tier': { default: 'Ultra Lite', 'zh-Hans': '轻量旗舰版' },
};
```

Replace the body of `readGoogleAntigravityQuota` after the `endpoints` line with:

```ts
  // Started before the loop so it overlaps the quota request; it resolves rather than rejects, so
  // an early throw from the loop cannot leave an unhandled rejection behind.
  const planRead = readPlan(fetcher, `${endpoints[0] ?? ''}${PLAN_PATH}`, headers, context.signal);

  let lastError: Error | undefined;
  for (const endpoint of endpoints) {
    context.signal.throwIfAborted();
    try {
      const items = await readSummary(fetcher, `${endpoint}${QUOTA_PATH}`, headers, body, context.signal);
      const plan = await planRead;
      return { items, ...(plan === undefined ? {} : { plan }) };
    } catch (error) {
      context.signal.throwIfAborted();
      lastError = error instanceof Error ? error : new Error('Antigravity quota request failed');
    }
  }
  await planRead;
  throw lastError ?? new Error('Antigravity quota request failed');
```

Add the plan reader beside `readSummary`:

```ts
async function readPlan(
  fetcher: RuntimeFetch,
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<LocalizedText | undefined> {
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers,
      body: PLAN_BODY,
      signal: AbortSignal.any([signal, AbortSignal.timeout(PLAN_TIMEOUT_MS)]),
      aioProxy: { traffic: 'control' },
    });
    if (!response.ok) return undefined;
    const payload: unknown = await response.json();
    if (!isPlainObject(payload)) return undefined;
    const paid = tier(Reflect.get(payload, 'paidTier') ?? Reflect.get(payload, 'paid_tier'));
    const current = tier(Reflect.get(payload, 'currentTier') ?? Reflect.get(payload, 'current_tier'));
    // A paid tier only counts once it names an id; an empty paid slot means the free plan applies.
    const effective = paid?.id === undefined ? current : paid;
    if (effective === undefined) return undefined;
    // Google's own `name` is what the user sees in Antigravity, and it stays right for tier ids we
    // have not mapped, so it wins over the built-in label.
    return effective.name ?? (effective.id === undefined ? undefined : (PLAN_BY_TIER_ID[effective.id] ?? effective.id));
  } catch {
    return undefined;
  }
}

function tier(value: unknown): { readonly id?: string; readonly name?: string } | undefined {
  if (!isPlainObject(value)) return undefined;
  const id = nonEmpty(Reflect.get(value, 'id'));
  const name = nonEmpty(Reflect.get(value, 'name'));
  if (id === undefined && name === undefined) return undefined;
  return { ...(id === undefined ? {} : { id }), ...(name === undefined ? {} : { name }) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b/packages/plugins/google-antigravity
bun test ./src/quota/quota.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Check the file size**

```bash
wc -l /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b/packages/plugins/google-antigravity/src/quota/quota.ts
```

Expected: under 250. If it exceeds 400, split the plan read into `quota/plan.ts` (private module, imported only from `quota/quota.ts`, never re-exported from `quota/index.ts`) before continuing.

- [ ] **Step 6: Commit**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b
git add packages/plugins/google-antigravity/src/quota
git commit -m "feat(google-antigravity): enrich quota with the subscription tier"
```

---

### Task 4: Wire the quota capability onto the adapter

**Files:**
- Modify: `packages/plugins/google-antigravity/src/plugin.ts`
- Modify: `packages/plugins/google-antigravity/src/plugin.test.ts`

**Interfaces:**
- Consumes: `readGoogleAntigravityQuota` from `./quota/index` (Tasks 2–3).
- Produces: `adapter.quota` is defined, which is the only thing `packages/server/src/plugin-account.ts:119` reads to set `DashboardProviderSummary.hasQuota`.

- [ ] **Step 1: Write the failing test**

Append to `packages/plugins/google-antigravity/src/plugin.test.ts`:

```ts
// `hasQuota` on the dashboard Provider card is derived from `adapter.quota !== undefined`
// (packages/server/src/plugin-account.ts). Without this the quota ring never renders.
test('registers a quota capability with no reset', async () => {
  const adapter = await adapterFrom(googleAntigravityPlugin);
  expect(adapter.quota?.read).toBeFunction();
  expect(adapter.quota?.reset).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b/packages/plugins/google-antigravity
bun test ./src/plugin.test.ts
```

Expected: FAIL — `expect(undefined).toBeFunction()`.

- [ ] **Step 3: Write the minimal implementation**

In `packages/plugins/google-antigravity/src/plugin.ts`, add the import after the existing `./oauth/userinfo` import:

```ts
import { readGoogleAntigravityQuota } from './quota/index';
```

and add the capability to the adapter object, directly after the `createRuntime` property:

```ts
    quota: {
      read: async (context) =>
        await readGoogleAntigravityQuota(context, dependencies.fetch ?? context.fetch ?? globalThis.fetch),
    },
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b/packages/plugins/google-antigravity
bun test ./src/plugin.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the whole plugin's tests**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b/packages/plugins/google-antigravity
bun run test:unit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b
git add packages/plugins/google-antigravity/src/plugin.ts packages/plugins/google-antigravity/src/plugin.test.ts
git commit -m "feat(google-antigravity): expose the OAuth quota capability"
```

---

### Task 5: Changeset and preflight

**Files:**
- Create: `.changeset/google-antigravity-quota.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the release note. Nothing depends on it.

- [ ] **Step 1: Confirm the exact package name**

```bash
grep -n '"name"' /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b/packages/plugins/google-antigravity/package.json
```

Expected: `"name": "@aio-proxy/plugin-google-antigravity"`. Use whatever this prints — a mistyped key makes `changeset version` fail.

- [ ] **Step 2: Write the changeset**

Create `.changeset/google-antigravity-quota.md`:

```md
---
'@aio-proxy/plugin-google-antigravity': minor
'aio-proxy': minor
---

google-antigravity: report account quota on the Provider card. The plugin now reads Antigravity's grouped five-hour and weekly limits, along with the subscription tier, so the dashboard renders a quota ring for Antigravity accounts.
```

Both keys are required. A changeset naming only the plugin still bumps `aio-proxy` through the `fixed` group, but its CHANGELOG entry would be empty and `scripts/release.ts` skips the GitHub Release, so the note would silently vanish.

- [ ] **Step 3: Build first if sibling `dist/` output is stale**

`preflight` type-checks against sibling packages' built `dist/`. If this worktree has never been built, or `packages/plugin-sdk/dist` predates the current `src`, run:

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b
bun run build
```

Skip it if `bun run check` already passes.

- [ ] **Step 4: Run preflight**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b
bun run preflight
```

Expected: PASS (oxlint + oxfmt check + all unit tests).

Known pre-existing flake: `packages/core/src/plugins/config-file/lock-identity.recovery.test.ts` can fail under full parallel load. If that is the only failure, re-run just that file to confirm it is the flake and not a regression:

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b/packages/core
bun test ./src/plugins/config-file/lock-identity.recovery.test.ts
```

If oxfmt reports formatting diffs, apply them:

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b
bun run format
```

- [ ] **Step 5: Commit**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/laughing-yonath-9fe10b
git add .changeset/google-antigravity-quota.md
git commit -m "chore: changeset for google-antigravity quota reporting"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: base URLs and `baseURL` interaction plus the CLI UA → Task 1; the request shape, response mapping, item ids with `dedupeItemIds`, `LocalizedText` display names with `zh-Hans`, item ordering, dropped buckets, the all-100% decision, and quota-read failure semantics → Task 2; the plan request, tier mapping, `name` preference, and enrichment failure semantics with its own timeout → Task 3; the `quota: { read }` wiring that lights up `hasQuota` → Task 4; the changeset → Task 5. `quota.reset` and `resetCredits` are declared out of scope in the Global Constraints and asserted absent in Task 4's test. Validator compliance is asserted in Task 2 Step 5. Every "Testing" bullet in the spec has a matching test in Task 2 or Task 3 except the `adapter.quota` bullet, which is Task 4.

**Placeholder scan.** No TBD/TODO. Every code step carries complete, runnable code. No "similar to Task N". Task 2 Step 5 offers two concrete variants with a `grep` to decide between them rather than leaving the choice open.

**Type consistency.** `readGoogleAntigravityQuota(context, fetcher?)` is named identically in Tasks 2, 3, and 4 and re-exported unchanged from `quota/index.ts`. `antigravityEndpoints(options, 'quota')` matches Task 1's signature. `currentGoogleCredential` returns a `CredentialSnapshot`, so Task 2 reads `credential.value.accessToken` / `credential.value.projectId`, matching `catalog/discover.ts`. `PLAN_BY_TIER_ID` values are `LocalizedText`, matching `OAuthQuotaSnapshot.plan`. `windowOrder(id, groupSlug)` is called with the ids `bucketItem` actually produces.
