# Antigravity Live Alias Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate Antigravity default aliases from live `fetchAvailableModels` displayName / `-tiered` collapse, route clients through unpreserved logical aliases, and insert-only merge new keys on re-login and TTL refresh.

**Architecture:** The plugin collapses picker IDs into `ModelCatalog.metadata.antigravityFamilies` and descriptor metadata. Runtime thinking/envelope read that catalog, never `ANTIGRAVITY_FAMILIES`. The host adds a monotonic `StoredCatalog.revision`, an atomic `compareAndSwapCatalog`, and a shared insert-only alias helper used after re-login commit and after a fenced TTL write.

**Tech Stack:** Bun, TypeScript, Zod via plugin-sdk, Bun test, Changesets, existing OAuth login/catalog scheduler.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-21-antigravity-live-alias-collapse-design.md` (working-tree revision after 2026-08-21 c, including Codex P2 clarifications).
- Domain language: Provider ID, Provider weight (`AGENTS.md`).
- Do not apply leftover `#185` worktree files (`.changeset/plugin-array-alias-variants.md`, plugin-sdk record-ban, core login record-ban). This plan owns Antigravity emitting `{ when, model, preserve }[]` rows from HEAD's record-shaped `aliases.ts`. User-config Record variants stay legal.
- New generated aliases/variants are always `preserve: false`.
- New aliases emit only `low` / `medium` / `high`. Do not generate `minimal` or `max`.
- Delete public `ANTIGRAVITY_FAMILIES` (including `wireProfiles` / retired set). Filter deprecated IDs from discovery `deprecatedModelIds` old keys plus the existing hard denylist.
- OpenAI `settings.reasoning` is captured in `createAntigravityLanguageModel` **before** the Google codec; never recover effort from codec `thinkingLevel` / `thinkingBudget`.
- `minimal` is accepted only when the current wire id ends with `-extra-low`.
- TTL catalog/diagnostic writes go through fenced repository methods. `runtimeRevision` is the login generation (credential refresh does not increment it).
- Every catalog row replace assigns `revision = (current ?? 0) + 1` (including `applyCatalog` and compensation `replaceCatalog`). Restored content must not rewind `revision`.
- Changeset must target `@aio-proxy/plugin-google-antigravity`, `@aio-proxy/core`, and `aio-proxy` at the same bump level. Never a changeset that targets only an internal package.
- Colocate tests next to source. Handwritten non-test files stay under 500 lines; split by responsibility before 400 if a file grows two jobs.
- Prefer `es-toolkit` catalog imports when adding shared utilities; do not add new utility dependencies.
- TDD: write the failing test, run it, then implement. Commit after each task.
- Final verification: `bun run check` plus affected package tests; `bun run preflight` before claiming done.

## File Structure

Plugin:

- `packages/plugins/google-antigravity/src/catalog/collapse/` — picker list + fold + logicalId + discard rules (`index.ts`, `collapse.ts`, `collapse.test.ts`).
- `packages/plugins/google-antigravity/src/catalog/classify/` — `classifyProvider` (`index.ts`, `classify.ts`, `classify.test.ts`).
- `packages/plugins/google-antigravity/src/catalog/families.ts` — delete after Tasks 4–5; do not keep a Gemini version table.
- `packages/plugins/google-antigravity/src/catalog/discover.ts` — parse picker fields, persist descriptor metadata, attach catalog metadata.
- `packages/plugins/google-antigravity/src/catalog/aliases.ts` — map `antigravityFamilies` to suggestions.
- `packages/plugins/google-antigravity/src/catalog/snapshot.ts` — live-shaped displayNames + `antigravityPicker`.
- `packages/plugins/google-antigravity/src/protocol/thinking.ts` — catalog mapper.
- `packages/plugins/google-antigravity/src/runtime/{envelope,provider,google-model,google-fetch}.ts` — catalog profiles + pre-codec reasoning.

Host:

