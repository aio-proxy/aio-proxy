# Plan review — 9 parallel verifiers against real source

Plan: `docs/superpowers/plans/2026-08-12-provider-editor-redesign.md`

---

## Group t8-10 — needs-fixes

### [1] MAJOR — plan line 971

**Claim:** Task 8 Step 1's test asserts `expect(await getCachedModelSlugs()).toEqual([])` as a cold-cache case after only `clearModelsCache()`, and Step 3 claims the suite then passes.

**Evidence:** packages/core/src/models-dev/index.test.ts:46-51 seeds the disk cache for every test: `beforeEach(async () => { home = mkdtempSync(...); process.env.AIO_PROXY_HOME = home; await fileCacheStorage.setItem('models-dev-providers', providerMap); clearModelsCache(); });` with `providerMap` holding openai/anthropic/google/openrouter. `clearModelsCache()` only clears the in-memory LRUs (packages/core/src/models-dev/index.ts:48-52), and `readCachedProviderMap` (:57-65) falls back to the seeded file cache, so the first assertion returns 4 slugs, not []. The file's own cold-cache test does it correctly at :125-127: `// Drop the seeded map so the file cache misses; ... await fileCacheStorage.removeItem('models-dev-providers'); clearModelsCache();`

**Fix:** Prefix the cold-cache assertion with `await fileCacheStorage.removeItem('models-dev-providers');` before `clearModelsCache()`, mirroring index.test.ts:125-127.

### [2] MINOR — plan line 1137

**Claim:** Step 1 cites `packages/ui/AGENTS.md:17` as the source of the shadcn add command.

**Evidence:** `packages/ui/AGENTS.md` does not exist (`ls packages/ui` -> CHANGELOG.md, components.json, node_modules, package.json, src, tsconfig.json). The rule lives in packages/ui/src/components/AGENTS.md, line 3 `Files in this directory are managed by the shadcn CLI and must not be edited manually.` and line 8 `bun x --bun --no-install shadcn add <component> --overwrite`.

**Fix:** Cite `packages/ui/src/components/AGENTS.md:8`.

### [3] MINOR — plan line 1147

**Claim:** Step 2 'Verify the package builds' via `bun run --filter @aio-proxy/ui build` — PASS.

**Evidence:** packages/ui/package.json scripts: `"build": "bun -e \"void 0\""` — a no-op that always exits 0 and never typechecks or bundles slider.tsx. There is no typecheck script in packages/ui; the actual type gate is the root `"lint:types": "oxlint --type-aware --type-check ... ."`.

**Fix:** Replace the step with `bun run lint:types` (or defer verification to the first task that imports the slider), since the ui `build` script cannot fail.

---

## Group t7 — needs-fixes

### [4] BLOCKER — plan line 864

**Claim:** The plan claims the merge path through `replaceProvider` restores `plugin`/`capability` from the persisted entry, so Step 4's resolution change admits oauth drafts. It does not — the merged candidate loses `plugin`/`capability`, `ProviderSchema.safeParse` fails, and resolution still returns `persisted_provider_mismatch`, so Step 3's first two tests keep failing after Step 4 is implemented exactly as written.

**Evidence:** packages/server/src/dashboard-routes/provider-mutation/provider-mutation.ts:89-91 `const next = retainRedactedSecrets(previous, provider);` then only `for (const key of ['headers', 'metadata', 'proxy', 'transforms'] as const) { if (provider[key] === undefined && previous[key] !== undefined) next[key] = previous[key]; }` (plus `alias` at :99-101 and `apiKey` at :103-110) — `plugin`/`capability` are never restored. packages/server/src/dashboard-routes/provider-secrets/provider-secrets.ts:58 `return mergeRecord(previous, submitted, false);` and :92 `return mapValues(submitted, (value, key) => ...)` — the result contains ONLY submitted keys. packages/types/src/provider.ts:218-228 `OAuthProviderMutationBodySchema = z.strictObject({ kind, id, name, enabled, weight, proxy, ...metadataField, alias, transforms })` — no `plugin`/`capability`, so the draft body cannot supply them. packages/types/src/provider.ts:104-112 `OAuthPluginProviderSchema = z.object({ ... plugin: PluginPackageNameSchema, capability: CapabilityIdSchema, ... })` — both required, so `ProviderSchema.safeParse(candidate)` (provider-draft-resolution.ts:58) fails and the new guard's `!parsed.success` branch returns `persisted_provider_mismatch`. The dedicated helper that does inject them is packages/server/src/dashboard-routes/provider-mutation/provider-mutation.ts:134-136 `replaceProvider(record, providerId, { ...provider, plugin: previousValue['plugin'], capability: previousValue['capability'], ...(previousValue['options'] === undefined ? {} : { options: previousValue['options'] }) })`.

