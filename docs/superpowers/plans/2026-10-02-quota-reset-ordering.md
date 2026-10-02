# Quota Reset Ordering (Increment 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in global routing policy that, within one Provider priority tier, tries the subscription whose quota allowance expires soonest first, in place of the weighted draw (aio-proxy/aio-proxy#476, increment 2).

**Architecture:** `router.selection: 'weighted' | 'quota-reset'` (default `weighted`). When `quota-reset`, the server reorders the router's candidates tier by tier from the quota cache's synchronous view, before response-owner/affinity promotion, in both the generation pipeline and token counting. A Routing-page switch writes the field through a new `PUT /routing/selection` route.

**Tech Stack:** TypeScript, Zod, Bun test, Hono, React + TanStack Form/Query, Changesets.

**Spec:** The "Design" section below (agreed in-session). Builds on increment 1 (`docs/superpowers/plans/2026-10-02-quota-aware-selection.md`): `quota-gate/` (`quotaScopeCovers`, `QUOTA_SNAPSHOT_MAX_AGE_MS`), `ProviderRouteSource.quotaStatus`.

## Design

- **Config:** `RouterConfigSchema.selection = z.enum(['weighted', 'quota-reset']).default('weighted')`, global (user choice). Off by default; with `weighted` nothing changes.
- **Ordering key:** for an OAuth candidate with a usable snapshot (status `ready`, not `stale`, `now - sampledAt <= QUOTA_SNAPSHOT_MAX_AGE_MS`), the **latest** `resetsAt > now` among items whose `scope` covers the candidate's model. The latest-resetting covering window is the allowance at stake (a weekly window, not the 5-hour one), so sorting by it spends the allowance that would expire unused first. Remaining ratio is not part of the key: it keeps the order stable between requests, and exhausted candidates are already removed by increment 1.
- **Unknown:** no key (non-OAuth, no snapshot, stale, too old, no covering scoped window with a future reset) → placed **after** all keyed candidates of the same tier, keeping their existing relative (weighted) order (user choice).
- **Tiers:** the router output is already in descending Provider priority; reorder only within each run of equal `routing.priority`. Ties on the key keep the router's order (stable sort). Provider-qualified routes (one candidate) are untouched.
- **Precedence:** reordering happens before `prioritizeAffinity`, so response owner and session affinity still win (user choice: keep prompt caches warm). Increment 1's hold filter still runs after, in the pipeline only.
- **Determinism:** token counting and generation call the same function on the same cache view; the key is an absolute reset time, so the order is shared unless a window rolls over or a snapshot crosses the 10-minute age bound between the two requests.
- **Trace:** a keyed, reordered candidate carries `selectionSource: 'quota_reset'` (new value of core `RouterSelectionSource` and server `AttemptSelectionSource`), recorded on the attempt span's existing `aio_proxy.route.selection_source`. Response owner / affinity still override it as today.
- **Dashboard:** routing config belongs on the Routing page, never Settings (`docs/superpowers/plans/2026-09-03-settings-page-completeness.md:14`; `settings.test.ts:310` rejects `router`). `DashboardRoutingModelsResponse` gains `selection`; new `PUT /dashboard/api/routing/selection` with `{ selection }` writes `router.selection` via `configStore.mutateConfig`, keeping sibling `router` keys, and returns the routing list. The Routing page shows one Switch ("Spend the subscription that resets soonest first") following the `settings-proxy-fallback.tsx` pattern (TanStack Form field + `Switch`, save on change), disabled when `writable` is false.

## Global Constraints

