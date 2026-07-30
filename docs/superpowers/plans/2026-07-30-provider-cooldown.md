# Provider Cooldown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an upstream returns `429` with a valid `Retry-After`, cool down that `(providerId, model)` for the indicated window. Cooled candidates are skipped during selection and fall back to the next provider immediately; when every candidate for a model is cooled, return a protocol-native synthesized `429` carrying the shortest remaining `Retry-After`, without hitting upstream. No same-provider request replay is added.

**Architecture:** A new in-memory `ProviderCooldownStore` (backed by `lru-cache` for per-item TTL eviction and a bounded `max`) lives on `ProviderRouteSource` beside `logicalSessionStore`, constructed once per server lifecycle so it survives config reloads. The single candidate loop (`packages/server/src/routes/pipeline/attempt/attempt.ts`) reads the store to skip cooled candidates and, on a `429` result (raw response OR mapped AI-SDK exception carrying `responseHeaders`), writes a cooldown. This mirrors CLIProxyAPI's cooldown model (lazy-expiry skip + all-cooled synthesized 429) and preserves the AGENTS rule that the candidate loop is the only place with fallback logic. It deliberately does NOT replay non-idempotent POSTs against the same provider.

**Tech Stack:** Bun, TypeScript, Zod (config), `lru-cache`, `bun:test`.

## Why cooldown, not same-provider retry

An earlier draft added same-provider retry with backoff. Review (codex `gpt-5.6-sol`) surfaced a BLOCKER: replaying non-idempotent POSTs risks duplicate side effects/double billing; the prior routing contract deliberately did one attempt per provider before fallback (`docs/superpowers/plans/2026-07-21-provider-network-config.md`); and an in-request `Bun.sleep` for `Retry-After` holds the provider lease and ignores client disconnect. Cooldown avoids all of these: it never replays a request, never sleeps in-request, and its benefit is cross-request (one 429 protects later requests from hammering the limited provider). Same-provider retry and 5xx/network cooldown are explicitly OUT OF SCOPE.

## Global Constraints

- Root `AGENTS.md`: `packages/server/src/routes/pipeline/` is the ONLY candidate loop; route files and attempt helpers must not add independent fallback logic. Cooldown read/write is invoked from the loop.
- Provider selection stays model-first, weight-ordered. Cooldown skipping is applied AFTER weight/affinity/response-owner ordering (see Task 6 for that interaction).
- `es-toolkit` before hand-written utilities; narrow imports.
- **`lru-cache` dependency (verified):** `@aio-proxy/server` does NOT currently declare or resolve `lru-cache`; `@aio-proxy/core` declares a literal `"lru-cache": "^11.5.2"`; the root catalog does NOT contain it. Per AGENTS (used by 2+ packages → catalog): add `lru-cache: ^11.5.2` to the root `package.json` `workspaces.catalog`, and change BOTH `packages/core/package.json` and `packages/server/package.json` to `"lru-cache": "catalog:"`. Run `bun install`.
- Non-test implementation files: 300-line hard limit, split at 240.
- Colocated tests next to source (`foo/foo.test.ts`), not `_test/`.
- Cooldown is keyed by `(providerId, model)` because 429 rate limits are per-model/per-key upstream; cooling the whole provider would wrongly suspend its other models.
- Only `429` with a parseable, positive `Retry-After` within the cap creates a cooldown. Everything else (5xx, network errors, other 4xx) keeps today's behavior unchanged.

---

## Cooldown contract (shared by all tasks)

- **Key:** `JSON.stringify([providerId, model])` where `model` is the RESOLVED upstream `candidate.modelId` (not the client alias). NUL-delimited keys are rejected because provider/model IDs accept arbitrary nonempty strings (`packages/types/src/common.ts`, `provider.ts:55`) and could contain `\0`.
- **Write trigger:** a candidate attempt fails with HTTP `429` AND `Retry-After` parses to a finite `ms > 0`. Stored TTL is `min(retryAfterMs, retryAfterCapMs)`. The `429` may come from a raw upstream `Response` (headers intact) OR a thrown AI-SDK `APICallError` whose `responseHeaders` carry `retry-after` (Task 4).
- **Read:** during candidate ordering, any candidate whose `(providerId, modelId)` has remaining cooldown `> 0` is skipped for selection.
- **All-cooled:** if every candidate for the requested model is cooled, return `adapter.errors.rateLimited(retryAfterSeconds)` (Task 3, protocol-native 429 for each adapter) where `retryAfterSeconds = max(1, ceil(minRemainingMs / 1000))` across the skipped candidates. Finalize as a request-level failure (Task 6) — NOT `finalFailure` (which requires a provider/model that was never attempted).
- **Eviction:** `lru-cache` with per-item `ttl` (the cooldown ms), `ttlAutopurge: true` (active removal of expired entries, including orphans left by a config reload that dropped a provider), and a bounded `max` (hard memory ceiling; evicting the oldest cooldown is acceptable). No manual purge, no reload hook.

