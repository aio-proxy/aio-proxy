# Provider Editor Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three provider authoring surfaces (api/ai-sdk stepper, oauth create page, oauth edit page) with one single-page editor, and land the six backend changes it depends on (oauth model whitelist, whitelist-filtered runtime catalog, stable runtime identity, ai-sdk draft catalog, oauth draft testing, empty-`models` alias validation fix).

**Spec:** `docs/superpowers/specs/2026-08-12-provider-editor-redesign-design.md` (same worktree). Read it before starting; every task below implements a named part of it.

**Architecture:** Backend-first. Tasks 1–8 land types/server/core changes each with their own tests, so the API surface the page needs exists before any UI work. Tasks 9–13 land i18n keys and pure frontend logic. Tasks 14–19 assemble the editor page and delete the legacy surfaces. Task 20 is the changeset and full preflight.

**Tech Stack:** Bun workspaces + Turborepo, Zod v4, Hono (typed RPC client), TanStack Form/Query/Router, React, shadcn over Base UI (`@base-ui/react`), paraglide i18n, `bun:test` (backend) and `@rstest/core` + Testing Library (dashboard).

## Global Constraints

- Repo root for all commands: `/Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/provider-07e326` (the worktree).
- Run backend package tests with `bun test <file>` from the repo root. Run dashboard tests with `bun run --filter @aio-proxy/dashboard test:unit`. Final gate: `bun run preflight` (oxlint + oxfmt + all unit tests).
- Colocated tests use same-name-directory grouping: `foo/index.ts` + `foo/foo.ts` + `foo/foo.test.ts` (repo rule). Never add tests to legacy `_test/` directories.
- Dashboard rules (`packages/dashboard/AGENTS.md`): every input uses TanStack Form; server state via TanStack Query; no direct `fetch` in components (services only); one React component per `.tsx` file; components are arrow functions typed `React.FC<XxxProps>` with `interface XxxProps`; user-facing copy via `import { m } from '@aio-proxy/i18n'` and keys in `packages/i18n/messages/*.json`; run `bun run i18n:compile` after changing messages; do not edit `src/route-tree.gen.ts`.
- Non-test implementation files: 500-line hard cap, evaluate splitting at 400.
- Prefer `es-toolkit` (narrow imports) for generic utilities; keep trivial native JS when clearer.
- Domain language: "Provider ID", "provider weight" (never "order"/"rank").
- Reference prototype: `/Users/bytedance/Documents/self/aio-proxy/.reference/provider-editor/src/prototype` (gitignored, outside the worktree, read-only inspiration; it is Chinese-labeled and form-state-free — always adapt to TanStack Form + i18n, never copy verbatim).
- Commit after every task with the message given in the task. Do not run `changeset version` or `changeset publish`.

## Target File Structure (dashboard)

```
modules/providers/
  templates/provider-editor-page/
    index.ts                        exports only
    provider-editor-page.tsx        layout + save/delete orchestration only
    section-nav.tsx
    editor-footer.tsx
  components/provider-editor/
    identity-section.tsx            kind picker + ProviderCommonFields section="connection"
    connection-section.tsx          kind fork: api fields / ai-sdk fields / oauth account fields
    models-section.tsx              row list + filter + manual add (all kinds)
    routing-section.tsx             enabled + weight slider + attempt-order preview + inline aliases
    advanced-section.tsx            proxy + headers (api) + request transforms
    exposure-panel.tsx              rail: modelRoutes() over current values
    model-validation-panel.tsx      rail: draft model test (all kinds)
    weight-slider-field.tsx
    attempt-order-preview.tsx
    model-metadata-visual-tab.tsx
  hooks/use-provider-editor-form.ts
  lib/section-status/               index.ts + section-status.ts + section-status.test.ts
  lib/model-rows/                   index.ts + model-rows.ts + model-rows.test.ts
```

Deleted at the end (task 19): `templates/provider-form-page.tsx`, `templates/oauth-provider-create-page.tsx`, `templates/oauth-provider-edit-page.tsx`, `templates/use-oauth-provider-edit-page.ts`, `hooks/use-oauth-provider-edit-form.ts`, `components/provider-alias/provider-alias-drawer.tsx`, `components/provider-alias/use-alias-drafts.ts`, `routes/providers/new.$kind.tsx`.

---

### Task 1: `validateAliasTargets` skips an empty `models` (backend half of spec change 6)

**Files:**
- Create: `packages/types/src/provider-alias/index.ts`, `packages/types/src/provider-alias/provider-alias.ts` (moved), `packages/types/src/provider-alias/provider-alias.test.ts`
- Delete: `packages/types/src/provider-alias.ts` (moved into the directory)

**Interfaces:**
- Consumes: nothing new.
- Produces: unchanged exports (`validateAliasTargets`, `normalizeProviderAlias`, `normalizeProviderAliasKeys`, `ProviderAlias`) now from `provider-alias/index.ts`. `provider.ts:6` and `provider.ts:9` are the only importers (`grep -rn "provider-alias" packages/types/src` confirms), and both spell `'./provider-alias'`, which resolves to the new directory index without edits.

- [ ] **Step 1: Move the file into a same-name directory**

```bash
mkdir -p packages/types/src/provider-alias
git mv packages/types/src/provider-alias.ts packages/types/src/provider-alias/provider-alias.ts
```

Then fix the moved file's own relative imports — it sits one level deeper now, so `provider-alias/provider-alias.ts:3-4` must change from `'./common'` to `'../common'`:

```ts
import type { AliasConfig } from '../common';
import { normalizeAliasName, normalizeVariantKey } from '../common';
```

Create `packages/types/src/provider-alias/index.ts`:

```ts
export * from './provider-alias';
```