**Fix:** In `resolveProviderDraft`'s non-identityChanged merge path, route oauth drafts through `replaceOAuthProvider` (already re-exported from `../provider-mutation` via `export * from './provider-mutation'`) instead of `replaceProvider`, e.g. `const merge = draft.kind === ProviderKind.OAuth ? replaceOAuthProvider : replaceProvider;` — or explicitly carry `plugin`, `capability`, and `options` from `previous` onto `draftBody` before the `replaceProvider` call. Then drop the false parenthetical on plan line 864.

### [5] MAJOR — plan line 878

**Claim:** Step 4 instructs deleting the `if (testProvider.kind === ProviderKind.OAuth) return failure('test_request_failed');` bail as "now-unreachable", but that bail is what type-narrows `testProvider` for the materialization helpers. Removing it makes the api/ai-sdk body fail to typecheck.

**Evidence:** packages/types/src/provider.ts:248-249 `export const ProviderSchema = z.discriminatedUnion('kind', [ApiProviderSchema, OAuthProviderSchema, AiSdkProviderSchema])` — so `const testProvider = ProviderSchema.parse(...)` at packages/server/src/dashboard-routes/provider-draft/provider-draft-operations.ts:61 is typed as the full `Provider` union, including oauth. The plan (line 713) keeps the helpers' `Exclude` types: provider-draft-operations.ts:96-99 `function materializeDraftRuntime(state: ServerState, provider: Exclude<Provider, { kind: ProviderKind.OAuth }>)`, called at :63 as `materializeDraftRuntime(state, testProvider)`. Narrowing the _parameter_ `provider` at the function entry does not narrow the separate `testProvider` binding, so the call becomes `Provider` -> `Exclude<Provider, {kind: OAuth}>` (TS2345).

**Fix:** Keep the `testProvider.kind === ProviderKind.OAuth` bail (it is unreachable at runtime but load-bearing for the type narrowing), or replace it with a narrowing parse/assertion, e.g. `const testProvider = ProviderSchema.parse({ ...provider, alias: undefined, enabled: true, models: [modelId] }) as Exclude<Provider, { kind: ProviderKind.OAuth }>;`. The rest of the declared deviation (entry widened to `Provider`, oauth branch first, helpers keep `Exclude`, `withDraftAttempt` widened to `Provider`) is correct as written.

### [6] MINOR — plan line 809

**Claim:** The third Step 3 test's name says it fails with `persisted_provider_mismatch`, but its assertion (plan line 820) expects `persisted_provider_not_found`. The assertion is the correct one; the name misleads (and it echoes the spec's looser wording at spec line 237).

**Evidence:** packages/server/src/dashboard-routes/provider-draft/provider-draft-resolution.ts:36-39 `if (persistedProviderId !== undefined) { if (persistedProviderId !== draft.id) return { ok: false, code: 'persisted_provider_mismatch' }; previous = state.currentConfig().providers.find(({ id }) => id === persistedProviderId); if (previous === undefined) return { ok: false, code: 'persisted_provider_not_found' };` — with `persistedProviderId: 'ghost'` equal to `draft.id`, the id check passes and the missing-provider branch returns `persisted_provider_not_found`, matching plan line 820, not the test title.

**Fix:** Rename the test to "...fails with persisted_provider_not_found" and leave the assertion unchanged.

---

## Group t4 — needs-fixes

### [7] MAJOR — plan line 371

**Claim:** The instruction to "extend the existing successful-materialization test in this file with a config carrying `models: [<one id from the shared catalog fixture>]`" cannot be followed as written: on the shared catalog fixture the assertion is unfalsifiable, and on the only multi-model test in the file it silently breaks a pre-existing assertion the plan never mentions updating.

**Evidence:** packages/server/src/plugin-runtime/test-support.ts:28-35 — the shared fixture is `export const catalog: ModelCatalog = { language: [{ id: 'model' }], image: [], ... }` — exactly ONE language id. So for the tests that use it (capabilities.test.ts:157 and :190, both via `materializeFixture`), `models: ['model']` filters `['model']` to `['model']`: `expect(result.provider?.models).toEqual(['model'])` passes identically with or without `exposedModelIds` in `createRuntimeProvider`. The only test with a multi-id catalog is capabilities.test.ts:99-110, which writes `language: [{id:'model'},{id:'bad-resolver'},{id:'bad-response'}]`; adding `models: ['model']` there does exercise the filter, but that test also asserts at capabilities.test.ts:144 `expect(result.summary.clientModels).toEqual(['client', 'bad-resolver', 'bad-response'])`, and `clientModels` is derived from `provider.models`: catalog.ts:37 `clientModels: provider === undefined ? [] : [...new Set(modelRoutes(provider).map((route) => route.alias))]` and core/src/router.ts:104-105 `directModelIds` = `new Set('models' in provider ? (provider.models ?? []) : [])`. With the whitelist, exposed models becomes `['model']`, alias `client -> model` (preserve:false) deletes it, so `clientModels` becomes `['client']` and line 144 FAILS with no instruction to update it.