- `packages/core/src/db/schema/plugin-oauth.ts` + new drizzle migration — `oauth_catalog.revision`.
- `packages/core/src/plugins/repository/{types,rows,plugin-state,pending-operations}.ts` — revision + CAS + fenced diagnostic.
- `packages/core/src/plugins/default-aliases/` — validate + insert-only helper; export from `packages/core/src/plugins/index.ts`.
- `packages/core/src/plugins/account-login/login.ts` — after `completeAccountOperation`, second coordinated config mutation for insert-only. Never insert inside the stage transaction.
- `packages/core/src/plugins/account-login/login/stage.ts` + `validation.ts` — create writes suggestions when `alias` is absent from the patch; re-login stage does not call `defaultAliases`.
- `packages/server/src/{catalog-scheduler.ts,plugin-runtime/types.ts,plugin-runtime/materialize.ts,server-state/index.ts}` — job identity + merge callback.
- `packages/plugins/google-antigravity/src/runtime/transport.ts` and `token-count.ts` — envelope/thinking catalog maps (Task 4).

---

### Task 1: Collapse algorithm

**Files:**
- Create: `packages/plugins/google-antigravity/src/catalog/classify/index.ts`
- Create: `packages/plugins/google-antigravity/src/catalog/classify/classify.ts`
- Create: `packages/plugins/google-antigravity/src/catalog/classify/classify.test.ts`
- Create: `packages/plugins/google-antigravity/src/catalog/collapse/index.ts`
- Create: `packages/plugins/google-antigravity/src/catalog/collapse/collapse.ts`
- Create: `packages/plugins/google-antigravity/src/catalog/collapse/collapse.test.ts`

**Interfaces:**
- Produces: `classifyProvider(descriptor: { readonly metadata?: unknown }): 'gemini' | 'claude' | 'none'`
- Produces: `type AntigravityFamily = { logicalId: string; kind: 'split' | 'tiered' | 'same-wire'; thinking: { mode: 'gemini' | 'claude' | 'none' }; base: string; variants: { effort: 'low' | 'medium' | 'high'; model: string }[] }`
- Produces: `pickerModelIds(input: { languageIds: ReadonlySet<string>; tieredModelIds?: { flash?: string[] }; agentModelSorts?: { groups: { modelIds: string[] }[] }[] }): string[]`
- Produces: `collapseAntigravityFamilies(input: { pickerIds: readonly string[]; descriptorsById: ReadonlyMap<string, ModelDescriptor>; deprecatedModelIds?: Record<string, { newModelId?: string }> }): AntigravityFamily[]`

- [ ] **Step 1: Write classify + collapse tests**

Cover spec cases: 3.6 split (drop competing `*-tiered`), 3.5 displayName `(Low)` not `(Extra Low)`, 3.1 high prefers `gemini-pro-agent`, 3.7 tiered, GPT-OSS `thinking.mode === 'none'`, unknown `gemini-3.8-flash-low/medium/high` → `gemini-3.8-flash`, `foo` vs `foo-thinking` same-wire keeps earlier picker member, `tieredModelIds.flash` prepended, `pro`/`flashLite` not prepended.

```ts
test('collapses a live-shaped 3.5/3.6/3.7/claude/gpt-oss picker', () => {
  const families = collapseAntigravityFamilies(liveShapedInput());
  expect(families.map((family) => family.logicalId)).toEqual([
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.1-pro',
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'gpt-oss-120b',
  ]);
  expect(families.find((family) => family.logicalId === 'gemini-3.6-flash-tiered')).toBeUndefined();
  expect(families.find((family) => family.logicalId === 'gemini-3.1-pro')?.variants).toContainEqual({
    effort: 'high',
    model: 'gemini-pro-agent',
  });
  expect(families.find((family) => family.logicalId === 'gpt-oss-120b')?.thinking.mode).toBe('none');
});

test('does not fold Extra Low displayName into low', () => {
  expect(
    collapseAntigravityFamilies({
      pickerIds: ['gemini-3.5-flash-extra-low'],
      descriptorsById: new Map([
        ['gemini-3.5-flash-extra-low', { id: 'gemini-3.5-flash-extra-low', displayName: 'Gemini 3.5 Flash (Extra Low)' }],
      ]),
    }).map((family) => family.kind),
  ).toEqual(['same-wire']);
});
```