- Server pipeline remains the only generation candidate loop; no network read on the request path.
- Nothing changes when `router.selection` is `weighted` (default) — same order, same `selectionSource`.
- Provider priority and Provider weight semantics unchanged; weight-zero and disabled candidates are already absent from the router output.
- Tests colocated (`foo/index.ts`, `foo/foo.ts`, `foo/foo.test.ts`); non-test files under 500 lines.
- Dashboard: shared `@aio-proxy/ui` components, TanStack Form/Query, services under `modules/routing/services`, all copy in `packages/i18n/messages/*.json` (every locale, `locale-parity.test.ts`), then `bun run i18n:compile`.
- Run package tests via `bun run --cwd packages/<pkg> test:unit <path>`; rebuild `@aio-proxy/types` / `@aio-proxy/core` (`bun run --cwd packages/<pkg> build`) before dependents type-check; `bun run build && bun run preflight` at the end.
- Changeset: a second note (independent opt-in feature), minor for `aio-proxy`, `@aio-proxy/core`, `@aio-proxy/types`, `@aio-proxy/server`, `@aio-proxy/dashboard`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Two subscriptions with a 5-hour and a weekly window each:** order follows the weekly reset, not the 5-hour one. Task 2 test.
2. **A tier mixing a subscription and an `api` Provider:** the `api` Provider goes after the keyed subscription and is never dropped. Task 2 test.
3. **Policy on, session affinity to the later-resetting subscription:** affinity still goes first. Task 3 test.
4. **Token count and generation for the same stable session:** same first candidate under the policy. Task 3 test.
5. **Switch toggled while the config file is read-only (`writable: false`):** control disabled; the route answers 409 `config_unavailable`. Tasks 4–5 tests.

---

### Task 1: Config field and selection-source value

**Files:**
- Modify: `packages/types/src/config/config.ts` (`RouterConfigSchema`, ~line 172) + `config.test.ts`
- Modify: `packages/core/src/router/router.ts:45` (`RouterSelectionSource` adds `'quota_reset'`)
- Modify: `packages/server/src/routes/pipeline/attempt-base/attempt-base.ts:7` (`AttemptSelectionSource` adds `'quota_reset'`), `packages/server/__tests__/pipeline-helpers/types.ts` (same union, if mirrored)

**Interfaces:**
- Produces: `RouterConfig['selection']: 'weighted' | 'quota-reset'`; `RouterSelectionSource` includes `'quota_reset'`.

- [ ] **Step 1: Failing test** in `config.test.ts`: `'router selection defaults to weighted and accepts quota-reset'` — `ConfigSchema.parse({ providers: {} }).router.selection === 'weighted'`; `{ router: { selection: 'quota-reset' } }` parses to `'quota-reset'`; `{ router: { selection: 'soonest' } }` throws.
- [ ] **Step 2: Run** `bun run --cwd packages/types test:unit src/config/config.test.ts` — FAIL.
- [ ] **Step 3: Implement** the field with `.describe('How to order candidates within one Provider priority tier: weighted draw, or subscriptions whose quota resets soonest first.')`; add the union members. If a generated JSON schema is checked in (`config-json-schema.ts` / `config-schema-ref.test.ts`), regenerate per that test's instructions.
- [ ] **Step 4: Run** the same + `bun run --cwd packages/types build && bun run --cwd packages/core build` — PASS.
- [ ] **Step 5: Commit** `feat(types): add the router.selection policy`

### Task 2: Reset ordering function

**Files:**
- Modify: `packages/server/src/routes/pipeline/quota-gate/quota-gate.ts` — extract `freshQuotaSnapshot(status, now): OAuthQuotaSnapshot | undefined` (ready, not stale, within max age) and use it in `quotaHeldUntil`; export it.
- Create: `packages/server/src/routes/pipeline/quota-order/index.ts`, `quota-order.ts`, `quota-order.test.ts`

**Interfaces:**
- Consumes: `freshQuotaSnapshot`, `quotaScopeCovers` (quota-gate).
- Produces: `orderByQuotaReset(candidates: readonly RouterCandidate<RuntimeProviderInstance>[], quotaStatus: (providerId: string) => OAuthQuotaCacheStatus, now: number): readonly RouterCandidate<RuntimeProviderInstance>[]` — per Design; keyed candidates returned as `{ ...candidate, selectionSource: 'quota_reset' }`.
- Produces: `applySelectionPolicy(candidates, selection: RouterConfig['selection'] | undefined, source: Pick<ProviderRouteSource, 'quotaStatus'>, now: number)` — returns `candidates` unchanged unless `selection === 'quota-reset'` and `source.quotaStatus` exists.