**Fix:** Name the test explicitly and state the collateral edit. Either (a) extend capabilities.test.ts:111-126 with `models: ['model']` AND change the assertion at :144 to `expect(result.summary.clientModels).toEqual(['client'])`, or (b) add a NEW materialization test that seeds a multi-id catalog itself (`fixture.repository.writeCatalog('person', { ...catalog, language: [{ id: 'model' }, { id: 'other' }] }, 1_000)`) with `models: ['model']` and asserts `result.provider?.models` equals `['model']`. Same problem applies to `expect(second.provider?.models).toEqual([...])` at plan line 391: with the single-id shared fixture that assertion is also unfalsifiable, so seed a second catalog id there too if it is meant to prove the cached path filters (otherwise state that the identity assertion is the contract and the direct `withRoutingConfig` unit test at plan lines 373-378 covers the filtering).

---

## Group t1-2 — needs-fixes

### [8] BLOCKER — plan line 68

**Claim:** Step 1's bare `git mv` breaks the moved file's own relative imports: `provider-alias.ts` imports `'./common'` twice, which must become `'../common'` once the file sits one directory deeper. The plan never edits them, so Step 1's verification claim on line 77 ("Run `bun run --filter @aio-proxy/types build` — must succeed") is false, and every later step in Task 1 (Steps 3/5 running `bun test`) is blocked too.

**Evidence:** packages/types/src/provider-alias.ts:3-4: `import type { AliasConfig } from './common';` / `import { normalizeAliasName, normalizeVariantKey } from './common';` (`packages/types/src/common.ts` is a sibling file, not inside the new directory). I performed the plan's exact Step 1 in this worktree and ran the build: `error Failed to load file with jiti: packages/types/rslib.config.ts` / `error Cannot find module './common'` / `Require stack: - packages/types/src/provider-alias/provider-alias.ts` / `at packages/types/src/provider-alias/provider-alias.ts:4:21`. Rewriting both to `'../common'` makes the same build exit 0 (`29 files generated in dist`) and emits `import ... from "./provider-alias/index.js"` in `dist/provider.js`, with `node -e "import('./packages/types/dist/index.js')"` printing `IMPORT_OK function`. Reverted afterwards.

**Fix:** Add to Step 1, after the `git mv`: rewrite both imports in `packages/types/src/provider-alias/provider-alias.ts` lines 3-4 from `'./common'` to `'../common'` (e.g. `perl -pi -e "s#from './common'#from '../common'#g" packages/types/src/provider-alias/provider-alias.ts`), then run the build.

### [9] MINOR — plan line 62

**Claim:** The Interfaces note (line 62) and the Step 1 verification note (line 77) both claim `config/config.ts` imports `provider-alias` (`"./provider-alias" and "../provider-alias" imports resolve to the new index.ts"`). No `../provider-alias` import exists anywhere in the package; `provider.ts` is the only importer.

**Evidence:** `grep -rn "provider-alias" packages/types/src` returns exactly two hits, both in `provider.ts` (`:6` import, `:9` re-export). `packages/types/src/config/config.ts:6-20` imports `validateAliasTargets` from `'../provider'`, not `'../provider-alias'`.

**Fix:** Drop `config/config.ts` from lines 62 and 77; `provider.ts:6` and `provider.ts:9` are the only specifiers that must keep resolving.

---

## Group t5-6 — needs-fixes

### [10] BLOCKER — plan line 531

**Claim:** Step 2's `import { … directModelIds, modelRoutes, sameRouteTargets } from '@aio-proxy/types'` (and the `export { modelRoutes } from '@aio-proxy/types'` beneath it) will not compile: nothing added to `provider-alias.ts` is reachable from the `@aio-proxy/types` root, and the plan never touches the barrel.