`ProviderCooldownStore` API (Task 1):
- `cool(providerId: string, model: string, ttlMs: number): void` — no-op when `ttlMs <= 0`.
- `remainingMs(providerId: string, model: string): number` — `0` when not cooled (or expired), else remaining ms via `getRemainingTTL`.

**Advisory-cooldown semantics (accurate, not absolute):** cooldown is best-effort, not a hard guarantee. Two concurrent requests can both read "not cooled" before the first 429 writes; and exceeding `max` active pairs evicts a still-live cooldown, permitting another upstream call. This is acceptable — cooldown reduces, not eliminates, hits on a limited provider.

## Task order

Dependencies require this order (not numeric): **1 → 2 → 3 → 5 → 6 → 4 → 7**. Rationale: the store (1), config+parser (2), and adapter 429 builder (3) are leaves; production wiring (5) and the test harness (6) must land before the loop write (4-ish) and selection tests can reference `source.cooldown`/helpers. Do NOT introduce a temporary per-request store — it defeats cross-request cooldown. Tasks below are numbered by topic; follow the dependency order above.

---

## Task 1: `ProviderCooldownStore`

**Files:**
- Create: `packages/server/src/routes/pipeline/provider-cooldown/index.ts`, `.../provider-cooldown.ts`, `.../provider-cooldown.test.ts`
- Modify: root `package.json` (catalog), `packages/core/package.json`, `packages/server/package.json` (lru-cache → `catalog:`)

**Interfaces:**
- Produces: `class ProviderCooldownStore { cool(providerId, model, ttlMs): void; remainingMs(providerId, model): number }`.

- [ ] **Step 1: Fix the lru-cache dependency declarations**

Add to root `package.json` `workspaces.catalog`: `"lru-cache": "^11.5.2"`. Change `packages/core/package.json` `"lru-cache": "^11.5.2"` → `"lru-cache": "catalog:"`. Add `"lru-cache": "catalog:"` to `packages/server/package.json` dependencies. Run `bun install`.

Verify: `cd packages/server && bun -e "import('lru-cache').then(m => console.log(typeof m.LRUCache))"` → prints `function`.

- [ ] **Step 2: Write the failing test**

`packages/server/src/routes/pipeline/provider-cooldown/provider-cooldown.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { ProviderCooldownStore } from './provider-cooldown';

describe('ProviderCooldownStore', () => {
  test('remainingMs is 0 before any cooldown', () => {
    expect(new ProviderCooldownStore().remainingMs('p', 'm')).toBe(0);
  });

  test('cool sets a positive window keyed by provider and model', () => {
    const store = new ProviderCooldownStore();
    store.cool('p', 'm', 5_000);
    expect(store.remainingMs('p', 'm')).toBeGreaterThan(0);
    expect(store.remainingMs('p', 'm')).toBeLessThanOrEqual(5_000);
    expect(store.remainingMs('p', 'other')).toBe(0);
    expect(store.remainingMs('other', 'm')).toBe(0);
  });

  test('cool ignores non-positive ttl', () => {
    const store = new ProviderCooldownStore();
    store.cool('p', 'm', 0);
    store.cool('p', 'm', -1);
    expect(store.remainingMs('p', 'm')).toBe(0);
  });

  test('an expired cooldown reports 0', async () => {
    const store = new ProviderCooldownStore();
    store.cool('p', 'm', 20);
    await Bun.sleep(40);
    expect(store.remainingMs('p', 'm')).toBe(0);
  });

  test('keys with special characters do not collide', () => {
    const store = new ProviderCooldownStore();
    store.cool('a', 'b\u0000c', 5_000); // model contains NUL
    expect(store.remainingMs('a\u0000b', 'c')).toBe(0); // different (provider, model) must not alias
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd packages/server && bun test src/routes/pipeline/provider-cooldown/provider-cooldown.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement `provider-cooldown.ts`**

```ts
import { LRUCache } from 'lru-cache';

// Cross-request, in-memory cooldown for (provider, model) pairs that returned a
// 429 with a Retry-After. Per-item TTL + ttlAutopurge reclaim expired entries
// (including orphans from a config reload that dropped a provider) without a
// manual sweep; `max` bounds memory. Advisory only: concurrent reads before the
// first write, and eviction past `max`, may still allow an extra upstream call.
const MAX_COOLDOWN_ENTRIES = 1_024;

export class ProviderCooldownStore {
  readonly #cache = new LRUCache<string, true>({ max: MAX_COOLDOWN_ENTRIES, ttlAutopurge: true });

