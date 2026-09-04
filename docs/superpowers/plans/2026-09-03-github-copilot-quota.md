# GitHub Copilot OAuth Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `github-copilot` plugin an `OAuthAdapter.quota.read` that reports Copilot premium/chat allowances so the Provider card renders its quota ring.

**Architecture:** One new module, `src/github-api/quota.ts`, reads `GET <apiBase>/copilot_internal/user` with the stored `githubToken`, maps every usable `quota_snapshots` entry (plus a `monthly_quotas` / `limited_user_quotas` fallback) into `OAuthQuotaItem`s, and is wired onto the adapter as `quota: { read }`. No server, core, or dashboard change: `hasQuota` derives from the capability existing.

**Tech Stack:** TypeScript, Bun test, Zod 4, `es-toolkit/predicate`, Changesets.

**Spec:** [docs/superpowers/specs/2026-09-03-github-copilot-quota-design.md](../specs/2026-09-03-github-copilot-quota-design.md)

## Global Constraints

- Package under change is `@aio-proxy/plugin-github-copilot` (`packages/plugins/github-copilot`). It depends only on `@aio-proxy/plugin-sdk` and `es-toolkit`; do not add a dependency.
- The snapshot must survive `validateOAuthQuotaSnapshot` (`packages/core/src/plugins/quota.ts`): no duplicate item ids, no unknown keys, `remainingRatio` within `0..1`, `resetsAt` a safe integer, `plan` a trimmed non-empty string.
- Never emit an item without `remainingRatio` — the dashboard filters those out entirely (`applicableQuotaItems`).
- An account with no metered window is a **successful** read returning `{ items: [] }`, not a throw.
- Every upstream call carries `aioProxy: { traffic: 'control' }`.
- `isPlainObject` from `es-toolkit/predicate` for every wire payload branch; per-entry parsing is lossy so one bad entry cannot discard siblings.
- Editor identity strings (`vscode/1.107.0`, `copilot-chat/0.35.0`, `GitHubCopilotChat/0.35.0`) exist once, as constants in `src/github-api/http.ts`. `packages/plugins/github-copilot/src/runtime/host-fetch.test.ts` pins the model-traffic values; do not change them.
- `X-Github-Api-Version: 2025-04-01`; quota auth scheme is `token <githubToken>`, not `Bearer`.
- Enterprise API base is `githubApiBase(credential.enterpriseURL)` (`<enterpriseURL>/api/v3`), read off the credential, not `context.options`.
- No `quota.reset`. No github.com billing-budget scraping.
- Colocated tests, flat inside `src/github-api/` beside their module — the layout `credential.ts` / `credential.test.ts` already uses.
- Non-test implementation files stay under 500 lines.
- One commit per task. Do not commit anything outside the listed files.

---

## File Structure

- Modify: `packages/plugins/github-copilot/src/github-api/http.ts` — extract the editor identity into constants; add `githubUserHeaders` (the `token`-scheme + `X-Github-Api-Version` builder for GitHub REST reads).
- Create: `packages/plugins/github-copilot/src/github-api/http.test.ts` — pins the one-editor-identity invariant and the `token` scheme.
- Modify: `packages/plugins/github-copilot/src/schema.ts` — add `copilotUserResponseSchema`, a permissive object schema so `fetchJson` keeps producing the plugin's standard error string.
- Create: `packages/plugins/github-copilot/src/github-api/quota.ts` — `readGitHubCopilotQuota`, the wire mapping, and its private helpers. Single responsibility: turn one `copilot_internal/user` response into an `OAuthQuotaSnapshot`.
- Create: `packages/plugins/github-copilot/src/github-api/quota.test.ts`
- Modify: `packages/plugins/github-copilot/src/github-api/index.ts` — export `readGitHubCopilotQuota` (exports only, no logic).
- Modify: `packages/plugins/github-copilot/src/plugin.ts` — `quota: { read: ... }` on the adapter.
- Modify: `packages/plugins/github-copilot/src/plugin.test.ts` — end-to-end capability test.
- Create: `.changeset/github-copilot-quota.md`