- [ ] **Step 2: Run tests and confirm they fail**

Run: `bun test --preload=./test/setup.ts src/catalog/collapse/collapse.test.ts src/catalog/classify/classify.test.ts`  
(cwd: `packages/plugins/google-antigravity`)

Expected: FAIL (modules missing).

- [ ] **Step 3: Implement classify + collapse per spec §折叠算法 / §Picker 名单 / §classifyProvider**

`classifyProvider`: `apiProvider` then `modelProvider`; case-insensitive includes `gemini` / `anthropic`; else `none`. Family mode: member priority `gemini > claude > none`.

DisplayName regex: `^(.+) \((Low|Medium|High)\)$` whole-string, case-sensitive.

logicalId: strip `-extra-low|-low|-medium|-high|-tiered` (longest); same-wire also strip trailing `-thinking`. If stems agree, use stem; else slugify display stem keeping digit dots.

Discard: tiered vs split → drop tiered; same-wire vs split/tiered → drop same-wire; same kind+logicalId → earliest picker member, then more variants, then smaller `base`.

Default `base`: medium variant if present, else first picker member of the family.

- [ ] **Step 4: Re-run tests until they pass**

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/google-antigravity/src/catalog/classify \
  packages/plugins/google-antigravity/src/catalog/collapse
git commit -m "$(cat <<'EOF'
feat(antigravity): collapse live catalog families

Fold picker wire ids by displayName and -tiered without a handwritten
Gemini version table.
EOF
)"
```

---

### Task 2: Discover metadata and default aliases

**Files:**
- Modify: `packages/plugins/google-antigravity/src/catalog/discover.ts`
- Modify: `packages/plugins/google-antigravity/src/catalog/discover.test.ts`
- Modify: `packages/plugins/google-antigravity/src/catalog/aliases.ts`
- Modify: `packages/plugins/google-antigravity/src/catalog/aliases.test.ts`

**Interfaces:**
- Consumes: Task 1 collapse/classify
- Produces: `ModelCatalog.metadata.antigravityPicker` and `metadata.antigravityFamilies`
- Produces: `defaultAntigravityAliases(catalog)` from families; every row `preserve: false`

- [ ] **Step 1: Write tests**

- Parse `agentModelSorts`, `tieredModelIds`, `deprecatedModelIds`.
- Deprecated old keys and denylist/internal are absent from `language` and cannot be alias targets.
- `maxOutputTokens` omitted when upstream is missing/non-positive (no `64000` invent).
- Descriptor metadata keeps `thinkingBudget` (including `-1`), `minThinkingBudget`, `apiProvider`/`modelProvider`, `model` as `modelEnum`.
- `defaultAntigravityAliases` emits `gemini-3.8-flash` for unknown 3.8 split IDs present in catalog+picker; all `preserve: false`; only low/medium/high; **variants are `{ when, model, preserve }[]` arrays**, not effort-key records (convert from HEAD `aliases.ts`).
- Generated aliases hide wire targets: `new Router([{ id, enabled: true, models: languageIds, alias: suggestions }]).resolve('gemini-3.5-flash-low')` throws `RouterModelNotFoundError`; `/v1/models` slugs do not include that wire id.

- [ ] **Step 2: Run and confirm fail**

Run: `bun test --preload=./test/setup.ts src/catalog/discover.test.ts src/catalog/aliases.test.ts` (cwd: plugin package)

- [ ] **Step 3: Implement**

Extend `discoveredModelSchema` / `discoverySchema`. `normalizeDiscoveredModels` takes `deprecatedModelIds` old keys instead of `ANTIGRAVITY_RETIRED_MODEL_IDS`. Persist extra fields under `metadata.antigravity`. After building language, compute picker + collapse and set catalog metadata.

`defaultAntigravityAliases` reads `metadata.antigravityFamilies`; skip family if any target missing from `catalog.language`; skip self-referential empty-`when` aliases (will not occur).

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(antigravity): emit aliases from discovered families

Persist picker metadata on the catalog and generate unpreserved
low/medium/high variants from collapse output.
EOF
)"
```