**Evidence:** `packages/types/src/index.ts` has no provider-alias export at all — lines 1-16 are `./aio`, `./codex-model/index`, `./commands`, `./common`, `./config/index`, `./dashboard/index`, `./dashboard-localized-text`, `./dashboard-oauth`, `./dashboard-provider-mutation`, `./dashboard-provider-draft/index`, `./plugin`, `./model-metadata/index`, `./provider`, `./provider-transform/index`, `./trace`, `./usage`. The only route to the module is a narrow named re-export: `packages/types/src/provider.ts:9: export { type ProviderAlias, validateAliasTargets } from './provider-alias';`. And `packages/types/package.json:6-12` declares only `".": { "types": "./dist/index.d.ts" }` plus `./config.schema.json`, so there is no `@aio-proxy/types/provider-alias` subpath fallback. Task 5's Files list (473-475) names only provider-alias + router.ts.

**Fix:** Add to Task 5 Step 2: extend `packages/types/src/provider.ts:9` to `export { directModelIds, type ModelRoute, modelRoutes, type ProviderAlias, sameRouteTargets, validateAliasTargets } from './provider-alias/index';` (or add `export * from './provider-alias/index';` to `packages/types/src/index.ts`), list that file under Files, and stage it in Step 4.

### [11] BLOCKER — plan line 473

**Claim:** Every path Task 5 modifies is wrong: `packages/types/src/provider-alias/` does not exist (the module is the flat `packages/types/src/provider-alias.ts`), there is no `provider-alias.test.ts` to "Append to", and the plan has no step to perform the move the repo's colocated-test rule requires.

**Evidence:** `ls packages/types/src/provider-alias/` → `no matches found`; `find packages/types/src -name '*provider-alias*'` → `packages/types/src/provider-alias.ts` (149 lines, `ProviderAlias` at :6, `validateAliasTargets` at :33) and no test file. `packages/types/src/provider.ts:6: import { normalizeProviderAlias, normalizeProviderAliasKeys, validateAliasTargets } from './provider-alias';` still points at the flat specifier, and every directory module in `index.ts` is imported with an explicit `/index` (`./config/index`, `./model-metadata/index`, …), so a bare `./provider-alias` is not relied on to resolve to a directory. Step 4 (547) stages only `packages/types/src/provider-alias packages/core/src/router.ts`, which cannot record the deletion of `packages/types/src/provider-alias.ts` nor the `provider.ts` edit.

**Fix:** Insert a first sub-step in Task 5 Step 2: `git mv packages/types/src/provider-alias.ts packages/types/src/provider-alias/provider-alias.ts`, add export-only `packages/types/src/provider-alias/index.ts`, update `packages/types/src/provider.ts:6,9` to `./provider-alias/index`, and create (not append to) `provider-alias/provider-alias.test.ts` with `import { expect, test } from 'bun:test';` since the snippet at 488-509 has no bun:test import. Stage `packages/types/src` in Step 4.

### [12] MINOR — plan line 515

**Claim:** The cited cut range `packages/core/src/router.ts:28-163` encloses two symbols that must stay in core — `ConfiguredRouterRoute` and the whole `Router` class — so "cut … 28-163 verbatim" as written guts the router.

**Evidence:** router.ts:32 `type ConfiguredRouterRoute<TProvider extends RoutableProvider> = {` and router.ts:38 `export class Router<TProvider extends RoutableProvider = ProviderInstance> {` (class body runs to :92). The symbols actually named for the move are at :28-30 (`ModelRoute`), :94 (`modelRoutes`), :104 (`directModelIds`), :129 (`preservedModelIds`), :155 (`sameRouteTargets`), :161-163 (`routeTargetModels`).

**Fix:** Cite the two real spans — `router.ts:28-30` and `router.ts:94-163` — instead of `28-163`.

---

## Group t3 — needs-fixes

### [13] MINOR — plan line 230

**Claim:** The plan tells the implementer to "follow the file's existing `providerEntry` tests for import names", but `constants-and-validation.test.ts` has no `providerEntry` test and no import path for the symbol, so the pasted snippet references an undefined identifier.

**Evidence:** packages/core/src/plugins/account-login/constants-and-validation.test.ts:1-16 imports only from './test-support' (`ABSENT_PROVIDER_DIGEST, configOf, createAccount, deleteOAuthAccount, expect, fixture, LOGIN_TIMEOUT_MS, OAuthLoginResultValidationError, ORPHAN_ACCOUNT_GRACE_MS, PENDING_OPERATION_TTL_MS, ProviderAccountAlreadyExistsError, RECOVERY_DRAIN_RETRY_MS, registry, test`). Its five tests are `exports the specified constants`, `credential schema failure...`, `malformed providers config is not overwritten during login`, `malformed providers config prevents delete staging`, `typed duplicate error contains only canonical guidance` — none call `providerEntry`. test-support.ts:176-206 export list contains `digestProviderEntry` but not `providerEntry`; the only definition is `packages/core/src/plugins/account-login/validation.ts:143: export function providerEntry(`.