Run `bun run --filter @aio-proxy/types build` — must succeed (`provider.ts`'s two `./provider-alias` specifiers resolve to the directory index). Skipping the `../common` rewrite fails here with `Cannot find module './common'`.

- [ ] **Step 2: Write the failing test**

Create `packages/types/src/provider-alias/provider-alias.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { z } from 'zod';

import { validateAliasTargets } from './provider-alias';

const issuesFor = (provider: { models?: readonly string[]; alias?: Record<string, { model: string; variants?: Record<string, { model: string }> }> }) => {
  const issues: z.core.$ZodIssue[] = [];
  const ctx = { addIssue: (issue: never) => issues.push(issue), value: provider } as unknown as z.RefinementCtx;
  validateAliasTargets(provider as never, ctx);
  return issues;
};

test('an alias-only provider with models: [] passes validation, including variant targets', () => {
  const issues = issuesFor({
    models: [],
    alias: { smart: { model: 'upstream-a', variants: { fast: { model: 'upstream-b' } } } },
  });
  expect(issues).toEqual([]);
});

test('an absent models list still skips the target check', () => {
  expect(issuesFor({ alias: { smart: { model: 'upstream-a' } } })).toEqual([]);
});

test('an alias outside a non-empty whitelist still fails, for alias and variant targets', () => {
  const issues = issuesFor({
    models: ['listed'],
    alias: { smart: { model: 'missing', variants: { fast: { model: 'also-missing' } } } },
  });
  expect(issues.map((issue) => issue.path)).toEqual([
    ['alias', 'smart', 'model'],
    ['alias', 'smart', 'variants', 'fast', 'model'],
  ]);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test packages/types/src/provider-alias/provider-alias.test.ts`
Expected: the `models: []` test FAILS (two `target-missing`-style issues are produced today); the other two pass.

- [ ] **Step 4: Implement the guard change**

In `packages/types/src/provider-alias/provider-alias.ts`, `validateAliasTargets` currently reads:

```ts
const models = provider.models === undefined ? undefined : new Set(provider.models);
```

Replace with (comment explains the constraint, matching the router's reading of `[]` — see `directModelIds`):

```ts
// Absent AND empty both mean "no whitelist": the router exposes nothing directly
// for either shape, and an alias-only provider (models: []) must stay saveable.
const models = provider.models === undefined || provider.models.length === 0 ? undefined : new Set(provider.models);
```

`validateVariants` receives the same `models` set, so both alias and variant targets are covered by this one change.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/types/src/provider-alias/provider-alias.test.ts` — all PASS.
Run: `bun run --filter @aio-proxy/types test:unit` — no regressions (the script already scans `src/*/**/*.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add -A packages/types/src/provider-alias packages/types/src/provider-alias.ts
git commit -m "fix(types): empty models no longer invalidates alias targets"
```

---

### Task 2: `aliasEditorIssues` skips an empty `models` (dashboard half of spec change 6)

**Files:**
- Modify: `packages/dashboard/src/modules/providers/lib/alias-editor/alias-editor.ts:165`
- Modify: `packages/dashboard/src/modules/providers/lib/alias-editor/alias-editor.issues.test.ts`

**Interfaces:**
- Consumes/Produces: `aliasEditorIssues(alias: ProviderAlias, models?: readonly string[]): readonly AliasEditorIssue[]` — signature unchanged; `models: []` now behaves like `undefined`.

- [ ] **Step 1: Write the failing test**

Append to `alias-editor.issues.test.ts` (mirror the file's existing test style):

```ts
test('reports no target-missing for models: [], matching the server guard', () => {
  const issues = aliasEditorIssues(
    { smart: { model: 'upstream-a', variants: { fast: { model: 'upstream-b' } } } },
    [],
  );
  expect(issues).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --filter @aio-proxy/dashboard test:unit`
Expected: the new test FAILS with two `target-missing` issues.

- [ ] **Step 3: Implement**

In `alias-editor.ts` change line 165 from

```ts
const availableModels = models === undefined ? undefined : new Set(models);
```

to

```ts
// Keep in lockstep with validateAliasTargets in @aio-proxy/types: absent and
// empty both mean "no whitelist", or the editor blocks a payload the server accepts.
const availableModels = models === undefined || models.length === 0 ? undefined : new Set(models);
```

- [ ] **Step 4: Run the dashboard tests**

Run: `bun run --filter @aio-proxy/dashboard test:unit` — all PASS (existing issues tests unchanged: they pass non-empty lists).

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/modules/providers/lib/alias-editor
git commit -m "fix(dashboard): alias editor treats empty models as no whitelist"
```

---

### Task 3: OAuth providers gain a `models` whitelist end to end (spec change 1)

**Files:**
- Modify: `packages/types/src/provider.ts` (`OAuthPluginProviderSchema` ~:104, `OAuthProviderMutationBodySchema` ~:218)
- Modify: `packages/types/src/dashboard-oauth.ts` (`DashboardOAuthProviderPatchSchema` ~:67)
- Modify: `packages/core/src/plugins/account-login/login.ts` (`OAuthProviderPatch` ~:41)
- Modify: `packages/core/src/plugins/account-login/validation.ts` (`providerEntry` ~:143)
- Modify: `packages/server/src/oauth-login-session/manager.ts` (~:69 patch mapping)
- Modify: `packages/dashboard/src/modules/providers/lib/oauth-provider-edit/oauth-provider-edit.ts`
- Test: `packages/core/src/plugins/account-login/constants-and-validation.test.ts`, `packages/dashboard/src/modules/providers/lib/oauth-provider-edit/oauth-provider-edit.test.ts`

**Interfaces:**
- Produces: `OAuthProvider` config and `OAuthProviderMutationBody` accept `models?: string[]`; `DashboardOAuthProviderPatch` accepts `models?: string[]`; `OAuthProviderPatch` (core) carries `readonly models?: readonly string[] | undefined`; `OAuthProviderEditValues` (dashboard lib) carries `readonly models?: readonly string[] | undefined` and both action branches forward it.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/plugins/account-login/constants-and-validation.test.ts` add the test below. The file today imports only from `./test-support` and has no `providerEntry` test, so add the import explicitly (`providerEntry` is defined at `validation.ts:143` and is not re-exported from test-support):

```ts
import { providerEntry } from './validation';
```

```ts
test('providerEntry keeps the existing models whitelist and lets the patch replace it', () => {
  const existing = { kind: 'oauth', plugin: 'p', capability: 'c', enabled: true, models: ['a'] };
  expect(providerEntry('p', 'c', {}, existing, undefined, undefined)['models']).toEqual(['a']);
  const patch = { name: undefined, enabled: true, weight: undefined, alias: undefined, models: ['b'] };
  expect(providerEntry('p', 'c', {}, existing, undefined, patch)['models']).toEqual(['b']);
  const clearing = { ...patch, models: undefined };
  expect('models' in providerEntry('p', 'c', {}, existing, undefined, clearing)).toBe(false);
});
```

In `oauth-provider-edit.test.ts` add:

```ts
test('whitelist round-trips through both action branches', () => {
  const base = {
    id: 'p',
    enabled: true,
    publicValues: {},
    secrets: {},
    clearSecrets: [],
    models: ['m1', 'm2'],
  };
  const update = oauthProviderEditAction(base, {});
  expect(update.kind).toBe('update');
  if (update.kind === 'update') expect(update.body.models).toEqual(['m1', 'm2']);

  const reauth = oauthProviderEditAction(base, {}, true);
  expect(reauth.kind).toBe('reauthorize');
  if (reauth.kind === 'reauthorize') expect(reauth.input.providerPatch?.models).toEqual(['m1', 'm2']);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/core/src/plugins/account-login/constants-and-validation.test.ts` — FAILS (type error / `models` dropped).
Run: `bun run --filter @aio-proxy/dashboard test:unit` — new test FAILS.

- [ ] **Step 3: Implement the schema and plumbing changes**

`packages/types/src/provider.ts` — inside `OAuthPluginProviderSchema`, after `...SharedProviderSchemaBase,` add the spread that api/ai-sdk already have:

```ts
  ...modelsField,
```

Inside `OAuthProviderMutationBodySchema`, after `weight: z.number().optional(),` add:

```ts
  models: z.array(z.string()).optional(),
```

`packages/types/src/dashboard-oauth.ts` — inside `DashboardOAuthProviderPatchSchema`, after `weight`:

```ts
  models: z.array(z.string()).optional(),
```

`packages/core/src/plugins/account-login/login.ts` — in `OAuthProviderPatch` add it as **optional**:

```ts
  readonly models?: readonly string[] | undefined;
```

The `?` matters. `login.ts:41-48` declares `name`/`enabled`/`weight` as required-with-undefined, so existing `providerPatch` literals spell out every required key and omit only `proxy?`/`transforms?`. A required `models` would break four literals this task does not otherwise touch (`relogin.test.ts:42, :78, :199` and `proxy-unsupported.test.ts:67`). Optional also matches the dashboard-side field added below.

`packages/core/src/plugins/account-login/validation.ts` — in `providerEntry`, alongside the `weight`/`name` lines add:

```ts
  const models = patch === undefined ? existing?.['models'] : patch.models;
```

and in the returned object, after the `alias` spread:

```ts
    ...(models === undefined ? {} : { models }),
```

`packages/server/src/oauth-login-session/manager.ts` — in the explicit patch mapping (~:69) add:

```ts
              models: input.providerPatch.models,
```

`packages/dashboard/src/modules/providers/lib/oauth-provider-edit/oauth-provider-edit.ts` — add to `OAuthProviderEditValues`:

```ts
  readonly models?: readonly string[] | undefined;
```

and inside the `providerPatch` object literal:

```ts
    ...(values.models === undefined ? {} : { models: [...values.models] }),
```

(the same `providerPatch` is spread into the `update` body, so both branches carry it).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/core/src/plugins/account-login/` and `bun run --filter @aio-proxy/dashboard test:unit` — PASS.
Run: `bun run --filter @aio-proxy/types test:unit` — PASS (task 1's guard means an oauth body with `models: []` plus aliases stays valid under `ProviderMutationBodySchema.superRefine(validateAliasTargets)`).

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/provider.ts packages/types/src/dashboard-oauth.ts packages/core/src/plugins/account-login packages/server/src/oauth-login-session/manager.ts packages/dashboard/src/modules/providers/lib/oauth-provider-edit
git commit -m "feat: oauth providers carry a models whitelist through config, mutation, and session patch"
```

---

### Task 4: Whitelist filters the runtime catalog; identity stays stable (spec changes 2 + 3)

**Files:**
- Modify: `packages/server/src/plugin-runtime/capabilities.ts` (`withRoutingConfig` :60, `createRuntimeProvider` :70, models line :97)
- Modify: `packages/server/src/plugin-runtime/materialize.ts` (:233 and :244 call sites)
- Modify: `packages/server/src/plugin-runtime/index.ts` (export `exposedModelIds`)
- Test: `packages/server/src/plugin-runtime/capabilities.test.ts`

**Interfaces:**
- Produces: `exposedModelIds(catalogIds: readonly string[], whitelist: readonly string[] | undefined): string[]` exported from `packages/server/src/plugin-runtime` (task 7 reuses it).
- `withRoutingConfig(provider: RuntimeProviderInstance, config: OAuthProvider, catalogIds: readonly string[]): RuntimeProviderInstance` — signature gains the third parameter.

- [ ] **Step 1: Write the failing tests**

In `capabilities.test.ts` (uses `catalog`, `runtimeFixture`, `materializePluginProvider` from `./test-support`; the shared `catalog` fixture's language ids can be read as `catalog.language.map(({ id }) => id)`):

```ts
import { exposedModelIds, withRoutingConfig } from './capabilities';

test('exposedModelIds: absent or empty whitelist exposes the whole catalog', () => {
  expect(exposedModelIds(['a', 'b'], undefined)).toEqual(['a', 'b']);
  expect(exposedModelIds(['a', 'b'], [])).toEqual(['a', 'b']);
});

test('exposedModelIds: a whitelist intersects the catalog and drops stale entries', () => {
  expect(exposedModelIds(['a', 'b', 'c'], ['b', 'gone', 'a'])).toEqual(['a', 'b']);
});
```

Add a **new, self-contained** materialization test — do not extend `materializeFixture`'s callers. The shared `catalog` fixture has exactly one language id (`test-support.ts:28-35`, `language: [{ id: 'model' }]`), so `models: ['model']` filters `['model']` → `['model']` and the assertion could never fail. Seed a two-id catalog in the test itself, the way the raw-capability test at `capabilities.test.ts:99-110` does:

```ts
test('a whitelist filters the freshly materialized catalog', async () => {
  const fixture = runtimeFixture({ kind: 'static' }, { createRuntime: async () => ({ provider: providerV4() }) });
  fixture.repository.writeCatalog('person', { ...catalog, language: [{ id: 'model' }, { id: 'other' }] }, 1_000);
  const result = await materializePluginProvider({
    config: { ...providerConfig, models: ['model'] },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  });
  expect(result.provider?.models).toEqual(['model']); // 'other' is discovered but not exposed
});
```

Then a `withRoutingConfig` test:

```ts
test('withRoutingConfig re-derives models from the unfiltered catalog ids', () => {
  const cached = { id: 'person', kind: ProviderKind.OAuth, enabled: true, models: ['a'], model: { invoke: () => { throw new Error('unused'); } } } as never;
  const next = withRoutingConfig(cached, { ...providerConfig, models: ['b'] } as never, ['a', 'b']);
  expect(next.models).toEqual(['b']);
});
```

And the identity-stability test (spec change 3), in the same file next to the materialization tests. It seeds the same two-id catalog for the same reason — on the shared single-id fixture the last assertion would hold with or without filtering:

```ts
test('changing only the whitelist keeps runtime identity stable and takes the cached routing path', async () => {
  const fixture = runtimeFixture({ kind: 'static' }, { createRuntime: async () => ({ provider: providerV4() }) });
  fixture.repository.writeCatalog('person', { ...catalog, language: [{ id: 'model' }, { id: 'other' }] }, 1_000);
  const first = await materializeFixture(fixture); // providerConfig has no whitelist -> both ids exposed
  expect(first.provider?.models).toEqual(['model', 'other']);
  const second = await materializePluginProvider({
    config: { ...providerConfig, models: ['model'] },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
    previous: first.cacheEntry,
  });
  // Same identity -> the provider instance is rebuilt via withRoutingConfig, not re-created:
  expect(second.cacheEntry?.identity).toBe(first.cacheEntry?.identity);
  expect(second.provider?.models).toEqual(['model']);
});
```

Adapt argument shapes to the file's existing fixtures — the assertions above are the contract; the fixture wiring must mirror the neighbouring tests exactly. `materializeFixture` (`capabilities.test.ts:32-40`) passes the unmodified `providerConfig`, so reuse it only where no whitelist is wanted.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/server/src/plugin-runtime/capabilities.test.ts`
Expected: FAIL — `exposedModelIds` is not exported; `withRoutingConfig` takes two arguments.

- [ ] **Step 3: Implement**

In `capabilities.ts`:

```ts
// One rule, two call sites (fresh + cached). Absent or empty whitelist means
// expose everything so existing oauth configs keep working; stale whitelist
// entries are dropped so they cannot create dead routes.
export function exposedModelIds(catalogIds: readonly string[], whitelist: readonly string[] | undefined): string[] {
  if (whitelist === undefined || whitelist.length === 0) return [...catalogIds];
  const allowed = new Set(whitelist);
  return catalogIds.filter((id) => allowed.has(id));
}
```

`withRoutingConfig` gains `catalogIds: readonly string[]` and sets `models` explicitly (today `models` rides along untouched inside `...previousProvider`):

```ts
export function withRoutingConfig(
  provider: RuntimeProviderInstance,
  config: OAuthProvider,
  catalogIds: readonly string[],
): RuntimeProviderInstance {
  const { alias: _previousAlias, configMetadata: _previousConfigMetadata, ...previousProvider } = provider;
  return {
    ...previousProvider,
    enabled: config.enabled,
    models: exposedModelIds(catalogIds, config.models),
    ...(config.alias === undefined ? {} : { alias: config.alias }),
    ...(config.metadata === undefined ? {} : { configMetadata: config.metadata }),
  };
}
```

In `createRuntimeProvider`, line 97 becomes:

```ts
    models: exposedModelIds(catalog.language.map(({ id }) => id), config.models),
```

In `materialize.ts`, both call sites (`:233` disabled path and `:244` cached path) pass the unfiltered catalog ids — `storedCatalog` is non-null in scope at both:

```ts
withRoutingConfig(options.previous.provider, config, storedCatalog.catalog.language.map(({ id }) => id))
```

Do **not** add any `modelsDigest` to `runtimeIdentity` — identity stability is the point (spec change 3). Export `exposedModelIds` from `packages/server/src/plugin-runtime/index.ts` alongside the existing exports.

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/server/src/plugin-runtime/` — all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/plugin-runtime packages/server/src/plugin-runtime/index.ts
git commit -m "feat(server): oauth whitelist filters the runtime catalog on both fresh and cached paths"
```

---

### Task 5: Move `modelRoutes` into `@aio-proxy/types`; core re-exports (spec Routing section)

**Files:**
- Modify: `packages/types/src/provider-alias/provider-alias.ts` (add `ModelRoute`, `modelRoutes`, `directModelIds`, `sameRouteTargets` + private `preservedModelIds`, `routeTargetModels`)
- Modify: `packages/types/src/provider.ts` (`:9` — widen the named re-export so the new symbols reach the package root)
- Modify: `packages/core/src/router.ts` (delete the moved functions, import from types, keep re-export)
- Test: `packages/types/src/provider-alias/provider-alias.test.ts`

**Interfaces:**
- Produces (from `@aio-proxy/types`):
  - `type ModelRoute = { readonly alias: string; readonly modelId: string }`
  - `modelRoutes(provider: { readonly enabled: boolean; readonly models?: readonly string[] | undefined; readonly alias?: ProviderAlias | undefined }): ModelRoute[]`
  - `directModelIds(provider: same): string[]`
  - `sameRouteTargets(left: AliasConfig, right: AliasConfig): boolean`
- `@aio-proxy/core` re-exports `modelRoutes` and `ModelRoute` unchanged, so `packages/server/src/provider-runtime/materialize.ts:7` and every other core consumer keeps compiling without edits. The dashboard (task 17) imports `modelRoutes` from `@aio-proxy/types`.

- [ ] **Step 1: Write the failing test**

In `packages/types/src/provider-alias/provider-alias.test.ts`, **merge** the new symbol into the existing import at `:5` — do not add a second `from './provider-alias'` line, `import/no-duplicates` is `error` in `oxlint.config.ts:25` and preflight would fail:

```ts
import { modelRoutes, validateAliasTargets } from './provider-alias';
```

Then append:

```ts
test('modelRoutes: aliases shadow their targets unless preserved', () => {
  expect(
    modelRoutes({ enabled: true, models: ['a', 'b'], alias: { smart: { model: 'a', preserve: false } } }),
  ).toEqual([
    { alias: 'smart', modelId: 'a' },
    { alias: 'b', modelId: 'b' },
  ]);
});

// Two models and no .sort(): with a single model the `!config.preserve` guard and the
// preservedModelIds re-add mask each other exactly, so the test only fails when BOTH break.
// Order is a product contract, not an implementation detail — clientModels
// (`materialize.ts:198,222`, `catalog.ts:37`) is this array's aliases in this order.
test('modelRoutes: preserve keeps the original id routable next to the alias', () => {
  expect(modelRoutes({ enabled: true, models: ['a', 'b'], alias: { smart: { model: 'a', preserve: true } } })).toEqual([
    { alias: 'smart', modelId: 'a' },
    { alias: 'a', modelId: 'a' },
    { alias: 'b', modelId: 'b' },
  ]);
});
```

And one assertion that the package **root** barrel actually re-exports the moved symbols — without it, forgetting the `provider.ts:9` widening below stays green here and only breaks in task 17. Import it from `../index`, **not** `@aio-proxy/types` — inside `packages/types` the package name self-resolves to `dist/index.js`, so a stale or absent build would let a missing widening pass unnoticed. `../index` traverses `src/index.ts` -> `provider.ts:9` -> `./provider-alias`, which is the exact chain the guard exists to check:

```ts
import * as types from '../index';

test('modelRoutes and its helpers reach the package root barrel', () => {
  expect(typeof types.modelRoutes).toBe('function');
  expect(typeof types.directModelIds).toBe('function');
  expect(typeof types.sameRouteTargets).toBe('function');
});
```

Run: `bun test packages/types/src/provider-alias/provider-alias.test.ts` — FAILS (`modelRoutes` not exported).

- [ ] **Step 2: Move the code**

Cut `modelRoutes`, `directModelIds`, `preservedModelIds`, `sameRouteTargets`, `routeTargetModels`, and the `ModelRoute` type from `packages/core/src/router.ts` **verbatim** into `packages/types/src/provider-alias/provider-alias.ts`. The symbols live in two spans — `router.ts:28-31` (`ModelRoute`, including its closing `};`) and `router.ts:94-163` (`modelRoutes` `:94`, `directModelIds` `:104`, `preservedModelIds` `:129`, `sameRouteTargets` `:155`, `routeTargetModels` `:161-163`). Do **not** cut `28-163` as one block: `ConfiguredRouterRoute` (`:33`) and the whole `Router` class (`:38-92`) sit between them and must stay in core. Then apply these mechanical adjustments:

- Parameter type: replace `RoutableProvider` with a local structural type. Drop only `id`; **keep `enabled: boolean` required.** These functions never read `enabled`, but every planned caller has it, and requiring it keeps two accident-prone shapes out — a `CatalogPage` (`provider-draft-operations.ts:140-143`) and a bare `{ models: aliasTargetModels(alias) }` both lack it and must stay compile errors. Task 17's `ExposurePanelProps` already carries `enabled: boolean`:

```ts
type RoutableModelSource = {
  readonly enabled: boolean;
  readonly models?: readonly string[] | undefined;
  readonly alias?: ProviderAlias | undefined;
};
```

- Export `modelRoutes`, `directModelIds`, `sameRouteTargets`, and `type ModelRoute`. Keep `preservedModelIds` and `routeTargetModels` private.

- **Widen the package-root re-export.** `packages/types/src/index.ts` has no `./provider-alias` entry at all, and `packages/types/package.json` exposes only `"."`, so there is no `@aio-proxy/types/provider-alias` subpath. The single route to this module is the narrow named list at `packages/types/src/provider.ts:9`. Extend it, or nothing below (nor task 17's dashboard import) resolves:

```ts
export {
  directModelIds,
  type ModelRoute,
  modelRoutes,
  type ProviderAlias,
  sameRouteTargets,
  validateAliasTargets,
} from './provider-alias';
```

In `packages/core/src/router.ts`:

```ts
import { type AliasConfig, directModelIds, type ModelId, resolveAliasTarget, sameRouteTargets } from '@aio-proxy/types';

export { modelRoutes } from '@aio-proxy/types';
export type { ModelRoute } from '@aio-proxy/types';
```

and delete the local implementations. The `Router` constructor keeps calling `directModelIds(provider)` and `addRoute` keeps calling `sameRouteTargets(...)` — both now imported.

- [ ] **Step 3: Verify everything still builds and passes**

Run: `bun test packages/types/src/provider-alias/provider-alias.test.ts` — PASS.
Run: `bun run --filter @aio-proxy/types build && bun run --filter @aio-proxy/core build && bun run --filter @aio-proxy/core test:unit && bun run --filter @aio-proxy/server test:unit` — PASS (router behavior unchanged; server imports via core re-export).

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/provider-alias packages/types/src/provider.ts packages/core/src/router.ts
git commit -m "refactor: move modelRoutes and alias route helpers into @aio-proxy/types"
```

---

### Task 6: ai-sdk drafts list an OpenAI-shaped catalog (spec change 4)

**Files:**
- Modify: `packages/server/src/dashboard-routes/provider-draft/provider-draft-operations.ts`
- Test: `packages/server/src/dashboard-routes/provider-draft/provider-draft.test.ts`

**Interfaces:**
- Consumes: `createProxyFetch` from `@aio-proxy/core`, `effectiveProxy` from `../../provider-runtime`, private `catalogPage` already in the file.
- Produces: `loadProviderDraftCatalog` accepts ai-sdk drafts when `options.baseURL` is a string; keeps `catalog_unsupported` otherwise; wrong response shape → `catalog_unavailable`.

**Implementation note (deviation from spec wording):** the spec says fetch "`baseURL` + `catalogPath(...)`" but ai-sdk `baseURL` conventionally already contains the version segment (`http://host/v1`) — `@ai-sdk/openai-compatible` appends `/chat/completions` to it. The correct listing URL is `${baseURL}/models`. `catalogPage(ProviderProtocol.OpenAICompatible, ...)` is single-page (no pagination for that protocol), so no loop is needed.

**Depends on task 21** — dispatch it first. Until it lands, `/providers/:id/edit-view` returns `options.apiKey` masked as `'****'`, so loading the catalog for a *saved* provider (the primary use case: open the editor, click Load models) would authenticate with `Bearer ****` and 401 into `catalog_unavailable`. The tests below use unsaved drafts and pass either way; only real use is affected.

- [ ] **Step 1: Write the failing tests**

Add to `provider-draft.test.ts` (same `Bun.serve` pattern as the existing catalog tests; the fixture config already contains `saved-sdk`):

```ts
test('lists an ai-sdk draft catalog from options.baseURL with bearer auth', async () => {
  let authorization: string | null = null;
  let pathname = '';
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      authorization = request.headers.get('authorization');
      pathname = new URL(request.url).pathname;
      return Response.json({ data: [{ id: 'sdk-model-a' }, { id: 'sdk-model-b' }] });
    },
  });
  try {
    const response = await routes.request(
      '/providers/draft/catalog',
      jsonRequest({
        draft: {
          id: 'unsaved-sdk',
          kind: 'ai-sdk',
          packageName: '@ai-sdk/openai-compatible',
          options: { apiKey: 'sdk-secret', baseURL: `http://127.0.0.1:${upstream.port}/v1` },
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, models: ['sdk-model-a', 'sdk-model-b'] });
    expect(authorization).toBe('Bearer sdk-secret');
    expect(pathname).toBe('/v1/models');
  } finally {
    await upstream.stop(true);
  }
});

// A *missing* options.baseURL is already pinned by the existing test at
// `provider-draft.test.ts:233` ("returns a recoverable unsupported catalog result
// for an AI SDK draft", no options at all) — do not add a second test for that.
// This one pins the blank-string branch, which nothing else covers: without the
// `.trim() === ''` guard a blank baseURL fetches "/models" and degrades to
// catalog_unavailable ("we tried and it broke") instead of catalog_unsupported
// ("you have not configured a listing endpoint").
test('an ai-sdk draft with a blank options.baseURL still returns catalog_unsupported', async () => {
  const response = await routes.request(
    '/providers/draft/catalog',
    jsonRequest({ draft: { id: 'unsaved-sdk', kind: 'ai-sdk', options: { apiKey: 'x', baseURL: '   ' } } }),
  );
  expect(await response.json()).toEqual({
    ok: false,
    error: { code: 'catalog_unsupported', recoverable: true },
  });
});

test('an ai-sdk endpoint that is not OpenAI-shaped returns catalog_unavailable', async () => {
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ unexpected: true }),
  });
  try {
    const response = await routes.request(
      '/providers/draft/catalog',
      jsonRequest({
        draft: { id: 'unsaved-sdk', kind: 'ai-sdk', options: { baseURL: `http://127.0.0.1:${upstream.port}/v1` } },
      }),
    );
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: 'catalog_unavailable', recoverable: true },
    });
  } finally {
    await upstream.stop(true);
  }
});