---

### Task 3: Catalog-driven thinking mapper

**Files:**
- Modify: `packages/plugins/google-antigravity/src/protocol/thinking.ts`
- Modify: `packages/plugins/google-antigravity/src/protocol/thinking.test.ts`

**Interfaces:**
- Consumes: catalog families + descriptor metadata
- Produces: `bindAntigravityThinking(catalog: ModelCatalog)` or pass catalog into `geminiThinkingConfig` / `applyAntigravityThinking`

- [ ] **Step 1: Rewrite tests off `ANTIGRAVITY_FAMILIES`**

Use a small catalog fixture. Required cases from spec §测试:

- split effort/wire mismatch rejects
- tiered + `thinkingBudget: -1` leaves `thinkingLevel`
- `minimal` on `…-extra-low` uses catalog budget
- `gemini-3.8-flash` (medium base) + `minimal` rejects
- `off`/`none` → budget 0 even if `minThinkingBudget > 0`
- Claude adaptive constants; `max` still 32768
- GPT-OSS `none` does not remap
- Gemini same-wire + `high` allowed (tiered semantics)
- Anthropic `fixed` on Gemini: `minThinkingBudget` enforced, no 1024 Claude floor
- Claude `fixed`: `>= max(1024, minThinkingBudget ?? 1024)`

- [ ] **Step 2: Run and confirm fail**

- [ ] **Step 3: Implement mapper**

Look up family by wire id. Mode from family or `classifyProvider`. Gemini split: variant.model must equal wire for low/medium/high. Gemini tiered/same-wire: those efforts always ok. Budget: positive `thinkingBudget` else pass `thinkingLevel`. `xhigh` → `high`.

Callers that today take only `modelId` must receive catalog (raw + applyAntigravityThinking). Prefer a bound helper created from `RuntimeContext.catalog` to avoid signature churn at every call.

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(antigravity): map thinking from catalog metadata

Replace the handwritten family budget table with discovered
thinkingBudget and explicit extra-low minimal compatibility.
EOF
)"
```

---

### Task 4: Envelope/runtime catalog profiles and pre-codec reasoning

**Files:**
- Modify: `packages/plugins/google-antigravity/src/runtime/envelope.ts`
- Modify: `packages/plugins/google-antigravity/src/runtime/provider.ts`
- Modify: `packages/plugins/google-antigravity/src/runtime/google-model.ts`
- Modify: `packages/plugins/google-antigravity/src/runtime/google-fetch.ts`
- Modify: `packages/plugins/google-antigravity/src/runtime/transport.ts` (every CCA envelope, including retries, is created here)
- Modify: `packages/plugins/google-antigravity/src/runtime/token-count.ts` (also calls thinking / google-fetch)
- Modify: `packages/plugins/google-antigravity/src/runtime/raw.ts`
- Modify: existing envelope/provider/google-model/google-fetch/transport/token-count tests
- Keep `families.ts` until Task 5; Task 4 must not delete it while `snapshot.ts` still imports `modelCapabilities`

**Interfaces:**
- Consumes: descriptor metadata + families
- Produces: transport/envelope always see `profileFor` / `familyFor` / thinking binder from `context.catalog`

- [ ] **Step 1: Write tests**

- New wire only in catalog (not old `wireProfiles`) still gets `modelEnum` / `maxOutputTokens` on the CCA envelope.
- Missing `maxOutputTokens` does not inject a limit.
- Non-picker Claude wire (`classifyProvider === 'claude'`) still sets tool mode `VALIDATED`.
- OpenAI `settings.reasoning = 'high'` becomes adaptive before codec; body `thinkingConfig` is mapper output.
- OpenAI `reasoning = 'none'` on `gemini-3*` → `thinkingBudget: 0`, never `thinkingLevel: minimal`.
- OpenAI `reasoning = 'high'` on `gemini-pro-agent` / Claude does not keep codec numeric budgets.

- [ ] **Step 2: Run and confirm fail**

- [ ] **Step 3: Implement**

`createGoogleAntigravityRuntime` builds maps and thinking binder; pass them into `AntigravityTransport` (constructor, used by every `execute` including retries), language model, raw resolver, and token-count. `createAntigravityLanguageModel`: if `aioProxy.thinking` absent and `settings.reasoning` is a string other than `provider-default`, synthesize thinking and strip `settings.reasoning`. `google-fetch` replaces `thinkingConfig` when thinking is present.

Do not delete `families.ts` in this task.

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(antigravity): drive envelope and reasoning from catalog

Apply wire profiles on every request and capture OpenAI reasoning
before the Google codec can rewrite it.
EOF
)"
```