- [ ] **Step 1: Failing tests** (`quota-order.test.ts`, fixed `now`, candidates built with `routing.priority` and OAuth/`api` kinds):
  - `'tries the subscription whose allowance expires first'` — A weekly reset +6d, B +1d, same tier → `[B, A]`, both `selectionSource: 'quota_reset'`.
  - `'keys on the latest covering window, not the 5-hour one'` — A {5h +1h, weekly +6d}, B {5h +3h, weekly +1d} → `[B, A]` (Review Focus 1).
  - `'never reorders across priority tiers'` — tier 10: A(+6d); tier 0: B(+1d) → `[A, B]`.
  - `'unknown candidates follow the keyed ones in their original order'` — `[api-x, C(none), B(+1d)]` same tier → `[B, api-x, C]`, `api-x`/`C` keep their original `selectionSource` (Review Focus 2).
  - `'ties keep the router order'`; `'a stale or aged snapshot is unknown'`; `'windows that do not cover the model are ignored'`.
  - `applySelectionPolicy`: `'weighted'`/`undefined` → same array reference; no `quotaStatus` → same reference.
- [ ] **Step 2: Run** `bun run --cwd packages/server test:unit src/routes/pipeline/quota-order src/routes/pipeline/quota-gate` — FAIL.
- [ ] **Step 3: Implement.** Group consecutive candidates by `routing.priority`; within a group stable-sort keyed by key ascending, append unkeyed.
- [ ] **Step 4: Run** the same — PASS.
- [ ] **Step 5: Commit** `feat(server): order a priority tier by subscription quota reset`

### Task 3: Wire into generation and token counting

**Files:**
- Modify: `packages/server/src/routes/pipeline/attempt/attempt.ts` (`attemptCandidates`: apply before `prioritizeAffinity`, reusing the selection `now`)
- Modify: `packages/server/src/routes/token-count/token-count.ts:~136` (apply before `prioritizeAffinity`, `lease.snapshot.config?.router.selection`)
- Create: `packages/server/src/routes/pipeline/attempt/attempt.quota-order.test.ts`
- Create: `.changeset/quota-reset-ordering.md`

- [ ] **Step 1: Failing integration tests** (pattern of `attempt.quota-gate.test.ts`; config `router.selection: 'quota-reset'`, two OAuth subs, same priority, deterministic `random`):
  - `'policy on: the sooner-resetting subscription serves'` — first attempt is the +1d sub; its attempt span `selectionSource === 'quota_reset'`.
  - `'policy off: order is the weighted draw'` — same fixtures with `selection` omitted → order equals the run without quota data.
  - `'session affinity still wins under the policy'` — Responses adapter, affinity to the +6d sub → it serves (Review Focus 3).
  - token-count (in `packages/server/src/routes/token-count/token-count.test.ts` or a sibling `token-count.quota-order.test.ts`): `'token counting uses the same reset order'` — first counted candidate is the +1d sub (Review Focus 4).
- [ ] **Step 2: Run** `bun run --cwd packages/server test:unit src/routes/pipeline/attempt src/routes/token-count` — FAIL.
- [ ] **Step 3: Implement** both call sites with `applySelectionPolicy`.
- [ ] **Step 4: Run** `bun run --cwd packages/server test:unit src/routes` — PASS.
- [ ] **Step 5: Changeset** (one paragraph): new opt-in `router.selection: quota-reset` makes each priority tier try the subscription whose quota allowance expires soonest first, so allowance is not left to expire on one subscription while another is drained; session affinity still wins; also a Routing-page switch.
- [ ] **Step 6: Commit** `feat(server): apply the quota-reset policy to generation and token counting`

### Task 4: Dashboard API

**Files:**
- Modify: `packages/types/src/dashboard/routing/routing.ts` — `DashboardRoutingModelsResponse(Schema)` gains `selection: RouterConfig['selection']`; add `DashboardRoutingSelectionMutationSchema = z.strictObject({ selection: RouterConfigSchema.shape.selection.unwrap() })` (or equivalent required enum) and its type; extend the types package's DTO test if one covers these schemas.
- Modify: `packages/server/src/model-routing/inventory.ts` (`assembleRoutingInventory` sets `selection` from `config.router.selection`), `control-plane.ts` (`updateSelection(input)` → `configStore.mutateConfig` setting `router.selection` while keeping sibling `router` keys; returns `list()`), `index.ts` exports.
- Modify: `packages/server/src/dashboard-routes/routing/routing.ts` — `.put('/routing/selection', …)` with the same validator style and error mapping as `/routing/models`.
- Test: `packages/server/src/dashboard-routes/routing/routing.test.ts`, `packages/server/src/model-routing/inventory.test.ts`