**Fix:** Replace the parenthetical with the concrete import the snippet needs: add `import { providerEntry } from './validation';` to the test file (keeping `test`/`expect` from './test-support'), or re-export `providerEntry` from test-support.ts and add it to the existing import block.

### [14] MINOR — plan line 293

**Claim:** Adding `readonly models: readonly string[] | undefined;` (no `?`) makes `models` a required property of `OAuthProviderPatch`, which invalidates four existing `providerPatch` object literals the task's file list does not touch.

**Evidence:** packages/core/src/plugins/account-login/login.ts:41-48 declares the sibling fields as required-with-undefined (`readonly name: string | undefined; readonly enabled: boolean; readonly weight: number | undefined;`) and only `proxy?`/`transforms?` as optional. Existing literals therefore already spell out every required key and omit only the optional ones: relogin.test.ts:42-47 `providerPatch: { name: 'Work', enabled: false, weight: 9, alias: {...} }` (also :78-84 and :199), and proxy-unsupported.test.ts:67-73 `providerPatch: { name: undefined, enabled: true, weight: undefined, proxy: patchProxy, alias: undefined }`. After the change each is missing required `models`. (Non-test code has exactly one construction site, manager.ts:69, which Step 3 does update.)

**Fix:** Either declare it optional — `readonly models?: readonly string[] | undefined;` — matching the dashboard-side field the same task adds, or add `models: undefined,` to the four literals (relogin.test.ts:42, :78, :199 and proxy-unsupported.test.ts:67) and list those files in the task's Files/commit.

---

## Group t11-13 — needs-fixes

### [15] MAJOR — plan line 1443

**Claim:** Task 13 claims `hooks/use-provider-form.ts` exports `ProviderFormShape` and imports it (`import { normalizeProviderFormValue, type ProviderFormShape } from './use-provider-form';`, plan:1486; also used at plan:1466 for `ProviderEditorShape` and plan:1503 for the cast). It is a module-local type, so the step as written does not compile (TS2459).

**Evidence:** packages/dashboard/src/modules/providers/hooks/use-provider-form.ts:10 — `type ProviderFormShape = ProviderFormValues extends infer Provider` (no `export`). The file's actual exports are `ProviderEditorKind` (:9), `ProviderFormInitial` (:15), `normalizeProviderFormValue` (:56), `parseProviderFormInitial` (:63), `providerFormStepIsValid` (:75), `ProviderForm` (:94), `useProviderForm` (:120). `ProviderFormShape` appears only as an internal annotation (:56, :78, :95, :124).

**Fix:** Add `use-provider-form.ts` to Task 13's Files as **Modify**, with an explicit step: change line 10 to `export type ProviderFormShape = ...`. Everything else in the import list (`normalizeProviderFormValue`, `parseProviderFormInitial`) is genuinely exported, and `ProviderAlias`/`OAuthProviderMutationBody`/`ProviderKind` all resolve from `@aio-proxy/types` (provider.ts:9, :272, :11), so no other import in that block needs changing.

### [16] MINOR — plan line 1490

**Claim:** The implementation destructures `({ kind, initial, onSubmit }: UseProviderEditorFormOptions)`, but no `UseProviderEditorFormOptions` type is defined anywhere in the task — the Interfaces block declares the options as an inline object literal on the function signature, and the step body elides types with `// ... types exactly as in Interfaces above ...`.

**Evidence:** Plan:1470 declares `export function useProviderEditorForm(options: { kind: ProviderKind; mode: ProviderFormMode; initial?: Partial<ProviderEditorShape> | undefined; onSubmit: (value: ProviderEditorShape) => void | Promise<void>; }): ProviderEditorForm;` while plan:1490 annotates the parameter as the never-declared `UseProviderEditorFormOptions`. The mirrored source does declare it: use-provider-form.ts:107 `type UseProviderFormOptions = { mode: ProviderFormMode; kind: ProviderEditorKind; ... }`.

**Fix:** Add the named `type UseProviderEditorFormOptions = { kind: ProviderKind; mode: ProviderFormMode; initial?: Partial<ProviderEditorShape> | undefined; onSubmit: (value: ProviderEditorShape) => void | Promise<void> }` to the Interfaces block, mirroring `UseProviderFormOptions`.

### [17] MINOR — plan line 1377

**Claim:** Task 12's test titled 'editing a row merges over previous metadata instead of replacing the record' does not exercise merge semantics — the supplied implementation replaces the record outright, and the test only passes because the fixture row already repeats `unknownField`. An implementer who takes the title literally and merges would break key deletion in the metadata JSON tab.