---

### Task 5: Snapshot uses the same collapse

**Files:**
- Modify: `packages/plugins/google-antigravity/src/catalog/snapshot.ts`
- Create or modify colocated snapshot tests
- Delete: `packages/plugins/google-antigravity/src/catalog/families.ts` and `families.test.ts` after snapshot no longer imports them. `rg ANTIGRAVITY_FAMILIES packages/plugins/google-antigravity` must be empty.

**Interfaces:**
- Consumes: Task 1–2
- Produces: `staticAntigravityCatalog()` with live-shaped displayNames and `metadata.antigravityPicker`

- [ ] **Step 1: Write test** that snapshot collapse equals collapse of the same models as a live-shaped picker fixture (Recommended + `tieredModelIds.flash`). Extra-low displayName must be `Gemini 3.5 Flash (Low)`.

- [ ] **Step 2: Run and confirm fail**

- [ ] **Step 3: Rewrite snapshot models** (add 3.6 / 3.7-tiered / gpt-oss as needed), attach picker metadata, run `normalize`+collapse (or call the same discover assembly helper). Write `modelEnum` / `maxOutputTokens` on each descriptor. Then delete `families.ts`.

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
fix(antigravity): align snapshot display names with collapse

First-login fallback can run the same picker fold as a live catalog.
EOF
)"
```

---

### Task 6: Catalog revision, CAS, and fenced diagnostics

**Files:**
- Modify: `packages/core/src/db/schema/plugin-oauth.ts`
- Create: drizzle migration via `bun run build:migrations` in `packages/core`
- Modify: `packages/core/src/plugins/repository/types.ts`
- Modify: `packages/core/src/plugins/repository/rows.ts`
- Modify: `packages/core/src/plugins/repository/plugin-state.ts`
- Modify: `packages/core/src/plugins/repository/pending-operations.ts`
- Modify: `packages/core/src/plugins/repository/plugin-state.test.ts`
- Modify: `packages/core/src/plugins/repository/pending-operations.test.ts`

**Interfaces:**
- Produces: `StoredCatalog.revision: number`
- Produces: `compareAndSwapCatalog(input): { ok: false } | { ok: true; revision: number }`
- Produces: `writeCatalogUnavailableIfCurrent(input): boolean`
- `writeCatalog` remains for account transactions and also increments revision

- [ ] **Step 1: Write repository tests**

- First write → revision 1; second write → 2.
- Compensation restore of catalog **content** still increments revision (does not rewind).
- CAS fails when `refreshedAt >= startedAt`, when `runtimeRevision` mismatches, when pending op exists, when plugin/capability mismatch; on failure neither catalog nor diagnostic change.
- CAS success increments revision and clears `CATALOG_UNAVAILABLE`.
- `writeCatalogUnavailableIfCurrent` no-ops under the same failed fence.

- [ ] **Step 2: Run and confirm fail**

- [ ] **Step 3: Add `revision` integer column default 0; implement increment on every `replaceCatalog`; implement the two fenced methods in one SQLite transaction each.**

`compareAndSwapCatalog` input: `providerId`, `catalog`, `refreshedAt`, `startedAt`, `plugin`, `capability`, `accountRuntimeRevision`.

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(core): fence catalog writes against re-login

Give oauth catalogs a monotonic revision and reject TTL updates
that lose the account generation or hit a pending operation.
EOF
)"
```