---

### Task 1: One editor identity, plus the GitHub REST header builder

**Files:**
- Modify: `packages/plugins/github-copilot/src/github-api/http.ts`
- Create: `packages/plugins/github-copilot/src/github-api/http.test.ts`

**Interfaces:**
- Produces: `githubUserHeaders(githubToken: string): HeadersInit` — `accept`, `authorization: token <githubToken>`, the three editor headers, and `X-Github-Api-Version`.
- Existing `copilotHeaders(token: string): HeadersInit` and `authHeaders(token: string): HeadersInit` keep their current output byte-for-byte.

- [ ] **Step 1: Write the failing test**

Create `packages/plugins/github-copilot/src/github-api/http.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { copilotHeaders, githubUserHeaders } from './http';

describe('GitHub Copilot HTTP headers', () => {
  // GitHub REST reads authenticate with the long-lived GitHub OAuth token under the `token`
  // scheme; the Copilot API takes the short-lived Copilot token as a `Bearer`. Swapping either
  // is a 401 that only shows up against the real upstream.
  test('authenticates GitHub REST reads with the token scheme', () => {
    const headers = new Headers(githubUserHeaders('github-token'));

    expect(headers.get('authorization')).toBe('token github-token');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('x-github-api-version')).toBe('2025-04-01');
  });

  // Both builders impersonate the same editor. Bumping one and not the other makes the two halves
  // of this plugin claim different clients, which upstream is entitled to treat differently.
  test('presents one editor identity across both header builders', () => {
    const rest = new Headers(githubUserHeaders('github-token'));
    const copilot = new Headers(copilotHeaders('copilot-token'));

    for (const key of ['editor-version', 'editor-plugin-version', 'user-agent']) {
      expect(rest.get(key)).toBe(copilot.get(key));
    }
    expect(copilot.get('editor-version')).toBe('vscode/1.107.0');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/plugins/github-copilot && bun test --preload=./test/setup.ts ./src/github-api/http.test.ts`
Expected: FAIL — `githubUserHeaders` is not exported from `./http`.

- [ ] **Step 3: Write the implementation**

Replace the body of `packages/plugins/github-copilot/src/github-api/http.ts` below `fetchJson` with:

```ts
// One editor identity for the whole plugin. `runtime/host-fetch.test.ts` pins these on the model
// path, so a bump has to move both builders together.
const EDITOR_VERSION = 'vscode/1.107.0';
const EDITOR_PLUGIN_VERSION = 'copilot-chat/0.35.0';
const EDITOR_USER_AGENT = 'GitHubCopilotChat/0.35.0';
const GITHUB_API_VERSION = '2025-04-01';

export function copilotHeaders(token: string): HeadersInit {
  return {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'Copilot-Integration-Id': 'vscode-chat',
    'Editor-Plugin-Version': EDITOR_PLUGIN_VERSION,
    'Editor-Version': EDITOR_VERSION,
    'User-Agent': EDITOR_USER_AGENT,
  };
}

/** GitHub REST (`api.github.com`, `<enterprise>/api/v3`) authenticates the GitHub OAuth token as `token`. */
export function githubUserHeaders(githubToken: string): HeadersInit {
  return {
    accept: 'application/json',
    authorization: `token ${githubToken}`,
    'Editor-Plugin-Version': EDITOR_PLUGIN_VERSION,
    'Editor-Version': EDITOR_VERSION,
    'User-Agent': EDITOR_USER_AGENT,
    'X-Github-Api-Version': GITHUB_API_VERSION,
  };
}

export function authHeaders(token: string): HeadersInit {
  return { accept: 'application/json', authorization: `Bearer ${token}` };
}
```