  #key(providerId: string, model: string): string {
    return JSON.stringify([providerId, model]);
  }

  cool(providerId: string, model: string, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.#cache.set(this.#key(providerId, model), true, { ttl: ttlMs });
  }

  remainingMs(providerId: string, model: string): number {
    const key = this.#key(providerId, model);
    return this.#cache.has(key) ? this.#cache.getRemainingTTL(key) : 0;
  }
}
```

`index.ts`: `export { ProviderCooldownStore } from './provider-cooldown';`

- [ ] **Step 5: Run to verify it passes**

Run: `cd packages/server && bun test src/routes/pipeline/provider-cooldown/provider-cooldown.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json packages/core/package.json packages/server/package.json bun.lock packages/server/src/routes/pipeline/provider-cooldown
git commit -m "feat(pipeline): add ProviderCooldownStore backed by lru-cache"
```

---

## Task 2: `server.retry.retryAfterCapMs` config + share `retryAfterMilliseconds`

**Files:**
- Modify: `packages/types/src/config/config.ts:27-44`; Test: `packages/types/src/config/config.test.ts`
- Create: `packages/plugin-sdk/src/http/retry-after/{index,retry-after,retry-after.test}.ts`
- Modify: `packages/plugin-sdk/src/index.ts`; `packages/plugins/google-antigravity/src/runtime/retry-after.ts`; delete its local test.

**Interfaces:**
- Produces: `ServerConfig['retry'] = { retryAfterCapMs: number }`, default `30_000`.
- Produces: `retryAfterMilliseconds(value, now?): number` from `@aio-proxy/plugin-sdk`.

- [ ] **Step 1: Failing config test**

```ts
test('defaults server.retry.retryAfterCapMs', () => {
  expect(ConfigSchema.parse({ server: {}, providers: {} }).server.retry).toEqual({ retryAfterCapMs: 30_000 });
});
test('accepts a custom retryAfterCapMs', () => {
  expect(ConfigSchema.parse({ server: { retry: { retryAfterCapMs: 5_000 } }, providers: {} }).server.retry)
    .toEqual({ retryAfterCapMs: 5_000 });
});
test('rejects out-of-range retryAfterCapMs', () => {
  expect(ConfigSchema.safeParse({ server: { retry: { retryAfterCapMs: -1 } }, providers: {} }).success).toBe(false);
  expect(ConfigSchema.safeParse({ server: { retry: { retryAfterCapMs: 400_000 } }, providers: {} }).success).toBe(false);
});
```

- [ ] **Step 2: Verify RED** — `cd packages/types && bun test src/config/config.test.ts` → FAIL.

- [ ] **Step 3: Add schema**

After `ServerLoggingSchema` (config.ts:32):

```ts
const ServerRetrySchema = z.object({
  retryAfterCapMs: z.number().int().min(0).max(300_000).default(30_000)
    .describe('Upper bound on an honored 429 Retry-After cooldown, in milliseconds.'),
});
```

Add `retry: ServerRetrySchema.prefault({})` to `ServerConfigSchema` after `logging` (line 43). `ServerConfigAuthoringSchema` omits only `host`/`logging`, so `retry` is inherited.

- [ ] **Step 4: Verify GREEN** — `cd packages/types && bun test src/config/config.test.ts` → PASS. Regenerate `packages/types/dist/config.schema.json` if tracked.

- [ ] **Step 5: Promote `retryAfterMilliseconds`**

Copy `packages/plugins/google-antigravity/src/runtime/retry-after.ts` (lines 1-70) verbatim into `packages/plugin-sdk/src/http/retry-after/retry-after.ts`; copy its test to `.../retry-after.test.ts` (import `./retry-after`); `index.ts` re-exports; add `export { retryAfterMilliseconds } from './http/retry-after';` to `packages/plugin-sdk/src/index.ts`.

- [ ] **Step 6: Re-point + verify**

Replace google-antigravity `retry-after.ts` body with `export { retryAfterMilliseconds } from '@aio-proxy/plugin-sdk';`; delete its local test.
Run: `cd packages/plugin-sdk && bun test src/http/retry-after/retry-after.test.ts` → PASS.
Run: `cd packages/plugins/google-antigravity && bun test src/runtime/transport-retry.test.ts src/runtime/transport.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/config packages/plugin-sdk packages/plugins/google-antigravity/src/runtime/retry-after.ts
git rm packages/plugins/google-antigravity/src/runtime/retry-after.test.ts
git commit -m "feat(config): add retryAfterCapMs and share retryAfterMilliseconds"
```

---

## Task 3: `adapter.errors.rateLimited(retryAfterSeconds)` — protocol-native 429

**Rationale:** The all-cooled case (Task 6) needs a 429 in each inbound protocol's native shape. `ProtocolErrorMapper` (`packages/core/src/protocol/adapter.ts:11-20`) has NO 429 member, and the builders (`openAIInvalid`/`anthropicError`/`geminiError`, `errors.ts:195-216`) are private. Passing a fabricated error through `provider()` is non-portable (OpenAI → `upstream_error`; Anthropic/Gemini → `500`). Add an explicit `rateLimited` member with native shapes and a `Retry-After` header.

**Files:**
- Modify: `packages/core/src/protocol/adapter.ts` (`ProtocolErrorMapper` type)
- Modify: `packages/core/src/protocol/errors.ts` (add `rateLimited` to all four mappers; extend `geminiError` code union with `429`)
- Test: `packages/core/src/protocol/errors.test.ts` (or the existing colocated errors test; create if absent)

**Interfaces:**
- Produces: `ProtocolErrorMapper.rateLimited: (retryAfterSeconds: number) => Response` — a 429 with a `Retry-After: <seconds>` header and the protocol-native error body:
  - OpenAI (completions + responses): `{ error: { code: 'rate_limit_exceeded', message, type: 'rate_limit_error' } }`, status 429.
  - Anthropic: `{ type: 'error', error: { type: 'rate_limit_error', message } }`, status 429.
  - Gemini: `{ error: { code: 429, message, status: 'RESOURCE_EXHAUSTED' } }`, status 429.

- [ ] **Step 1: Write failing tests**

For each adapter's `errors.rateLimited(3)`: assert `status === 429`, `headers.get('retry-after') === '3'`, and the native body shape above. Example (OpenAI):

```ts
test('openai rateLimited builds a native 429 with Retry-After', async () => {
  const r = openAIResponsesErrors.rateLimited(3);
  expect(r.status).toBe(429);
  expect(r.headers.get('retry-after')).toBe('3');
  expect(await r.json()).toEqual({ error: { code: 'rate_limit_exceeded', message: expect.any(String), type: 'rate_limit_error' } });
});
```

Repeat for `openAICompletionsErrors`, `anthropicMessagesErrors`, `geminiGenerateContentErrors`.

- [ ] **Step 2: Verify RED** — `cd packages/core && bun test src/protocol/errors.test.ts` → FAIL (no `rateLimited`).

- [ ] **Step 3: Implement**

In `adapter.ts`, add to `ProtocolErrorMapper`: `readonly rateLimited: (retryAfterSeconds: number) => Response;`.

In `errors.ts`:
- Extend `geminiError` code union to include `429`: `code: 400 | 404 | 409 | 413 | 415 | 429 | 499 | 500 | 501 | 503` and its `status` union to include `'RESOURCE_EXHAUSTED'` (already present).
- Add builders and wire into each mapper object:

```ts
function withRetryAfter(response: Response, retryAfterSeconds: number): Response {
  response.headers.set('retry-after', String(Math.max(1, Math.trunc(retryAfterSeconds))));
  return response;
}
function openAIRateLimited(retryAfterSeconds: number): Response {
  return withRetryAfter(
    Response.json({ error: { code: 'rate_limit_exceeded', message: 'All providers for this model are cooling down', type: 'rate_limit_error' } }, { status: 429 }),
    retryAfterSeconds,
  );
}
// anthropicRateLimited → anthropicError-like body with type 'rate_limit_error', status 429
// geminiRateLimited → geminiError(429, 'RESOURCE_EXHAUSTED', message)
```

Add `rateLimited: openAIRateLimited` to `openAICompletionsErrors` and `openAIResponsesErrors`; `rateLimited: anthropicRateLimited` to `anthropicMessagesErrors`; `rateLimited: geminiRateLimited` to `geminiGenerateContentErrors`.

- [ ] **Step 4: Verify GREEN** — `cd packages/core && bun test src/protocol/errors.test.ts` → PASS.

- [ ] **Step 5: Update any exhaustive `ProtocolErrorMapper` conformance**

Run: `cd packages/core && bun run check`. Two known `ProtocolErrorMapper` literals need an explicit `rateLimited` member (else TS errors on the new required field):

1. `packages/core/__tests__/protocol/adapter.test.ts:26` — the mapper literal built there. Add `rateLimited: (s) => { const r = new Response(null, { status: 429 }); r.headers.set('retry-after', String(s)); return r; },`.
2. `packages/server/__tests__/pipeline-helpers/adapter.ts:74-82` — the test-helper adapter's inline `errors` object. `withRetryAfter` is PRIVATE to `errors.ts` and not exported; do NOT reference it. Add inline: `rateLimited: (s) => { const r = errorResponse(429, 'rate_limited', 'cooling down'); r.headers.set('retry-after', String(Math.max(1, Math.trunc(s)))); return r; },` (reuse the file's existing `errorResponse` helper).

Search for any other `ProtocolErrorMapper`/`errors: {` literal the compiler flags and add the same member.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/protocol/adapter.ts packages/core/src/protocol/errors.ts packages/core/src/protocol/errors.test.ts packages/core/__tests__/protocol/adapter.test.ts packages/server/__tests__/pipeline-helpers/adapter.ts
git commit -m "feat(protocol): add adapter.errors.rateLimited native 429 builder"
```

---

## Task 5: Wire `ProviderCooldownStore` into production `ProviderRouteSource`

**Files:**
- Modify: `packages/server/src/runtime.ts:72-80` (add `cooldown` to `ProviderRouteSource`)
- Modify: `packages/server/src/server-state/index.ts:135-165`
- Modify: `packages/server/src/server-state/lifecycle.ts:112-166`

**Interfaces:**
- Produces: `ProviderRouteSource.cooldown: ProviderCooldownStore`, one instance per server lifecycle. Not cleared on reload (cooldown is runtime state independent of the snapshot; reload swaps only snapshot/router — `server-state/index.ts:134`, `lifecycle.ts:71`). `ttlAutopurge` reclaims entries for dropped providers.

- [ ] **Step 1: Add to `ProviderRouteSource`** — in `runtime.ts` add `readonly cooldown: ProviderCooldownStore;`, import from `./routes/pipeline/provider-cooldown`.

- [ ] **Step 2: Construct + thread** — in `server-state/index.ts` near line 136 add `const cooldown = new ProviderCooldownStore();`; pass into `assembleServerState` via `ServerStateParts` (add `readonly cooldown: ProviderCooldownStore;` to `ServerStateParts` in `lifecycle.ts`); in `assembleServerState` return object add `cooldown: parts.cooldown,`.

- [ ] **Step 3: Typecheck** — `cd packages/server && bun run check`. If `ServerState` must satisfy `ProviderRouteSource`, ensure `cooldown` is present there.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/runtime.ts packages/server/src/server-state/index.ts packages/server/src/server-state/lifecycle.ts
git commit -m "feat(server-state): provide ProviderCooldownStore on the route source"
```

---

## Task 6 (harness): cooldown store + config injection in test helpers

**Files:**
- Modify: `packages/server/__tests__/pipeline-helpers/providers.ts` (add `cooldown`; add `withSnapshotConfigs` + `retryConfig`)
- Modify: `packages/server/__tests__/pipeline-helpers/index.ts` (exports)
- Modify: `packages/server/src/routes/pipeline/attempt-metadata.test.ts` (drop local `withSnapshotConfigs`, import shared)

- [ ] **Step 1: Add `cooldown` to the test source** — in `providers.ts` add `cooldown: new ProviderCooldownStore(),` (import from `../../src/routes/pipeline/provider-cooldown`). This satisfies the extended `ProviderRouteSource` for every existing pipeline test.

- [ ] **Step 2: Promote `withSnapshotConfigs`, add `retryConfig`**

Move `withSnapshotConfigs` verbatim from `attempt-metadata.test.ts:124-131` into `providers.ts`; export it. Add:

```ts
import { ConfigSchema, type Config } from '@aio-proxy/types';
export function retryConfig(overrides: Partial<Config['server']['retry']> = {}): Config {
  const base = ConfigSchema.parse({ server: {}, providers: {} });
  return { ...base, server: { ...base.server, retry: { ...base.server.retry, ...overrides } } };
}
```

Export both from `index.ts`. In `attempt-metadata.test.ts` delete the local `withSnapshotConfigs` and import from helpers (`apiConfig`/`modelConfig` stay local).

- [ ] **Step 3: Verify existing pipeline suite still green** — `cd packages/server && bun test src/routes/pipeline` → PASS (source now carries `cooldown`; no behavior change yet).

- [ ] **Step 4: Commit**

```bash
git add packages/server/__tests__/pipeline-helpers packages/server/src/routes/pipeline/attempt-metadata.test.ts
git commit -m "test(pipeline): cooldown store and retry-config injection in harness"
```

---

## Task 4 (loop): write cooldown on 429; skip cooled; synthesize all-cooled 429

**Rationale:** With store, config, adapter 429 builder, wiring, and harness in place, the loop now (a) writes a cooldown when an attempt 429s with a valid `Retry-After`, (b) skips cooled candidates during selection, (c) synthesizes a 429 when all candidates for the model are cooled.

**Files:**
- Modify: `packages/server/src/routes/pipeline/attempt/context.ts` (`AttemptLoopContext` gains `cooldown`, `retryAfterCapMs`)
- Create: `packages/server/src/routes/pipeline/attempt/cooldown-write.ts` + `.test.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/attempt.ts` (build ctx fields; skip + all-cooled synthesis)
- Modify: `packages/server/src/routes/pipeline/attempt/raw.ts` (write on raw 429)
- Modify: `packages/server/src/routes/pipeline/attempt/error.ts` (write on AI-SDK 429 exception with headers)
- Modify: `packages/core/src/protocol/errors.ts` (expose `retryAfterHeaderFromError` OR extract headers pre-mapping — see Step 5)
- Test: `packages/server/src/routes/pipeline/attempt.test.ts`

**Interfaces:**
- Produces: `cooldownTtlMs(status: number, retryAfterHeader: string | null, retryAfterCapMs: number, now?: number): number` — `0` unless `status === 429`; for 429, `min(parsedMs, cap)` when parse is finite `> 0`, else `0`.
- `AttemptLoopContext` gains `readonly cooldown: ProviderCooldownStore; readonly retryAfterCapMs: number;`.

- [ ] **Step 1: Failing unit test for `cooldownTtlMs`**

```ts
import { describe, expect, test } from 'bun:test';
import { cooldownTtlMs } from './cooldown-write';
const cap = 30_000;
describe('cooldownTtlMs', () => {
  test('non-429 never cools', () => {
    expect(cooldownTtlMs(503, '5', cap)).toBe(0);
    expect(cooldownTtlMs(500, null, cap)).toBe(0);
  });
  test('429 numeric Retry-After within cap', () => { expect(cooldownTtlMs(429, '5', cap)).toBe(5_000); });
  test('429 Retry-After above cap clamps', () => { expect(cooldownTtlMs(429, '120', cap)).toBe(cap); });
  test('429 without parseable Retry-After does not cool', () => {
    expect(cooldownTtlMs(429, null, cap)).toBe(0);
    expect(cooldownTtlMs(429, 'garbage', cap)).toBe(0);
  });
});
```

- [ ] **Step 2: Verify RED** — `cd packages/server && bun test src/routes/pipeline/attempt/cooldown-write.test.ts` → FAIL.

- [ ] **Step 3: Implement `cooldown-write.ts`**

```ts
import { retryAfterMilliseconds } from '@aio-proxy/plugin-sdk';

// TTL (ms) to cool a (provider, model) after a failed attempt, or 0 when the
// failure should not cool. Only a 429 with a parseable, positive Retry-After
// cools; the window is clamped to retryAfterCapMs.
export function cooldownTtlMs(
  status: number,
  retryAfterHeader: string | null,
  retryAfterCapMs: number,
  now = Date.now(),
): number {
  if (status !== 429) return 0;
  const parsed = retryAfterMilliseconds(retryAfterHeader, now);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.round(parsed), retryAfterCapMs);
}
```

- [ ] **Step 4: Verify GREEN** — PASS.

- [ ] **Step 5: Extract 429 status + `Retry-After` from a thrown AI-SDK error (recursive)**

**Verified pitfall (codex runtime probe):** the AI SDK retries internally and wraps the terminal `APICallError` inside `RetryError.lastError`/`.errors`; `AiSdkProviderError` wraps that again. A shallow `cause.responseHeaders` read returns `null`, and `adapter.errors.provider(wrapped)` maps to **500** (not 429) for OpenAI/Anthropic/Gemini. Therefore cooldown for exceptions MUST key off the extracted `APICallError.statusCode` (429), NOT the mapped response status. Confirmed working via probe: `AiSdkProviderError → RetryError → APICallError` extracts `status: 429, retry-after: "30"`.

Add to `errors.ts` (export from the core protocol barrel):

```ts
import { APICallError } from '@ai-sdk/provider';
import { RetryError } from 'ai';