---

### Task 7: Insert-only helper; create vs re-login

**Files:**
- Create: `packages/core/src/plugins/default-aliases/index.ts`
- Create: `packages/core/src/plugins/default-aliases/default-aliases.ts`
- Create: `packages/core/src/plugins/default-aliases/default-aliases.test.ts`
- Modify: `packages/core/src/plugins/account-login/validation.ts` (delegate `validatedDefaultAliases`; fix `providerEntry` alias fallthrough)
- Modify: `packages/core/src/plugins/account-login/login/stage.ts`
- Modify: `packages/core/src/plugins/account-login/login.ts`
- Modify: `packages/core/src/plugins/index.ts` (export the helper)
- Modify: `packages/core/src/plugins/account-login/create.test.ts`
- Modify: `packages/core/src/plugins/account-login/relogin.test.ts`

**Interfaces:**
- Produces: `assertAliasTargetsInCatalog(suggestions, catalog): ProviderAlias`
- Produces: `insertMissingAliases(base: ProviderAlias, suggestions: ProviderAlias): ProviderAlias`
- Produces: `validatedDefaultAliases(adapter, catalog)` as a thin wrapper (create path)
- Re-login `stageAccountWrite` does **not** call `defaultAliases`
- After `completeAccountOperation` in `login.ts`, a **second** `coordinateProviderCommit` / `config.transaction` runs insert-only. Throw there must **not** `compensateAccountOperation`
- `providerEntry` alias uses **nullish** fallback, not `Object.hasOwn`: `patch?.alias ?? existing?.['alias'] ?? defaults`. The dashboard login session always reconstructs `providerPatch` with `alias: input.providerPatch.alias` which is often `undefined` while the key is still present (`packages/server/src/oauth-login-session/manager.ts`). `Object.hasOwn` would treat that as an explicit empty alias and drop create defaults / wipe re-login aliases. Test both a sparse `{ weight: 2 }` patch and a reconstructed `{ name, enabled, weight, proxy, alias: undefined, transforms }` patch.

- [ ] **Step 1: Write tests**

- `insertMissingAliases` keeps existing keys byte-identical; inserts missing keys only.
- Create + no patch: still writes full suggestions; missing target still fails create.
- Create + reconstructed server patch `{ alias: undefined, weight: 2, ... }`: still writes full suggestions (nullish, not `hasOwn`).
- Create + patch **without** `alias` key (`providerPatch: { weight: 2 }`): still writes full suggestions.
- Create + explicit `providerPatch.alias`: patch is final (no insert).
- Re-login: `defaultAliases` is **not** called during the account transaction; after `completeAccountOperation`, new keys appear; edited keys stay.
- Re-login: `defaultAliases` throwing on the post-commit merge leaves catalog/credential intact (no compensate).
- Update current test `re-login preserves an edited alias despite catalog suggestions` (it currently expects `suggestions === 0`).

- [ ] **Step 2: Run and confirm fail**

- [ ] **Step 3: Implement helper + login.ts post-commit merge**

`buildProviderEntry` for `currentAccount !== null` must pass `defaults: undefined`. In `login.ts`, after `completeAccountOperation`, if this was a re-login and discover succeeded, run insert-only inside `coordinateProviderCommit` (or a second `config.transaction`). Catch merge errors, log, do not compensate, do not write `CATALOG_UNAVAILABLE`. Fix `providerEntry` with `patch?.alias ?? existing?.['alias'] ?? defaults` (nullish, matching the server session reconstruction).

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(core): insert missing OAuth aliases after re-login