Leave the `import` line and `fetchJson` at the top of the file untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/plugins/github-copilot && bun test --preload=./test/setup.ts ./src/github-api/http.test.ts ./src/runtime/host-fetch.test.ts`
Expected: PASS — including the pre-existing host-fetch assertions on `vscode/1.107.0`, `copilot-chat/0.35.0`, and `GitHubCopilotChat/0.35.0`.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/github-copilot/src/github-api/http.ts packages/plugins/github-copilot/src/github-api/http.test.ts
git commit -m "refactor(github-copilot): share one editor identity and add GitHub REST headers"
```

---

### Task 2: Quota reader — transport and percent-based mapping

**Files:**
- Modify: `packages/plugins/github-copilot/src/schema.ts`
- Create: `packages/plugins/github-copilot/src/github-api/quota.ts`
- Create: `packages/plugins/github-copilot/src/github-api/quota.test.ts`
- Modify: `packages/plugins/github-copilot/src/github-api/index.ts`

**Interfaces:**
- Consumes: `githubUserHeaders` (Task 1), `fetchJson` and `githubApiBase` (existing), `credentialPort` from `packages/plugins/github-copilot/__tests__/test-support.ts`.
- Produces:
  - `copilotUserResponseSchema` in `src/schema.ts` — parses any JSON object into `Record<string, unknown>`.
  - `readGitHubCopilotQuota(context: AccountContext<GitHubCopilotCredential, GitHubAccountOptions>, fetcher?: RuntimeFetch): Promise<OAuthQuotaSnapshot>`, re-exported from `src/github-api/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/plugins/github-copilot/src/github-api/quota.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import type { AccountContext, RuntimeFetch, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { type GitHubAccountOptions, type GitHubCopilotCredential, readGitHubCopilotQuota } from '.';
import { credentialPort } from '../../__tests__/test-support';

// `expiresAt: 0` on purpose: the quota read wants the long-lived GitHub token, so it must not take
// the credential-refresh path. The stub fetcher below would see the extra token request if it did.
const credential: GitHubCopilotCredential = {
  githubToken: 'github-token',
  copilotToken: 'copilot-token',
  expiresAt: 0,
  baseURL: 'https://api.githubcopilot.com',
};

function context(
  overrides: Partial<GitHubCopilotCredential> = {},
): AccountContext<GitHubCopilotCredential, GitHubAccountOptions> {
  return {
    credentials: credentialPort({ ...credential, ...overrides }).port,
    options: { deploymentType: 'github.com' },
    signal: new AbortController().signal,
  };
}

function usageFetcher(payload: unknown, status = 200) {
  const calls: { readonly url: string; readonly headers: Headers; readonly init: RuntimeRequestInit }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RuntimeRequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), init: init ?? {} });
    return status === 200 ? Response.json(payload) : new Response('denied', { status });
  }) as RuntimeFetch;
  return { fetcher, calls };
}

describe('GitHub Copilot quota', () => {
  test('maps each reported window and the monthly reset date', async () => {
    const { fetcher } = usageFetcher({
      copilot_plan: 'copilot_business',
      quota_reset_date: '2026-10-01',
      quota_snapshots: {
        premium_interactions: { entitlement: 300, remaining: 210, percent_remaining: 70 },
        chat: { entitlement: 100, remaining: 5, percent_remaining: 5 },
      },
    });

    const snapshot = await readGitHubCopilotQuota(context(), fetcher);

    expect(snapshot).toEqual({
      items: [
        {
          id: 'premium_interactions',
          displayName: { default: 'Premium requests', 'zh-Hans': '高级请求' },
          remainingRatio: 0.7,
          resetsAt: Date.parse('2026-10-01'),
        },
        {
          id: 'chat',
          displayName: { default: 'Chat', 'zh-Hans': '聊天' },
          remainingRatio: 0.05,
          resetsAt: Date.parse('2026-10-01'),
        },
      ],
      plan: 'Copilot Business',
    });
  });

  test('reads copilot_internal/user once, as control traffic, with the GitHub OAuth token', async () => {
    const { fetcher, calls } = usageFetcher({ copilot_plan: 'free' });

    await readGitHubCopilotQuota(context(), fetcher);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.github.com/copilot_internal/user');
    expect(calls[0]?.headers.get('authorization')).toBe('token github-token');
    expect(calls[0]?.headers.get('x-github-api-version')).toBe('2025-04-01');
    expect(calls[0]?.init.aioProxy).toEqual({ traffic: 'control' });
  });

  test('reads an Enterprise deployment through the REST base the plugin already uses', async () => {
    const { fetcher, calls } = usageFetcher({ copilot_plan: 'free' });

    await readGitHubCopilotQuota(context({ enterpriseURL: 'https://company.ghe.com' }), fetcher);

    expect(calls[0]?.url).toBe('https://company.ghe.com/api/v3/copilot_internal/user');
  });

  test('fails when the usage request is rejected', async () => {
    const { fetcher } = usageFetcher(undefined, 401);

    await expect(readGitHubCopilotQuota(context(), fetcher)).rejects.toThrow(
      'GitHub Copilot request failed (401)',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/plugins/github-copilot && bun test --preload=./test/setup.ts ./src/github-api/quota.test.ts`
