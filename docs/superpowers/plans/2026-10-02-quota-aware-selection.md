# Quota-Aware Candidate Selection (Increment 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A subscription Provider whose cached quota snapshot shows an exhausted window with a known future reset is not attempted for the models that window covers until the reset, and the trace says why (aio-proxy/aio-proxy#476, increment 1 only).

**Architecture:** Plugins opt a quota item into routing with a new optional `scope` (`'account'` or model patterns). The server pipeline reads the quota cache's synchronous `status()` view, treats a fresh, exhausted, in-scope item like a cooldown that lasts until `resetsAt`, and folds it into the existing `selectLiveCandidates` filter and all-cooled 429. Skipped candidates are recorded on the inference span.

**Tech Stack:** TypeScript, Bun test, `es-toolkit`, OpenTelemetry span attributes, Changesets.

**Spec:** The design agreed in-session, recorded in the "Design" section below (no separate spec file).

## Design

- **SDK:** `OAuthQuotaItem.scope?: OAuthQuotaItemScope` where `OAuthQuotaItemScope = 'account' | { readonly models: readonly string[] }`. Contract: when the item has `remainingRatio` 0 and a future `resetsAt`, upstream **refuses** requests for the covered models until `resetsAt`. A plugin declares a scope only when that is true. No scope = the item never affects routing.
- **Model patterns:** each entry matches the candidate's upstream model id, case-insensitively; `*` matches any run of characters (including `/` and empty); an entry starting with `!` excludes. A model is covered iff it matches at least one inclusion and no exclusion.
- **Gate rule:** a candidate is held by quota iff the cache status is `ready`, the entry is not `stale`, `now - sampledAt <= 10 min`, and some item with a scope covering the candidate's model has `remainingRatio <= 0` and `resetsAt > now`. Held until the latest such `resetsAt`. Every other state (none, loading, failed, unsupported, stale, too old, no `resetsAt`, ratio unknown) never holds.
- **Refresh:** for an OAuth candidate whose status is `none`, stale, older than 10 min, or currently held, selection calls `warmProviderQuota` (fire-and-forget; the cache's 5-minute read cooldown bounds traffic). Never awaited — no network on the request path.
- **Precedence:** like cooldown, a quota hold removes the candidate even if session affinity or response owner put it first. Filtering never reorders survivors, so stable-session order is preserved; token counting is untouched.
- **Combined hold:** a candidate both cooling and quota-held is held for the longer of the two, reported with that reason.
- **All held:** joins the existing all-cooled path: synthesized 429, `Retry-After` = ceil(min remaining hold across candidates / 1000), at least 1 — uncapped for quota.
- **Trace:** the inference span gets `aio_proxy.route.skipped_candidates` (string[]), one entry `<providerId>:<reason>` per removed candidate, reason `cooldown` or `quota_exhausted`, in candidate order. Absent when nothing was skipped.
- **Bundled plugin scopes:**
  - kimi-code: every item `'account'`.
  - muse-code: every item `'account'`.
  - openai-chatgpt: each `additional_rate_limits[]` window item gets `{ models: [limit_name.toLowerCase()] }` when `limit_name` is present (none when only `metered_feature` exists). `primary`/`secondary` get `'account'` when there are no such names, otherwise `{ models: ['*', ...names.map((n) => '!' + n)] }`.
  - cursor: `auto` → `{ models: ['default', 'grok-*', 'cursor-grok-*', 'composer-*'] }`; `api` → `{ models: ['*', '!default', '!grok-*', '!cursor-grok-*', '!composer-*'] }`; `plan`, `on-demand`, `grok-bot` unscoped.
  - google-antigravity, github-copilot, xai-grok, openrouter: unchanged.
- No config option: increment 1 only acts on windows a plugin declared.

## Global Constraints

- The server pipeline stays the only generation candidate loop; no network read on the request path.
- Unknown or stale quota never blocks a candidate.
- Snapshot max age: `QUOTA_SNAPSHOT_MAX_AGE_MS = 10 * 60_000`.
- SDK change is additive (one optional field + one exported type) so it rebases cleanly over aio-proxy/aio-proxy#475.
- Tests colocated as `foo/index.ts`, `foo/foo.ts`, `foo/foo.test.ts`; every test protects behavior.
- Non-test implementation files under 500 lines; `attempt.ts` (351) must stay readable — put new logic in `quota-gate/`.
- Use `escapeRegExp` from `es-toolkit/string` for pattern compilation.
- Domain terms: Provider ID, Provider priority, Provider weight.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **ChatGPT `limit_name` is not the model id** (e.g. `GPT-Reserve` vs a catalog id `gpt-5-reserve`): the main-lane exclusion then misses the model, and an exhausted main lane wrongly skips it. Confirm with the user against a real `additional_rate_limits` payload before shipping; Task 4 pins the lowercase-equality assumption in a test so a change is deliberate.
2. **Clock skew / `resetsAt` already past at selection time:** a snapshot whose reset passed must not hold, even if `remainingRatio` is still 0. Task 2 test.
3. **Provider reconfigured to a different account:** `invalidate` clears the entry, status becomes `none`, so the old account's exhaustion never holds the new one. Task 2 test via status `none`.
4. **Multiple exhausted items covering one model:** held until the latest reset, not the earliest. Task 2 test.
5. **An item with scope but unknown `remainingRatio`:** never holds. Task 2 test.

---

### Task 1: SDK scope type and core validation

**Files:**
- Modify: `packages/plugin-sdk/src/oauth.ts` (`OAuthQuotaItem`, ~line 133)
- Modify: `packages/core/src/plugins/quota.ts` (`ITEM_KEYS`, item validator)
- Test: `packages/core/src/plugins/quota.test.ts`, `packages/core/src/plugins/quota-rejections.test.ts` (existing files, extend)
- Create: `.changeset/quota-item-scope.md`

**Interfaces:**
- Produces: `export type OAuthQuotaItemScope = 'account' | { readonly models: readonly string[] }` and `OAuthQuotaItem.scope?: OAuthQuotaItemScope`, both exported from `@aio-proxy/plugin-sdk`. Add a doc comment carrying the contract sentence from Design.

- [ ] **Step 1: Write failing tests**
  - `quota.test.ts`: `'keeps an account scope and a model-pattern scope'` — validating `{ items: [{ id: 'a', displayName: 'A', scope: 'account' }, { id: 'b', displayName: 'B', scope: { models: ['gpt-*', '!gpt-reserve'] } }] }` returns those scopes unchanged.
  - `quota-rejections.test.ts`: rejects with path `['items', 0, 'scope']` for `scope: 'model'`, `scope: { models: [] }`, `scope: { models: [''] }`, `scope: { models: ['!'] }`, `scope: { models: [1] }`, and `['items', 0, 'scope', 'extra']` for `scope: { models: ['a'], extra: 1 }`.
- [ ] **Step 2: Run** `bun test packages/core/src/plugins/quota` — expect FAIL (unknown key `scope`).
- [ ] **Step 3: Implement** — add `'scope'` to `ITEM_KEYS`; add `optionalScope(value, path, ancestors)` using the file's existing `withPlainRecord` / `withDenseArray` (keys `{'models'}`); each entry must be a string whose text after an optional leading `!` is non-empty; the array must be non-empty.
- [ ] **Step 4: Run** `bun test packages/core/src/plugins/quota` — expect PASS.
- [ ] **Step 5: Changeset** `.changeset/quota-item-scope.md`, `'@aio-proxy/plugin-sdk': minor`, one paragraph: quota items can declare `scope` (whole account or model patterns) to tell aio-proxy which models an exhausted window blocks; items without it are display-only.
- [ ] **Step 6: Commit** `feat(plugin-sdk): let quota items declare the models they gate`

### Task 2: Quota gate

**Files:**
- Create: `packages/server/src/routes/pipeline/quota-gate/index.ts`, `quota-gate.ts`, `quota-gate.test.ts`

**Interfaces:**
- Consumes: `OAuthQuotaCacheStatus` from `packages/server/src/plugin-quota`, `OAuthQuotaItemScope` from Task 1.
- Produces:
  - `export const QUOTA_SNAPSHOT_MAX_AGE_MS = 600_000`
  - `export function quotaScopeCovers(scope: OAuthQuotaItemScope, modelId: string): boolean`
  - `export type QuotaGate = { readonly heldUntil?: number; readonly refresh: boolean }`
  - `export function quotaGate(status: OAuthQuotaCacheStatus, modelId: string, now: number): QuotaGate` — `heldUntil` set per the Design gate rule (latest qualifying `resetsAt`); `refresh` true for `none`, stale, too old, or held.

- [ ] **Step 1: Write failing tests** in `quota-gate.test.ts` (fixed `now = 1_000_000_000`, helper `ready(items, { sampledAt = now - 1_000, stale = false })`):
  - `quotaScopeCovers`: `'account'` covers anything; `['gpt-*']` covers `GPT-5` (case), not `o3`; `['*', '!gpt-reserve']` covers `gpt-5`, not `gpt-reserve`; `['!x']` covers nothing; `*` spans `/` (`['anthropic/*']` covers `anthropic/claude`).
  - holds an account-scoped exhausted item: `{ heldUntil: now + 60_000, refresh: true }`.
  - ignores an exhausted item without scope → `{ refresh: false }`.
  - ignores an exhausted item whose model scope excludes the model.
  - ignores `remainingRatio > 0`, missing `remainingRatio`, missing `resetsAt`, and `resetsAt <= now` (Review Focus 2, 5).
  - two covering exhausted items with resets `+60_000` and `+120_000` → `heldUntil: now + 120_000` (Review Focus 4).
  - stale entry → not held, `refresh: true`; `sampledAt = now - QUOTA_SNAPSHOT_MAX_AGE_MS - 1` → not held, `refresh: true`; exactly at max age → held.
  - status `none` → `{ refresh: true }` (Review Focus 3); `loading`, `failed`, `unsupported` → `{ refresh: false }`.
- [ ] **Step 2: Run** `bun test packages/server/src/routes/pipeline/quota-gate` — expect FAIL (module missing).
- [ ] **Step 3: Implement** in `quota-gate.ts`; compile patterns with `escapeRegExp` then `\*` → `.*`, anchored, flag `i`. Comment the max-age choice (two read-cooldown periods, tolerates one missed refresh).
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(server): decide when a cached quota snapshot holds a candidate`

### Task 3: Pipeline selection, all-held 429, and trace

**Files:**
- Modify: `packages/server/src/routes/pipeline/attempt/cooldown-write/cooldown-write.ts` (`selectLiveCandidates`, `CooldownSelection`)
- Modify: `packages/server/src/routes/pipeline/attempt/cooldown-write/cooldown-write.test.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/attempt.ts` (`attemptCandidates`, selection block ~line 248)
- Modify: `packages/server/src/runtime.ts` (`ProviderRouteSource`)
- Modify: `packages/server/src/server-state/lifecycle.ts` (~line 238, wire `quotaStatus`)
- Modify: `packages/server/src/request-tracing/semantic/semantic.ts` (`routeSkippedCandidates: 'aio_proxy.route.skipped_candidates'`)
- Create: `packages/server/src/routes/pipeline/attempt/attempt.quota-gate.test.ts` (sibling of the existing `attempt.quota-warm.test.ts`)
- Create: `.changeset/quota-aware-selection.md`

**Interfaces:**
- Consumes: `quotaGate`, `QuotaGate` (Task 2).
- Produces:
  - `ProviderRouteSource.quotaStatus?: (providerId: string) => OAuthQuotaCacheStatus` (absent → no gating, no selection-time warm; realtime/test sources unaffected).
  - `export type CandidateHold = { readonly reason: 'cooldown' | 'quota_exhausted'; readonly remainingMs: number }`
  - `selectLiveCandidates(ordered: readonly Candidate[], holdOf: (candidate: Candidate) => CandidateHold | undefined): CooldownSelection`, where both variants of `CooldownSelection` also carry `skipped: readonly { readonly providerId: string; readonly reason: CandidateHold['reason'] }[]`. `holdOf` is called once per candidate (keeps the single-reading guarantee in the existing comment).
  - `attempt.ts` builds `holdOf` from `ctx.cooldown.remainingMs(...)` and `quotaGate(source.quotaStatus(id), modelId, now)` (OAuth candidates only, `now` read once), picks the longer hold, and calls `source.warmProviderQuota?.(id)` when `gate.refresh`. If this makes `attempt.ts` noticeably longer, move the `holdOf` builder into `quota-gate/` as `candidateHold(...)`.

- [ ] **Step 1: Update unit tests** in `cooldown-write.test.ts` for the new `selectLiveCandidates` signature: preserves order of survivors; reports skipped in candidate order with reasons; all held → `all-cooled` with `retryAfterSeconds = ceil(min / 1000)`, min 1; a held candidate cannot yield a synthetic 429 while another is live.
- [ ] **Step 2: Write failing integration tests** in `attempt.quota-gate.test.ts`, reusing the `asOAuth` / `defineProviderRouteSource` / `handleProtocolRequest` pattern from `attempt.quota-warm.test.ts`, with a fake `quotaStatus` keyed by Provider ID:
  - `'skips an exhausted subscription and serves from the next candidate'` — providers `sub-a` (exhausted, account scope, reset +1h) and `sub-b`; `sub-a.invoke` must never be called; response 200 from `sub-b`; inference span attribute `aio_proxy.route.skipped_candidates` equals `['sub-a:quota_exhausted']`.
  - `'unknown quota is attempted as today'` — status `none` → `sub-a` attempted; no skipped attribute; `warmed` contains `sub-a`.
  - `'stale quota is attempted as today'` — exhausted but `stale: true` → attempted.
  - `'quota exhaustion overrides session affinity'` — resolution with active affinity to `sub-a`; `sub-a` not attempted.
  - `'all exhausted returns 429 with Retry-After until the earliest reset'` — two exhausted subs (+90s, +3h) → status 429, `retry-after: 90`, no provider invoked.
  - `'mixed cooldown and quota are both recorded'` — `sub-a` cooled via `source.cooldown.cool`, `sub-b` exhausted, `sub-c` live → served by `sub-c`, attribute `['sub-a:cooldown', 'sub-b:quota_exhausted']`.
  - `'a model outside the item scope is not held'` — scope `{ models: ['other-*'] }` → attempted.
- [ ] **Step 3: Run** `bun test packages/server/src/routes/pipeline/attempt` — expect FAIL.
- [ ] **Step 4: Implement** the interfaces above; set the attribute with `trace.getSpan(session.rootContext)?.setAttribute(attributeName.routeSkippedCandidates, entries)` before the all-cooled branch so both outcomes record it. Update the `selectLiveCandidates` comment to cover quota holds.
- [ ] **Step 5: Run** `bun test packages/server/src/routes/pipeline packages/server/src/plugin-quota` — expect PASS (existing cooldown, affinity, and quota-warm tests unchanged).
- [ ] **Step 6: Changeset** `.changeset/quota-aware-selection.md`, minor for `aio-proxy`, `@aio-proxy/core`, `@aio-proxy/server`, `@aio-proxy/plugin-kimi-code`, `@aio-proxy/plugin-muse-code`, `@aio-proxy/plugin-openai-chatgpt`, `@aio-proxy/plugin-cursor`. One paragraph: subscription Providers whose quota window is known to be exhausted are skipped until it resets instead of failing each request; when every candidate is exhausted or cooling, the client gets a 429 with `Retry-After`; the trace lists skipped Providers; supported for Kimi Code, Muse Code, ChatGPT, and Cursor.
- [ ] **Step 7: Commit** `feat(server): skip subscription Providers whose quota is exhausted`

### Task 4: Bundled plugin scopes

**Files:**
- Modify: `packages/plugins/kimi-code/src/quota.ts` (item builder ~line 39) + its existing test
- Modify: `packages/plugins/muse-code/src/quota/quota.ts` (`weekly` ~line 70, window ~line 116/122) + `quota.test.ts`
- Modify: `packages/plugins/openai-chatgpt/src/quota/quota.ts` (`laneItems`, `additionalItems`, assembly at line 42) + `quota.test.ts`
- Modify: `packages/plugins/cursor/src/quota/summary.ts` (`summaryQuota`, `item()`) + its test

**Interfaces:**
- Consumes: `OAuthQuotaItemScope` (Task 1). Scope values exactly as in Design.

- [ ] **Step 1: Update tests** so each plugin's existing snapshot expectations include the new `scope` values; add:
  - chatgpt `'scopes main lanes around model-specific limits'` — payload with `additional_rate_limits` `[{ limit_name: 'GPT-5.3-Codex-Spark', metered_feature: 'codex_spark', … }]` → `primary.scope` = `{ models: ['*', '!gpt-5.3-codex-spark'] }`, `codex-spark.scope` = `{ models: ['gpt-5.3-codex-spark'] }` (pins Review Focus 1); an entry with only `metered_feature` → that item has no scope and the main lanes stay `'account'`.
  - cursor: `auto`/`api` scopes as in Design; `plan`, `on-demand` have no scope.
- [ ] **Step 2: Run** `bun test packages/plugins/kimi-code packages/plugins/muse-code packages/plugins/openai-chatgpt packages/plugins/cursor` — expect FAIL.
- [ ] **Step 3: Implement.** Comment on each scope why the window refuses requests (the contract), and in cursor why `plan`/`on-demand` stay unscoped.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(plugins): declare which models each subscription quota window gates`

### Task 5: Docs and preflight

**Files:**
- Modify: `README.md` and `README.zh-Hans.md` — "Routing rules": after step 6 add a step: cooling candidates and subscription candidates whose quota window is known to be exhausted are removed (overriding response owner and session affinity); unknown or stale (>10 min) quota never removes a candidate; if all are removed, 429 with `Retry-After` until the earliest reset.
- Modify: `website/docs/en/guide/routing/routing-rules.md`, `website/docs/zh/guide/routing/routing-rules.md` — same content, plus which plugins report gating windows and the `aio_proxy.route.skipped_candidates` trace attribute.

- [ ] **Step 1: Edit** the four docs.
- [ ] **Step 2: Run** `bun run preflight` — expect exit 0; record the actual output.
- [ ] **Step 3: Commit** `docs: describe quota-aware candidate selection`