Keep existing alias keys stable and apply catalog suggestions only
for keys the user does not already have.
EOF
)"
```

---

### Task 8: TTL scheduler merge callback

**Files:**
- Modify: `packages/server/src/plugin-runtime/types.ts`
- Modify: `packages/server/src/plugin-runtime/materialize.ts`
- Modify: `packages/server/src/catalog-scheduler.ts`
- Modify: `packages/server/src/config-store.ts`
- Modify: existing catalog-scheduler / plugin-runtime / config-store tests
- Modify: `packages/server/src/server-state/index.ts`

**Interfaces:**
- `CatalogJobDescriptor` gains `plugin`, `capability`, `accountRuntimeRevision`, optional bound `defaultAliases` (function, not adapter)
- `CatalogSchedulerOptions.mergeDefaultAliases?(providerId, catalog, identity)`
- `#run` captures `startedAt` **before** `discover`
- Success: `compareAndSwapCatalog`; only if `ok` call merge **outside** the discover/CAS `catch` (merge throw must not become `CATALOG_UNAVAILABLE`)
- Failure: `writeCatalogUnavailableIfCurrent` only
- `mutateProvidersNow`: if `fn(providers)` returns the **same object reference** as `providers`, do not write a new top-level config (no verify/rebuild). Insert-only helper returns the input `providers` object when it inserted nothing. Do not call a write and then hope to skip inside it.

- [ ] **Step 1: Write tests**

- `startedAt` is recorded before discover (inject `now` + delayed discover; a catalog written after `startedAt` loses CAS).
- Insert-only on successful refresh; merge throw keeps catalog and does **not** write `CATALOG_UNAVAILABLE`.
- Config store not ready: catalog writes, merge skipped, no throw.
- plugin/capability/`runtimeRevision` mismatch or pending op or revision change: no insert.
- Pre-relogin job cannot write catalog/diagnostic while a pending update exists (even if `refreshedAt` is old).
- `mutateProviders` identity no-op: returning the input providers object does not write/rebuild. Merge with no new keys uses that path.

- [ ] **Step 2: Run and confirm fail**

- [ ] **Step 3: Implement**

Late-bind merge callback (scheduler may be constructed before `ConfigStore`). Merge fn: identity checks fail or nothing to insert → `return providers` (same reference). `mutateProvidersNow` short-circuits when `nextProviders === providers`. Rebuild/verify only runs when a key was inserted.

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(server): merge new default aliases on catalog refresh

Existing accounts pick up newly discovered logical ids without
overwriting user edits or in-flight re-login.
EOF
)"
```

---

### Task 9: Changeset and preflight

**Files:**
- Create: `.changeset/antigravity-live-alias-collapse.md`
- Do not touch `.changeset/plugin-array-alias-variants.md`

- [ ] **Step 1: Add changeset**

```md
---
'@aio-proxy/plugin-google-antigravity': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'aio-proxy': minor
---

Generate Antigravity default aliases from live model discovery and insert newly seen logical ids on refresh.
```

If plugin-sdk types were exported, add `@aio-proxy/plugin-sdk` at the same bump and keep `aio-proxy`. Do not use `.changeset/plugin-array-alias-variants.md`.

- [ ] **Step 2: Run `bun run check` and the touched package tests, then `bun run preflight`**

- [ ] **Step 3: Commit changeset + any preflight-only fixes**

```bash
git commit -m "$(cat <<'EOF'
chore: add changeset for live Antigravity aliases

Record the plugin and host behavior change on the published
aio-proxy release notes.
EOF
)"
```

---

## Self-review

**Spec coverage:** collapse, picker, preserve:false + router hide, thinking mapper, pre-codec OpenAI reasoning, envelope/transport/token-count, snapshot picker, CAS+revision+pending fence, create alias-absent patch, re-login post-`completeAccountOperation` insert-only, TTL startedAt + merge-outside-catch, changeset including server — each has a task.

**Placeholders:** none intended; implementers must copy algorithms from the spec when a snippet is abbreviated.

**Types:** `AntigravityFamily`, `compareAndSwapCatalog`, `insertMissingAliases`, `CatalogJobDescriptor` fields are named consistently across tasks.