Expected: FAIL — `readGitHubCopilotQuota` is not exported from `.`.

- [ ] **Step 3: Write the implementation**

Append to `packages/plugins/github-copilot/src/schema.ts`:

```ts
// `copilot_internal/user` is read key by key with lossy per-entry parsing, so the schema's only job
// is to reject a non-object body and keep `fetchJson`'s standard failure message.
export const copilotUserResponseSchema = zod.record(zod.string(), zod.unknown());
```

Create `packages/plugins/github-copilot/src/github-api/quota.ts`:

```ts
import type {
  AccountContext,
  LocalizedText,
  OAuthQuotaItem,
  OAuthQuotaSnapshot,
  RuntimeFetch,
} from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { copilotUserResponseSchema } from '../schema';
import { fetchJson, githubUserHeaders } from './http';
import type { GitHubAccountOptions, GitHubCopilotCredential } from './types';
import { githubApiBase } from './urls';

// A `Map`, not an object literal: a payload key of `constructor` or `__proto__` must not pull a
// function off `Object.prototype` and hand it to the snapshot validator as a display name.
const QUOTA_LABELS = new Map<string, LocalizedText>([
  ['premium_interactions', { default: 'Premium requests', 'zh-Hans': '高级请求' }],
  ['chat', { default: 'Chat', 'zh-Hans': '聊天' }],
  ['completions', { default: 'Code completions', 'zh-Hans': '代码补全' }],
]);

export async function readGitHubCopilotQuota(
  context: AccountContext<GitHubCopilotCredential, GitHubAccountOptions>,
  fetcher: RuntimeFetch = context.fetch ?? globalThis.fetch,
): Promise<OAuthQuotaSnapshot> {
  // Read the credential directly rather than through `currentGitHubCopilotCredential`: this endpoint
  // authenticates the long-lived GitHub token, so refreshing the Copilot token would be a wasted
  // round trip on every poll.
  const { value: credential } = await context.credentials.read();
  const payload = await fetchJson(
    `${githubApiBase(credential.enterpriseURL)}/copilot_internal/user`,
    {
      headers: githubUserHeaders(credential.githubToken),
      signal: context.signal,
      aioProxy: { traffic: 'control' },
    },
    copilotUserResponseSchema,
    fetcher,
  );
  context.signal.throwIfAborted();

  // GitHub reports one account-wide monthly boundary, not a per-window reset, so every item shares it.
  const resetsAt = timestamp(Reflect.get(payload, 'quota_reset_date'));
  const items = snapshotItems(payload, resetsAt);
  const plan = planText(Reflect.get(payload, 'copilot_plan'));
  // An all-unlimited or token-billed seat legitimately meters nothing. That is an empty snapshot, not
  // a failure: throwing would paint the "load failed" ring over a read that worked.
  return { items, ...(plan === undefined ? {} : { plan }) };
}

function snapshotItems(
  payload: Readonly<Record<string, unknown>>,
  resetsAt: number | undefined,
): readonly OAuthQuotaItem[] {
  const snapshots = Reflect.get(payload, 'quota_snapshots');
  if (!isPlainObject(snapshots)) return [];
  return Object.keys(snapshots).flatMap((key): OAuthQuotaItem[] => {
    const id = key.trim();
    const value = Reflect.get(snapshots, key);
    if (id === '' || !isPlainObject(value)) return [];
    const percent = number(Reflect.get(value, 'percent_remaining'));
    return percent === undefined ? [] : [quotaItem(id, clampRatio(percent / 100), resetsAt)];
  });
}

function quotaItem(id: string, remainingRatio: number, resetsAt: number | undefined): OAuthQuotaItem {
  return {
    id,
    displayName: QUOTA_LABELS.get(id) ?? titleCase(id) ?? id,
    remainingRatio,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/** `copilot_plan` is an upstream enum (`copilot_business`, `free`); `unknown` is its "no answer". */
function planText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const plan = value.trim();
  if (plan === '' || plan.toLowerCase() === 'unknown') return undefined;
  return titleCase(plan);
}

// `LocalizedTextSchema` rejects empty and untrimmed strings, and a rejected label or plan fails the
// whole otherwise-valid snapshot, so a title-case that collapses to nothing returns undefined.
function titleCase(value: string): string | undefined {
  const text = value
    .split(/[\s_-]+/u)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return text === '' ? undefined : text;
}

function number(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampRatio(ratio: number): number {
  return Math.min(Math.max(ratio, 0), 1);
}

/** `quota_reset_date` is ISO-8601 or a bare `yyyy-mm-dd`; both go through `Date.parse`. */
function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Date.parse(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
```