// A configured Authorization must beat options.apiKey, the way upstreamHeaders
// (core/.../api.ts:98-104), the schema contract (types/provider.ts:94) and
// @ai-sdk/openai-compatible all resolve it. Deliberately spelled with a capital A: an
// object spread keeps both casings and fetch comma-joins them into one malformed
// credential, so this asserts the single-value outcome that Headers.set guarantees.
test('a configured Authorization header overrides options.apiKey', async () => {
  let authorization: string | null = null;
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      authorization = request.headers.get('authorization');
      return Response.json({ data: [{ id: 'sdk-model-a' }] });
    },
  });
  try {
    await routes.request(
      '/providers/draft/catalog',
      jsonRequest({
        draft: {
          id: 'unsaved-sdk',
          kind: 'ai-sdk',
          options: {
            apiKey: 'placeholder',
            baseURL: `http://127.0.0.1:${upstream.port}/v1`,
            headers: { Authorization: 'Bearer real-token' },
          },
        },
      }),
    );
    expect(authorization).toBe('Bearer real-token');
  } finally {
    await upstream.stop(true);
  }
});

// The ai-sdk loader duplicates the api loader's non-ok handling (its equivalent test is
// 'returns a recoverable catalog failure without reflecting the upstream body') and
// carries the same guarantee: an upstream error body never reaches the dashboard.
test('an ai-sdk catalog error is recoverable and does not reflect the upstream body', async () => {
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('sdk-upstream-secret-body', { status: 401 }),
  });
  try {
    const response = await routes.request(
      '/providers/draft/catalog',
      jsonRequest({
        draft: {
          id: 'unsaved-sdk',
          kind: 'ai-sdk',
          options: { apiKey: 'wrong-key', baseURL: `http://127.0.0.1:${upstream.port}/v1` },
        },
      }),
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: false, error: { code: 'catalog_unavailable', recoverable: true } });
    expect(text).not.toContain('sdk-upstream-secret-body');
    expect(text).not.toContain('wrong-key');
  } finally {
    await upstream.stop(true);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/server/src/dashboard-routes/provider-draft/provider-draft.test.ts`
Expected: the first test FAILS with `catalog_unsupported` (the kind test rejects it today) and the third FAILS the same way; the blank-baseURL test passes from the start — it pins the guard you are about to write, and stays green through the change.

- [ ] **Step 3: Implement**

In `provider-draft-operations.ts`, replace line 26 (`if (provider.kind === ProviderKind.AiSdk) return failure('catalog_unsupported');`) with a delegation, and add the ai-sdk loader:

```ts
import { createProxyFetch } from '@aio-proxy/core';
import { isPlainObject } from 'es-toolkit/predicate';
import { effectiveProxy } from '../../provider-runtime';

export async function loadProviderDraftCatalog(
  state: ServerState,
  provider: Exclude<Provider, { kind: ProviderKind.OAuth }>,
): Promise<DashboardProviderDraftCatalogResponse> {
  if (provider.kind === ProviderKind.AiSdk) return loadAiSdkDraftCatalog(state, provider);
  // ... existing api body unchanged ...
}

// ai-sdk runtimes expose no raw capability and no protocol field, so the api
// loader cannot serve them. Convention over schema: baseURL/apiKey/headers are the
// @ai-sdk/openai-compatible option keys, and the listing must be OpenAI-shaped.
async function loadAiSdkDraftCatalog(
  state: ServerState,
  provider: Extract<Provider, { kind: ProviderKind.AiSdk }>,
): Promise<DashboardProviderDraftCatalogResponse> {
  const baseURL = provider.options?.['baseURL'];
  if (typeof baseURL !== 'string' || baseURL.trim() === '') return failure('catalog_unsupported');
  // Proxy only. The runtime path also wraps this in createProviderRequestTransformFetch +
  // createObservedFetch (materialize.ts:156-159), but both are provably inert here: the
  // transform fetch returns early unless currentProviderAttemptContext() names this
  // provider, and createObservedFetch passes through with neither a debug scope nor an
  // attempt response observation. Draft catalog loading establishes none of the three —
  // the api loader above has the same gap. Wiring them in would look like transform
  // support without providing any.
  const fetchWithProxy = createProxyFetch(effectiveProxy(state.currentConfig().proxy, provider.proxy));
  try {
    const response = await fetchWithProxy(`${baseURL.replace(/\/+$/u, '')}/models`, {
      signal: AbortSignal.timeout(5_000),
      headers: catalogHeaders(provider.options),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return failure('catalog_unavailable');
    }
    const page = catalogPage(ProviderProtocol.OpenAICompatible, await response.json());
    return { ok: true, models: [...new Set(page.models)] };
  } catch {
    return failure('catalog_unavailable');
  }
}

// apiKey first, configured headers second — `upstreamHeaders` (core/.../api.ts:98-104),
// the schema contract at types/provider.ts:94 ("configured values win"), and
// @ai-sdk/openai-compatible itself all resolve the collision this way. A gateway whose
// real credential lives in options.headers must authenticate here exactly as it does in
// the proxy, or Load models reports catalog_unavailable for a provider that works.
// Headers.set is case-insensitive, so a configured `Authorization` in any casing replaces
// the bearer instead of being comma-joined onto it the way an object spread would.
function catalogHeaders(options: Readonly<Record<string, unknown>> | undefined): Headers {
  const headers = new Headers();
  const apiKey = options?.['apiKey'];
  if (typeof apiKey === 'string' && apiKey !== '') headers.set('authorization', `Bearer ${apiKey}`);
  const configured = options?.['headers'];
  // isPlainObject, not `typeof === 'object'`: the native check admits an array, which
  // would spread into a bogus `0:` header.
  if (isPlainObject(configured)) {
    for (const [name, value] of Object.entries(configured)) headers.set(name, String(value));
  }
  return headers;
}
```

(`catalogPage` throws `TypeError` on a non-OpenAI shape, which the catch maps to `catalog_unavailable` — exactly the error split the spec requires.)

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/server/src/dashboard-routes/provider-draft/provider-draft.test.ts` — all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/dashboard-routes/provider-draft
git commit -m "feat(server): ai-sdk drafts list models from an OpenAI-shaped options.baseURL"
```

---

### Task 7: OAuth drafts can be tested (spec change 5)

**Files:**
- Modify: `packages/types/src/dashboard-provider-draft/dashboard-provider-draft.ts` (:7-10 union)
- Modify: `packages/server/src/dashboard-routes/provider-draft/provider-draft-resolution.ts`
- Modify: `packages/server/src/dashboard-routes/provider-draft/provider-draft-operations.ts`
- Test: `packages/server/src/dashboard-routes/provider-draft/provider-draft.test.ts`, `packages/types/src/dashboard-provider-draft/dashboard-provider-draft.test.ts`

**Interfaces:**
- Consumes: `exposedModelIds` from `../../plugin-runtime` (task 4); `state.acquireProviderSnapshot()` (`ProviderRouteSource`, `packages/server/src/runtime.ts:87-96`); `runtime.upstreamMetadata` (`runtime.ts:55`).
- Produces: `DashboardProviderDraftSchema` gains an oauth branch; `resolveProviderDraft` admits oauth drafts backed by a persisted oauth provider; `testProviderDraft(state, provider: Provider, modelId)` handles oauth by borrowing the live runtime.

**Design constraints from the spec:** the oauth test borrows the live runtime instance from the provider snapshot (never a throwaway materialization — that would drive plugin auth from a test button); the enablement gate for oauth checks the *effective* exposed set (`exposedModelIds` over the runtime's full catalog ids with the **draft's** whitelist), so an empty whitelist can test any discovered model; `fresh_credentials_required` never applies to oauth. Deviation from the spec's letter: instead of widening all five `Exclude<Provider, ...OAuth>` signatures, `testProviderDraft` widens to `Provider` and branches to the oauth path before the materialization helpers, which keep their `Exclude` types accurately (they are only reachable for api/ai-sdk). `withDraftAttempt` widens to `Provider` because the oauth path calls it. **Keep** the existing `if (testProvider.kind === ProviderKind.OAuth) return failure('test_request_failed');` bail at `provider-draft-operations.ts:62`: `ProviderSchema` is a discriminated union over all three kinds (`types/src/provider.ts:248-249`), so `const testProvider = ProviderSchema.parse(...)` at `:61` is typed as the full `Provider` regardless of the entry-point branch — narrowing the `provider` parameter does not narrow the separate `testProvider` binding. Deleting the bail makes `materializeDraftRuntime(state, testProvider)` at `:63` fail with TS2345 against its `Exclude<Provider, { kind: ProviderKind.OAuth }>` parameter (`:96-99`). It is unreachable at runtime and load-bearing at compile time. Leave an inline comment on it so it does not read as dead code:

```ts
  // Unreachable: the entry point routes oauth to testOAuthProvider. Kept because
  // ProviderSchema.parse returns the full union — this narrows testProvider for
  // materializeDraftRuntime's Exclude<Provider, { kind: OAuth }> parameter.
  if (testProvider.kind === ProviderKind.OAuth) return failure('test_request_failed');
```

- [ ] **Step 1: Write the failing schema test**

In `packages/types/src/dashboard-provider-draft/dashboard-provider-draft.test.ts` add:

```ts
test('accepts an oauth draft with a whitelist', () => {
  const result = DashboardProviderDraftSchema.safeParse({
    kind: 'oauth',
    id: 'oauth-p',
    enabled: true,
    proxy: null,
    models: ['m1'],
  });
  expect(result.success).toBeTrue();
});
```

Run: `bun test packages/types/src/dashboard-provider-draft/` — FAILS (invalid discriminator).

- [ ] **Step 2: Add the oauth branch to the draft schema**

In `dashboard-provider-draft.ts`:

```ts
import {
  AiSdkProviderMutationBodySchema,
  ApiProviderMutationBodySchema,
  HttpProxyUrlSchema,
  OAuthProviderMutationBodySchema,
} from '../provider';

export const DashboardProviderDraftSchema = z.discriminatedUnion('kind', [
  ApiProviderMutationBodySchema.extend({ proxy: DraftProxySchema }).strict(),
  AiSdkProviderMutationBodySchema.extend({ proxy: DraftProxySchema }).strict(),
  OAuthProviderMutationBodySchema.extend({ proxy: DraftProxySchema }),
]);
```

(`OAuthProviderMutationBodySchema` is already a `strictObject`; `.extend` preserves strictness.) Run the schema test — PASS.

- [ ] **Step 3: Write the failing route tests**

In `provider-draft.test.ts`, extend the `beforeEach` config with an oauth provider entry and inject a live runtime instance through the `providerInstances` option of `createServerState` (see `ServerStateOptions.providerInstances`, `packages/server/src/server-state/types.ts:34`):

```ts
// In the ConfigSchema.parse({ providers: { ... } }) block add:
'saved-oauth': { kind: 'oauth', plugin: '@example/oauth', capability: 'default' },

// Declare next to `routes` in the describe scope, reset in beforeEach:
let probedModel: string | undefined;

// In the createServerState options add. The two lists MUST differ: `models` is the
// runtime's already-filtered SAVED whitelist, `upstreamMetadata` keys are the full
// discovered catalog, and the gate must read the latter. Make them equal and
// `Object.keys(runtime.upstreamMetadata)` and `runtime.models` become
// indistinguishable, so nothing catches a gate wired to the saved whitelist —
// which is exactly the unsaved-whitelist-edit case this task exists to support.
providerInstances: [
  {
    id: 'saved-oauth',
    kind: 'oauth',
    enabled: true,
    models: ['disc-a'],
    upstreamMetadata: { 'disc-a': {}, 'disc-b': {} },
    model: {
      // Record the requested id: the transport must be invoked with the model the
      // user asked about, or the button reports "works" for a model it never called.
      invoke: async function* (input: { readonly modelId: string }) {
        probedModel = input.modelId;
        yield { type: 'text-delta', delta: 'pong' };
      },
    },
  } as never,
],
```

Then the tests. (`proxy: null` is the required schema shape, not form state: the oauth editor has no proxy field — the live runtime owns the connection, so the draft's proxy is inert on this path. Do not wire a form value to it.)

```ts
test('tests an oauth draft model against the live runtime', async () => {
  const response = await routes.request(
    '/providers/draft/test',
    jsonRequest({
      draft: { kind: 'oauth', id: 'saved-oauth', enabled: true, proxy: null, models: [] },
      persistedProviderId: 'saved-oauth',
      model: 'disc-a',
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(probedModel).toBe('disc-a');
});

// The gate reads the DISCOVERED catalog with the DRAFT's whitelist, not the saved
// `runtime.models` (which is only ['disc-a']). Swap the implementation to
// `runtime.models` and this is the test that goes red: an unsaved whitelist edit
// naming a discovered-but-not-yet-saved model must be testable before saving.
test('an oauth draft whitelist beats the saved one for a discovered model', async () => {
  const response = await routes.request(
    '/providers/draft/test',
    jsonRequest({
      draft: { kind: 'oauth', id: 'saved-oauth', enabled: true, proxy: null, models: ['disc-b'] },
      persistedProviderId: 'saved-oauth',
      model: 'disc-b',
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(probedModel).toBe('disc-b');
});

test('an oauth draft with an empty whitelist can test any discovered model, but not an unknown one', async () => {
  const response = await routes.request(
    '/providers/draft/test',
    jsonRequest({
      draft: { kind: 'oauth', id: 'saved-oauth', enabled: true, proxy: null, models: [] },
      persistedProviderId: 'saved-oauth',
      model: 'not-discovered',
    }),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ ok: false, error: { code: 'model_not_enabled', recoverable: true } });
});

test('an oauth draft naming an id with no persisted provider fails with persisted_provider_not_found', async () => {
  const response = await routes.request(
    '/providers/draft/test',
    jsonRequest({
      draft: { kind: 'oauth', id: 'ghost', enabled: true, proxy: null },
      persistedProviderId: 'ghost',
      model: 'disc-a',
    }),
  );
  expect(await response.json()).toEqual({
    ok: false,
    error: { code: 'persisted_provider_not_found', recoverable: true },
  });
});

// The contract, not the line that happens to enforce it: an oauth draft is testable
// only against its persisted account. Today the candidate fails ProviderSchema first
// (no plugin/capability), so this passes through the `!parsed.success` arm rather than
// the oauth guard below it — that is fine. If plugin/capability ever gain defaults,
// this test is what stops a credential-less oauth draft from reaching a transport.
test('a fresh oauth draft with no persisted provider is not testable', async () => {
  const response = await routes.request(
    '/providers/draft/test',
    jsonRequest({
      draft: { kind: 'oauth', id: 'fresh-oauth', enabled: true, proxy: null, models: [] },
      model: 'disc-a',
    }),
  );
  expect(await response.json()).toEqual({
    ok: false,
    error: { code: 'persisted_provider_mismatch', recoverable: true },
  });
  expect(probedModel).toBeUndefined();
});
```

`providerInstances` does not merge with config-declared providers — it replaces materialization
outright. `server-state/index.ts:89-102` calls `buildSnapshotWithProviders(config, providerInstances,
createRouter)` *instead of* `buildSnapshot(...)` whenever the option is present, so the snapshot's
`providers` array is exactly the injected list and `saved`/`saved-proxied`/`saved-sdk` are absent from
it. That is safe here: the api/ai-sdk draft paths read `state.currentConfig()` and build a throwaway
runtime via `materializeDraftRuntime`, never the snapshot — only the oauth path below reads it.
`buildSnapshotWithProviders` maps each input through `materializeRuntimeProvider`
(`provider-runtime/materialize.ts:32-38`), which returns an already-materialized provider unchanged, so
the fixture keeps its `model` transport and `upstreamMetadata`.

Run: `bun test packages/server/src/dashboard-routes/provider-draft/provider-draft.test.ts` — the first three FAIL with `persisted_provider_mismatch` (today's early return).

- [ ] **Step 4: Implement resolution and the oauth test path**

`provider-draft-resolution.ts`:

- `DraftResolution` ok-branch becomes `{ readonly ok: true; readonly provider: Provider }`.
- In `hasSameProviderIdentity`, before the final `return false` add (oauth drafts cannot edit plugin/capability, so connection identity never changes):

```ts
  if (previous.kind === ProviderKind.OAuth && draft.kind === ProviderKind.OAuth) {
    return true;
  }
```

- In the non-`identityChanged` merge branch (`:44-55`), route oauth drafts through `replaceOAuthProvider` instead of `replaceProvider`. This is load-bearing, not a cleanup: `replaceProvider` (`provider-mutation.ts:78-113`) never restores `plugin`/`capability`, and `OAuthProviderMutationBodySchema` (`types/src/provider.ts:218-228`) is a `strictObject` without them, so the merged candidate would fail `ProviderSchema.safeParse` — `OAuthPluginProviderSchema` (`:104-112`) requires both — and the new guard's `!parsed.success` branch would still return `persisted_provider_mismatch`, leaving Step 3's first two tests red. `replaceOAuthProvider` (`:115-130`) is the helper that injects `plugin`, `capability`, and `options` from the persisted entry, has the identical signature, and is already re-exported through `../provider-mutation` (its `index.ts` is `export * from './provider-mutation'`):

```ts
      const merge = draft.kind === ProviderKind.OAuth ? replaceOAuthProvider : replaceProvider;
      const restored = merge({ [persistedProviderId]: previousBody }, persistedProviderId, draftBody)[
        persistedProviderId
      ];
```

`replaceOAuthProvider` throws `PROVIDER_KIND_MISMATCH` when the persisted entry is not oauth, but that is unreachable here — `:40` already returned `persisted_provider_mismatch` on a kind mismatch. Widen the import at `:5` to `import { replaceOAuthProvider, replaceProvider } from '../provider-mutation';`.

- Replace the final guard

```ts
  const parsed = ProviderSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.kind === ProviderKind.OAuth) {
    return { ok: false, code: 'persisted_provider_mismatch' };
  }
```

with

```ts
  const parsed = ProviderSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, code: 'persisted_provider_mismatch' };
  // An oauth draft is only testable against its persisted account; a fresh
  // oauth draft has no credentials and never will (fresh_credentials_required
  // does not apply — oauth drafts carry no credential fields at all).
  if (parsed.data.kind === ProviderKind.OAuth && previous?.kind !== ProviderKind.OAuth) {
    return { ok: false, code: 'persisted_provider_mismatch' };
  }
```

(`credentialFields` already returns `undefined` for oauth, so `requiresFreshCredentials` cannot fire on this path.)

`provider-draft-operations.ts`:

```ts
import { exposedModelIds } from '../../plugin-runtime';

export async function testProviderDraft(
  state: ServerState,
  provider: Provider,
  modelId: string,
): Promise<DashboardProviderDraftTestResponse> {
  if (provider.kind === ProviderKind.OAuth) return testOAuthProvider(state, provider, modelId);
  if (!provider.models?.includes(modelId)) return failure('model_not_enabled');
  // ... existing api/ai-sdk body unchanged, INCLUDING the `testProvider.kind === OAuth` bail ...
}

// Borrows the live runtime: an oauth provider cannot exist unsaved, and a
// one-shot materialization would drive plugin auth (and can rewrite stored
// credentials) from a read-only test button. Unsaved draft transforms are
// therefore NOT exercised here; the editor's rail copy says so.
async function testOAuthProvider(
  state: ServerState,
  provider: Extract<Provider, { kind: ProviderKind.OAuth }>,
  modelId: string,
): Promise<DashboardProviderDraftTestResponse> {
  const lease = state.acquireProviderSnapshot();
  try {
    const runtime = lease.snapshot.providers.find((candidate) => candidate.id === provider.id);
    const transport = runtime?.model;
    if (runtime === undefined || transport === undefined) return failure('test_request_failed');
    const catalogIds = Object.keys(runtime.upstreamMetadata ?? {});
    // Gate on the DRAFT whitelist over the full discovered catalog, so an
    // unsaved whitelist edit is honored and an empty whitelist exposes everything.
    if (!new Set(exposedModelIds(catalogIds, provider.models)).has(modelId)) {
      return failure('model_not_enabled');
    }
    const passed = await withDraftAttempt(provider, modelId, transport.targetProtocol?.(modelId), async () => {
      await transport.ensureAvailable?.();
      const signal = AbortSignal.timeout(10_000);
      const stream = transport.invoke({
        context: {
          requestId: crypto.randomUUID(),
          session: { key: `sha256:${'0'.repeat(64)}`, source: 'internal' },
        },
        messages: [{ role: 'user', content: 'ping' }],
        modelId,
        settings: { maxOutputTokens: 1 },
        signal,
      });
      for await (const _part of stream) {
        // Fully consume the single validation request so provider stream errors are observed.
      }
      return true;
    });
    return passed ? { ok: true } : failure('test_request_failed');
  } catch {
    return failure('test_request_failed');
  } finally {
    lease.release();
  }
}
```

Widen `withDraftAttempt`'s provider parameter to `Provider` (its `sourceProtocol` fallback already handles non-api kinds). `loadProviderDraftCatalog` keeps its `Exclude<..., OAuth>` parameter but the route now resolves oauth drafts, so add at its top:

```ts
export async function loadProviderDraftCatalog(state: ServerState, provider: Provider) {
  if (provider.kind === ProviderKind.OAuth) return failure('catalog_unsupported');
  // ...
}
```

(OAuth candidates come from `oauthProviderEditView`, not the draft catalog endpoint.)

- [ ] **Step 5: Run to verify pass**

Run: `bun test packages/server/src/dashboard-routes/provider-draft/ packages/types/src/dashboard-provider-draft/` — all PASS, including the pre-existing api/ai-sdk draft tests.

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/dashboard-provider-draft packages/server/src/dashboard-routes/provider-draft
git commit -m "feat(server): oauth drafts resolve against their persisted account and test via the live runtime"
```

---

### Task 8: `GET /dashboard/api/models-dev/slugs` from the disk cache (spec Metadata Drawer)

**Files:**
- Modify: `packages/core/src/models-dev/index.ts` (add `getCachedModelSlugs`)
- Modify: `packages/core/src/index.ts` (re-export it where the other models-dev functions are re-exported — find with `rg -n "getModelsCachedOnly" packages/core/src/index.ts`)
- Modify: `packages/server/src/dashboard-routes/config.ts` (add the route)
- Test: `packages/core/src/models-dev/index.test.ts`

**Interfaces:**
- Produces: `getCachedModelSlugs(): Promise<string[]>` — `providerId/modelId` slugs (the shape `resolveModel` resolves for `extend`), sorted, `[]` on a cold cache, never a network fetch. Route `/dashboard/api/models-dev/slugs` returns `{ slugs: string[] }`; the Hono RPC client derives the response type.

- [ ] **Step 1: Write the failing test**

In `packages/core/src/models-dev/index.test.ts` add (the file already imports `clearModelsCache` and seeds `fileCacheStorage` — mirror its seeding helper). Note the `removeItem` on the first line: `beforeEach` (`:46-51`) seeds `models-dev-providers` with four providers for every test, and `clearModelsCache()` only drops the in-memory LRUs (`index.ts:48-52`) while `readCachedProviderMap` (`:57-65`) still falls back to the file cache. Without the removal the "cold cache" assertion sees 4 slugs. The file's own cold-cache test does exactly this at `:125-127`.

```ts
test('getCachedModelSlugs returns [] on a cold cache and sorted provider/model slugs on a warm one', async () => {
  await fileCacheStorage.removeItem('models-dev-providers'); // drop the beforeEach seed so the file cache misses
  clearModelsCache();

  // Cached-only is a hot-path promise: opening the drawer must never reach the
  // network. Reject instead of calling through so a regression fails fast.
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = (() => {
    fetched = true;
    throw new Error('getCachedModelSlugs must not fetch');
  }) as typeof fetch;

  try {
    expect(await getCachedModelSlugs()).toEqual([]);

    await fileCacheStorage.setItem('models-dev-providers', {
      // Insertion order is deliberately NOT sorted order: without `.sort()` this
      // yields openrouter's slug first and the assertion below fails.
      // One slash-bearing key on purpose: 54% of real models.dev ids contain a
      // slash and `resolveModel` splits on the FIRST slash only, so a slug like
      // `openrouter/vendor/model-z` must round-trip through `extend` unchanged.
      openrouter: { models: { 'vendor/model-z': { id: 'vendor/model-z' } } },
      anthropic: { models: { 'claude-x': { id: 'claude-x' } } },
      // No `models` at all: the cache is unvalidated, so this shape is reachable
      // and `Object.keys(undefined)` would throw without the `?? {}` guard.
      broken: {},
    });
    clearModelsCache();
    expect(await getCachedModelSlugs()).toEqual(['anthropic/claude-x', 'openrouter/vendor/model-z']);
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(fetched).toBe(false);
});
```

Run: `bun test packages/core/src/models-dev/index.test.ts` — FAILS (not exported).

- [ ] **Step 2: Implement**

In `packages/core/src/models-dev/index.ts`:

```ts
/** Flattened `providerId/modelId` slugs from the cached models.dev catalog.
 * Cached-only by design: a cold cache yields [] instead of blocking the drawer. */
export async function getCachedModelSlugs(): Promise<string[]> {
  const providerMap = await readCachedProviderMap();
  if (providerMap === undefined) return [];
  return Object.entries(providerMap)
    // `provider.models` is a compile-time fiction: readCachedProviderMap never
    // passes a `schema` (see it above in this file) and cache/file.ts:66 is a bare
    // `return value as T`, so a hand-edited cache file really can hold
    // a provider with no `models` — and `Object.keys(undefined)` throws. The test's
    // `broken: {}` fixture pins this guard. resolve.ts:38 guards the same way.
    .flatMap(([providerId, provider]) => Object.keys(provider.models ?? {}).map((modelId) => `${providerId}/${modelId}`))
    .sort();
}
```

Re-export from `packages/core/src/index.ts` next to the other models-dev exports. In `packages/server/src/dashboard-routes/config.ts` add after the `/config` route:

```ts
    .get('/models-dev/slugs', async (context) => context.json({ slugs: await getCachedModelSlugs() }))
```

with `import { getCachedModelSlugs } from '@aio-proxy/core';`.

- [ ] **Step 3: Run to verify pass**

Run: `bun test packages/core/src/models-dev/index.test.ts && bun run --filter @aio-proxy/server test:unit` — PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/models-dev packages/core/src/index.ts packages/server/src/dashboard-routes/config.ts
git commit -m "feat: expose cached models.dev slugs for the metadata extend combobox"
```

---

### Task 9: i18n — locale parity test, drift fixes, and the editor's new keys

**Files:**
- Create: `packages/i18n/__tests__/locale-parity.test.ts` (this directory is already scanned by `test:unit`, `packages/i18n/package.json:17`, and holds message-level tests; the assertion is over `messages/*.json`, not a source module)
- Modify: `packages/i18n/messages/en.json`, `zh-Hans.json`, `zh-Hant.json`, `ja.json`, `ko.json`

**Interfaces:**
- Produces: every key below exists in all five locales; `bun run i18n:compile` regenerates the `m` functions the dashboard imports.

- [ ] **Step 1: Write the failing parity test**

```ts
// packages/i18n/__tests__/locale-parity.test.ts
import { expect, test } from 'bun:test';

const LOCALES = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko'] as const;

const flatten = (value: unknown, prefix = ''): [string, unknown][] => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [[prefix, value]];
  return Object.entries(value)
    .filter(([key]) => key !== '$schema')
    .flatMap(([key, child]) => flatten(child, prefix === '' ? key : `${prefix}.${key}`));
};

const placeholders = (value: unknown): string =>
  typeof value === 'string'
    ? [...value.matchAll(/\{(\w+)\}/g)]
        .map((match) => match[1]!)
        .sort()
        .join(',')
    : '';

test('all five locales share one key set and one placeholder set per key', async () => {
  const catalogs = await Promise.all(
    LOCALES.map(async (locale) => {
      const data = await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json();
      return [locale, new Map(flatten(data))] as const;
    }),
  );
  const [, en] = catalogs[0]!;
  for (const [locale, messages] of catalogs.slice(1)) {
    expect({ locale, missing: [...en.keys()].filter((key) => !messages.has(key)).sort() }).toEqual({ locale, missing: [] });
    expect({ locale, extra: [...messages.keys()].filter((key) => !en.has(key)).sort() }).toEqual({ locale, extra: [] });
    // A renamed or dropped placeholder is invisible to everything else in the
    // toolchain: paraglide unions the placeholder sets across locales, so the
    // generated signature still typechecks and the value renders `undefined`.
    // The key-set assertions above cannot see it either — the key is present.
    const drift = [...en]
      .filter(([key, value]) => placeholders(messages.get(key)) !== placeholders(value))
      .map(([key]) => key)
      .sort();
    expect({ locale, placeholderDrift: drift }).toEqual({ locale, placeholderDrift: [] });
  }
});
```

Run: `bun test packages/i18n/__tests__/locale-parity.test.ts`
Expected: FAIL — `zh-Hant`/`ja`/`ko` are missing `dashboard.providers.oauth.authorize_url_title` and carry `cli.upgrade.daemon_running_hint` + `cli.upgrade.option_restart_description` that `en`/`zh-Hans` lack.

- [ ] **Step 2: Fix the three pre-existing drift discrepancies**

- Translate `dashboard.providers.oauth.authorize_url_title` (en value already exists) into `zh-Hant`, `ja`, `ko` and add it there.
- Delete `cli.upgrade.daemon_running_hint` and `cli.upgrade.option_restart_description` from `zh-Hant`, `ja`, and `ko`. Both are dead: `packages/cli/src/upgrade/upgrade.ts:97-100` comments that a managed daemon's restart is deliberately unconditional — "no opt-in flag" — so `option_restart_description` documents a flag that was rejected, and `daemon_running_hint` is superseded by the `manual_restart_hint` branch at `:102` and the `restarting` branch at `:105`. Grep for each key before deleting to confirm no consumer appeared since.

Run the parity test — PASS.

- [ ] **Step 3: Add the editor's new keys to all five locales**

Under `dashboard.providers.editor` add (en values below; translate for the other four locales in the same tone as the neighbouring keys — do NOT copy the en string into other locales):

```json
"section_identity": "Identity",
"section_connection": "Connection",
"section_models": "Models",
"section_routing": "Routing",
"section_advanced": "Advanced",
"section_status_todo": "To do",
"section_status_attention": "Attention",
"footer_blocking": "Complete these sections before saving:",
"footer_cancel": "Cancel",
"footer_save": "Save provider",
"footer_saved": "Saved",
"authorize": "Authorize",
"authorization_required": "Authorization required",
"authorization_locked_hint": "Authorize this account to unlock models, routing, and advanced settings.",
"kind_label": "Provider kind",
"kind_api": "API endpoint",
"kind_ai_sdk": "AI SDK package",
"kind_oauth": "OAuth plugin",
"api_key_retained_hint": "Leave empty to keep the stored key.",
"exposure_title": "Exposed models",
"exposure_empty": "Enable models or add aliases to expose this provider.",
"exposure_disabled_note": "Provider is disabled and will not be routed.",
"exposure_origin_alias": "alias",
"exposure_warning_catalog": "The provider was created, but its model catalog is not available yet.",
"preview_title": "Attempt order",
"preview_affinity_note": "Session affinity can override this order for an active session.",
"preview_empty": "No other provider serves these models.",
"models_filter_placeholder": "Filter models…",
"models_count": "{enabled} of {total} models enabled",
"models_all_discovered": "All {count} discovered models are exposed",
"models_manual_add": "Add model id",
"models_stale_whitelist": "{model} is no longer in the discovered catalog",
"metadata_tab_visual": "Visual",
"metadata_tab_json": "JSON",
"metadata_unknown_fields": "{count} more fields are only editable in the JSON tab",
"metadata_extend_label": "Inherit from models.dev",
"metadata_extend_empty": "models.dev catalog not cached yet",
"weight_out_of_range": "Stored weight {weight} is outside the slider range; drag to snap it",
"test_checks_saved_account": "The test uses the saved account; unsaved transform edits are not exercised."
```

Also under `dashboard.providers.editor`, keep `step_connection`/`step_models`/`step_routing`/`step_validate`/`step_invalid`/`next`/`previous` for now — they are removed in task 19 together with their last consumers. Keep all `validate_*` keys (the rail panel reuses them).

- [ ] **Step 4: Compile and verify**

Run: `bun run i18n:compile && bun test packages/i18n/__tests__/locale-parity.test.ts && bun run --filter @aio-proxy/i18n test:unit` — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/i18n
git commit -m "feat(i18n): provider editor section keys, locale parity test, drift fixes"
```

---

### Task 10: Weight slider component in `packages/ui`

**Files:**
- Create: `packages/ui/src/components/slider.tsx` (generated)

- [ ] **Step 1: Add via the shadcn registry (per `packages/ui/src/components/AGENTS.md:8`)**

```bash
cd packages/ui && bun x --bun --no-install shadcn add slider --overwrite && cd ../..
```

Expected: `packages/ui/src/components/slider.tsx` exists and imports from `@base-ui/react/slider` (already a dependency — no package.json change). If the generator writes a different import root, keep the generated file as-is; `components.json` is the source of truth.

- [ ] **Step 2: Verify the generated file typechecks**

Run: `bun x --bun tsc --noEmit -p packages/ui` — PASS (exit 0, no output; verified clean on this tree before the slider was added, so any error is attributable to the generated file).

This is the ONLY check that reads the new file. Three plausible alternatives are all inert here:
- `@aio-proxy/ui`'s own `build` script is `bun -e "void 0"`, a no-op.
- `bun run lint:types` cannot see the file at all: `oxc.ts:11` ignores `packages/ui/src/components/**` ("shadcn-generated primitives are maintained upstream rather than by this repository"). Pointing oxlint straight at a deliberately broken file in that directory returns "No files found to lint", exit 0.
- `packages/ui` is absent from the root `tsconfig.json` `references`, so the project-wide build does not reach it either.

- [ ] **Step 3: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): add slider component from the configured registry"
```

---

### Task 11: `lib/section-status` — pure per-section status

**Files:**
- Create: `packages/dashboard/src/modules/providers/lib/section-status/index.ts`, `section-status.ts`, `section-status.test.ts`

**Interfaces:**
- Consumes: `AliasEditorIssue` from `../alias-editor`.
- Produces:

```ts
export type SectionId = 'identity' | 'connection' | 'models' | 'routing' | 'advanced';
export type SectionStatus = 'todo' | 'attention' | 'ok';
export interface SectionStatusInput {
  readonly kind: 'api' | 'ai-sdk' | 'oauth';
  readonly mode: 'create' | 'edit';
  readonly id: string;
  readonly baseURL?: string | undefined;          // api only
  readonly protocol?: string | undefined;         // api only
  readonly capabilityKey?: string | undefined;    // oauth only
  readonly authorized: boolean;                   // oauth: account exists; api/ai-sdk: always true
  readonly models: readonly string[];
  readonly discoveredModels?: readonly string[] | undefined; // oauth catalog candidates
  readonly aliasIssues: readonly AliasEditorIssue[];
  readonly transformsValid: boolean;
  readonly weightTie: boolean;
}
export function sectionStatuses(input: SectionStatusInput): Readonly<Record<SectionId, SectionStatus>>;
export function blockingSections(statuses: Readonly<Record<SectionId, SectionStatus>>): SectionId[];
```

Status rules (spec Form State table): `todo` only for fields the mutation schema requires — Provider ID (create mode), api `baseURL`/`protocol`, oauth capability before authorization — plus alias issues (the schema rejects those payloads) and invalid transforms JSON. `apiKey` is NOT a todo (optional in the schema; an unauthenticated local endpoint must stay saveable). `attention` for a weight tie (routing) and stale whitelist entries (models: whitelist entry not in `discoveredModels` when provided). Empty `models` is not a todo — alias-only providers are valid.

- [ ] **Step 1: Write the failing tests**

```ts
// section-status.test.ts
import { expect, test } from '@rstest/core';

import { blockingSections, sectionStatuses } from './section-status';

const base = {
  kind: 'api' as const,
  mode: 'create' as const,
  id: 'p1',
  baseURL: 'https://x.example/v1',
  protocol: 'openai-compatible',
  authorized: true,
  models: ['m1'],
  aliasIssues: [],
  transformsValid: true,
  weightTie: false,
};

test('an empty baseURL on an api provider is todo and blocks; an empty apiKey is not', () => {
  const statuses = sectionStatuses({ ...base, baseURL: '' });
  expect(statuses.connection).toBe('todo');
  expect(blockingSections(statuses)).toEqual(['connection']);
  expect(sectionStatuses(base).connection).toBe('ok');
});

test('an empty provider id blocks in create mode only', () => {
  expect(sectionStatuses({ ...base, id: '' }).identity).toBe('todo');
  expect(sectionStatuses({ ...base, id: '', mode: 'edit' }).identity).toBe('ok');
});

test('alias issues raise routing to todo because the schema would reject the save', () => {
  const statuses = sectionStatuses({ ...base, aliasIssues: [{ code: 'target-missing', alias: 'smart' }] });
  expect(statuses.routing).toBe('todo');
});

test('a stale whitelist entry is attention and does not block', () => {
  const statuses = sectionStatuses({
    ...base,
    kind: 'oauth',
    capabilityKey: 'p\0c',
    models: ['gone'],
    discoveredModels: ['here'],
  });
  expect(statuses.models).toBe('attention');
  expect(blockingSections(statuses)).toEqual([]);
});

test('a weight tie is attention on routing', () => {
  expect(sectionStatuses({ ...base, weightTie: true }).routing).toBe('attention');
});

test('an oauth provider without a capability is todo; unauthorized locks nothing but connection stays attention-free todo path', () => {
  const statuses = sectionStatuses({
    ...base,
    kind: 'oauth',
    capabilityKey: '',
    authorized: false,
    models: [],
  });
  expect(statuses.connection).toBe('todo');
});

test('invalid transforms JSON blocks the advanced section', () => {
  expect(sectionStatuses({ ...base, transformsValid: false }).advanced).toBe('todo');
});
```

Run: `bun run --filter @aio-proxy/dashboard test:unit` — FAILS (module missing).

- [ ] **Step 2: Implement**

```ts
// section-status.ts
import type { AliasEditorIssue } from '../alias-editor';

export type SectionId = 'identity' | 'connection' | 'models' | 'routing' | 'advanced';
export type SectionStatus = 'todo' | 'attention' | 'ok';

export interface SectionStatusInput {
  readonly kind: 'api' | 'ai-sdk' | 'oauth';
  readonly mode: 'create' | 'edit';
  readonly id: string;
  readonly baseURL?: string | undefined;
  readonly protocol?: string | undefined;
  readonly capabilityKey?: string | undefined;
  readonly authorized: boolean;
  readonly models: readonly string[];
  readonly discoveredModels?: readonly string[] | undefined;
  readonly aliasIssues: readonly AliasEditorIssue[];
  readonly transformsValid: boolean;
  readonly weightTie: boolean;
}

const SECTION_ORDER: readonly SectionId[] = ['identity', 'connection', 'models', 'routing', 'advanced'];

export function sectionStatuses(input: SectionStatusInput): Readonly<Record<SectionId, SectionStatus>> {
  // The id is server-assigned for oauth creation, so it can never be a todo there.
  const identity: SectionStatus =
    input.mode === 'create' && input.kind !== 'oauth' && input.id.trim() === '' ? 'todo' : 'ok';

  let connection: SectionStatus = 'ok';
  if (input.kind === 'api' && ((input.baseURL ?? '').trim() === '' || (input.protocol ?? '') === '')) connection = 'todo';
  if (input.kind === 'oauth' && (input.capabilityKey ?? '') === '') connection = 'todo';

  let models: SectionStatus = 'ok';
  if (input.discoveredModels !== undefined && input.models.length > 0) {
    const discovered = new Set(input.discoveredModels);
    if (input.models.some((model) => !discovered.has(model))) models = 'attention';
  }

  // Alias issues block: validateAliasTargets turns them into a 400 on save.
  let routing: SectionStatus = input.aliasIssues.length > 0 ? 'todo' : 'ok';
  if (routing === 'ok' && input.weightTie) routing = 'attention';

  const advanced: SectionStatus = input.transformsValid ? 'ok' : 'todo';

  return { identity, connection, models, routing, advanced };
}

export function blockingSections(statuses: Readonly<Record<SectionId, SectionStatus>>): SectionId[] {
  return SECTION_ORDER.filter((section) => statuses[section] === 'todo');
}
```

```ts
// index.ts
export * from './section-status';
```

- [ ] **Step 3: Run to verify pass, then commit**

Run: `bun run --filter @aio-proxy/dashboard test:unit` — PASS.

```bash
git add packages/dashboard/src/modules/providers/lib/section-status
git commit -m "feat(dashboard): pure section status for the provider editor"
```

---

### Task 12: `lib/model-rows` — models[] × metadata{} round trip

**Files:**
- Create: `packages/dashboard/src/modules/providers/lib/model-rows/index.ts`, `model-rows.ts`, `model-rows.test.ts`

**Interfaces:**

```ts
export interface ModelRow {
  readonly id: string;
  readonly metadata: Record<string, unknown> | undefined;
}
export function toModelRows(models: readonly string[], metadata: Readonly<Record<string, Record<string, unknown>>> | undefined): ModelRow[];
export function applyModelRows(
  rows: readonly ModelRow[],
  previousMetadata: Readonly<Record<string, Record<string, unknown>>> | undefined,
): { models: string[]; metadata: Record<string, Record<string, unknown>> | undefined };
```

Contract (spec Models Section): the round trip preserves metadata keys for models **not** in `models[]` (alias-only models legitimately carry metadata) and never drops unrecognized metadata fields (`ModelMetadataSchema` is `.loose()`).

- [ ] **Step 1: Write the failing tests**

```ts
// model-rows.test.ts
import { expect, test } from '@rstest/core';

import { applyModelRows, toModelRows } from './model-rows';

test('rows join models with their metadata', () => {
  expect(toModelRows(['a', 'b'], { a: { name: 'A' } })).toEqual([
    { id: 'a', metadata: { name: 'A' } },
    { id: 'b', metadata: undefined },
  ]);
});

test('round trip keeps metadata for alias-only models and unrecognized fields', () => {
  const previous = { 'alias-only': { extend: 'openai/gpt-y', unknownField: 1 }, a: { cost: { input: 1 } } };
  const rows = toModelRows(['a'], previous);
  const applied = applyModelRows(rows, previous);
  expect(applied.models).toEqual(['a']);
  expect(applied.metadata).toEqual(previous);
});

test('a row metadata record replaces the previous record for that id', () => {
  const previous = { a: { cost: { input: 1 }, removedInDrawer: true } };
  const rows = [{ id: 'a', metadata: { cost: { input: 2 } } }];
  // A row carries the WHOLE record for its id (toModelRows seeded it from previous), so a key
  // the user deleted in the drawer must stay deleted — never revived from previousMetadata.
  expect(applyModelRows(rows, previous).metadata).toEqual({ a: { cost: { input: 2 } } });
});

test('empty metadata collapses to undefined', () => {
  expect(applyModelRows([{ id: 'a', metadata: undefined }], undefined)).toEqual({ models: ['a'], metadata: undefined });
});
```

Run: `bun run --filter @aio-proxy/dashboard test:unit` — FAILS.

- [ ] **Step 2: Implement**

```ts
// model-rows.ts
export interface ModelRow {
  readonly id: string;
  readonly metadata: Record<string, unknown> | undefined;
}

type MetadataRecord = Readonly<Record<string, Record<string, unknown>>>;

export function toModelRows(models: readonly string[], metadata: MetadataRecord | undefined): ModelRow[] {
  return models.map((id) => ({ id, metadata: metadata?.[id] }));
}

export function applyModelRows(
  rows: readonly ModelRow[],
  previousMetadata: MetadataRecord | undefined,
): { models: string[]; metadata: Record<string, Record<string, unknown>> | undefined } {
  const models = rows.map((row) => row.id);
  const rowIds = new Set(models);
  const merged: Record<string, Record<string, unknown>> = {};
  // Metadata for ids outside models[] (e.g. alias-only targets) must survive.
  for (const [id, value] of Object.entries(previousMetadata ?? {})) {
    if (!rowIds.has(id)) merged[id] = value;
  }
  for (const row of rows) {
    if (row.metadata !== undefined && Object.keys(row.metadata).length > 0) merged[row.id] = row.metadata;
  }
  return { models, metadata: Object.keys(merged).length === 0 ? undefined : merged };
}
```

```ts
// index.ts
export * from './model-rows';
```

- [ ] **Step 3: Run to verify pass, then commit**

Run: `bun run --filter @aio-proxy/dashboard test:unit` — PASS.

```bash
git add packages/dashboard/src/modules/providers/lib/model-rows
git commit -m "feat(dashboard): model rows join/split preserving alias-only and loose metadata"
```

---

### Task 13: `use-provider-editor-form` — one kind-discriminated form hook

**Files:**
- Create: `packages/dashboard/src/modules/providers/hooks/use-provider-editor-form.ts`
- Modify: `hooks/use-provider-form.ts` — `ProviderFormShape` (`:10`) is currently package-private (`type ProviderFormShape = ...`). Add `export`: `export type ProviderFormShape = ...`. Nothing else in that file changes. `normalizeProviderFormValue` (`:56`) and `parseProviderFormInitial` (`:63`) are already exported — reuse, do not duplicate.

**Interfaces:**

```ts
export type OAuthEditorShape = {
  readonly kind: ProviderKind.OAuth;
  readonly id: string;
  readonly name?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly weight?: number | undefined;
  readonly proxy?: OAuthProviderMutationBody['proxy'];
  readonly alias?: ProviderAlias | undefined;
  readonly transforms?: unknown;
  readonly models?: readonly string[] | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly capabilityKey: string;
  readonly publicValues: Record<string, unknown>;
  readonly secrets: Record<string, string>;
  readonly clearSecrets: readonly string[];
  readonly jsonValues: Record<string, string>;
  readonly validationModel?: string | undefined;
};
export type ProviderEditorShape = ProviderFormShape | OAuthEditorShape; // ProviderFormShape from use-provider-form.ts
export type ProviderEditorForm = ReactFormExtendedApi<ProviderEditorShape, any, ..., any>; // same any-arity as ProviderForm
type UseProviderEditorFormOptions = {
  // mirrors the private UseProviderFormOptions at use-provider-form.ts:109
  readonly kind: ProviderKind;
  readonly mode: ProviderFormMode;
  readonly initial?: Partial<ProviderEditorShape> | undefined;
  readonly onSubmit: (value: ProviderEditorShape) => void | Promise<void>;
};
export function useProviderEditorForm(options: UseProviderEditorFormOptions): ProviderEditorForm;
```

Implementation mirrors `useProviderForm` (`hooks/use-provider-form.ts:120-136`): `useForm` with `defaultValues: { ...initial, kind }`, an `onChange` validator that safeParses api/ai-sdk values against their mutation schemas via `normalizeProviderFormValue` and skips schema validation for oauth (account fields are not a Zod shape; the oauth body is validated at submit in the page), and `onSubmit` that forwards raw values — the page template owns dispatch (task 18). Cast through `as unknown as ProviderEditorForm` exactly as `useProviderForm` does; keep the existing `// ponytail:` comments' rationale by reference, not by copying.

- [ ] **Step 1: Export `ProviderFormShape`, then implement the hook (no isolated unit test — it is exercised by the section/page tests in tasks 14–19; a hook-only test would restate the implementation)**

First, in `hooks/use-provider-form.ts:10`, add the missing `export` keyword so the new hook can import the shape:

```ts
export type ProviderFormShape = ProviderFormValues extends infer Provider
```

Then create the hook:

```ts
import type { OAuthProviderMutationBody, ProviderAlias } from '@aio-proxy/types';
import { AiSdkProviderMutationBodySchema, ApiProviderMutationBodySchema, ProviderKind } from '@aio-proxy/types';
import { type ReactFormExtendedApi, useForm } from '@tanstack/react-form';

import type { ProviderFormMode } from '../lib/constants';
import { normalizeProviderFormValue, type ProviderFormShape } from './use-provider-form';

// ... types exactly as in Interfaces above ...

export function useProviderEditorForm({ kind, initial, onSubmit }: UseProviderEditorFormOptions): ProviderEditorForm {
  const schema =
    kind === ProviderKind.Api
      ? ApiProviderMutationBodySchema
      : kind === ProviderKind.AiSdk
        ? AiSdkProviderMutationBodySchema
        : undefined;

  return useForm({
    defaultValues: { ...initial, kind } as ProviderEditorShape,
    validators: {
      onChange: ({ value }) => {
        if (schema === undefined) return undefined; // oauth: validated at submit
        const result = schema.safeParse(normalizeProviderFormValue(value as ProviderFormShape));
        return result.success ? undefined : result.error.issues.map((issue) => issue.message).join(', ');
      },
    },
    onSubmit: async ({ value }) => onSubmit(value),
  }) as unknown as ProviderEditorForm;
}
```

- [ ] **Step 2: Verify compile, then commit**

Run: `bun run --filter @aio-proxy/dashboard build` — PASS (hook unused yet; that is fine).

```bash
git add packages/dashboard/src/modules/providers/hooks/use-provider-editor-form.ts packages/dashboard/src/modules/providers/hooks/use-provider-form.ts
git commit -m "feat(dashboard): unified kind-discriminated provider editor form hook"
```

---

### Task 14: Identity and connection sections; slim the three kind wrappers

**Files:**
- Create: `packages/dashboard/src/modules/providers/components/provider-editor/identity-section.tsx`, `connection-section.tsx`
- Modify: `components/provider-form-fields-api.tsx` (keep ONLY protocol/baseURL/apiKey; drop the step switch, `ProviderCommonFields`, proxy, headers, models, alias, transforms blocks)
- Modify: `components/provider-form-fields-ai-sdk.tsx` (keep ONLY packageName/options/parseReasoningContent)
- Modify: `components/oauth-provider-edit-fields.tsx` (keep ONLY the account/capability/reauthorize block)
- Modify: `components/provider-common-fields.tsx` — widen its `form` prop from `ReturnType<typeof useProviderForm>` to `ProviderEditorForm`. `IdentitySection` renders it with the new form, so without this the section does not typecheck. The two slimmed kind wrappers above take the same prop and widen with it.
- Modify: `components/provider-form-fields-api.test.tsx` (assertions on models/alias/transforms move out per spec Test Accounting)

**Interfaces:**
- Produces:

```ts
// identity-section.tsx
interface IdentitySectionProps {
  readonly form: ProviderEditorForm;
  readonly mode: ProviderFormMode;
  readonly kind: ProviderKind;
  readonly onKindChange?: ((kind: ProviderKind) => void) | undefined; // create mode only
  readonly status: SectionStatus;
}
// connection-section.tsx
interface ConnectionSectionProps {
  readonly form: ProviderEditorForm;
  readonly accountForm?: OAuthProviderForm | undefined;  // oauth: existing useOAuthProviderForm instance, imported from ../../hooks/use-oauth-provider-form
  readonly mode: ProviderFormMode;
  readonly kind: ProviderKind;
  readonly capabilities?: readonly DashboardOAuthCapability[] | undefined;
  readonly oauth?: DashboardOAuthProviderEdit | undefined; // oauth edit stage
  readonly status: SectionStatus;
}
```

- [ ] **Step 1: Slim the api wrapper**

`provider-form-fields-api.tsx` becomes a single connection-fields component: delete the `activeStep` prop and all step branches; keep exactly the protocol Select (`:45-76`), baseURL Input (`:77-91`), and apiKey Input (`:92-112`) blocks. For apiKey in edit mode, extend the existing helper with the retained-key hint (spec Form State: `""` means retain server-side):

```tsx
<p className="text-sm text-muted-foreground">
  {mode === ProviderFormMode.Edit
    ? m['dashboard.providers.editor.api_key_retained_hint']()
    : m['dashboard.providers.form.api_key_helper_create']()}
</p>
```

Ship **no** clear button and add no `api_key_clear` key. This is already settled against source, so do not re-derive it: `provider-mutation.ts:103-108` restores the previous key whenever the incoming `apiKey` is absent or `""`, and any non-empty string is stored verbatim — the mutation has no clear path, so a sentinel such as `'<clear>'` would be saved as the API key itself. Clearing a stored key needs a real server-side flag and is out of scope (spec Form State).

Props shrink to `{ form, mode }`. Update `provider-form-fields-api.test.tsx`: keep the protocol/baseURL/apiKey assertions, delete the step-navigation and models/alias/transforms assertions (their behavior is covered by the new section tests in tasks 15–16).

- [ ] **Step 2: Slim the ai-sdk and oauth wrappers the same way**

`provider-form-fields-ai-sdk.tsx`: keep packageName, options editor (`provider-options-editor.tsx` untouched), `parseReasoningContent`; drop everything else. `oauth-provider-edit-fields.tsx`: keep the account fields + reauthorize block (`OAuthAccountFields`, capability display, reauthorize button); drop common/alias/transforms/proxy blocks. Drop the section chrome too — all three `<section>` wrappers and their `<h2>` headings (`form.section_basic` at `:45`, `form.section_connection` at `:92`, `form.section_models_aliases` at `:135`) go with them, leaving the file contributing fields only. The new `identity-section.tsx`/`connection-section.tsx` own the headings via the `editor.section_*` keys, so keeping the inner `<h2>` would render two headings for one section — identical text in `en`, and in `zh-Hant` two different words for it (`form.section_connection` is 「連接」, `editor.section_connection` is 「連線」). This file is the sole consumer of all three keys, so task 19 retires them.

- [ ] **Step 3: Create the two section components**

```tsx
// identity-section.tsx — kind picker (create only) + name/id via ProviderCommonFields
import { m } from '@aio-proxy/i18n';
import { ProviderKind } from '@aio-proxy/types';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { Field } from '@aio-proxy/ui/components/field';
import { Label } from '@aio-proxy/ui/components/label';

import { ProviderCommonFields } from '../provider-common-fields';
import { ProviderFormMode } from '../../lib/constants';
import { SectionShell } from './section-shell';

const KIND_LABEL_KEYS = {
  [ProviderKind.Api]: 'dashboard.providers.editor.kind_api',
  [ProviderKind.AiSdk]: 'dashboard.providers.editor.kind_ai_sdk',
  [ProviderKind.OAuth]: 'dashboard.providers.editor.kind_oauth',
} as const;

export const IdentitySection: React.FC<IdentitySectionProps> = ({ form, mode, kind, onKindChange, status }) => (
  <SectionShell id="identity" title={m['dashboard.providers.editor.section_identity']()} status={status}>
    {mode === ProviderFormMode.Create ? (
      <Field>
        <Label>{m['dashboard.providers.editor.kind_label']()}</Label>
        <Select value={kind} onValueChange={(value) => onKindChange?.(value as ProviderKind)}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.values(ProviderKind).map((candidate) => (
              <SelectItem key={candidate} value={candidate}>{m[KIND_LABEL_KEYS[candidate]]()}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    ) : null}
    {/* oauth create: no id field, the server assigns session.providerId */}
    <ProviderCommonFields form={form} mode={kind === ProviderKind.OAuth && mode === ProviderFormMode.Create ? ProviderFormMode.Edit : mode} section="connection" />
  </SectionShell>
);
```

Also create `components/provider-editor/section-shell.tsx` (one component per file) used by every section: an anchor target with heading + status badge:

```tsx
interface SectionShellProps {
  readonly id: string;
  readonly title: string;
  readonly status: SectionStatus;
  readonly children: React.ReactNode;
  readonly disabledReason?: string | undefined; // oauth pre-authorization lock
}
export const SectionShell: React.FC<SectionShellProps> = ({ id, title, status, children, disabledReason }) => (
  <section id={`editor-${id}`} aria-labelledby={`editor-${id}-heading`} className="scroll-mt-28 space-y-5">
    <div className="flex items-center gap-2">
      <h2 id={`editor-${id}-heading`} className="text-base font-semibold">{title}</h2>
      {status === 'todo' ? <Badge variant="destructive">{m['dashboard.providers.editor.section_status_todo']()}</Badge> : null}
      {status === 'attention' ? <Badge variant="outline">{m['dashboard.providers.editor.section_status_attention']()}</Badge> : null}
    </div>
    {disabledReason === undefined ? children : (
      <div aria-disabled className="pointer-events-none space-y-5 opacity-50">
        <p className="pointer-events-auto rounded-lg border bg-muted p-3 text-sm opacity-100">{disabledReason}</p>
        {children}
      </div>
    )}
  </section>
);
```

`connection-section.tsx` forks on kind and renders the slimmed wrappers (`ProviderFormFieldsApi`, `ProviderFormFieldsAiSdk`, oauth: `OAuthCapabilityCombobox` + `OAuthAccountFields` in create, `OAuthProviderEditFields` in edit) inside a `SectionShell id="connection"`.

- [ ] **Step 4: Run dashboard tests and commit**

Run: `bun run --filter @aio-proxy/dashboard test:unit` — PASS (updated api-fields test; page templates still compile because their step props were removed together with their usage — if `provider-form-page.tsx` breaks, patch its call sites minimally; it is deleted in task 19).

```bash
git add packages/dashboard/src/modules/providers/components
git commit -m "feat(dashboard): identity and connection sections; kind wrappers keep connection fields only"
```

---

### Task 15: Models section — one row list plus the metadata drawer tabs

**Files:**
- Create: `components/provider-editor/models-section/{index.ts,models-section.tsx,models-section.test.tsx}` (same-name directory: it has a colocated test), `components/provider-editor/model-metadata-visual-tab.tsx` (no test, stays flat)
- Modify: `components/provider-models-field/provider-model-metadata-drawer-content.tsx` (add the tab strip)
- Modify: `hooks/use-provider-catalog-mutation/use-provider-catalog-mutation.ts` — widen its first parameter from `ProviderForm` (`:7`) to `ProviderEditorForm`. The models section reuses this hook with the new form, so without this the section does not typecheck.
- Create: `packages/dashboard/src/modules/providers/services/models-dev-service.ts`
- Modify: `packages/dashboard/src/lib/query-keys.ts` (add `modelsDevSlugs`)

**Interfaces:**

```ts
// models-section.tsx
interface ModelsSectionProps {
  readonly form: ProviderEditorForm;
  readonly kind: ProviderKind;
  readonly mode: ProviderFormMode;
  readonly persistedProviderId?: string | undefined;
  readonly candidates?: readonly string[] | undefined; // oauth: oauth.models (discovered catalog); api/ai-sdk: last draft catalog result
  readonly status: SectionStatus;
}
// models-dev-service.ts
export const modelsDevSlugsQueryOptions = () => queryOptions({
  queryKey: queryKeys.modelsDevSlugs,
  queryFn: async () => (await dashboardClient.dashboard.api['models-dev'].slugs.$get()).json(),
});
```

Behavior (spec Models Section): one row list built from `toModelRows(models, metadata)`; a filter input; a count line — for oauth with empty whitelist the count reads `models_all_discovered` (candidates length), otherwise `models_count`; a single manual-add input (replaces `TagsInput`, catalog grid, and enabled list in `provider-models-field.tsx`); per-row: enable/disable checkbox against `candidates`, metadata button opening the drawer, remove button; rows write back through `applyModelRows` so alias-only/unknown metadata survives. Stale whitelist rows (not in candidates) render with `models_stale_whitelist` copy. The "load catalog" button reuses `useProviderCatalogMutation` for api/ai-sdk; for oauth, candidates come in via props (no draft catalog call).

Metadata drawer: wrap the existing JSON textarea in `<Tabs>` (`@aio-proxy/ui/components/tabs`) with `metadata_tab_visual` / `metadata_tab_json`. The visual tab (`model-metadata-visual-tab.tsx`) edits `extend` (Combobox fed by `modelsDevSlugsQueryOptions`, empty state `metadata_extend_empty`), `limit.context`/`limit.output` (number inputs), `cost.input`/`cost.output` (number inputs), `capabilities.attachment`/`capabilities.reasoning` (switches). It must merge over the existing object — build its output as `{ ...currentValue, extend, limit, cost, capabilities }` dropping only keys the user explicitly cleared — and render `metadata_unknown_fields` with the count of keys outside `{name, description, extend, limit, cost, capabilities}`. The JSON tab keeps the current textarea behavior byte-for-byte.

- [ ] **Step 1: Write failing section tests** (`components/provider-editor/models-section/models-section.test.tsx`, rstest + Testing Library, mock `@tanstack/react-query` as `provider-models-field` tests do): (a) rows render from form `models`+`metadata`; (b) manual add appends a row and writes the form; (c) removing a row keeps alias-only metadata (assert via form value after `applyModelRows`); (d) oauth empty whitelist renders the `models_all_discovered` wording; (e) a whitelist entry outside candidates renders the stale copy. Run — FAIL.

- [ ] **Step 2: Implement `models-section.tsx`, `model-metadata-visual-tab.tsx`, the drawer tab strip, and the slugs service.** Keep `provider-models-field/` intact for now (deleted with the stepper in task 19 if nothing else consumes it; `provider-model-metadata-drawer-content.tsx` and `provider-model-metadata-drawer.tsx` are reused by the new section).

- [ ] **Step 3: Run to verify pass, then commit**

Run: `bun run --filter @aio-proxy/dashboard test:unit` — PASS.

```bash
git add packages/dashboard/src/modules/providers packages/dashboard/src/lib/query-keys.ts
git commit -m "feat(dashboard): unified models section with metadata visual/JSON drawer tabs"
```

---

### Task 16: Routing section — weight slider, attempt-order preview, inline aliases

**Files:**
- Create: `components/provider-editor/routing-section.tsx`, `weight-slider-field.tsx`, and `components/provider-editor/attempt-order-preview/{index.ts,attempt-order-preview.tsx,attempt-order-preview.test.tsx}` (same-name directory: it has a colocated test)
- Modify: `components/provider-alias/index.ts` — re-export `ProviderAliasList` and `useAliasDrafts` instead of the deleted `ProviderAliasFields`, so `routing-section.tsx` consumes the directory's public entry rather than reaching into private modules
- Delete: `components/provider-alias/provider-alias-drawer.tsx` and its only two callers, `components/provider-alias/provider-alias-fields.tsx` and `components/oauth-provider-alias-fields.tsx` (both are the per-kind alias blocks that task 14 already strips out of the three wrappers)
- Modify: `provider-alias-list.tsx` (drop the empty-whitelist early return) and `provider-alias-config-fields.tsx` (target options fall back to the catalog) — see the empty-whitelist note below
- Unchanged, reused as-is: `provider-alias-card.tsx`, `provider-alias-draft.tsx`, `provider-alias-variants.tsx`, `provider-alias-delete-dialog.tsx`, and **`use-alias-drafts.ts`** — see the draft-layer note below
- Keep: `lib/alias-editor/alias-editor.drafts.test.ts` (the draft layer survives, so its test does too)

**The draft layer does not die with the drawer.** This is the one place the earlier draft of this plan was wrong, so read it before touching anything: `useAliasDrafts` exists because a not-yet-named alias cannot be a key in the `alias` record, and because renaming has to reject duplicates — neither concern belongs to the drawer. Its signature is `useAliasDrafts(alias, onAliasChange)` (`use-alias-drafts.ts:13`), it holds no drawer state, and `provider-alias-drawer.tsx` is a pure pass-through: `const drafts = useAliasDrafts(alias, onAliasChange)` at `:43`, then eleven props spread into `<ProviderAliasList>` at `:73-88`. `routing-section.tsx` therefore calls the hook itself and reproduces that same JSX block verbatim; `ProviderAliasList` keeps all 14 of its current props and needs **no** prop-contract rewrite. What actually dies is the sheet chrome, the close-time `clearDrafts`, and the dirty-discard `AlertDialog` (`:102-115`); `discardOpen`/`setDiscardOpen`/`hasDirtyDrafts` become unread and may be trimmed from the hook only if that costs no change to `ProviderAliasList`'s required props.

**Interfaces:**

```ts
// weight-slider-field.tsx
interface WeightSliderFieldProps {
  readonly value: number | undefined;
  readonly onChange: (value: number | undefined) => void;
  readonly disabled: boolean;
}
// attempt-order-preview.tsx
interface AttemptOrderPreviewProps {
  readonly selfId: string;
  readonly selfWeight: number | undefined;
  readonly selfEnabled: boolean;
  readonly exposedAliases: readonly string[];       // modelRoutes(...).map(r => r.alias)
  readonly others: readonly Pick<DashboardProviderSummary, 'id' | 'weight' | 'clientModels' | 'enabled'>[];
}
export const attemptOrder = (props: AttemptOrderPreviewProps): { alias: string; providerIds: string[] }[]; // exported pure helper for the test
```

Weight slider semantics (spec Routing): `min=0 max=100 step=5`; an out-of-range or off-step stored value is displayed as-is (numeric label next to the slider) and only snaps once the user drags; absent stays absent — never write `0` for an untouched value (absent coalesces to `0` at the single ordering point, `config.ts:185`; the reason to not write is config hygiene, not ordering). Preview: for each exposed alias, providers serving that alias sorted by `(weight ?? 0)` descending with stable config order (the summaries list from `providersQueryOptions()` is already config-sorted, so a stable sort over it is exactly attempt order); self is injected at its edited weight; renders `preview_affinity_note` under the list. Weight tie detection feeds `sectionStatuses` (`weightTie`: some other enabled provider shares an exposed alias with `(weight ?? 0)` equal to self's).

Inline aliases: `routing-section.tsx` renders enabled + weight (from `ProviderCommonFields section="routing"` minus the old number input — replace the weight `Input` usage with `WeightSliderField` here, keeping `ProviderCommonFields` for `enabled` only or inlining the switch) followed by `useAliasDrafts(alias, onAliasChange)` and the `ProviderAliasList` block copied from `provider-alias-drawer.tsx:73-88`. Rows write `form` as soon as an alias has a name — the draft state covers only the not-yet-named row and the rename/duplicate check, exactly as it does today; what goes away is the drawer's staging-until-close behavior. `aliasEditorIssues(alias, models)` renders as inline row errors via the existing `aliasIssueControlId` anchors and feeds `sectionStatuses` as `aliasIssues`. The alias target picker offers only whitelisted models when `models` is non-empty (spec Form State) — pass `models` as the option list to `provider-alias-config-fields.tsx`.

**The empty whitelist must stay authorable.** Spec change 6 (tasks 1-2) made an alias-only provider — `models: []`, everything exposed through aliases — valid on both the server and the client. Two surfaces still block authoring it, and both are fixed here: `provider-alias-list.tsx:44` returns an `aliases_empty_models` empty state when `models.length === 0`, and `provider-alias-config-fields.tsx:104-130` renders the alias target as a `Select` whose only options are `models.map(...)`, so an empty whitelist leaves it with zero options. That early return is load-bearing today precisely because of the empty `Select`; removing it alone would ship an unusable picker.

The human's ruling: **when the whitelist is empty, the target options come from the discovered catalog instead**, mirroring the router's "an empty whitelist exposes everything" semantics (spec line 211). So thread the same `candidates` list the Models section already receives (task 15's `candidates?: readonly string[]` — oauth: `oauth.models`; api/ai-sdk: last draft catalog result) into `routing-section.tsx` and on to `provider-alias-config-fields.tsx`, and have the picker's option list be `models.length === 0 ? candidates : models`. Then delete the `provider-alias-list.tsx:44` early return. Note this only changes which options are *offered*: `aliasEditorIssues` still receives the raw `models`, where empty correctly means "no whitelist, so no target can be missing" — do not pass the fallback list to the validator, or an alias-only provider would start failing against the catalog. Retire the now-unused `aliases_empty_models` key in task 19's i18n step if nothing else references it. Cover it in Step 1: with `models: []` and non-empty `candidates`, the alias rows render and the target picker offers the candidates; with a non-empty `models`, the picker offers only the whitelist.

- [ ] **Step 1: Write the failing preview test** (pure `attemptOrder`): two others sharing an alias, weights 10/5, self edited to 7 → order `[10-provider, self, 5-provider]`; absent weights keep list order; tie at equal weight keeps config order and flags the tie. Run — FAIL.

- [ ] **Step 2: Implement the three components, repoint the barrel, delete the drawer and its two callers, and apply the empty-whitelist fix.** `use-alias-drafts.ts` is not edited; `provider-alias-list.tsx` and `provider-alias-config-fields.tsx` get only the two edits described in the empty-whitelist note. Grep consumers before deleting: `rg -n "provider-alias-drawer|ProviderAliasFields|oauth-provider-alias-fields" packages/dashboard/src` — the consumers are **components, not templates**: `ProviderAliasFields` is imported by `provider-form-fields-api.tsx` and `provider-form-fields-ai-sdk.tsx`, and `oauth-provider-alias-fields.tsx` by `oauth-provider-edit-fields.tsx`. Task 14 already strips the alias block out of all three, so this task only removes the now-unused files; if any import survives, fix that wrapper here rather than leaving a re-export shim. `provider-form-fields-api.test.tsx` also references the drawer and is rewritten in task 14.

- [ ] **Step 3: Run to verify pass, then commit**

Run: `bun run --filter @aio-proxy/dashboard test:unit` — PASS (including `alias-editor.drafts.test.ts`, which still applies).

```bash
git add -A packages/dashboard/src/modules/providers
git commit -m "feat(dashboard): routing section with weight slider, attempt-order preview, inline aliases"
```

---

### Task 17: Advanced section and the right rail

**Files:**
- Create: `components/provider-editor/advanced-section.tsx`, `exposure-panel.tsx`, and the tested panel as a same-name directory — `components/provider-editor/model-validation-panel/{index.ts,model-validation-panel.tsx,model-validation-panel.test.tsx}` (root `CLAUDE.md` requires the directory grouping whenever a module has a colocated test; the file it replaces already follows it. `advanced-section.tsx` and `exposure-panel.tsx` have no colocated test and stay flat.)
- Delete: `components/provider-validate-step/` — its test content moves into `model-validation-panel/model-validation-panel.test.tsx` and the component itself is superseded (spec Test Accounting: "the step becomes the rail panel"). Task 19 lists the deletion alongside its only consumer, `templates/provider-form-page.tsx`.

**Interfaces:**

```ts
// advanced-section.tsx: proxy (ProviderProxyField), headers (api only, ProviderHeadersField),
// transforms (ProviderRequestTransformsFormField with onValidityChange feeding sectionStatuses)
// exposure-panel.tsx
interface ExposurePanelProps {
  readonly models: readonly string[];
  readonly alias: ProviderAlias | undefined;
  readonly enabled: boolean;
  readonly warning?: 'catalog_unavailable' | undefined; // surfaced from the oauth session (task 18)
}
// model-validation-panel.tsx
interface ModelValidationPanelProps {
  readonly form: ProviderEditorForm;
  readonly kind: ProviderKind;
  readonly persistedProviderId?: string | undefined;
  readonly exposedModels: readonly string[]; // candidates for the test select
}
```

`exposure-panel.tsx` calls the real `modelRoutes` — `import { modelRoutes } from '@aio-proxy/types'` (task 5) — over the **current form values**, so the rail always matches what the router will expose on save; alias-origin rows render `→ target` like the prototype's `exposure-panel.tsx`, with `exposure_origin_alias` labels, `exposure_empty` when no routes, `exposure_disabled_note` when disabled, and the `exposure_warning_catalog` banner when `warning` is set. `model-validation-panel.tsx` is `provider-validate-step.tsx` re-shaped: same `useProviderTestMutation` flow and `validate_*` copy, plus oauth support — for oauth it builds the draft from the oauth form values (`kind: 'oauth'`, id, enabled, proxy: null, models) with `persistedProviderId`, and renders `test_checks_saved_account` under the button (spec change 5's limitation). Check `useProviderTestMutation`'s draft construction and extend it for the oauth shape rather than duplicating the mutation.

- [ ] **Step 1: Port the validate-step test to the panel** (assert: oauth panel renders the saved-account note; api panel keeps existing behaviors). Run — FAIL.
- [ ] **Step 2: Implement the three components; extend `useProviderTestMutation` for oauth drafts.**
- [ ] **Step 3: Run to verify pass, then commit**

```bash
git add -A packages/dashboard/src/modules/providers
git commit -m "feat(dashboard): advanced section and rail panels backed by real modelRoutes and draft tests"
```

---

### Task 18: The editor shell — nav, footer, save/delete, and the OAuth two-stage flow

**Files:**
- Create: `templates/provider-editor-page/index.ts`, `provider-editor-page.tsx`, `section-nav.tsx`, `editor-footer.tsx`
- Create: `hooks/use-active-section.ts` (scroll-spy via IntersectionObserver, ported from the prototype `hooks/use-active-section.ts`)
- Test: `templates/provider-editor-page/provider-editor-page.test.tsx` (new; covers create-api save, oauth two-stage, oauth re-auth in place)

**Interfaces:**

```ts
// provider-editor-page.tsx
interface ProviderEditorPageProps {
  readonly mode: ProviderFormMode;
  readonly kind: ProviderKind;                       // initial kind; create mode may change it in-page
  readonly onKindChange?: ((kind: ProviderKind) => void) | undefined; // create mode; threaded to IdentitySection
  readonly providerId?: string | undefined;          // edit mode
  readonly initial?: Partial<ProviderEditorShape> | undefined;
  readonly oauth?: DashboardOAuthProviderEdit | undefined;
  readonly sessionId?: string | undefined;           // oauth authorization session (search param)
  readonly onSessionIdChange: (sessionId: string | undefined) => void;
}
// editor-footer.tsx
interface EditorFooterProps {
  readonly blocking: readonly SectionId[];           // clickable jump targets; save disabled while non-empty
  readonly primaryLabel: string;                     // Save / Authorize
  readonly onPrimary: () => void;
  readonly onCancel: () => void;
  readonly onDelete?: (() => void) | undefined;      // edit mode
  readonly pending: boolean;
}
// section-nav.tsx
interface SectionNavProps {
  readonly statuses: Readonly<Record<SectionId, SectionStatus>>;
  readonly activeId: SectionId;
}
```

Orchestration in `provider-editor-page.tsx` (layout + save/delete ONLY; sections/nav/footer are the imported components):

- Builds `sectionStatuses` from form values (via `form.Subscribe`/`useSelector`), `aliasEditorIssues`, `transformsValid` state, weight-tie from the summaries query, oauth candidates.
- Save dispatch: api/ai-sdk → `ProviderMutationBodySchema` branch parse → `useProviderCreate`/`useProviderUpdate`; success **stays put** and shows the `footer_saved` indicator (no navigate — spec OAuth section: "A save stays put"). oauth → `oauthProviderEditAction(values, oauth.publicValues, forceReauthorize)`; `update` → `useProviderUpdate`; `reauthorize` → `startOAuthSession` with popup (port the popup + effect wiring from `use-oauth-provider-edit-page.ts:41-129` verbatim, minus both `navigate({ to: '/providers' ... })` calls).
- OAuth create stage (spec OAuth Creation): while `mode === Create && kind === OAuth && !authorized` — sections 3-5 render inside `SectionShell disabledReason={m['dashboard.providers.editor.authorization_locked_hint']()}`; identity hides the id field; primary button is `authorize` and submits `startOAuthSession` with `providerPatch` built from live sections 1-2 values (`{ enabled: true, name?, proxy? }`).
- On `session.status === 'succeeded'`: do NOT navigate to the list. Adopt `session.providerId`, `queryClient.invalidateQueries({ queryKey: queryKeys.providers })`, refetch the edit view, unlock sections 3-5, set primary to Save, surface `session.warning` through `ExposurePanel`'s `warning` prop, and `history`-replace the URL to `/providers/$id/edit` (TanStack Router: `navigate({ to: '/providers/$id/edit', params: { id }, replace: true })` — this replace is the one navigation the flow keeps, so a reload lands on the saved provider).
- Re-authorize on an existing provider: same in-place handling — refetch the edit view, stay put, warning to the rail.
- Failed/cancelled sessions keep `closeUnclaimedPopup` and remain in the authorization stage.
- Delete: `DeleteProviderDialog` ref (as `oauth-provider-edit-page.tsx:27,109` does today) — navigate to `/providers` only after deletion.

- [ ] **Step 1: Write the failing page tests** (rstest + Testing Library, mock react-query/router as `oauth-provider-create-page.test.tsx:28-48` does):
  - create-api: fill name/id/baseURL/protocol → footer save enabled → save calls create mutation, stays on page, shows saved indicator; emptying baseURL disables save and lists Connection in the footer.
  - oauth create: sections 3-5 disabled with the lock hint; primary reads Authorize; on mocked `session = { status: 'succeeded', providerId: 'p-new', warning: 'catalog_unavailable' }` the page does NOT call `navigate` to `/providers`, calls the replace-navigation to the edit route, and renders the catalog warning in the rail.
  - oauth re-auth: with a succeeded session on an existing provider, no list navigation happens and the edit view refetch is triggered.
- [ ] **Step 2: Implement the four files + `use-active-section.ts`.** Keep `provider-editor-page.tsx` under 400 lines by pushing all rendering into the section/rail/nav/footer components; if orchestration alone exceeds it, extract `templates/provider-editor-page/use-provider-editor-page.ts` (hook, one file one responsibility).
- [ ] **Step 3: Run to verify pass, then commit**

Run: `bun run --filter @aio-proxy/dashboard test:unit` — PASS.

```bash
git add packages/dashboard/src/modules/providers/templates/provider-editor-page packages/dashboard/src/modules/providers/hooks/use-active-section.ts
git commit -m "feat(dashboard): single-page provider editor shell with in-place oauth authorization"
```

---

### Task 19: Route swap, legacy deletion, and test accounting

**Files:**
- Create: `packages/dashboard/src/routes/providers/new.tsx`
- Modify: `packages/dashboard/src/routes/providers/$id.edit.tsx` (render `ProviderEditorPage` for all kinds)
- Delete: `routes/providers/new.$kind.tsx`
- Modify: `modules/providers/templates/providers-page.tsx` (+ `components/providers-table/*` as needed): the create action links to `/providers/new` without a kind; keep the `focus` search param; the list keeps its `warning` banner for direct URLs but nothing navigates with `warning` anymore
- Delete: `templates/provider-form-page.tsx`, `templates/oauth-provider-create-page.tsx`, `templates/oauth-provider-edit-page.tsx`, `templates/use-oauth-provider-edit-page.ts`, `hooks/use-oauth-provider-edit-form.ts`, `templates/provider-stepper-import.test.tsx`, `templates/oauth-provider-create-page.test.tsx`, `templates/oauth-provider-edit-page.test.tsx`, `components/provider-validate-step/` (all three files: `index.ts`, `provider-validate-step.tsx`, `provider-validate-step.test.tsx` — `templates/provider-form-page.tsx` is its only consumer and `model-validation-panel` from task 17 replaces it; it also calls the `step_validate` key Step 4 retires, so leaving it breaks both the build and Step 4's grep gate)
- Modify: `templates/providers-page.test.tsx` (create menu carries no kind — the menu lives in `templates/providers-page.tsx:35-42`, not in `components/providers-table/`)
- Modify: `packages/i18n/messages/*.json` — retire `dashboard.providers.editor.step_*`, `editor.next`, `editor.previous`, `dashboard.providers.oauth.models_readonly`, `dashboard.providers.form.aliases_empty_models` (task 16 deletes its only consumer, the `provider-alias-list.tsx` empty-whitelist early return), `dashboard.providers.form.proxy_unchanged` (task 21 deletes its only consumer, the proxy field's masked tri-state), and `dashboard.providers.form.section_basic`, `form.section_connection`, `form.section_models_aliases` (task 14 drops the section chrome in `oauth-provider-edit-fields.tsx`, their sole consumer, because the new section components own the headings); reword `form.metadata_description`, `form.metadata_json_label`, `form.metadata_json_error` to stop asserting the editor is JSON-only, and reword `form.proxy_helper`, which still enumerates four proxy arms ("keep, inherit, disable, or replace") though task 21 already reduced `ProxyMode` to `'inherit' | 'disabled' | 'url'` — drop the stale "keep" arm, and while rewriting it, change `ko`'s 제공자 to 프로바이더 so it matches the 109 프로바이더 elsewhere in that file and the `editor.*` keys it now renders beside (all five locales; parity test keeps this honest); run `bun run i18n:compile`
- Keep: `components/reui/stepper.tsx` (loses its last consumer; deletion is explicitly out of scope)

Route files:

```tsx
// routes/providers/new.tsx
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { ProviderKind } from '@aio-proxy/types';
import { useState } from 'react';

import { ProviderFormMode } from '@/modules/providers/lib/constants';
import { ProviderEditorPage } from '@/modules/providers/templates/provider-editor-page';

const NewProviderPage: React.FC = () => {
  const { session } = useSearch({ from: '/providers/new' });
  const navigate = useNavigate({ from: '/providers/new' });
  const [kind, setKind] = useState<ProviderKind>(ProviderKind.Api);
  return (
    <ProviderEditorPage
      key={kind}
      mode={ProviderFormMode.Create}
      kind={kind}
      onKindChange={setKind}
      initial={{ enabled: true }}
      sessionId={session}
      onSessionIdChange={(next) => void navigate({ search: next === undefined ? {} : { session: next }, replace: true })}
    />
  );
};

export const Route = createFileRoute('/providers/new')({
  validateSearch: (raw) => ({ session: typeof raw['session'] === 'string' ? raw['session'] : undefined }),
  component: NewProviderPage,
});
```

(`onKindChange` is threaded to `IdentitySection`; note create no longer seeds `weight: 0` — absent stays absent per the spec's slider rule.) `$id.edit.tsx` keeps its loading/not-found branches and replaces both page components with `ProviderEditorPage` (`mode: Edit`, `kind: provider.kind`, `initial: parseProviderFormInitial(provider)` for api/ai-sdk, oauth initial built from `provider` + `oauth`).

**Do not copy `use-oauth-provider-edit-page.ts:68-78` verbatim for the oauth initial — it seeds the whitelist from the catalog.** Task 3's review confirmed the bug and the human ruled it fixed at the root: that file's `models: oauth.models` was corrected to seed from `provider.models` (with `?? []`, since absent and empty both mean "no whitelist"), because `server-state/oauth-views.ts:39` fills `oauth.models` with `catalog?.language.map(({ id }) => id)` — the discovered catalog. Take every other field from `provider.*` as that hook does; take the form's `models` from `provider.models ?? []`, and pass `oauth.models` only as `candidates` per the Models section contract above. Seeding the whitelist from the catalog makes one no-op Save freeze the current catalog as an explicit whitelist, after which newly discovered upstream models are never exposed. The same file's `aliasEditorIssues(alias, …)` call was likewise corrected to take the form's live whitelist, not the catalog — carry that over too.

- [ ] **Step 1: Swap routes and delete legacy files; fix every dangling import** (`rg -n "provider-form-page|oauth-provider-create-page|oauth-provider-edit-page|use-oauth-provider-edit|provider-validate-step|new/\\$kind|new\\.\\$kind" packages/dashboard/src -g '!route-tree.gen.ts'` must return nothing. The generated route tree still names `new/$kind` until Step 2 regenerates it, so it has to be excluded here rather than fixed by hand).
- [ ] **Step 2: Regenerate the route tree** — run `bun run --filter @aio-proxy/dashboard build` (TanStack Router regenerates `route-tree.gen.ts`; never edit it by hand).
- [ ] **Step 3: Update `templates/providers-page.test.tsx`** — the create menu asserts one entry linking to `/providers/new` with no `params` (no kind submenu). This is the file that renders `ProvidersPage`, the component that owns the menu; `components/providers-table/providers-table.test.tsx` has no create-menu assertions to change.
- [ ] **Step 4: Retire/reword the i18n keys listed above in all five locales, run `bun run i18n:compile`, and confirm `rg -n "step_connection|step_models|step_routing|step_validate|step_invalid|models_readonly|aliases_empty_models|proxy_unchanged" packages/dashboard/src packages/i18n/messages` only matches the reworded metadata keys.**
- [ ] **Step 5: Run the full dashboard suite** — `bun run --filter @aio-proxy/dashboard test:unit` PASS, and `bun test packages/i18n/__tests__/locale-parity.test.ts` PASS.
- [ ] **Step 6: Commit**

```bash
git add -A packages/dashboard packages/i18n
git commit -m "feat(dashboard): route the unified provider editor and delete the stepper and oauth pages"
```

---

### Task 20: Changeset and preflight

**Files:**
- Create: `.changeset/provider-editor-single-page.md`

- [ ] **Step 1: Write the changeset** (authored directly because `bun changeset` is interactive; CI owns version/publish). Per repo rules it targets the product package `aio-proxy` plus every internal package the change lives in, all at the same bump level; the oauth model whitelist is a new user-facing config field → `minor`:

```md
---
'aio-proxy': minor
'@aio-proxy/types': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/ui': minor
'@aio-proxy/i18n': minor
'@aio-proxy/dashboard': minor
---

Redesign the provider editor into a single page shared by api, ai-sdk, and oauth providers: five fixed sections, a persistent exposure/validation rail, an in-place two-stage OAuth authorization flow, inline alias editing, a weight slider with a real attempt-order preview, and a visual model-metadata tab. OAuth providers gain a `models` whitelist that filters the discovered catalog (empty or absent exposes everything); ai-sdk providers with an OpenAI-shaped `options.baseURL` can list their catalog; oauth providers can run draft model tests; `models: []` no longer invalidates alias-only providers.
```

Verify the package names before committing: the six `@aio-proxy/*` entries against `packages/*/package.json` `name`, and `aio-proxy` against `npm/aio-proxy/package.json` — the CLI launcher lives under `npm/`, not `packages/`, so it will not appear in a `packages/*` listing and must not be dropped as a typo. It is the entry that gets the published release notes.

- [ ] **Step 2: Full gate**

Run: `bun run preflight`
Expected: oxlint clean, oxfmt clean, all unit tests green. Fix anything it reports before committing.

- [ ] **Step 3: Commit**

```bash
git add .changeset/provider-editor-single-page.md
git commit -m "chore: changeset for the single-page provider editor"
```

---

### Task 21: The provider edit-view returns real secrets (human ruling; dispatch BEFORE tasks 6 and 7)

**Human ruling:** stop masking on the provider editor path, api providers included — return real values. Scoped by the follow-up ruling to the provider edit endpoint only. `GET /providers/:id/edit-view` returns the real config entry. `GET /dashboard/api/config` (`dashboard-routes/config.ts:35`) and the `aio-proxy config` CLI (`cli/src/config-cmd/config-cmd.ts:21`) **keep masking**, so `redactSecrets` survives — only its edit-view caller, and the machinery that existed solely to cope with masked round-trips, go.

Why this is a task and not cleanup: it dissolves three defects at one root — an ai-sdk `options.apiKey` masked to `'****'` and sent upstream as `Bearer ****` (task 6), a `baseURL` edit hitting `fresh_credentials_required` before the new catalog loader can run (task 6), and every proxied oauth provider failing the new test button with `redacted_proxy_unsupported` (task 7).

**Files:**
- Modify: `packages/server/src/dashboard-routes/provider-routes.ts` (edit-view handler, `:25-39`)
- Modify: `packages/server/src/dashboard-routes/provider-draft/provider-draft-resolution.ts`
- Modify: `packages/types/src/dashboard-provider-draft/dashboard-provider-draft.ts` (both error enums)
- Modify: `packages/server/src/dashboard-routes/provider-mutation/provider-mutation.ts` (`:10`, `:89`)
- Modify: `packages/server/src/dashboard-routes/provider-secrets/provider-secrets.ts` and `provider-secrets/index.ts` (delete `retainRedactedSecrets`)
- Modify: `packages/dashboard/src/modules/providers/hooks/use-provider-form.ts` (`:56-72`), `hooks/use-oauth-provider-edit-form.ts` (`:40`), `components/provider-proxy-field/provider-proxy-field.tsx`
- Test: `packages/server/__tests__/dashboard-providers-mutation-basic.lifecycle.test.ts`, `packages/server/src/dashboard-routes/provider-draft/provider-draft.test.ts`

**Interfaces:**
- `GET /providers/:id/edit-view` returns the stored provider entry verbatim — real `apiKey`, real `headers`, real `options`, real `proxy`. The ad-hoc `hasApiKey` boolean it synthesized goes away (nothing outside its own test reads it; the providers *list* keeps its own `hasApiKey` from `materialize.ts:49`, which is unrelated and untouched).
- `DraftResolution` loses `'redacted_proxy_unsupported'` and `'fresh_credentials_required'`; both codes leave the two enums in `dashboard-provider-draft.ts` as well.
- `retainRedactedSecrets` is deleted. `redactSecrets` and `retainAuthoredTemplateStrings` stay.

- [ ] **Step 1: Invert the tests that pin masking**

`packages/server/__tests__/dashboard-providers-mutation-basic.lifecycle.test.ts:59-63` currently reads `13. GET edit-view returns hasApiKey:true and no apiKey field`. Invert it — same request, opposite contract:

```ts
  test('13. GET edit-view returns the real apiKey', async () => {
    const response = await routes.request('/providers/api-provider/edit-view');
    const body = await response.json();
    expect(body.provider.apiKey).toBe('secret-key'); // whatever the fixture seeds
    expect(body.provider).not.toHaveProperty('hasApiKey');
  });
```

Read the fixture to get the seeded key rather than guessing it.

In `packages/server/src/dashboard-routes/provider-draft/provider-draft.test.ts`, these are the masked-round-trip tests. Every one of them asserts a behavior this task removes, so each is **deleted**, not adjusted: `:270`, `:324-352`, `:527`, `:573`, `:585-635`, `:627`, `:637-687`. Before deleting, read each and check whether it also pins something that survives (e.g. a `persisted_provider_mismatch` assertion sharing the block) — keep those halves. Replace the deleted coverage with one test proving the new contract end to end:

```ts
test('an identity-changing edit reaches the upstream instead of short-circuiting', async () => {
  const response = await routes.request(
    '/providers/draft/catalog',
    jsonRequest({
      draft: { id: 'saved-api', kind: 'api', protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:1/v2' },
      persistedProviderId: 'saved-api',
    }),
  );
  // Reaches the upstream fetch and fails there — no longer short-circuited by fresh_credentials_required.
  expect(await response.json()).toEqual({ ok: false, error: { code: 'catalog_unavailable', recoverable: true } });
});
```

Run: `bun run --filter @aio-proxy/server test:unit` — the inverted lifecycle test and the new draft test FAIL; the deletions are already green by construction.

- [ ] **Step 2: Un-mask the edit-view**

`provider-routes.ts:25-39` collapses to:

```ts
    .get('/providers/:id/edit-view', (context) => {
      const id = context.req.param('id');
      // Real values on purpose: the editor round-trips this entry straight back
      // through the mutation endpoint, and every masked field it had to restore
      // was a source of Bearer '****' bugs. GET /config and the CLI still mask.
      const provider = state.currentConfig().providers.find((entry) => entry.id === id);
      if (provider === undefined) {
        return context.json({ error: 'provider not found' }, 404);
      }
      const oauth = provider.kind === 'oauth' ? state.oauthProviderEditView(id) : undefined;
      return context.json({ provider, ...(oauth === undefined ? {} : { oauth }) });
    })
```

Drop the now-unused `redactSecrets` import if nothing else in the file uses it (check first — `rg -n redactSecrets packages/server/src/dashboard-routes/provider-routes.ts`).

- [ ] **Step 3: Delete the masked-draft machinery**

In `provider-draft-resolution.ts`, in one commit:

- **`:81` is load-bearing, not cleanup.** `isEqual(draft.options, redactSecrets(previous.options))` compares a now-real draft against a masked previous, so it is permanently unequal and **every** ai-sdk draft would become `identityChanged`. It becomes `isEqual(draft.options, previous.options)`.
- Delete `:27` (the `draft.proxy === '****'` bail), `:44`'s `stripRedactedValues(...)` call (the `identityChanged` branch becomes `candidate = { ...normalizedDraft, enabled: true }`), and `:62-64`'s `requiresFreshCredentials` gate.
- Delete the now-dead helpers: `stripRedactedValues` (`:96`), `requiresFreshCredentials` (`:108`), `credentialFields` (`:113`), `hasPersistedSensitiveValue` (`:118`), `hasFreshCredentialValue` (`:133`), plus the `OMIT` symbol (`:19`) and `FRESH_CREDENTIAL_KEY_PATTERN` (`:20`).
- Remove `'redacted_proxy_unsupported'` and `'fresh_credentials_required'` from the `DraftResolution` code union (`:13`, `:16`).
- The `redactSecrets` and `isPlainObject` imports (`:2`, `:6`) both go dead — remove them. `isEqual` stays.

In `packages/types/src/dashboard-provider-draft/dashboard-provider-draft.ts`, remove both codes from each of the two enums (`:31`, `:35`, `:51`, `:55`). Grep the whole repo for each string afterwards — a leftover reference in a dashboard error-message map would compile but never fire.

- [ ] **Step 4: Delete `retainRedactedSecrets`**

`provider-mutation.ts:89` becomes `const next = { ...provider };` and the import at `:10` narrows to `retainAuthoredTemplateStrings` only. Then delete `retainRedactedSecrets` and its private `mergeRecord`/`mergeValue` helpers from `provider-secrets.ts`, drop it from `provider-secrets/index.ts`, and drop its tests from `provider-secrets.test.ts`.

Why this is safe rather than a behavior change: it existed so a masked value coming back from a client resolved to the stored one. After Step 2 nothing produces a masked provider body — the dashboard reads providers only through `/providers/:id/edit-view` (it never calls `/config`; settings uses `/settings`, which keeps its own masking), and the CLI's masking is print-only. Verify that claim before deleting: `rg -n 'api\.config|\.config\.\$get' packages/dashboard/src` must come back empty.

- [ ] **Step 5: Retire the dashboard's `'****'` handling**

Only the provider editor's, not the settings form's (`settings-service-group.tsx:56,67` reads `/settings` and stays).

- `hooks/use-provider-form.ts`: `normalizeProviderFormValue` (`:56`) loses its proxy-mask strip and becomes just the `validationModel` split; `parseProviderFormInitial` (`:63`) loses `redactedProxy` and its re-application at `:72`.
- `hooks/use-oauth-provider-edit-form.ts:40`: `const proxy = value.proxy;`.
- `components/provider-proxy-field/provider-proxy-field.tsx`: drop the `'unchanged'` mode from `ProxyMode`, `selectedMode`'s `'****'` arm (`:32`), `initiallyRedacted` (`:39`), the `'unchanged'` arm of `changeMode` (`:45`), the conditional `SelectItem` that renders it, and the `!== '****'` guard on the url input (`:73`). `mode` (`ProviderFormMode`) may become unused — remove the prop only if no other branch reads it.
- The `dashboard.providers.form.proxy_unchanged` i18n key becomes dead: add it to task 19's retirement list and its grep gate.

- [ ] **Step 6: Run to verify pass**

Run: `bun run --filter @aio-proxy/server test:unit && bun run --filter @aio-proxy/types test:unit && bun run --filter @aio-proxy/dashboard test:unit` — all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/dashboard-routes packages/server/__tests__/dashboard-providers-mutation-basic.lifecycle.test.ts packages/types/src/dashboard-provider-draft packages/dashboard/src/modules/providers
git commit -m "feat(server): the provider edit-view returns real credentials instead of masks"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** change 1 → task 3; change 2+3 → task 4; change 4 → task 6; change 5 → task 7; change 6 → tasks 1–2; models.dev slugs → task 8; i18n section → tasks 9 + 19; slider/preview/inline alias → tasks 10 + 16; models section/metadata tabs → task 15; shell/two-stage/re-auth-in-place → task 18; route removal + test accounting rows → task 19; release → task 20. The `modelRoutes` move (spec Routing) → task 5. Un-masking the provider edit-view (human ruling, no spec section) → task 21.
- **No remaining deviations from the spec.** The two that were declared here have been folded into the spec itself (commit `870db4e9`) after being verified against source: task 6 fetches `${options.baseURL}/models` because `catalogPath()` returns an inbound request path the raw capability rewrites, never a base-URL suffix, and ai-sdk base URLs already carry `/v1` (spec Metadata/change 4); task 7 widens only `testProviderDraft` and `withDraftAttempt` to `Provider` and **keeps** the `:62` oauth bail, which is runtime-unreachable after the entry branch but load-bearing for narrowing `testProvider` before `materializeDraftRuntime` (spec change 5, Signatures).
- **Type consistency:** `exposedModelIds(catalogIds, whitelist)` is defined in task 4 and consumed with the same signature in task 7; `ProviderEditorShape`/`ProviderEditorForm` are defined in task 13 and consumed in 14–19; `SectionStatus`/`SectionId`/`blockingSections` defined in task 11 and consumed in 14/18; `toModelRows`/`applyModelRows` defined in task 12 and consumed in 15; `modelRoutes` from `@aio-proxy/types` defined in task 5 and consumed in 17.
- **Ordering constraint:** i18n keys are added (task 9) before any component uses them (14–18) and retired only after their last consumers are deleted (19), so every intermediate commit compiles.
- **Ordering constraint (task 21):** task 21 is numbered last but must be dispatched **before tasks 6 and 7**. Both assume the edit-view returns real credentials: task 6's catalog loader authenticates with `options.apiKey` and task 7's oauth test path would otherwise be rejected by the `redacted_proxy_unsupported` bail it deletes. Task 21 is self-contained against the current `main` (it depends on none of tasks 1–20), so it can run at any point before them.