- [ ] **Step 1: Failing tests:** GET `/routing/models` includes `selection: 'weighted'` by default; PUT `{ selection: 'quota-reset' }` → 200, response `selection: 'quota-reset'`, file's `router` keeps `models` and other keys; PUT `{ selection: 'x' }` → 400 `validation_failed`; no config file → 409 `config_unavailable` (Review Focus 5).
- [ ] **Step 2: Run** `bun run --cwd packages/server test:unit src/dashboard-routes/routing src/model-routing` — FAIL.
- [ ] **Step 3: Implement**; rebuild `@aio-proxy/types`.
- [ ] **Step 4: Run** the same — PASS.
- [ ] **Step 5: Commit** `feat(server): read and write the routing selection policy from the dashboard`

### Task 5: Routing page switch

**Files:**
- Modify: `packages/dashboard/src/modules/routing/services/routing-service.ts` (`updateRoutingSelectionMutationFn`)
- Create: `packages/dashboard/src/modules/routing/hooks/use-routing-selection-mutation.ts` (same cache update as `use-routing-mutation.ts`)
- Create: `packages/dashboard/src/modules/routing/components/routing-selection-policy/{index.ts,routing-selection-policy.tsx,routing-selection-policy.test.tsx}`
- Modify: `packages/dashboard/src/modules/routing/templates/routing-page.tsx` (render above the table when `query.data` exists)
- Modify: `packages/i18n/messages/{en,ja,ko,zh-Hans,zh-Hant}.json` — `dashboard.routing.selection_quota_reset` (label) and `dashboard.routing.selection_quota_reset_description`; run `bun run i18n:compile`

**Interfaces:**
- `RoutingSelectionPolicy: React.FC<{ readonly selection: 'weighted' | 'quota-reset'; readonly writable: boolean }>` — TanStack Form field `quotaReset: boolean`, `Switch` from `@aio-proxy/ui/components/switch`, row layout like `SettingsFieldRow` (local markup with `Field`/`Label` if that row is settings-private), `onCheckedChange` → mutation with `'quota-reset' | 'weighted'`; disabled while `!writable` or pending; on error resets the field to the server value.

- [ ] **Step 1: Failing component tests:** renders unchecked for `weighted`; toggling calls the mutation with `{ selection: 'quota-reset' }`; disabled when `writable` is false (Review Focus 5). Follow the existing `routing-table.test.tsx` / settings-page test setup for QueryClient and request mocking.
- [ ] **Step 2: Run** `bun run --cwd packages/dashboard test:unit src/modules/routing` — FAIL.
- [ ] **Step 3: Implement**; English copy: label "Spend the subscription that resets soonest first", description "Within each priority tier, try the subscription whose quota resets soonest before the weighted draw. Session affinity still takes precedence." (Chinese: "优先消耗最快重置的订阅" / "在同一 priority 层内，先尝试配额最快重置的订阅，再按权重抽取；会话亲和仍然优先。"; ja/ko/zh-Hant translated equivalently).
- [ ] **Step 4: Run** the same + `bun test packages/i18n/__tests__` — PASS.
- [ ] **Step 5: Commit** `feat(dashboard): add the quota-reset ordering switch to the Routing page`

### Task 6: Docs and preflight

- Modify: `README.md`, `README.zh-Hans.md` (Routing rules step 4: mention `router.selection: quota-reset`), `website/docs/{en,zh}/guide/routing/routing-rules.md` (section 6 gains a "Reset ordering" paragraph: config, key, unknown-after-known, affinity precedence, dashboard switch, `selection_source: quota_reset`).
- [ ] **Step 1: Edit** docs.
- [ ] **Step 2: Run** `bun run build && bun run preflight` — exit 0; record output.
- [ ] **Step 3: Commit** `docs: describe quota-reset ordering`
