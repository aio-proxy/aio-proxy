# OAuth Model Denylist and Alias Inherit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OAuth exposure becomes `catalog − excludedModels`, and plugin `defaultAliases` inherit at runtime instead of being written into the file.

**Architecture:** Split OAuth authored alias (`AuthoredOAuthAlias`, may contain `false` / `*`) from effective `ProviderAlias`. Resolve once in `createRuntimeProvider` / `withRoutingConfig`. Delete every persist path that seeds plugin defaults. Dashboard serializes only authored rows; inherit rows stay display-only.

**Tech Stack:** TypeScript, Bun test, Zod 4, Changesets. Dashboard: TanStack Form, existing alias-editor.

**Spec:** [docs/superpowers/specs/2026-09-03-oauth-model-denylist-design.md](../specs/2026-09-03-oauth-model-denylist-design.md)

## Global Constraints

- Domain terms: Provider ID, provider priority, provider weight.
- `false` and `*` exist only on authored types. Resolve is the only consumer. No shotgun `if (config === false)` in router / capabilities / `aliasEditorIssues`.
- Membership tests on authored maps use `Object.hasOwn`.
- Reserved `*` is checked after `trim`. `' *'` must not become a route.
- Two independent `z.strictObject` surfaces plus `OAuthProviderPatch`: mutation body, dashboard patch schema, login patch type.
- Per-entry plugin-default helper replaces throw-all `assertAliasTargetsInCatalog` / `validatedDefaultAliases` (including the `validation.ts` re-export).
- `preserve: true` cannot re-admit an `excludedModels` id. Authored target in `excludedModels` fails parse.
- OAuth edit serialization always sends `alias` as an object (`{}` if empty), never `undefined`.
- `providerEntry` drops leftover `models` and retains `excludedModels`.
- OAuth `replaceProvider` does not restore `alias` or `excludedModels` from `previous`.
- Changeset targets `aio-proxy` plus `@aio-proxy/types`, `@aio-proxy/core`, `@aio-proxy/server`, `@aio-proxy/dashboard` at the same bump. `aio-proxy` note states leftover-`models` widening.
- Already on `cursor/oauth-model-denylist-2e20`. Do not create another worktree.
- Colocated tests in same-name directories. Do not add files under `_test/`.
- Non-test files stay under 500 lines; split by responsibility before adding more.

---

## File map

- Create: `packages/types/src/provider-alias/oauth-alias.ts` — `AuthoredOAuthAlias`, schema, `resolveOAuthAlias`, `oauthExposedModels`.
- Create: `packages/types/src/provider-alias/oauth-alias.test.ts`
- Modify: `packages/types/src/provider-alias/provider-alias.ts` — `validateAliasTargets` kind branch; normalize skips `false`.
- Modify: `packages/types/src/provider.ts` — split OAuth `alias` / drop `models` / add `excludedModels`.
- Modify: `packages/types/src/dashboard-oauth.ts` — patch schema authored alias + `excludedModels`.
- Modify: `packages/core/src/plugins/default-aliases/` — per-entry helper; delete `insertMissingAliases`.
- Modify: `packages/core/src/plugins/account-login/` — `providerEntry`, `OAuthProviderPatch`, delete merge/seed.
- Modify: `packages/server/src/plugin-runtime/capabilities.ts` — denylist + resolve at both entry points.
- Modify: `packages/server/src/plugin-runtime/materialize.ts` — pass defaults; drop `CatalogJobDescriptor.defaultAliases`.
- Modify: `packages/server/src/catalog-scheduler.ts` + `server-state/index.ts` — delete merge hook.
- Modify: `packages/server/src/dashboard-routes/provider-mutation/provider-mutation.ts` — no OAuth alias/excludedModels restore.
- Modify: `packages/dashboard/src/modules/providers/lib/alias-editor/` — three-state rows + authored serialize.
- Modify: `packages/dashboard/src/modules/providers/lib/exposed-models.ts` + three call sites.
- Create: `.changeset/oauth-model-denylist.md`

---

### Task 1: Authored alias types and resolve helper

**Files:**
- Create: `packages/types/src/provider-alias/oauth-alias.ts`
- Create: `packages/types/src/provider-alias/oauth-alias.test.ts`
- Modify: `packages/types/src/provider-alias/index.ts` (barrel is `export *`)
- Modify: `packages/types/src/provider-alias/provider-alias.test.ts` (barrel pin list)

**Interfaces:**
- Produces:
  - `AuthoredOAuthAliasValue = AliasConfig | false`
  - `AuthoredOAuthAlias = Readonly<Record<string, AuthoredOAuthAliasValue>>`
  - `AuthoredOAuthAliasSchema`
  - `resolveOAuthAlias(authored, defaults, exposedCatalog?) => ProviderAlias`
  - `oauthExposedModels(catalogIds, excludedModels) => string[]`
  - `isAuthoredAliasConfig(value) => value is AliasConfig`