**Evidence:** Plan:1377-1381 fixture: `previous = { a: { cost: { input: 1 }, unknownField: true } }`, `rows = [{ id: 'a', metadata: { cost: { input: 2 }, unknownField: true } }]`. Plan's implementation of `applyModelRows` does `if (row.metadata !== undefined && Object.keys(row.metadata).length > 0) merged[row.id] = row.metadata;` — a straight replace, no read of `previousMetadata[row.id]`. Replace is the correct behavior here (the spec's merge requirement is on the drawer's visual tab, design.md:141, not on model-rows), so the title, not the code, is wrong.

**Fix:** Rename the test to what it asserts (e.g. 'a row's metadata object replaces the stored record so JSON-tab deletions stick') and drop `unknownField` from the row to make the assertion meaningful, or keep it and state that merging is the drawer's job.

---

## Group t17-20 — needs-fixes

### [18] BLOCKER — plan line 1866

**Claim:** Task 19's delete list omits `components/provider-validate-step/`, which loses its only consumer in this same task while still calling the `step_validate` key that Step 4 retires — the dashboard stops building and Step 4's own grep gate cannot pass.

**Evidence:** `packages/dashboard/src/modules/providers/components/provider-validate-step/provider-validate-step.tsx:38` → `{m['dashboard.providers.editor.step_validate']()}`. Its only consumers are `templates/provider-form-page.tsx:22` (`import { ProviderValidateStep } from '../components/provider-validate-step';`) and `:171` (`<ProviderValidateStep`), and plan line 1866 deletes `templates/provider-form-page.tsx`. Task 17 (plan line 1760) moves only `provider-validate-step.test.tsx`, not `provider-validate-step.tsx` or its `index.ts` (`ls` shows all three files present). Plan Step 4 (line 1911) retires `dashboard.providers.editor.step_*` and then asserts `rg -n "...|step_validate|..." packages/dashboard/src` "only matches the reworded metadata keys" — it will match this surviving file.

**Fix:** Add `components/provider-validate-step/` (all three files: `index.ts`, `provider-validate-step.tsx`, `provider-validate-step.test.tsx`) to Task 19's delete list, and state in Task 17 that `model-validation-panel.tsx` replaces the component so the old directory goes away rather than only its test moving.

### [19] MAJOR — plan line 1867

**Claim:** `providers-table.test.tsx` contains no create-menu assertions at all — the kind submenu lives in `templates/providers-page.tsx`, so Step 3 asks the implementer to update a file that has nothing to update, and the real create-menu change ships untested.

**Evidence:** `grep -n "new/\$kind|providers/new|create" packages/dashboard/src/modules/providers/components/providers-table/providers-table.test.tsx` returns zero matches across the 357-line file. The three kind links are at `packages/dashboard/src/modules/providers/templates/providers-page.tsx:40,43,46` — e.g. `:40` `<DropdownMenuItem render={<Link preload="intent" to="/providers/new/$kind" params={{ kind: 'api' }} />}>`. `templates/providers-page.test.tsx` also has no `providers/new` match (only `kind: 'api'` at `:16` and `:92`, inside provider stubs).

**Fix:** Retarget the Files entry and Step 3 at `templates/providers-page.test.tsx` (which renders `ProvidersPage`, the component that owns the menu) and have it assert a single item linking to `/providers/new` with no `params`.

### [20] MAJOR — plan line 1907

**Claim:** Step 1's gate ("must return nothing") cannot pass, because the generated route tree inside `packages/dashboard/src` still contains `new/$kind` until Step 2 regenerates it.

**Evidence:** `grep -c 'new/$kind' packages/dashboard/src/route-tree.gen.ts` → `12`. That file is under the searched path `packages/dashboard/src`, and plan Step 2 (line 1908) only regenerates it afterwards while warning "never edit it by hand".

**Fix:** Scope the grep away from the generated file — e.g. `rg -n "..." packages/dashboard/src -g '!route-tree.gen.ts'` — or move the gate after Step 2's regeneration.

### [21] MINOR — plan line 1760

**Claim:** The new test path `components/provider-editor/model-validation-panel.test.tsx` violates the repo's same-name-directory rule for colocated tests, which the file it replaces already follows.

**Evidence:** CLAUDE.md Testing: "When a module has a colocated test, group the public entry point, implementation, and test in a same-name directory: `foo/index.ts`, `foo/foo.ts`, and `foo/foo.test.ts`", with the few-shot marking flat `foo.ts` + `foo.test.ts` as Bad. The source being ported already complies: `ls packages/dashboard/src/modules/providers/components/provider-validate-step/` → `index.ts`, `provider-validate-step.tsx`, `provider-validate-step.test.tsx`.

**Fix:** Place it at `components/provider-editor/model-validation-panel/{index.ts,model-validation-panel.tsx,model-validation-panel.test.tsx}`; the other four new files in Task 17 have no tests and may stay flat.

### [22] MINOR — plan line 1942

**Claim:** The verification instruction points at the wrong directory for the one package that must be in the changeset: `aio-proxy` has no `packages/*/package.json`, so verifying "against each `packages/*/package.json`" suggests it is a bogus entry to drop.

**Evidence:** `find . -maxdepth 3 -name package.json -not -path "*/node_modules/*"` lists `./npm/aio-proxy/package.json`, whose `name` is `aio-proxy`; iterating `packages/*/package.json` yields only `@aio-proxy/{cli,core,dashboard,i18n,infra,logger,plugin-sdk,server,types,ui}` — no `aio-proxy`. Root `workspaces.packages` includes `npm/*`. CLAUDE.md: "Never write a changeset that targets ONLY an internal or platform-binary package ... the notes silently vanish."

**Fix:** Reword to "verify against `packages/*/package.json` and `npm/aio-proxy/package.json`", noting `aio-proxy` is the launcher package under `npm/`.

---

## Group t14-16 — needs-fixes

### [23] BLOCKER — plan line 1712

**Claim:** Task 16 says provider-alias-list.tsx is 'reused inline; they already write via callbacks' while the same task deletes use-alias-drafts.ts. ProviderAliasList IS the draft-layer UI: it requires 8 draft props supplied only by useAliasDrafts, and renders ProviderAliasDraft. Rendering it from routing-section.tsx after deleting the hook cannot compile.

**Evidence:** packages/dashboard/src/modules/providers/components/provider-alias/provider-alias-list.tsx:7 'import type { AliasDraft, AliasEditorIssue, AliasEditResult, ProviderAlias } from "../../lib/alias-editor";' and :14-26 required props aliasDraftIds, aliasIds, variantDrafts, onAddAliasDraft, onCommitAliasDraft: (id, draft: AliasDraft) => AliasEditResult, onDiscardDraft, onAddVariantDraft, onDraftDirtyChange; :9 'import { ProviderAliasDraft } from "./provider-alias-draft";'. The only supplier is the deleted file: provider-alias-drawer.tsx:30 'import { useAliasDrafts } from "./use-alias-drafts";', :43 'const drafts = useAliasDrafts(alias, onAliasChange);', :73-82 passes drafts.aliasDraftIds / drafts.commitDraft into <ProviderAliasList>.

**Fix:** Scope the real work in task 16: rewrite ProviderAliasList's prop contract to the immediate-write shape (drop the 8 draft props) and decide the fate of provider-alias-draft.tsx (delete, or keep it and keep the hook). Add both files to the Files block.

### [24] MAJOR — plan line 1743

**Claim:** 'the only consumers are the old templates (patched or deleted in task 19)' is false. provider-alias-drawer.tsx is imported by two component files that the plan never mentions anywhere, so deleting it leaves broken imports task 19 does not touch.

**Evidence:** grep over packages/dashboard/src: 'components/provider-alias/provider-alias-fields.tsx:16: import { ProviderAliasDrawer } from "./provider-alias-drawer";' (used at :55) and 'components/oauth-provider-alias-fields.tsx:9: import { ProviderAliasDrawer } from "./provider-alias/provider-alias-drawer";' (used at :45). grep of the whole plan for 'provider-alias-fields|oauth-provider-alias-fields|ProviderAliasFields|OAuthProviderAliasFields' returns zero hits, while the spec (design.md:72) maps ProviderAliasFields / OAuthProviderAliasFields into the Routing section.

**Fix:** Add provider-alias/provider-alias-fields.tsx and oauth-provider-alias-fields.tsx (plus provider-alias/index.ts, which re-exports ProviderAliasFields) to task 16's Delete list, and correct the step-2 note to name components, not templates.

### [25] MAJOR — plan line 1617

**Claim:** IdentitySection passes form: ProviderEditorForm into ProviderCommonFields, whose prop is typed over the narrower old form shape, and task 14 does not list provider-common-fields.tsx as modified. The step will not typecheck.

**Evidence:** packages/dashboard/src/modules/providers/components/provider-common-fields.tsx:12-16 'interface ProviderCommonFieldsProps { form: ReturnType<typeof useProviderForm>; mode: ProviderFormMode; section: "connection" | "routing"; }'. Plan:1466 defines 'export type ProviderEditorShape = ProviderFormShape | OAuthEditorShape;' and :1467 'export type ProviderEditorForm = ReactFormExtendedApi<ProviderEditorShape, ...>' - a strictly wider union, not assignable to a form API over ProviderFormShape. Task 14 Files (plan:1525-1529) lists only provider-form-fields-api.tsx, provider-form-fields-ai-sdk.tsx, oauth-provider-edit-fields.tsx and the api test.

**Fix:** Add packages/dashboard/src/modules/providers/components/provider-common-fields.tsx to task 14's Modify list and widen its form prop to ProviderEditorForm (same for the two slimmed kind wrappers, whose form prop is also ReturnType<typeof useProviderForm>).

### [26] MAJOR — plan line 1547

**Claim:** ConnectionSectionProps references the type OAuthAccountFormApi, which exists nowhere in the repo or the plan. The exported type for a useOAuthProviderForm instance is OAuthProviderForm.

**Evidence:** grep 'OAuthAccountFormApi' over packages/dashboard/src and packages/types/src returns no matches; grep over the plan returns exactly one hit, plan:1547 itself. The real type: packages/dashboard/src/modules/providers/hooks/use-oauth-provider-form.ts:25 'export type OAuthProviderForm = ReactFormExtendedApi<' (with :9 'export interface OAuthProviderFormValues' and :53 'export const useOAuthProviderForm').

**Fix:** Change the prop to 'readonly accountForm?: OAuthProviderForm | undefined;' and import it from ../../hooks/use-oauth-provider-form.

### [27] MAJOR — plan line 1567

**Claim:** The apiKey clear button writes the literal sentinel '<clear>' into the apiKey field. The server has no clear semantics: any non-empty string is stored as the new key, so this saves an API key whose value is the string '<clear>'.

**Evidence:** packages/server/src/dashboard-routes/provider-mutation/provider-mutation.ts:103-108 'const apiKeyProvided = typeof provider["apiKey"] === "string" && provider["apiKey"] !== ""; if (!apiKeyProvided) { if (typeof previous["apiKey"] === "string") { restored["apiKey"] = previous["apiKey"]; } else { delete restored["apiKey"]; } }' - empty means retain, and there is no branch that clears. Confirmed by packages/types/src/provider.ts:158 'id is REQUIRED on both POST and PUT. apiKey uses "" -> retain semantics server-side.'

**Fix:** Delete the clear Button from the snippet and ship only the retained-key hint (which is what the plan's own guard rail says to do once the check comes back negative). If the spec's 'offer an explicit way to clear' must be honored, add a real server-side clear flag as an explicit backend change instead of a client sentinel.

### [28] MAJOR — plan line 1689

**Claim:** models-section.tsx is told to reuse useProviderCatalogMutation with the new editor form, but that hook's parameter is typed to the old form type and task 15 does not list it as modified - same non-compiling mismatch as the ProviderCommonFields case.

**Evidence:** packages/dashboard/src/modules/providers/hooks/use-provider-catalog-mutation/use-provider-catalog-mutation.ts:7 'export const useProviderCatalogMutation = (form: ProviderForm, persistedProviderId?: string) =>'; the section receives 'form: ProviderEditorForm' (plan:1673) and ProviderEditorShape is the wider union 'ProviderFormShape | OAuthEditorShape' (plan:1466). Task 15 Files (plan:1662-1666) lists only models-section.tsx, model-metadata-visual-tab.tsx, the drawer content, models-dev-service.ts and query-keys.ts.

**Fix:** Add hooks/use-provider-catalog-mutation/use-provider-catalog-mutation.ts to task 15's Modify list and widen its form parameter to ProviderEditorForm.

### [29] MINOR — plan line 1693

**Claim:** The new colocated tests are placed flat next to their sources, which the root CLAUDE.md testing rule forbids for new files (same-name-directory grouping required).

**Evidence:** CLAUDE.md Testing: 'When a module has a colocated test, group the public entry point, implementation, and test in a same-name directory: foo/index.ts, foo/foo.ts, and foo/foo.test.ts' with 'Bad: foo.ts foo.test.ts'. Plan:1693 creates components/provider-editor/models-section.test.tsx beside models-section.tsx, and plan:1715 creates components/provider-editor/attempt-order-preview.test.tsx beside attempt-order-preview.tsx. The repo already follows the directory form for new units, e.g. hooks/use-provider-catalog-mutation/{index.ts,use-provider-catalog-mutation.ts,use-provider-catalog-mutation.test.tsx}.

**Fix:** Put each tested section in its own directory: components/provider-editor/models-section/{index.ts,models-section.tsx,models-section.test.tsx} and .../attempt-order-preview/{index.ts,attempt-order-preview.tsx,attempt-order-preview.test.tsx}.

---

Total: 29 defects.