// Walks AiSdkProviderError.cause → RetryError.lastError/errors → nested cause
// chains to the terminal APICallError, using APICallError.isInstance as the
// robust guard (works across duplicated @ai-sdk/provider copies).
function findApiCallError(error: unknown, depth = 0): APICallError | undefined {
  if (depth > 6 || error === null || typeof error !== 'object') return undefined;
  if (APICallError.isInstance(error)) return error;
  if (error instanceof AiSdkProviderError) return findApiCallError(error.cause, depth + 1);
  if (RetryError.isInstance(error)) {
    const fromLast = findApiCallError(error.lastError, depth + 1);
    if (fromLast !== undefined) return fromLast;
    for (const inner of error.errors ?? []) {
      const found = findApiCallError(inner, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if ('cause' in error) return findApiCallError((error as { cause?: unknown }).cause, depth + 1);
  return undefined;
}

// The upstream status and Retry-After of a thrown provider error, or undefined
// status when no APICallError is found. Used to decide/size a cooldown.
export function upstreamRetryInfo(error: unknown): { status: number | undefined; retryAfter: string | null } {
  const api = findApiCallError(error);
  if (api === undefined) return { status: undefined, retryAfter: null };
  const headers = api.responseHeaders ?? {};
  const retryAfter = headers['retry-after'] ?? headers['Retry-After'] ?? null;
  return { status: api.statusCode, retryAfter: typeof retryAfter === 'string' ? retryAfter : null };
}
```

`RetryError` is imported from `ai` (already a `@aio-proxy/core` dependency, `catalog:`). `APICallError` from `@ai-sdk/provider` (already a dependency). `AiSdkProviderError.cause` is retained (`packages/core/src/error.ts:37`). `RetryError` shape confirmed: `readonly lastError: unknown; readonly errors: Array<unknown>` (`ai@7 dist/index.d.ts:6894-6896`).

- [ ] **Step 6: Thread ctx fields**

`context.ts` `AttemptLoopContext`: add `readonly cooldown: ProviderCooldownStore;` (import from `../provider-cooldown`) and `readonly retryAfterCapMs: number;`. In `attempt.ts`, after `config` destructure: `const retryAfterCapMs = config?.server.retry.retryAfterCapMs ?? 30_000;`; add `cooldown: source.cooldown` and `retryAfterCapMs` to the `ctx` literal.

- [ ] **Step 7: Write cooldown from `raw.ts`**

In the failure branch (`raw.ts` ~29-43), before the fallback/return decision:

```ts
const cooldownMs = cooldownTtlMs(response.status, response.headers.get('retry-after'), ctx.retryAfterCapMs);
if (cooldownMs > 0) ctx.cooldown.cool(provider.id, candidate.modelId, cooldownMs);
```

Import `cooldownTtlMs`. The existing `shouldFallbackStatus`/`hasNext`/finalize logic is unchanged (429 already falls back / returns as today; the raw terminal 429 keeps its own `Retry-After` via `retainedFailure`).

- [ ] **Step 8: Write cooldown from `error.ts`**

In `handleAttemptError`, after `mapped`/`cancelled` resolved (~60-67):

```ts
if (!cancelled) {
  // Use the extracted upstream status (429), NOT mapped.status — a wrapped
  // AI-SDK 429 maps to 500 (see Step 5's verified pitfall).
  const { status, retryAfter } = upstreamRetryInfo(error);
  if (status !== undefined) {
    const cooldownMs = cooldownTtlMs(status, retryAfter, ctx.retryAfterCapMs);
    if (cooldownMs > 0) ctx.cooldown.cool(provider.id, candidate.modelId, cooldownMs);
  }
}
```

Import `cooldownTtlMs` and `upstreamRetryInfo`. This cools based on the real upstream 429 regardless of how the adapter maps the exception for the client response. A non-429 upstream (or an error with no `APICallError`) does not cool. The mapped response returned to the client is unchanged.

- [ ] **Step 9: Skip cooled candidates + all-cooled synthesis in `attempt.ts`**

After `ordered` is built (post affinity/response-owner/weight ordering):

```ts
// Snapshot each candidate's remaining TTL ONCE so filtering and the all-cooled
// Retry-After use the same reading (a cooldown expiring between two reads must
// not yield a synthetic 1s 429 while a candidate is already live).
const remaining = ordered.map((candidate) => ({
  candidate,
  remainingMs: ctx.cooldown.remainingMs(candidate.provider.id, candidate.modelId),
}));
const live = remaining.filter((entry) => entry.remainingMs === 0).map((entry) => entry.candidate);
if (live.length === 0 && ordered.length > 0) {
  const minRemaining = Math.min(...remaining.map((entry) => entry.remainingMs));
  const retryAfterSeconds = Math.max(1, Math.ceil(minRemaining / 1_000));
  const response = adapter.errors.rateLimited(retryAfterSeconds);
  // Request-level finalization: no provider was attempted, so do NOT use finalFailure
  // (it requires/records a provider+model). Snapshot lease + body cleanup are handled
  // by the outer finally blocks in index.ts:155,191.
  session.finish({ outcome: 'failure', finalHttpStatus: 429, errorCode: 'rate_limited' });
  return response;
}
```

Iterate `live` (not `ordered`) in the candidate loop; compute `hasNext` from `live`. Filtering preserves order, so cooldown overrides both affinity and response-owner prioritization — add a code comment referencing the AGENTS session-affinity section stating this is intentional. If `attempt.ts` nears 240 lines, extract the all-cooled synthesis into a sibling helper file.

- [ ] **Step 10: Selection/synthesis tests**

Add to `attempt.test.ts` (helpers from Task 6). Cover ALL of:

1. **Cooled provider skipped, falls back to backup** (primary 429s once, backup serves; second request skips primary without a second call).
2. **Only provider cooled → synthesized 429** (single provider 429s; second request returns 429 with a positive `Retry-After` and does NOT hit upstream).
3. **Shortest remaining TTL wins** with two cooled candidates (cool provider A for a long window and B for a short one via two 429s with different `Retry-After`; assert the synthesized `Retry-After` reflects the smaller remaining).
4. **Protocol-native synthesized bodies** for OpenAI, Anthropic, and Gemini all-cooled cases (assert each body shape from Task 3).
5. **AI-SDK 429 exception through the real wrapper chain** cools the pair. `APICallError.isInstance()` REJECTS plain lookalike objects (verified) and a bare `APICallError` would not exercise the recursive unwrap — so the test MUST throw the exact production nesting: `new AiSdkProviderError('p', new RetryError({ message: 'failed', reason: 'maxRetriesExceeded', errors: [new APICallError({ message: 'limited', url: 'https://u.test', requestBodyValues: {}, statusCode: 429, responseHeaders: { 'retry-after': '30' } })] }))` from a model-transport `invoke`. Assert the pair is cooled (the next request skips it). Import `APICallError` from `@ai-sdk/provider`, `RetryError` from `ai`, `AiSdkProviderError` from `@aio-proxy/core`.
6. **Trace finalization**: all-cooled path finishes with status 429, `errorCode: 'rate_limited'`, NO final provider/model, and zero attempt spans (assert via the recording/trace test support already used in `attempt-metadata.test.ts`).
7. **Cooled affinity/response-owner candidate is skipped** (bind affinity to a provider, cool it, assert the next live candidate is used).
8. **Expiry re-entry** (retained test, not only smoke): cool via a short `Retry-After`, `await Bun.sleep` past it, assert the provider is selected again.

- [ ] **Step 11: Run** — `cd packages/server && bun test src/routes/pipeline/attempt.test.ts` → PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/server/src/routes/pipeline/attempt packages/core/src/protocol/errors.ts packages/server/src/routes/pipeline/attempt.test.ts
git commit -m "feat(pipeline): write/skip/synthesize provider cooldown on 429"
```

---

## Task 7: Full verification

- [ ] **Step 1: Pipeline suite** — `cd packages/server && bun test src/routes/pipeline` → PASS. Watch `raw-fallback.test.ts`, `terminal.test.ts`, `oauth.test.ts`, `attempt-metadata.test.ts`: non-429 and 429-without-Retry-After paths must be unchanged. A 429 WITH `Retry-After` now writes a cooldown; if any existing test issues two requests through one source with such a 429, reconcile the second-request expectation to the intended cooldown behavior (skip), not by weakening the assertion.
- [ ] **Step 2: Preflight** — `bun run preflight` → oxlint + oxfmt clean, all unit tests pass.
- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git commit -m "test(pipeline): finalize provider cooldown verification"
```

---

## Self-Review

**Scope coverage:** 429+Retry-After cooldown write (raw + AI-SDK) → Tasks 2,3,4. Skip cooled + all-cooled protocol-native 429 → Tasks 3,4. Leak-free store → Task 1. Config → Task 2. Adapter 429 → Task 3. Wiring → Task 5. Harness → Task 6. Verify → Task 7.

**Out of scope (agreed):** same-provider replay; in-request `Retry-After` sleep; 5xx/network cooldown; cooldown persistence across restart; circuit breaker; fake200 detection.

**Resolves prior review:** BLOCKER (POST replay) — eliminated (no replay). MAJOR (in-request sleep) — eliminated. MAJOR (over-broad retry classification) — only 429+valid Retry-After cools. MAJOR (lost Retry-After for AI-SDK) — `retryAfterHeaderFromError` extracts from the original cause (Task 4 Step 5). MAJOR (no reusable adapter 429) — explicit `adapter.errors.rateLimited` (Task 3). MAJOR (all-cooled finalization) — request-level `session.finish({outcome:'failure',finalHttpStatus:429,errorCode:'rate_limited'})`, not `finalFailure` (Task 4 Step 9). MAJOR (test gaps) — Task 4 Step 10 covers shortest-TTL, native bodies, AI-SDK exception, trace finalization, affinity skip, expiry. MINOR (task order) — dependency order 1→2→3→5→6→4→7 stated. MINOR (catalog) — root catalog + core/server `catalog:` (Task 1 Step 1). NIT (key collision) — `JSON.stringify([providerId, model])` (contract + Task 1 test).

**Advisory semantics:** stated explicitly (concurrent-read race + `max` eviction may allow an extra call). Cooldown reduces, not eliminates, hits on a limited provider.

**Interaction with the already-applied SSE fix on this branch:** independent; SSE fix ensures a returned 429 body reaches the client cleanly, cooldown wraps around it.