Add to `packages/plugins/github-copilot/src/github-api/index.ts`, between the `./login` and `./types` lines so the file stays alphabetical and exports-only:

```ts
export { readGitHubCopilotQuota } from './quota';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/plugins/github-copilot && bun test --preload=./test/setup.ts ./src/github-api/quota.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/github-copilot/src/schema.ts packages/plugins/github-copilot/src/github-api/quota.ts packages/plugins/github-copilot/src/github-api/quota.test.ts packages/plugins/github-copilot/src/github-api/index.ts
git commit -m "feat(github-copilot): read Copilot quota snapshots"
```

---

### Task 3: Unlimited seats, derived ratios, unfamiliar keys, and the counter fallback

**Files:**
- Modify: `packages/plugins/github-copilot/src/github-api/quota.ts`
- Modify: `packages/plugins/github-copilot/src/github-api/quota.test.ts`

**Interfaces:**
- Consumes: everything Task 2 produced. `readGitHubCopilotQuota`'s signature does not change.
- Produces: no new exports. Behavior only.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('GitHub Copilot quota', ...)` block in `packages/plugins/github-copilot/src/github-api/quota.test.ts`:

```ts
  // An unlimited allowance has no denominator, and GitHub's zero/zero placeholder for token-based
  // billing is sometimes served as `percent_remaining: 100`. Showing either as a full bar would tell
  // the user a seat is healthy when it is simply not metered.
  test('reports an unmetered seat as a successful empty snapshot', async () => {
    const { fetcher } = usageFetcher({
      copilot_plan: 'free',
      quota_snapshots: {
        premium_interactions: { unlimited: true, percent_remaining: 100 },
        chat: { entitlement: 0, remaining: 0, percent_remaining: 100 },
      },
    });

    const snapshot = await readGitHubCopilotQuota(context(), fetcher);

    expect(snapshot).toEqual({ items: [], plan: 'Free' });
  });

  test('derives a missing percentage and clamps an over-quota window to empty', async () => {
    const { fetcher } = usageFetcher({
      quota_snapshots: {
        premium_interactions: { percent_remaining: -20 },
        chat: { entitlement: 200, remaining: 50 },
      },
    });

    const snapshot = await readGitHubCopilotQuota(context(), fetcher);

    expect(snapshot.items.map((item) => [item.id, item.remainingRatio])).toEqual([
      ['premium_interactions', 0],
      ['chat', 0.25],
    ]);
  });

  test('keeps an unfamiliar window when a sibling entry is malformed', async () => {
    const { fetcher } = usageFetcher({
      copilot_plan: 'unknown',
      quota_snapshots: { spark_premium_request: { percent_remaining: 40 }, chat: 'nope' },
    });

    const snapshot = await readGitHubCopilotQuota(context(), fetcher);

    expect(snapshot.items).toEqual([
      { id: 'spark_premium_request', displayName: 'Spark Premium Request', remainingRatio: 0.4 },
    ]);
    // `unknown` is GitHub's "no answer", not a tier. Showing it would put a literal "Unknown" under
    // the Provider name.
    expect(snapshot.plan).toBeUndefined();
  });

  // Free and older seats answer with counters instead of snapshots. A duplicate id would make the
  // core validator reject the whole snapshot, so `chat` must not come back twice.
  test('falls back to the monthly counters for windows the snapshots do not cover', async () => {
    const { fetcher } = usageFetcher({
      quota_snapshots: { chat: { percent_remaining: 25 } },
      monthly_quotas: { chat: 50, completions: 2000 },
      limited_user_quotas: { chat: 20, completions: 500 },
    });

    const snapshot = await readGitHubCopilotQuota(context(), fetcher);

    expect(snapshot.items).toEqual([
      { id: 'chat', displayName: { default: 'Chat', 'zh-Hans': '聊天' }, remainingRatio: 0.25 },
      {
        id: 'completions',
        displayName: { default: 'Code completions', 'zh-Hans': '代码补全' },
        remainingRatio: 0.25,
      },
    ]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/plugins/github-copilot && bun test --preload=./test/setup.ts ./src/github-api/quota.test.ts`
Expected: FAIL on all four new tests — the unmetered seat yields two items, the derived window is missing, and the counter fallback yields nothing.

- [ ] **Step 3: Write the implementation**

In `packages/plugins/github-copilot/src/github-api/quota.ts`, replace the `const items = snapshotItems(payload, resetsAt);` line in `readGitHubCopilotQuota` with:

```ts
  const snapshots = snapshotItems(payload, resetsAt);
  const items = [...snapshots, ...counterItems(payload, resetsAt, new Set(snapshots.map(({ id }) => id)))];
```

Replace the whole `snapshotItems` function with:

```ts
function snapshotItems(
  payload: Readonly<Record<string, unknown>>,
  resetsAt: number | undefined,
): readonly OAuthQuotaItem[] {
  const snapshots = Reflect.get(payload, 'quota_snapshots');
  if (!isPlainObject(snapshots)) return [];
  return Object.keys(snapshots).flatMap((key): OAuthQuotaItem[] => {
    const id = key.trim();
    const value = Reflect.get(snapshots, key);
    if (id === '' || !isPlainObject(value)) return [];
    const ratio = snapshotRatio(value);
    return ratio === undefined ? [] : [quotaItem(id, ratio, resetsAt)];
  });
}

function snapshotRatio(snapshot: Readonly<Record<string, unknown>>): number | undefined {
  if (Reflect.get(snapshot, 'unlimited') === true) return undefined;
  const entitlement = number(Reflect.get(snapshot, 'entitlement'));
  const remaining = number(Reflect.get(snapshot, 'remaining'));
  // GitHub serves an explicit zero/zero for token-based billing and Business seats, sometimes with
  // `percent_remaining: 100`. Check it before the percentage or the bar reads as a full allowance.
  if (entitlement === 0 && remaining === 0) return undefined;
  const percent = number(Reflect.get(snapshot, 'percent_remaining'));
  if (percent !== undefined) return clampRatio(percent / 100);
  if (entitlement === undefined || entitlement <= 0 || remaining === undefined) return undefined;
  return clampRatio(remaining / entitlement);
}

/**
 * Free and older seats answer with counters instead of snapshots: `monthly_quotas` is the allowance
 * and `limited_user_quotas` is what is left. Ids `quota_snapshots` already produced are skipped — a
 * duplicate id makes the core validator reject the whole snapshot, valid windows included.
 */
function counterItems(
  payload: Readonly<Record<string, unknown>>,
  resetsAt: number | undefined,
  taken: ReadonlySet<string>,
): readonly OAuthQuotaItem[] {
  const monthly = Reflect.get(payload, 'monthly_quotas');
  const limited = Reflect.get(payload, 'limited_user_quotas');
  if (!isPlainObject(monthly) || !isPlainObject(limited)) return [];
  return Object.keys(monthly).flatMap((key): OAuthQuotaItem[] => {
    const id = key.trim();
    if (id === '' || taken.has(id)) return [];
    const entitlement = number(Reflect.get(monthly, key));
    const remaining = number(Reflect.get(limited, key));
    if (entitlement === undefined || entitlement <= 0 || remaining === undefined) return [];
    return [quotaItem(id, clampRatio(remaining / entitlement), resetsAt)];
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/plugins/github-copilot && bun test --preload=./test/setup.ts ./src/github-api/quota.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/github-copilot/src/github-api/quota.ts packages/plugins/github-copilot/src/github-api/quota.test.ts
git commit -m "feat(github-copilot): handle unmetered seats and counter-only quota payloads"
```

---

### Task 4: Wire the capability onto the adapter

**Files:**
- Modify: `packages/plugins/github-copilot/src/plugin.ts`
- Modify: `packages/plugins/github-copilot/src/plugin.test.ts`

**Interfaces:**
- Consumes: `readGitHubCopilotQuota` from `./github-api`.
- Produces: `adapter.quota = { read }`. The server reads `adapter.quota !== undefined` at `packages/server/src/plugin-account.ts:119` to set `DashboardProviderSummary.hasQuota`; nothing else is needed to render the ring.

- [ ] **Step 1: Write the failing test**

In `packages/plugins/github-copilot/src/plugin.test.ts`, extend the existing import of `@aio-proxy/plugin-sdk` types and the test-support import:

```ts
import type { OAuthAdapter, PluginDescriptor, RuntimeFetch, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';
```

```ts
import { credentialPort, deviceFlowFetch, loginContext, withFetchMock } from '../__tests__/test-support';
```

Then add this test inside the existing `describe('GitHub Copilot plugin', ...)` block, immediately before the closing `});`:

```ts
  test('reads quota through the host fetch and offers no reset', async () => {
    const adapter = await adapterFrom(githubCopilotPlugin);
    const quota = adapter.quota;
    if (quota === undefined) throw new Error('missing GitHub Copilot quota capability');
    const requests: RuntimeRequestInit[] = [];

    // No `withFetchMock` here on purpose: the capability has to reach upstream through the injected
    // host fetch, which is what tags the call as control traffic and applies the Provider's proxy.
    const snapshot = await quota.read({
      credentials: credentialPort({
        githubToken: 'github-token',
        copilotToken: 'copilot-token',
        expiresAt: 0,
        baseURL: 'https://api.githubcopilot.com',
      }).port,
      options: { deploymentType: 'github.com' },
      signal: new AbortController().signal,
      fetch: (async (_input: RequestInfo | URL, init?: RuntimeRequestInit) => {
        requests.push(init ?? {});
        return Response.json({ copilot_plan: 'pro', quota_snapshots: { chat: { percent_remaining: 40 } } });
      }) as RuntimeFetch,
    });

    expect(quota.reset).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.aioProxy).toEqual({ traffic: 'control' });
    expect(snapshot).toEqual({
      items: [{ id: 'chat', displayName: { default: 'Chat', 'zh-Hans': '聊天' }, remainingRatio: 0.4 }],
      plan: 'Pro',
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/plugins/github-copilot && bun test --preload=./test/setup.ts ./src/plugin.test.ts`
Expected: FAIL with `missing GitHub Copilot quota capability`.

- [ ] **Step 3: Write the implementation**

In `packages/plugins/github-copilot/src/plugin.ts`, add `readGitHubCopilotQuota` to the existing `./github-api` import (the list is alphabetical, so it goes after `normalizeEnterpriseURL`):

```ts
import {
  COPILOT_CATALOG_TTL_MS,
  discoverGitHubCopilotModels,
  type GitHubAccountOptions,
  type GitHubCopilotCredential,
  loginToGitHubCopilot,
  normalizeEnterpriseURL,
  readGitHubCopilotQuota,
} from './github-api';
```

Then add the capability to the adapter object, directly after `createRuntime: createGitHubCopilotRuntime,`:

```ts
    // No `reset`: GitHub has no endpoint that redeems or resets a Copilot allowance.
    quota: { read: (context) => readGitHubCopilotQuota(context) },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/plugins/github-copilot && bun test --preload=./test/setup.ts`
Expected: PASS — the whole plugin package's unit tests.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/github-copilot/src/plugin.ts packages/plugins/github-copilot/src/plugin.test.ts
git commit -m "feat(github-copilot): expose the OAuth quota capability"
```

---

### Task 5: Changeset and preflight

**Files:**
- Create: `.changeset/github-copilot-quota.md`

**Interfaces:**
- Consumes: nothing. Produces: the published release note.

- [ ] **Step 1: Add the changeset**

Create `.changeset/github-copilot-quota.md`. Both packages are required: a changeset naming only the plugin still bumps `aio-proxy` through the `fixed` group, but with an empty CHANGELOG entry, so `scripts/release.ts` skips its GitHub Release and the note disappears.

```md
---
'@aio-proxy/plugin-github-copilot': minor
'aio-proxy': minor
---

github-copilot: report Copilot OAuth quota in the dashboard

The GitHub Copilot OAuth adapter now reads `copilot_internal/user`, so its Provider card shows the quota ring: the premium-request and chat allowances, any other window the account reports, the monthly reset date, and the Copilot plan. Seats with an unlimited or token-billed entitlement report no metered window rather than a misleading full bar.
```

- [ ] **Step 2: Run the full verification**

Run: `bun run preflight` from the repo root (oxlint type-aware, `oxfmt --check`, and every package's tests).

If sibling packages have stale `dist/` output, the type-aware lint pass fails on unresolved workspace imports. Run `bun run build` once first, then re-run `bun run preflight`.

`packages/core/src/plugins/config-file/lock-identity.recovery.test.ts` has a known pre-existing flake under full parallel load. If it is the only failure, re-run that file on its own with `cd packages/core && bun test ./src/plugins/config-file/lock-identity.recovery.test.ts` to confirm it passes in isolation; do not "fix" it as part of this change.

Expected: PASS.

- [ ] **Step 3: Fix any formatting the check flags**

Run: `bun run format` from the repo root, then `bun run format:check` to confirm clean.

- [ ] **Step 4: Commit**

```bash
git add .changeset/github-copilot-quota.md
git commit -m "chore: changeset for GitHub Copilot quota reporting"
```

---

## Spec coverage

| Spec requirement | Task |
| --- | --- |
| `token` auth scheme, `X-Github-Api-Version`, one editor identity | 1 |
| `GET <apiBase>/copilot_internal/user` as control traffic | 2 |
| `githubApiBase()` (`/api/v3`) for Enterprise, read off the credential | 2 |
| No credential refresh on the quota path | 2 |
| Item ids, curated `zh-Hans` labels, title-cased unfamiliar keys | 2, 3 |
| `quota_reset_date` → shared `resetsAt` | 2 |
| `copilot_plan` normalization, `unknown` omitted | 2, 3 |
| Non-2xx and non-object body throw | 2 |
| `unlimited` and zero/zero placeholder omitted | 3 |
| Empty items is a success, not a throw | 3 |
| Ratio derivation and `0..1` clamping | 3 |
| Lossy per-entry parsing | 3 |
| `monthly_quotas` / `limited_user_quotas` fallback, no duplicate ids | 3 |
| `quota: { read }` wired, no `reset` | 4 |
| Changeset targeting both packages | 5 |