- [ ] **Step 1: Write failing tests** in `oauth-alias.test.ts` for: inherit on/off; `false` hide; authored override; later default appears; leftover file key stays at file value; `' *'` / `*: { model }` reject; `' *': false` is inherit-off; resolve drops excluded / missing-catalog targets; `preserve` cannot punch through denylist (effective map only); `oauthExposedModels` is catalog minus excluded.

- [ ] **Step 2: Run** `cd packages/types && bun test ./src/provider-alias/oauth-alias.test.ts` — expect FAIL (module missing).

- [ ] **Step 3: Implement** `oauth-alias.ts` with `false`-first parse that re-roots `AliasConfigSchema` issues onto the value path, reserved-key refine after `normalizeAliasName`, and resolve steps 3–5 from the spec. `exposedCatalog` omitted = skip step 5 (edit-view).

- [ ] **Step 4: Re-run tests** — expect PASS.

- [ ] **Step 5: Commit** `feat(types): add authored OAuth alias resolve helper`

---

### Task 2: Schema split and `validateAliasTargets`

**Files:**
- Modify: `packages/types/src/provider.ts`
- Modify: `packages/types/src/provider-alias/provider-alias.ts`
- Modify: `packages/types/src/dashboard-oauth.ts`
- Modify: `packages/types/src/plugin.test.ts` (leftover `models` stripped; `excludedModels` kept)
- Modify: `packages/types/src/provider-oauth-mutation.test.ts`
- Modify: `packages/types/src/alias-variant/alias-variant.test.ts` (patch schema `false` / `*` paths)
- Modify: `packages/core/src/config/parse-runtime-config.test.ts` (malformed oauth `models` no longer quarantines)

**Interfaces:**
- Consumes: `AuthoredOAuthAliasSchema`
- Produces: OAuth config / mutation / patch accept `excludedModels` + authored alias; leftover `models` stripped on `z.object` config schema; mutation/patch `strictObject` reject leftover `models`.

- [ ] **Step 1: Failing tests** — leftover `models` ignored on config parse; authored `false` / `*: false` parse; api/ai-sdk reject `false` / `*`; authored target in `excludedModels` fails at `alias.<key>.model`; patch schema errors still at `alias.<key>`; mutation rejects `models`.

- [ ] **Step 2: Run the new tests** — expect FAIL.

- [ ] **Step 3: Split `alias` off `SharedProviderSchemaBase` for OAuth; drop `modelsField` from OAuth; add `excludedModels`. Branch `validateAliasTargets` on `kind` (OAuth ignores leftover `models`). Patch schema `superRefine` with `kind: oauth`. `normalizeProviderAlias` skips `false` values.

- [ ] **Step 4: `cd packages/types && bun test`** — expect PASS. Fix any sibling tests that assumed OAuth `models`.

- [ ] **Step 5: Commit** `feat(types): parse OAuth denylist and authored alias`

---

### Task 3: Core persist stop + per-entry helper + `providerEntry`

**Files:**
- Modify: `packages/core/src/plugins/default-aliases/default-aliases.ts` (+ test)
- Modify: `packages/core/src/plugins/account-login/validation.ts`
- Modify: `packages/core/src/plugins/account-login/login.ts`
- Modify: `packages/core/src/plugins/account-login/login/stage.ts`
- Modify: create / relogin / constants-and-validation tests

**Interfaces:**
- Produces: `pluginDefaultAliases(adapter, catalog) => ProviderAlias | undefined` — catch hook, per-entry `safeParse` + catalog membership, `Object.hasOwn`, empty → `undefined`.
- `OAuthProviderPatch.alias: AuthoredOAuthAlias | undefined`; `excludedModels` instead of `models`.
- `providerEntry` does not write `models`; retains `excludedModels` unless patch has the key.

- [ ] **Step 1: Failing tests** — one bad default + three good → three inherit; throwing hook → empty; first login / re-login / `providerPatch` do not persist plugin defaults; `providerEntry` drops leftover `models` and keeps `excludedModels` when omitted.

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Implement helper; delete `insertMissingAliases`, `assertAliasTargetsInCatalog`, `validatedDefaultAliases` and the `validation.ts` re-export; delete `mergeInsertedAliases` and first-login `defaults` seed.

- [ ] **Step 4: `cd packages/core && bun test`** — expect PASS.

- [ ] **Step 5: Commit** `fix(core): stop writing plugin default aliases`

---

### Task 4: Server resolve, denylist, mutation

**Files:**
- Modify: `packages/server/src/plugin-runtime/capabilities.ts` (+ test)
- Modify: `packages/server/src/plugin-runtime/materialize.ts` (+ types.ts)
- Modify: `packages/server/src/catalog-scheduler.ts` + merge tests (delete merge behavior)
- Modify: `packages/server/src/server-state/index.ts`
- Modify: `packages/server/src/dashboard-routes/provider-mutation/provider-mutation.ts`
- Modify: `packages/server/src/dashboard-routes/provider-draft/provider-draft-operations.ts`
- Modify: `packages/server/src/oauth-login-session/manager.ts`
- Modify: `packages/server/src/server-state/oauth-views.ts` (use per-entry helper)
- Startup leftover-`models` warn on raw oauth entries (config envelope still sees `raw`)

**Interfaces:**
- `createRuntimeProvider` / `withRoutingConfig` take `defaults?: ProviderAlias` and set `provider.alias` to `resolveOAuthAlias(...)`.
- Cache path (`previous.identity === identity`) must pass current defaults.
- `exposedModelIds` for OAuth is `oauthExposedModels`. Draft Test gate uses `excludedModels`.
- `preservedAliasModels` runs on the effective map; `excludedModels` wins.

- [ ] **Step 1: Failing tests** — leftover `models` does not restrict exposure; inherit appears without file keys; cache reuse picks up a new plugin key; `preserve` cannot re-admit excluded id; OAuth PUT omit `alias` / `excludedModels` deletes them; leftover `models` warn.

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Implement. Delete `mergeCatalogDefaultAliases`, `CatalogSchedulerOptions.mergeDefaultAliases`, `CatalogMergeIdentity.defaultAliases`, `mergeHost` wiring, `CatalogJobDescriptor.defaultAliases`.

- [ ] **Step 4: `cd packages/server && bun test`** on the touched files, then broader server tests.

- [ ] **Step 5: Commit** `feat(server): resolve OAuth inherit at runtime`

---

### Task 5: Dashboard denylist + three-state alias editor

**Files:**
- Modify: `alias-editor.ts` — `AliasRow` three-state; authored `toAliasRecord` / `serializeAlias`; `aliasEditorIssues` skips `false` + inherited.
- Modify: `plugin-alias-suggestions.ts` — keep `applicablePluginAliases` (input = draft exposed set); delete `mergePluginAliasRows`.
- Modify: `exposed-models.ts` + `models-section`, `section-status`, `section-hint`, `use-provider-editor-page` (`weightTie`), `provider-editor-page` (exposure rail).
- Modify: `oauth-provider-edit.ts` — `excludedModels`; always send `alias` object on edit.
- Modify: form shapes; i18n `hint_models_*` if OAuth copy must say "still exposed".
- Tests: uncheck writes only that id; inherit row absent from mutation and `providerPatch`; hide → `false`; restore removes key; inherit off → `*: false` no snapshot; issues skip inherit/`false`; `weightTie` sees inherited names.

- [ ] **Step 1: Failing editor / save tests.**

- [ ] **Step 2: Run dashboard unit tests** — expect FAIL.

- [ ] **Step 3: Implement serializer + denylist UI. Edit mode never emits `alias: undefined`.

- [ ] **Step 4: Re-run dashboard unit tests** — expect PASS.

- [ ] **Step 5: Commit** `feat(dashboard): OAuth denylist and inherited alias rows`

---

### Task 6: Changeset and preflight

**Files:**
- Create: `.changeset/oauth-model-denylist.md`

```md
---
'@aio-proxy/types': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/dashboard': minor
'aio-proxy': minor
---

OAuth providers now hide models with `excludedModels` instead of a `models` whitelist. Leftover `models` keys are ignored and no longer restrict exposure — newly discovered catalog ids stay visible unless hidden. Plugin default aliases inherit at runtime and are no longer written into the config file.
```

- [ ] **Step 1: Add changeset.**
- [ ] **Step 2: `bun run preflight`** (or `bun run check` + package tests).
- [ ] **Step 3: Commit** `chore: changeset for OAuth model denylist`

---

## Spec coverage

| Spec requirement | Task |
| --- | --- |
| Authored vs effective types | 1 |
| `OAuthProviderPatch` typed as authored | 3 |
| Dual strict schemas | 2 |
| Resolve at createRuntimeProvider / withRoutingConfig + cache | 4 |
| Per-entry helper; delete throw-all + re-export | 3 |
| `preserve` vs denylist | 1, 4 |
| Write-path deletions + providerPatch serializer | 3, 5 |
| `providerEntry` models drop / excludedModels keep | 3 |
| `replaceProvider` no OAuth restore | 4 |
| AliasRow three-state; issues skip; weightTie effective | 5 |
| `exposedModels` three call sites | 5 |
| Leftover `models` startup warn | 4 |
| Changeset lockstep + leftover-models note | 6 |
