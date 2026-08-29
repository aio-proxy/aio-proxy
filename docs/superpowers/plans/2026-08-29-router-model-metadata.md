# Router-Level Model Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move model metadata config from per-provider (`providers.<id>.metadata`, keyed by upstream model id) to a router-level section (`router.models.<slug>.metadata`, keyed by exposed model slug) with per-provider `cost`/`limit` overrides, and rename the plugin SDK's free-form `metadata` fields to `extra` while adding a typed `modelMetadata` descriptor field.

**Architecture:** The user-config metadata layer changes *location and keying* only; the per-field merge precedence design (docs/superpowers/specs/2026-08-08-model-metadata-source-precedence-design.md) is preserved. New precedence: `router.models.<slug>.providers.<id>.{cost,limit}` > `router.models.<slug>.metadata` > plugin `upstreamMetadata` > models.dev fallback. `ResolvedModelCandidate.configMetadata` keeps its name but is now populated from the router policy, which keeps `codex-client-models.ts` and the resolution helpers nearly unchanged. Router-metadata capability grants happen **at request time, keyed by the requested public slug** — never compressed into the upstream-id-keyed `capabilityIndex`, where two slugs sharing an upstream target would leak capabilities into each other. One shared predicate (`candidateSupportsImage`) makes that judgment for BOTH the capability filter and the image dispatch path, so a grant that passes the filter cannot be re-rejected downstream. Because it reads the leased snapshot's config, this is uniform across provider kinds (api/ai-sdk/oauth) AND the `providerInstances` injection path (`buildSnapshotWithProviders`). The only materialization touch is *plumbing, not a grant*: image transport attachment gets a provider-agnostic "any router policy declares image output" boolean, because a transport that exists but is unused is harmless while a granted candidate without a transport is a dead end. Billing reads the router policy exclusively from the same leased snapshot, and provider-qualified requests bill the underlying public slug. The plugin SDK rename is an independent phase done first.

**Tech Stack:** Bun workspace monorepo, Zod 4 schemas in `@aio-proxy/types`, Hono server, React dashboard (TanStack Query/Form), Changesets.

## Global Constraints

- Run `bun run check` plus affected package tests per task; full `bun run preflight` before finishing.
- Per-provider `providers.<id>.metadata` is deleted from schema with **no warning, no migration** (confirmed decision: project has no external users yet).
- Per-provider override under `router.models.<slug>.providers.<id>` allows **only `cost` and `limit`** (never name/description/capabilities). An override `cost`/`limit` object replaces the slug-level object wholesale (no deep merge).
- `extend` stays supported on `router.models.<slug>.metadata`.
- Plugin `upstreamMetadata` keeps working; `ModelDescriptor.displayName` wins over `modelMetadata.name`.
- Plugin SDK rename is hard (no dual-name compatibility): `ModelDescriptor.metadata`→`extra`, `ModelCatalog.metadata`→`extra`, `RawResolver` input `metadata`→`extra`. `PluginDescriptor.metadata` and OAuth credential-refresh `metadata` are NOT renamed.
- Plugin `modelMetadata` is **fail-soft**: an invalid value is dropped (descriptor and catalog stay valid). Catalogs are upstream-discovered data; one malformed field must not take a whole Provider down. Only structural catalog problems (bad id, non-JSON `extra`) still throw `ModelCatalogValidationError`.
- Plugin `modelMetadata` is validated with a **descriptor-specific strip schema**, NOT the loose `ModelMetadataSchema`: the loose config schema passes unknown keys (a plugin-set `protocol` would leak into `RuntimeModelMetadata` and change dispatch) with unvalidated values (a non-JSON value would break catalog persistence). Top-level unknown keys — including `extend` and `protocol` — are stripped structurally; an `isJsonValue` guard drops payloads the nested loose schemas let through.
- `@aio-proxy/types` becomes a **published npm package** and the SDK's metadata type source (decision: reuse host types instead of maintaining a structural mirror; the SDK already ships runtime deps like `zod`, so it was never dependency-free). `scripts/release.ts` auto-discovers non-private packages, but discovery order is glob order — NOT dependency order — so the release script MUST gain a dependency-aware publish ordering (Task 1): if `@aio-proxy/plugin-sdk` published first and the `@aio-proxy/types` publish then failed, the registry would hold an uninstallable SDK version. First publish of the new package also needs a credential bootstrap: the release workflow's own comment (`.github/workflows/release.yml:75-83`) says OIDC trusted publishing cannot create a package that does not yet exist, so the `NPM_TOKEN` secret must be set for the release that first ships `@aio-proxy/types`, then its trusted publisher configured on npmjs.com, then the secret removed (operator checklist in Task 1). `@aio-proxy/types` gets no GitHub Release notes of its own — notes still route through `aio-proxy`/`@aio-proxy/plugin-sdk` only. Everything the types package exports beyond what the SDK re-exports is published-but-unstable (0.x lockstep, no stability promise).
- Stored plugin catalogs (SQLite `catalog_json`) get a **read-time shape migration** in `readCatalog` (`descriptor.metadata`→`extra`, catalog-level `metadata`→`extra`). This is mandatory, not optional: static catalogs are persisted with `revision` and never refresh (see `__tests__/plugin-snapshot/catalog.test.ts` "static catalog with revision 0 stays fresh"), and TTL catalogs keep serving stale rows until a refresh succeeds — without migration the stored `metadata.protocol` raw-dispatch hints would silently vanish.
- Billing/pricing reads `router.models` only from the leased snapshot (`options.config` in the attempt loop, threaded into `AttemptLoopContext`), never from `source.currentProviderSnapshot()`. Provider-qualified requests (`providerId/slug`) strip the provider prefix before the policy lookup so they keep the slug cost and that provider's override.
- Domain language: "Provider ID", "provider priority", "provider weight" (see AGENTS.md).
- Changesets: target `aio-proxy` AND `@aio-proxy/plugin-sdk` (both minor) plus changed internal packages; never internal-only.
- Dashboard work follows `packages/dashboard/AGENTS.md` (module layout, TanStack Query services, i18n via `@aio-proxy/i18n`, one component per file).
- New colocated tests follow the `foo/index.ts`+`foo/foo.ts`+`foo/foo.test.ts` layout; do not add tests to legacy `_test/` directories.

## Scope note

Phases are independently green: Phase 1 (SDK rename) touches no config schema; Phases 2–3 are the config/server move; Phase 4 is dashboard; Phase 5 is docs/changesets. If splitting into two PRs, cut between Phase 1 and Phase 2.

---

## Phase 1 — Plugin SDK rename + typed `modelMetadata`

### Task 1: Publish `@aio-proxy/types`, rename SDK fields, add `modelMetadata`

**Files:**
- Modify: `packages/types/package.json` (make publishable)
- Modify: `packages/plugin-sdk/package.json` (depend on `@aio-proxy/types`)
- Modify: `packages/plugin-sdk/src/runtime.ts:80-104`
- Test: existing `packages/plugin-sdk` type tests (`bun run test:types` in the package)

**Interfaces:**
- Produces: `ModelDescriptor = { id, displayName?, extra?: JsonValue, modelMetadata?: DescriptorModelMetadata }`; `ModelCatalog.extra?: JsonValue`; `RawResolver` input field `extra?: JsonValue`; exported alias `DescriptorModelMetadata = Pick<ModelMetadataInput, …>` (derived from the real host schema type — no structural mirror to keep in sync, no `extend`).

- [ ] **Step 1: Make `@aio-proxy/types` publishable**

In `packages/types/package.json`: delete `"private": true`; add `"files": ["dist"]`, `"publishConfig": { "access": "public" }`, and a `repository` field mirroring `packages/plugin-sdk/package.json` (with `"directory": "packages/types"`). The package already builds `dist` + d.ts via rslib and has a `test:artifact` smoke test.

In `packages/plugin-sdk/package.json` `dependencies`: add `"@aio-proxy/types": "workspace:*"`. Run `bun install` to update the lockfile.

- [ ] **Step 1b: Dependency-aware publish order in `scripts/release.ts`**

The current ordering (line ~72) only pushes packages WITH `optionalDependencies` to the end; among the rest, glob order decides — `packages/plugin-sdk` can publish before `packages/types`, and a failure between the two strands an uninstallable SDK on the registry. Replace the `.sort(...)` with a topological order over workspace `dependencies` + `optionalDependencies` edges (this subsumes the existing platform-binaries-before-launcher rule, since the launcher optionalDepends on the binaries):

```ts
// Publish dependencies before dependents. npm silently skips an optionalDependency
// that isn't on the registry yet (launcher -> @aio-proxy/cli-*), and a dependent
// published before its workspace dependency (plugin-sdk -> @aio-proxy/types) is
// uninstallable if the later publish fails mid-release.
const unsorted = allPackages.filter(({ json }) => json.private !== true);
const names = new Set(unsorted.map((p) => p.json.name));
const emitted = new Set<string>();
const publishable: typeof unsorted = [];
while (publishable.length < unsorted.length) {
  const ready = unsorted.filter(
    (p) =>
      !emitted.has(p.json.name) &&
      [...Object.keys(p.json.dependencies ?? {}), ...Object.keys(p.json.optionalDependencies ?? {})].every(
        (dep) => !names.has(dep) || emitted.has(dep),
      ),
  );
  if (ready.length === 0) throw new Error('Cyclic workspace dependencies among publishable packages');
  for (const p of ready) emitted.add(p.json.name);
  publishable.push(...ready);
}
```

Verify with `bun scripts/release.ts --dry-run` output: the publish list must print `@aio-proxy/types` before `@aio-proxy/plugin-sdk` and every `@aio-proxy/cli-*` before `aio-proxy` (abort the dry run after the list if it runs long).

- [ ] **Step 1c: Operator checklist for the first `@aio-proxy/types` publish (goes in the PR description, not code)**

Per `.github/workflows/release.yml:75-83`, OIDC trusted publishing cannot create a package that does not exist yet:
1. Before merging the Version PR that first ships `@aio-proxy/types`: set the `NPM_TOKEN` repository secret to an npm automation token authorized for the `@aio-proxy` scope.
2. After the release: configure the trusted publisher for `@aio-proxy/types` on npmjs.com (same repo/workflow as the existing packages).
3. Delete the `NPM_TOKEN` secret so publishing returns to OIDC-only.

- [ ] **Step 2: Edit `packages/plugin-sdk/src/runtime.ts`**

Replace the `RawResolver`, `ModelDescriptor`, and `ModelCatalog` definitions:

```ts
import type { ModelMetadataInput } from '@aio-proxy/types';

export type RawResolver = (input: {
  readonly protocol: ProtocolId;
  readonly modelId: string;
  readonly extra?: JsonValue;
  readonly capability?: 'language' | 'embedding';
  // Inbound URL pathname when the pipeline is choosing between raw and model.
  // Absent for capability probes that are not tied to a request.
  readonly requestPath?: string;
}) => RawTransport | undefined;

/**
 * Typed, host-consumed model metadata a plugin may report for a catalog model —
 * the descriptor-facing subset of the host's ModelMetadata authoring shape.
 * `extend` is a user-config concept and is excluded; the host strips unknown
 * keys and DROPS an invalid value fail-soft, keeping the rest of the
 * descriptor and catalog usable.
 *
 * Pick (not Omit): the schema is `.loose()`, so its type carries a string
 * index signature — Omit would collapse the named keys, Pick keeps them exact.
 */
export type DescriptorModelMetadata = Pick<
  ModelMetadataInput,
  'name' | 'description' | 'limit' | 'capabilities' | 'cost'
>;

export type ModelDescriptor = {
  readonly id: string;
  readonly displayName?: string;
  /** Plugin-private free-form data (e.g. wire protocol hints); opaque to users. */
  readonly extra?: JsonValue;
  /** Typed model metadata merged into the host's upstream metadata layer. */
  readonly modelMetadata?: DescriptorModelMetadata;
};

export type ModelCatalog = {
  readonly language: readonly ModelDescriptor[];
  readonly image: readonly ModelDescriptor[];
  readonly embedding: readonly ModelDescriptor[];
  readonly speech: readonly ModelDescriptor[];
  readonly transcription: readonly ModelDescriptor[];
  readonly reranking: readonly ModelDescriptor[];
  /** Catalog-level plugin-private free-form data. */
  readonly extra?: JsonValue;
};
```

Export `DescriptorModelMetadata` from the SDK index if `runtime.ts` types are re-exported there (check `packages/plugin-sdk/src/index.ts` and mirror how `ModelDescriptor` is exported). Plugin authors who want the piece types (`ModelCostInput`, `ModelCapabilitiesInput`, …) import them from `@aio-proxy/types` directly — it is now a published package.

- [ ] **Step 3: Run the SDK's checks — expect downstream compile failures only outside this package**

Run: `bun run check 2>&1 | head -50` (workspace root)
Expected: `packages/plugin-sdk` itself passes; core/server/plugins now FAIL to compile on `.metadata` — that is the work of Tasks 2–4. Do not commit yet.
Also run: `bun test packages/plugin-sdk/build` and the package's `test:artifact` after `bun run build` — the SDK build must still produce a valid artifact now that it has a workspace dependency.

Packed-consumer verification (the SDK tarball must be installable with the types tarball, exactly what a plugin author's `npm install` will do):

```bash
PACKDIR=$(mktemp -d)
(cd packages/types && bun pm pack --destination "$PACKDIR")
(cd packages/plugin-sdk && bun pm pack --destination "$PACKDIR")
CONSUMER=$(mktemp -d) && cd "$CONSUMER" && npm init -y >/dev/null
npm install "$PACKDIR"/*.tgz   # types tarball satisfies the SDK's dependency range (lockstep versions)
node --input-type=module -e "import('@aio-proxy/plugin-sdk').then(() => console.log('sdk ok'))"
node --input-type=module -e "import('@aio-proxy/types').then(() => console.log('types ok'))"
```

Expected: both imports print ok and `npm install` needed no registry fetch for `@aio-proxy/*`. If the SDK re-exports `DescriptorModelMetadata`, also confirm the packed d.ts resolves: `ls node_modules/@aio-proxy/types/dist/*.d.ts`.

### Task 2: Core catalog validation follows the rename and validates `modelMetadata`

**Files:**
- Modify: `packages/core/src/plugins/catalog.ts:44-78`
- Test: `packages/core/src/plugins/catalog.test.ts`

**Interfaces:**
- Consumes: `ModelMetadataSchema` (for its field sub-schemas) and `isJsonValue` — core already depends on types and already uses `isJsonValue` for `extra`.
- Produces: validated descriptors carrying `extra` and parsed `modelMetadata`. The descriptor schema **strips** unknown top-level keys (including `extend` and `protocol`); a value that fails validation or is not JSON-serializable is **dropped fail-soft** (descriptor survives without it); invalid `extra` still throws `ModelCatalogValidationError` as today.

- [ ] **Step 1: Write failing tests in `packages/core/src/plugins/catalog.test.ts`**

Rename all `metadata:` fixture keys to `extra:` in this file (the exports under test are `validateModelCatalog` and `ModelCatalogValidationError` from `catalog.ts`; reuse the file's existing empty-catalog fixture), and add:

```ts
test('preserves a valid descriptor modelMetadata, stripping extend and unknown keys like protocol', () => {
  const catalog = validateModelCatalog({
    ...emptyCatalog,
    language: [
      {
        id: 'm1',
        extra: { protocol: 'anthropic' },
        modelMetadata: {
          name: 'M1',
          extend: 'openai/gpt-5',
          protocol: 'anthropic',
          limit: { context: 200_000, output: 8192 },
        },
      },
    ],
  });
  expect(catalog.language[0]?.modelMetadata).toEqual({ name: 'M1', limit: { context: 200_000, output: 8192 } });
});

test('drops an invalid descriptor modelMetadata but keeps the descriptor', () => {
  const catalog = validateModelCatalog({
    ...emptyCatalog,
    language: [{ id: 'm1', displayName: 'Kept', modelMetadata: { limit: { context: -5 } } }],
  });
  expect(catalog.language[0]).toEqual({ id: 'm1', displayName: 'Kept' });
});

test('drops a modelMetadata that smuggles non-JSON values through a nested loose schema', () => {
  const catalog = validateModelCatalog({
    ...emptyCatalog,
    language: [{ id: 'm1', modelMetadata: { cost: { input: 1, note: () => {} } } }],
  });
  expect(catalog.language[0]?.modelMetadata).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/core/src/plugins/catalog.test.ts`
Expected: FAIL (compile errors on `extra`, missing `modelMetadata` handling)

- [ ] **Step 3: Implement in `packages/core/src/plugins/catalog.ts`**

Define the descriptor-specific schema (module level):

```ts
// NOT the loose ModelMetadataSchema: config tolerates unknown keys for
// forward-compat, but plugin metadata must not — a plugin-set `protocol`
// would leak into RuntimeModelMetadata and change dispatch, and loose
// passthrough admits non-JSON values that break catalog persistence.
// z.object strips unknown top-level keys (extend and protocol included);
// the isJsonValue guard below catches what the nested loose schemas admit.
const DescriptorModelMetadataSchema = z.object({
  name: ModelMetadataSchema.shape.name,
  description: ModelMetadataSchema.shape.description,
  limit: ModelMetadataSchema.shape.limit,
  capabilities: ModelMetadataSchema.shape.capabilities,
  cost: ModelMetadataSchema.shape.cost,
});
```

In the descriptor validator, rename the destructured `metadata` to `extra` (including the error path segment `['extra']`), and add:

```ts
const { id: rawId, displayName, extra, modelMetadata } = descriptor;
// ... existing id/displayName validation ...
if (extra !== undefined && !isJsonValue(extra)) {
  throw new ModelCatalogValidationError(modality, index, ['extra']);
}
// Fail-soft: catalogs are upstream-discovered data, so an invalid modelMetadata
// is dropped rather than failing the whole catalog/Provider.
let parsedModelMetadata: ModelMetadata | undefined;
if (modelMetadata !== undefined) {
  const result = DescriptorModelMetadataSchema.safeParse(modelMetadata);
  if (result.success && isJsonValue(result.data)) {
    parsedModelMetadata = Object.keys(result.data).length === 0 ? undefined : result.data;
  }
}
return {
  id,
  ...(displayName === undefined ? {} : { displayName }),
  ...(extra === undefined ? {} : { extra }),
  ...(parsedModelMetadata === undefined ? {} : { modelMetadata: parsedModelMetadata }),
};
```

Import `ModelMetadataSchema, type ModelMetadata` from `@aio-proxy/types` and `z` from `zod`. Rename the catalog-level `metadata` validation block to `extra` the same way. (Note: `result.data` still carries `undefined`-valued optional keys in Zod output — if `Object.keys` counts them, filter with the existing spread-if-defined idiom; the tests pin the observable shape.)

- [ ] **Step 4: Run tests**

Run: `bun test packages/core/src/plugins`
Expected: PASS

### Task 3: Server plugin-runtime reads `extra` and merges `modelMetadata` into `upstreamMetadata`

**Files:**
- Modify: `packages/server/src/plugin-runtime/catalog.ts:86-132`
- Modify: `packages/server/src/plugin-runtime/capabilities.ts:61-67` (raw bridge)
- Test: `packages/server/src/plugin-runtime/catalog.test.ts`, `packages/server/src/plugin-runtime/capabilities.test.ts`

**Interfaces:**
- Produces: `modelMetadataRecord(catalog)` entries now include the plugin's typed `modelMetadata` fields (limit/capabilities/cost/description), with `displayName` still winning for `name` and `extra.protocol` still supplying `protocol`.

- [ ] **Step 1: Update fixtures and add a failing test in `packages/server/src/plugin-runtime/catalog.test.ts`**

Rename fixture `metadata:` → `extra:`. Add:

```ts
test('descriptor modelMetadata feeds upstream metadata with displayName winning the name', () => {
  expect(
    modelMetadataRecord({
      ...emptyFamilies,
      language: [
        {
          id: 'm1',
          displayName: 'Display',
          extra: { protocol: ProviderProtocol.Anthropic },
          modelMetadata: { name: 'Ignored', limit: { context: 100_000 } },
        },
      ],
      embedding: [],
    }),
  ).toEqual({
    m1: { name: 'Display', protocol: ProviderProtocol.Anthropic, limit: { context: 100_000 } },
  });
});

test('overlapping language and image descriptors merge typed fields, language winning, protocol from language only', () => {
  const record = modelMetadataRecord({
    ...emptyFamilies,
    image: [
      {
        id: 'm1',
        extra: { protocol: ProviderProtocol.OpenAIImage },
        modelMetadata: { name: 'Image', cost: { image: 0.04 } },
      },
    ],
    language: [{ id: 'm1', modelMetadata: { limit: { context: 100_000 } } }],
    embedding: [],
  });
  // Image-only fields survive, language fields merge in, and the image
  // descriptor's extra.protocol does NOT survive — language owns protocol.
  expect(record['m1']).toEqual({
    name: 'Image',
    cost: { image: 0.04 },
    limit: { context: 100_000 },
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/server/src/plugin-runtime/catalog.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement in `packages/server/src/plugin-runtime/catalog.ts`**

```ts
function descriptorMetadata(descriptor: ModelCatalog['language'][number]): RuntimeModelMetadata {
  const protocol = metadataProtocol(descriptor.extra);
  const typed = descriptor.modelMetadata ?? {};
  return {
    ...typed,
    ...(descriptor.displayName === undefined
      ? {}
      : { name: descriptor.displayName }),
    ...(protocol === undefined ? {} : { protocol }),
  };
}
```

Note: `typed` was already schema-validated in core (Task 2), so spreading it is safe. `descriptorMetadata` only ever sets defined keys (conditional spreads + the cleaned typed spread), so plain object spreads below are exact merges — no `undefined`-valued keys to leak.

`modelMetadataRecord` (round-3 P2): every modality may carry `modelMetadata`, and the current code loses fields on overlapping ids — the embedding/image loop overwrites wholesale and the language-overlap branch rebuilds from `name`/`protocol` only. Replace both merge points:

```ts
export function modelMetadataRecord(catalog: ModelCatalog): Readonly<Record<string, RuntimeModelMetadata>> {
  const record: Record<string, RuntimeModelMetadata> = {};
  for (const descriptor of [...catalog.embedding, ...catalog.image]) {
    const next = descriptorMetadata(descriptor);
    const existing = record[descriptor.id];
    // Cross-modality overlap merges fields; the earlier modality wins conflicts
    // (embedding before image — this loop's order).
    record[descriptor.id] = existing === undefined ? next : { ...next, ...existing };
  }
  for (const descriptor of catalog.language) {
    const next = descriptorMetadata(descriptor);
    const existing = record[descriptor.id];
    if (existing === undefined) {
      record[descriptor.id] = next;
      continue;
    }
    // Language owns targetProtocol: a protocol from a non-language descriptor's
    // extra must not survive (image/embed convert never read it, and it must not
    // redirect language dispatch). Other fields merge; language wins conflicts.
    const { protocol: _nonLanguageProtocol, ...nonLanguageFields } = existing;
    record[descriptor.id] = { ...nonLanguageFields, ...next };
  }
  return record;
}
```

In `capabilities.ts` `rawCapability`, change the bridge line:

```ts
...(descriptor?.extra === undefined ? {} : { extra: descriptor.extra }),
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/server/src/plugin-runtime`
Expected: PASS (fix remaining `metadata:` fixtures in `capabilities.test.ts` as compile errors surface)

- [ ] **Step 5: Commit** (after Task 4 makes the whole workspace green — the rename is atomic across packages; commit at the end of Task 4)

### Task 4: Rename in all six plugins

**Files (writes and reads of the free-form blob, from the audit):**
- Modify: `packages/plugins/github-copilot/src/github-api/catalog.ts:38`, `src/runtime/runtime.ts:44,128-133`, test fixtures (`catalog.test.ts`, `tool-images.test.ts`, `host-fetch.test.ts`, `runtime.protocol-scenarios.test.ts`, `runtime.test-support.ts`)
- Modify: `packages/plugins/kimi-code/src/catalog.ts:22,53-55`, `src/runtime/runtime.ts:36,164-167`, fixtures
- Modify: `packages/plugins/openai-chatgpt/src/catalog.ts:28`, fixtures
- Modify: `packages/plugins/xai-grok/src/catalog.ts:9,68,75`, fixtures
- Modify: `packages/plugins/cursor/src/catalog/discover/discover.ts:34,95`, `src/runtime/runtime.ts:30,53-63`, `src/catalog/default-aliases/default-aliases.ts:24`, fixtures
- Modify: `packages/plugins/google-antigravity/src/catalog/discover.ts:143-145,222+`, `src/catalog/snapshot.ts:170-181`, `src/catalog/classify/classify.ts`, `src/protocol/thinking.ts:184,223`, `src/runtime/envelope.ts:41,120`, `src/catalog/aliases.ts:60`, `src/runtime/provider.ts:60-67`, `src/runtime/raw.ts`, many test fixtures

- [ ] **Step 1: Mechanical rename**

In each listed file, rename the descriptor/catalog property `metadata` → `extra` (both object-literal writes and property reads such as `descriptor.metadata`, `model.metadata`, `catalog.metadata`). Do NOT touch: `PluginDescriptor.metadata` (plugin.ts), OAuth credential refresh `metadata` (`packages/plugins/cursor/src/oauth/credential.ts:66`), HTTP request bodies (`google-antigravity/src/oauth/project.ts` `body: { metadata: ... }`), or any `ModelMetadata` config typing.

Use search to catch stragglers: `rg -l '\bmetadata\b' packages/plugins` and inspect each hit against the do-not-touch list.

- [ ] **Step 2: Workspace compile + tests**

Run: `bun run check && bun test packages/plugins packages/core/src/plugins packages/server/src/plugin-runtime`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/types/package.json packages/plugin-sdk packages/core packages/server packages/plugins bun.lock
git commit -m "feat(plugin-sdk)!: rename catalog free-form metadata to extra, add typed modelMetadata"
```

### Task 4b: Read-time migration for persisted catalogs

Stored SQLite rows (`oauth_catalog.catalog_json`) written before the rename still carry `descriptor.metadata` / catalog-level `metadata`, including the `protocol` raw-dispatch hints. Static catalogs never refresh (revision-fenced, stay fresh forever) and TTL catalogs keep serving stale rows until a refresh succeeds, so these rows must be migrated when read.

**Files:**
- Create: `packages/core/src/plugins/repository/catalog-migration/` (`index.ts` export-only, `catalog-migration.ts`, `catalog-migration.test.ts`) — same-name-directory layout per repo testing rules
- Modify: `packages/core/src/plugins/repository/plugin-state.ts:46-51` (`readCatalog`)

**Interfaces:**
- Produces: `migrateStoredCatalogShape(catalog: ModelCatalog): ModelCatalog` — pure, idempotent, **key-rename only**; applied inside `readCatalog`, the single choke point every consumer goes through (`plugin-runtime/materialize.ts`, `model-routing/inventory.ts`, `server-state/oauth-views.ts`, `catalog-scheduler.ts`). It must NOT repair structural damage (missing/non-array modalities stay as-is so `validateModelCatalog` still rejects them).

- [ ] **Step 1: Write failing tests in `catalog-migration/catalog-migration.test.ts`**

```ts
import { expect, test } from 'bun:test';

import { migrateStoredCatalogShape } from './catalog-migration';

const empty = { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };

test('renames pre-rename descriptor and catalog metadata to extra', () => {
  const migrated = migrateStoredCatalogShape({
    ...empty,
    language: [{ id: 'm1', metadata: { protocol: 'anthropic' } } as never],
    metadata: { note: 'catalog-level' },
  } as never);
  expect(migrated.language[0]).toEqual({ id: 'm1', extra: { protocol: 'anthropic' } });
  expect(migrated.extra).toEqual({ note: 'catalog-level' });
  expect('metadata' in migrated).toBe(false);
});

test('extra wins when both extra and a stray legacy metadata key are present', () => {
  const migrated = migrateStoredCatalogShape({
    ...empty,
    language: [{ id: 'm1', extra: { protocol: 'openai-response' }, metadata: { protocol: 'anthropic' } } as never],
    extra: { keep: true },
    metadata: { stale: true },
  } as never);
  expect(migrated.language[0]).toEqual({ id: 'm1', extra: { protocol: 'openai-response' } });
  expect(migrated.extra).toEqual({ keep: true });
  expect('metadata' in migrated).toBe(false);
});

test('leaves post-rename catalogs identical', () => {
  const catalog = { ...empty, language: [{ id: 'm1', extra: { protocol: 'openai-response' } }] };
  expect(migrateStoredCatalogShape(catalog)).toEqual(catalog);
});

test('does not repair structural damage — a missing modality stays missing for the validator', () => {
  const broken = { language: [{ id: 'm1', metadata: { protocol: 'anthropic' } }] } as never;
  const migrated = migrateStoredCatalogShape(broken);
  expect(migrated.language[0]).toEqual({ id: 'm1', extra: { protocol: 'anthropic' } });
  expect('image' in migrated).toBe(false);
});

test('passes null and primitive descriptors through untouched for the validator to reject', () => {
  const broken = { ...empty, language: [null, 42, 'x', { id: 'ok', metadata: { keep: 1 } }] } as never;
  const migrated = migrateStoredCatalogShape(broken);
  expect(migrated.language).toEqual([null, 42, 'x', { id: 'ok', extra: { keep: 1 } }] as never);
});

test('a non-object catalog is returned as-is', () => {
  expect(migrateStoredCatalogShape(null as never)).toBeNull();
  expect(migrateStoredCatalogShape('broken' as never)).toBe('broken');
});
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `bun test packages/core/src/plugins/repository/catalog-migration` — FAIL (module missing).

In `catalog-migration/catalog-migration.ts`:

```ts
import { isPlainObject } from 'es-toolkit/predicate';

import type { ModelCatalog, ModelDescriptor } from '@aio-proxy/plugin-sdk';

const MODALITIES = ['language', 'image', 'embedding', 'speech', 'transcription', 'reranking'] as const;

// Rows persisted before the metadata→extra rename keep the old key. Static
// catalogs never refresh and TTL catalogs serve stale rows until a refresh
// succeeds, so the rename must happen at read time or protocol hints vanish.
// Key-rename ONLY, over UNVALIDATED database JSON: anything that is not a
// plain object — the catalog itself, or a null/primitive descriptor inside a
// modality array — passes through untouched so validateModelCatalog still
// rejects it (`'metadata' in x` throws on primitives; never reach it unguarded).
export function migrateStoredCatalogShape(catalog: ModelCatalog): ModelCatalog {
  if (!isPlainObject(catalog)) return catalog;
  const migrated: Record<string, unknown> = { ...catalog };
  if ('metadata' in migrated) {
    const legacy = migrated['metadata'];
    delete migrated['metadata'];
    if (catalog.extra === undefined) migrated['extra'] = legacy;
  }
  for (const modality of MODALITIES) {
    const list = catalog[modality];
    if (Array.isArray(list)) migrated[modality] = list.map(migrateDescriptor);
  }
  return migrated as ModelCatalog;
}

function migrateDescriptor(descriptor: ModelDescriptor): ModelDescriptor {
  if (!isPlainObject(descriptor)) return descriptor;
  const legacy = descriptor as ModelDescriptor & { readonly metadata?: unknown };
  if (!('metadata' in legacy)) return descriptor;
  const { metadata, ...rest } = legacy;
  return descriptor.extra === undefined ? ({ ...rest, extra: metadata } as ModelDescriptor) : (rest as ModelDescriptor);
}
```

(`packages/core` must declare `"es-toolkit": "catalog:"` — verify with `rg '"es-toolkit"' packages/core/package.json` and add it if missing.)

`catalog-migration/index.ts` re-exports `migrateStoredCatalogShape` only.

In `plugin-state.ts` `readCatalog`, wrap the decode: `catalog: migrateStoredCatalogShape(decodeJson<ModelCatalog>(row.catalog_json))`.

- [ ] **Step 3: Add a stale-catalog regression test**

In `packages/server/__tests__/plugin-snapshot/catalog.test.ts` (existing persisted-catalog suite), add a case that writes a catalog row in the pre-rename shape (descriptor `metadata: { protocol: ... }`) directly via the repository, materializes, and asserts the runtime still resolves the raw protocol hint (i.e. reads it as `extra`). Follow the file's existing fixture style for writing rows.

- [ ] **Step 4: Run and commit**

Run: `bun test packages/core/src/plugins/repository packages/server/__tests__/plugin-snapshot`
Expected: PASS

```bash
git add packages/core packages/server
git commit -m "fix(core): migrate persisted plugin catalogs to the extra key at read time"
```

---

## Phase 2 — Config schema move

### Task 5: Types — delete provider `metadata`, extend router policy

**Files:**
- Modify: `packages/types/src/provider.ts` (delete lines 99–104 `metadataField` and its six spreads at 112, 163, 186, 227, 265, 292; delete the now-unused `ModelMetadataSchema` import on line 26)
- Modify: `packages/types/src/config/config.ts:141-156`
- Modify: `packages/types/src/provider-alias/provider-alias.ts` (delete `RoutableModelSource.metadata` at line 155 and the `Object.keys(provider.metadata ?? {})` loop in `directModelIds` at line 182 — config metadata keys no longer invent client-facing routes; drop any `provider-alias.test.ts` cases asserting metadata-derived routes)
- Modify: `packages/types/src/model-metadata/model-metadata.ts:121-123` (doc comment: replace "Keyed by upstream model id inside a provider's `metadata`" with "Configured per exposed model slug under `router.models.<slug>.metadata`")
- Test: `packages/types/src/config/config-acceptance.test.ts` (extend), `packages/types/src/config/config-schema-ref.test.ts` (update ref path)

**Interfaces:**
- Produces: `RouterProviderOverrideSchema = { priority?, weight?, cost?, limit? }`; `RouterModelPolicySchema = { metadata?: ModelMetadata, providers: {...} }`; provider schemas no longer accept/emit `metadata`.

- [ ] **Step 1: Write failing acceptance tests**

In `config-acceptance.test.ts` add:

```ts
test('parses router model metadata with per-provider cost and limit overrides', () => {
  const config = ConfigSchema.parse({
    router: {
      models: {
        'gpt-5': {
          metadata: { name: 'GPT-5', extend: 'openai/gpt-5', cost: { input: 1.25 } },
          providers: {
            reseller: { priority: 10, cost: { input: 0.8 }, limit: { context: 128_000 } },
          },
        },
      },
    },
    providers: {},
  });
  const policy = config.router.models['gpt-5']!;
  expect(policy.metadata?.name).toBe('GPT-5');
  expect(policy.providers['reseller']?.cost).toEqual({ input: 0.8 });
  expect(policy.providers['reseller']?.limit).toEqual({ context: 128_000 });
});

test('silently strips the removed provider-level metadata field', () => {
  const config = ConfigSchema.parse({
    providers: {
      openai: { ...apiProvider, metadata: { 'gpt-5': { name: 'x' } } },
    },
  });
  expect('metadata' in config.providers[0]!).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/types/src/config/config-acceptance.test.ts`
Expected: FAIL (`metadata`/`cost`/`limit` unknown on router policy)

- [ ] **Step 3: Implement**

In `config.ts` (imports: add `ModelCostSchema, ModelLimitSchema, ModelMetadataSchema` from `../model-metadata/index`):

```ts
export const RouterProviderOverrideSchema = z.object({
  priority: RoutingPrioritySchema.optional(),
  weight: RoutingWeightSchema.optional(),
  cost: ModelCostSchema.optional().describe(
    'Provider-specific cost override for this model; replaces the model-level cost wholesale.',
  ),
  limit: ModelLimitSchema.optional().describe(
    'Provider-specific token-limit override for this model; replaces the model-level limit wholesale.',
  ),
});

export const RouterModelPolicySchema = z.object({
  metadata: ModelMetadataSchema.optional().describe(
    'Client-facing metadata for this exposed model (name, description, extend, limit, capabilities, cost).',
  ),
  providers: z.record(z.string().min(1), RouterProviderOverrideSchema).default({}),
});
```

In `provider.ts`, delete `metadataField` and all six `...metadataField` spreads and the `ModelMetadataSchema` import. In `provider-alias/provider-alias.ts`, delete the `metadata` field from `RoutableModelSource` and the metadata-keys loop in `directModelIds`; update the doc comment in `model-metadata/model-metadata.ts`.

- [ ] **Step 4: Update `config-schema-ref.test.ts`**

The models.dev `$ref` (`MODELS_DEV_MODEL_REF`) is now reachable via `router.models.*.metadata.extend` instead of `providers.*.metadata.*.extend`. Update the asserted JSON-schema path accordingly and re-run `bun test packages/types`.

- [ ] **Step 5: Run and commit**

Run: `bun test packages/types` — expect PASS; the rest of the workspace now fails to compile (Tasks 6–9 fix it; commit only when Task 9 lands to keep main-branch commits green, or commit per-task on a feature branch — this plan assumes a feature branch, so commit now):

```bash
git add packages/types
git commit -m "feat(types)!: move model metadata config to router.models, drop provider metadata field"
```

### Task 6: `resolve-extend` walks `router.models`

**Files:**
- Modify: `packages/server/src/server-state/resolve-extend/resolve-extend.ts` (full rewrite of the walk; merge logic unchanged)
- Test: `packages/server/src/server-state/resolve-extend/resolve-extend.test.ts` (rewrite fixtures), `extend-e2e.test.ts`

**Interfaces:**
- Consumes: `Config['router']['models']` (`Readonly<Record<string, RouterModelPolicy>>`).
- Produces: same exported names — `applyMetadataExtend(config, logger?, deps?): Promise<Config>`, `ResolveExtendDeps`. The returned config has `router.models[slug].metadata.extend` materialized.

- [ ] **Step 1: Rewrite tests**

Port each existing test from provider-shaped fixtures to router-shaped ones. Core behavioral cases to keep: extend resolves from catalog with user fields winning; arrays replace wholesale; unresolved slug warns and keeps user fields; catalog fetch failure preserves entries; unchanged config keeps object identity. Fixture shape:

```ts
const config = ConfigSchema.parse({
  router: { models: { 'my-model': { metadata: { extend: 'openai/gpt-5', name: 'Mine' } } } },
  providers: {},
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/server/src/server-state/resolve-extend`
Expected: FAIL

- [ ] **Step 3: Implement**

Replace the provider walk with a router walk (keep `resolveEntry`, `resolveCatalog`, `warnUnresolved` bodies; the log context uses the slug instead of a provider id):

```ts
export async function applyMetadataExtend(
  config: Config,
  logger?: PluginLogSink,
  deps?: ResolveExtendDeps,
): Promise<Config> {
  const slugs = collectExtendSlugs(config.router.models);
  if (slugs.size === 0) return config;

  const cachedOnly = deps?.getModels === undefined;
  const catalogCached = !cachedOnly || (await hasCachedModelsCatalog());
  const catalog = await resolveCatalog([...slugs], deps?.getModels ?? getModelsCachedOnly);
  if (!catalogCached && deps?.onCatalogWarmed !== undefined) {
    void getModels([...slugs]).then(deps.onCatalogWarmed, () => {});
  }

  const preserveUnresolved =
    !catalogCached || (cachedOnly && Object.values(catalog).some((model) => model === undefined));
  let changed = false;
  const models: Record<string, RouterModelPolicy> = {};
  for (const [slug, policy] of Object.entries(config.router.models)) {
    if (policy.metadata?.extend === undefined) {
      models[slug] = policy;
      continue;
    }
    changed = true;
    models[slug] = {
      ...policy,
      metadata: resolveEntry(slug, policy.metadata, catalog, logger, preserveUnresolved),
    };
  }
  return changed ? { ...config, router: { ...config.router, models } } : config;
}

function collectExtendSlugs(models: Readonly<Record<string, RouterModelPolicy>>): Set<string> {
  const slugs = new Set<string>();
  for (const policy of Object.values(models)) {
    if (policy.metadata?.extend !== undefined) slugs.add(policy.metadata.extend);
  }
  return slugs;
}
```

`resolveEntry` signature simplifies to `(slug: string, meta: ModelMetadata, catalog, logger, preserveUnresolved)` — the warning context becomes `{ model: slug }` and the log message drops the provider id. Delete `rewriteProvider` and `providerMetadata`.

- [ ] **Step 4: Run and commit**

Run: `bun test packages/server/src/server-state/resolve-extend`
Expected: PASS

```bash
git add packages/server/src/server-state/resolve-extend
git commit -m "feat(server): resolve metadata.extend from router.models"
```

---

## Phase 3 — Server runtime and resolution

### Task 7: Remove `configMetadata` from runtime providers; slug-keyed capability grant at request time

**Design constraint (review P1 rounds 2–3):** `capabilityIndex` is keyed by **upstream model id**, so per-slug router metadata cannot be projected into it without leaking capabilities between slugs that share an upstream target (and onto direct routes hidden by an alias). Router-metadata capability therefore lives at request time, resolved against the requested **public slug** from the leased snapshot's config. Round 3 found the grant must survive the WHOLE image path, not just the first filter — three downstream gates also read the index and would kill a granted candidate:

1. `dispatchImageCandidate` re-checks `supportsImage`/`supportsImageConvert` (`attempt/image.ts:26,39`);
2. `attachImageTransport` only builds an api/ai-sdk image transport when the index already has an image-capable model (`materialize-image.ts:24`);
3. plugin-runtime only creates the plugin `image` invoke when `catalog.image` is non-empty (`plugin-runtime/capabilities.ts:153-154`).

Resolution: one shared predicate `candidateSupportsImage` (index OR slug-policy grant) is used by the filter AND both dispatch gates. Transport creation is decoupled from the index: (2) attaches when the index has image OR *any* router policy declares image output (provider-agnostic boolean — over-attaching is harmless plumbing; the per-request grant still decides who may use it), and (3) attaches the plugin image invoke unconditionally in the language-catalog branch (the invoke is lazy; a plugin whose V4 provider lacks `imageModel` fails per-attempt like any candidate failure). OAuth raw image needs no change beyond the shared gate: `rawCapability`'s descriptor lookup already falls back to language descriptors for the image protocol (`capabilities.ts:57-60`) — it was only ever blocked by the index check in the dispatch gate.

**Files:**
- Modify: `packages/server/src/runtime.ts:94` (delete the `configMetadata` field from `RuntimeProviderBase`)
- Modify: `packages/server/src/provider-runtime/materialize.ts` (delete the two `configMetadata:` copies at 69/106; delete the `metadata:` inputs at 53/73/110 and the `metadata` param of `capabilityIndexFromRoutable` at 186–200 — all three feeders were provider config metadata; thread `routerModels` into the `attachImageTransport` options)
- Modify: `packages/server/src/provider-runtime/materialize-image.ts:24-31` (attach condition gains the router-grant boolean)
- Modify: `packages/server/src/provider-runtime/capability-index/capability-index.ts` (delete BOTH the `metadata` and `configMetadata` inputs — lines 17–18, the image check 39–45, and both `Object.keys` in `finiteNonCatalogIds` 63–64; export `metadataHasImageOutput` and new `routerModelsGrantImage`; delete `supportsImageConvert`, whose only caller moves to the shared predicate — run `rg -n 'supportsImageConvert|supportsImageRaw' packages/server/src` and delete `supportsImageRaw` too if nothing but the barrel exports remain)
- Modify: `packages/server/src/plugin-runtime/capabilities.ts` (delete the `metadata: configMetadata` / `configMetadata` inputs at 217–218 and the `configMetadata` fields from the return objects; in the language-catalog return branch at 171–183, include `image` unconditionally: `image: { invoke: createProviderV4ImageInvoke(config.id, result.provider) }` with a comment that router metadata may grant image output to language models and the invoke is lazy. The non-language branches at 184+ keep the `catalog.image.length > 0` condition. No `routerModels` threading in plugin-runtime.)
- Modify: `packages/core/src/router/router.ts:29,249-253` (delete `RoutableProvider.configMetadata` and its `directModelIds` loop)
- Create: `packages/server/src/routes/pipeline/public-slug/` (`index.ts`, `public-slug.ts`, `public-slug.test.ts`) — shared by the capability filter (this task) and billing (Task 9)
- Modify: `packages/server/src/routes/pipeline/attempt/capability-filter/capability-filter.ts` (new signature + exported `candidateSupportsImage`), `packages/server/src/routes/pipeline/index.ts:249` (pass routing from the lease), `packages/server/src/routes/pipeline/attempt/context.ts` (add `routerModels` to `AttemptLoopContext` — needed by dispatch here and billing in Task 9), `attempt/attempt.ts` (populate from `options.config`), `attempt/image.ts:26,39` (both gates use the shared predicate)
- Test: `public-slug.test.ts` (new), `capability-filter.test.ts`, `attempt/image.test.ts` (granted-candidate dispatch), `materialize-image` tests, `capability-index.test.ts`, `materialize.test.ts`, `plugin-runtime/capabilities.test.ts`, core router tests

**Interfaces:**
- Produces in `public-slug/public-slug.ts`:

```ts
// A provider-qualified request ("providerId/slug") acts on the underlying
// public slug for router policy lookups (capability grants, billing). The
// router set selectionSource for exactly these routes, so the strip is exact.
export function publicSlug(
  requestedModelId: string,
  candidate: { readonly provider: { readonly id: string }; readonly selectionSource: RouterSelectionSource },
): string {
  const prefix = `${candidate.provider.id}/`;
  return candidate.selectionSource === 'provider_qualified' && requestedModelId.startsWith(prefix)
    ? requestedModelId.slice(prefix.length)
    : requestedModelId;
}
```

- New `filterCandidatesByCapability` signature plus the shared predicate (both in `capability-filter.ts`):

```ts
export function filterCandidatesByCapability<
  T extends { provider: RuntimeProviderInstance; modelId: string; selectionSource: RouterSelectionSource },
>(
  candidates: readonly T[],
  capability: InboundCapability,
  routing: {
    readonly requestedModelId: string;
    readonly routerModels: Readonly<Record<string, RouterModelPolicy>> | undefined;
  },
): T[]

// Effective image support: the upstream-id index OR the requested slug's
// router-policy grant. The SAME predicate gates the capability filter and
// dispatchImageCandidate — a candidate that passes the filter must never be
// re-rejected downstream by an index-only check.
export function candidateSupportsImage(
  candidate: {
    readonly provider: Pick<RuntimeProviderInstance, 'id' | 'capabilityIndex'>;
    readonly modelId: string;
    readonly selectionSource: RouterSelectionSource;
  },
  requestedModelId: string,
  routerModels: Readonly<Record<string, RouterModelPolicy>> | undefined,
): boolean {
  return (
    supportsImage(candidate.provider.capabilityIndex, candidate.modelId) ||
    metadataHasImageOutput(routerModels?.[publicSlug(requestedModelId, candidate)]?.metadata)
  );
}
```

Only the `image` capability consults router metadata (mirroring the old configMetadata behavior, which only granted image via `metadataHasImageOutput`); language/embedding stay index-only. The filter's image branch is just `candidateSupportsImage(candidate, routing.requestedModelId, routing.routerModels)`.

- `AttemptLoopContext` gains (in `attempt/context.ts`, populated in `attempt/attempt.ts` from `options.config?.router.models`):

```ts
// Router policy from the SAME leased snapshot that selected the candidates.
// Dispatch grants and billing must never re-read the live snapshot: a hot
// reload between selection and dispatch/usage-capture would evaluate
// snapshot-A candidates against snapshot-B policies.
readonly routerModels: Readonly<Record<string, RouterModelPolicy>> | undefined;
```

(`options.config` IS the leased snapshot's config — verified at `pipeline/index.ts:264`. Every test building an `AttemptLoopContext` literal gains `routerModels: undefined`; the compiler lists them.)

- In `capability-index.ts`, next to the exported `metadataHasImageOutput`:

```ts
// Provider-agnostic transport plumbing: does ANY router policy declare image
// output? Deliberately not per-provider/per-slug — an attached-but-unused
// transport is harmless, while a granted candidate without a transport is a
// dead end. Per-request enforcement stays in candidateSupportsImage.
export function routerModelsGrantImage(
  models: Readonly<Record<string, RouterModelPolicy>> | undefined,
): boolean {
  return Object.values(models ?? {}).some((policy) => metadataHasImageOutput(policy.metadata));
}
```

- [ ] **Step 1: Write the failing tests**

`public-slug/public-slug.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { publicSlug } from './public-slug';

test('strips the provider prefix only for provider-qualified selections', () => {
  const qualified = { provider: { id: 'cheap' }, selectionSource: 'provider_qualified' as const };
  expect(publicSlug('cheap/pub', qualified)).toBe('pub');
  const weighted = { provider: { id: 'cheap' }, selectionSource: 'weighted_random' as const };
  expect(publicSlug('cheap/pub', weighted)).toBe('cheap/pub');
});
```

`capability-filter/capability-filter.test.ts` — extend the existing suite (its fixtures build providers with a `capabilityIndex`); every candidate literal gains `selectionSource: 'weighted_random'` unless stated:

```ts
const imageOut = { capabilities: { modalities: { output: ['image' as const] } } };

test('router metadata grants image per requested slug, not per shared upstream id', () => {
  // text-slug and image-slug both resolve to upstream 'wire-shared' on a
  // provider whose index has no image support. Only image-slug's policy
  // declares image output — requesting text-slug must NOT inherit it.
  const candidate = { provider, modelId: 'wire-shared', selectionSource: 'weighted_random' as const };
  const routerModels = {
    'image-slug': { metadata: imageOut, providers: {} },
    'text-slug': { metadata: { name: 'Text' }, providers: {} },
  };
  expect(
    filterCandidatesByCapability([candidate], 'image', { requestedModelId: 'image-slug', routerModels }),
  ).toHaveLength(1);
  expect(
    filterCandidatesByCapability([candidate], 'image', { requestedModelId: 'text-slug', routerModels }),
  ).toHaveLength(0);
});

test('a policy keyed by a hidden upstream id does not leak through its public alias', () => {
  // 'wire' is hidden behind alias 'pretty' (non-preserve). Policy metadata on
  // the hidden slug 'wire' must not grant anything to requests for 'pretty'.
  const candidate = { provider, modelId: 'wire', selectionSource: 'weighted_random' as const };
  const routerModels = { wire: { metadata: imageOut, providers: {} } };
  expect(
    filterCandidatesByCapability([candidate], 'image', { requestedModelId: 'pretty', routerModels }),
  ).toHaveLength(0);
});

test('a provider-qualified request resolves the policy of its underlying slug', () => {
  const candidate = { provider, modelId: 'wire', selectionSource: 'provider_qualified' as const };
  const routerModels = { 'image-slug': { metadata: imageOut, providers: {} } };
  expect(
    filterCandidatesByCapability([candidate], 'image', {
      requestedModelId: `${provider.id}/image-slug`,
      routerModels,
    }),
  ).toHaveLength(1);
});
```

(The filter only reads `candidate.provider.capabilityIndex`, so provider kind is irrelevant — this same code path covers api, ai-sdk, oauth, and injected `providerInstances`; no per-kind capability test is needed.)

`attempt/image.test.ts` — the granted candidate must survive DISPATCH, not just the filter (round-3 P1). Follow the file's existing harness style for building `ctx` and `slot`:

```ts
test('a router metadata image grant dispatches through the convert transport instead of unsupported', async () => {
  // Provider: capabilityIndex has NO image entry for 'wire'; provider.image is
  // a fake transport recording invocations; provider.raw resolves nothing.
  // ctx: requestedModelId 'pub', routerModels { pub: { metadata: imageOut, providers: {} } },
  // adapter.capability 'image', streamRequested false.
  const step = await dispatchImageCandidate(ctx, slot);
  // Must NOT be the unsupportedDispatch rejection; the fake image transport was invoked.
  expect(imageTransport.invocations).toHaveLength(1);
});

test('without the grant the same candidate is rejected as unsupported', async () => {
  // identical setup, routerModels undefined → unsupportedDispatch path
});
```

`materialize-image` tests (colocate per repo layout if the module lacks a test):

```ts
test('a router image-output policy attaches the image transport even when no catalog model is image-capable', () => {
  // openai-compatible api provider, capabilityIndex without image entries,
  // routerModels { pub: { metadata: imageOut, providers: {} } } → instance.image defined
});
```

- [ ] **Step 2: Run to verify failure, then implement the request-time grant**

Run: `bun test packages/server/src/routes/pipeline/attempt packages/server/src/routes/pipeline/public-slug` — FAIL.

Implement `public-slug/public-slug.ts` (code in Interfaces above; `index.ts` re-exports it). In `capability-filter.ts`, apply the new signature and export `candidateSupportsImage`; export `metadataHasImageOutput` from `capability-index` (it already implements the modalities check) and import it here. Add `routerModels` to `AttemptLoopContext` (`attempt/context.ts`, comment in Interfaces) and populate it in `attempt/attempt.ts` with `routerModels: options.config?.router.models`. In `routes/pipeline/index.ts:249`:

```ts
const eligible = filterCandidatesByCapability(candidates, adapter.capability, {
  requestedModelId: requestedModel,
  routerModels: lease.snapshot.config?.router.models,
});
```

In `attempt/image.ts`, replace BOTH index gates with the shared predicate (import from `../capability-filter`):

```ts
const granted = candidateSupportsImage(slot.candidate, ctx.requestedModelId, ctx.routerModels);
const raw = granted
  ? provider.raw?.resolve({ ... })   // unchanged resolve args
  : undefined;
// ...
if (granted && provider.image !== undefined) {   // replaces supportsImageConvert(provider, ...)
```

- [ ] **Step 3: Decouple image transport creation from the index**

- `materialize-image.ts`: the attach condition becomes `capabilityIndexHasImage(instance.capabilityIndex) || routerModelsGrantImage(options.routerModels)` (implement `routerModelsGrantImage` in `capability-index.ts` per Interfaces). Thread `routerModels` into the options: `rg -n 'attachImageTransport' packages/server/src` and extend each call site with the snapshot build's `config?.router.models` (materialization is per-snapshot, so this stays consistent with the leased config the filter reads).
- `plugin-runtime/capabilities.ts`: in the language-catalog branch (171–183) attach `image: { invoke: createProviderV4ImageInvoke(config.id, result.provider) }` unconditionally, commenting that router metadata may grant image output to language models and the invoke is lazy (a V4 provider without `imageModel` fails per-attempt). Non-language branches unchanged.

- [ ] **Step 4: Delete the config-metadata capability inputs**

- `materialize.ts`: delete both `configMetadata:` copies (69, 106), the three `metadata:` arguments (53, 73, 110), and the `metadata` param of `capabilityIndexFromRoutable` (186–200).
- `capability-index.ts`: delete the `metadata` AND `configMetadata` inputs (17–18), their image-output checks (40–41), and both `Object.keys(...)` spreads in `finiteNonCatalogIds` (63–64). Keep `upstreamMetadata`. Export `metadataHasImageOutput` and `routerModelsGrantImage`. Delete `supportsImageConvert` (its only caller now uses `candidateSupportsImage`); check `supportsImageRaw` with `rg` and delete it too if only barrel exports remain — update `capability-index/index.ts` and `provider-runtime/index.ts` exports either way.
- `plugin-runtime/capabilities.ts`: delete lines 217–218 (`metadata: configMetadata` / `configMetadata`) from the `buildModelCapabilityIndex` call and the `configMetadata` fields from the return objects of `routingCapabilities` / `withRoutingConfig` / `createRuntimeProvider`. Keep the existing `allowed` filtering for `upstreamMetadata`. No `routerModels` parameter anywhere in plugin-runtime — the request-time predicate covers oauth (raw image resolution already falls back to language descriptors at `capabilities.ts:57-60`).
- `core/src/router/router.ts`: delete `configMetadata` from `RoutableProvider` and the `Object.keys(provider.configMetadata ?? {})` loop in `directModelIds`. Keep the `upstreamMetadata` loop. Behavior change to document: config metadata keys no longer create public model routes — models must be listed in `providers.<id>.models` or aliased.
- `runtime.ts`: delete the `configMetadata` field.

- [ ] **Step 5: Fix compile fallout in tests, run, commit**

Run: `bun run check && bun test packages/server/src/routes/pipeline packages/server/src/provider-runtime packages/server/src/plugin-runtime packages/core/src/router`
Expected: PASS (delete/adjust test cases that asserted configMetadata-derived routes, configMetadata-derived index capabilities, or `supportsImageConvert` directly; `AttemptLoopContext` literals gain `routerModels: undefined`)

```bash
git add packages/server packages/core
git commit -m "feat(server)!: drop provider-level configMetadata from runtime providers"
```

### Task 8: `model-resolution` reads the router policy

**Files:**
- Modify: `packages/server/src/server/model-resolution/model-resolution.ts:67-108`
- Test: `packages/server/src/server/model-resolution/model-resolution.test.ts`

**Interfaces:**
- Produces: `ResolvedModelCandidate` unchanged in shape (`configMetadata` now router-sourced). `resolveModelField`, `resolveModelCapabilities`, `resolveAggregatedLimit` unchanged. Later tasks (codex, list-models) rely on this stability.

- [ ] **Step 1: Write failing tests**

`model-resolution.test.ts` already has the needed fixtures: `fakeState(providers, aggregation?)` (builds a snapshot whose `Router` already receives `{ models: config?.router.models }` at line 102) and `slugProvider(id, slug, modelId, limit?, routing?)`. Extend `fakeState` with a third parameter `models?: Record<string, RouterModelPolicy>` that lands in `config.router.models` (config must be defined whenever either `aggregation` or `models` is set). `slugProvider`'s `configMetadata` branch is deleted in this task's port (the field no longer exists after Task 7) — existing cases that used it move their limits into router policies. Note: fixtures are raw objects, not `ConfigSchema.parse` output, so spell out `providers: {}` on each policy.

```ts
test('router slug metadata supplies the config layer for every candidate', async () => {
  await seedCatalog({});
  const resolved = await resolveEnabledModels(
    fakeState([slugProvider('a', 'pub', 'up-a'), slugProvider('b', 'pub', 'up-b')], undefined, {
      pub: { metadata: { name: 'Pub', limit: { context: 100 } }, providers: {} },
    }),
  );
  const model = resolved.find((entry) => entry.slug === 'pub')!;
  expect(model.candidates.map((candidate) => candidate.configMetadata?.name)).toEqual(['Pub', 'Pub']);
  expect(resolveModelField(model, (metadata) => metadata.name)).toBe('Pub');
});

test('per-provider limit override replaces the slug limit for that candidate only', async () => {
  await seedCatalog({});
  const providers = [slugProvider('capped', 'pub', 'up-a'), slugProvider('full', 'pub', 'up-b')];
  const models = {
    pub: { metadata: { limit: { context: 200 } }, providers: { capped: { limit: { context: 100 } } } },
  };
  const min = await resolveEnabledModels(fakeState(providers, ModelContextAggregation.Min, models));
  expect(resolveAggregatedLimit(min.find((entry) => entry.slug === 'pub')!, 'context')).toBe(100);
  const max = await resolveEnabledModels(fakeState(providers, ModelContextAggregation.Max, models));
  expect(resolveAggregatedLimit(max.find((entry) => entry.slug === 'pub')!, 'context')).toBe(200);
});

test('per-provider cost override does not leak name or capabilities', async () => {
  await seedCatalog({});
  const resolved = await resolveEnabledModels(
    fakeState([slugProvider('cheap', 'pub', 'up-a')], undefined, {
      pub: { metadata: { name: 'Pub' }, providers: { cheap: { cost: { input: 1 } } } },
    }),
  );
  const model = resolved.find((entry) => entry.slug === 'pub')!;
  expect(model.candidates[0]?.configMetadata).toEqual({ name: 'Pub', cost: { input: 1 } });
  expect(resolveModelField(model, (metadata) => metadata.name)).toBe('Pub');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/server/src/server/model-resolution`
Expected: FAIL

- [ ] **Step 3: Implement**

In `resolveEnabledModels`, populate candidates from the router policy:

```ts
const routerModels = lease.snapshot.config?.router.models;
for (const slug of lease.snapshot.router.modelIds()) {
  const routed = lease.snapshot.router.catalogCandidates(slug);
  if (routed.length === 0) continue;
  const policy = routerModels?.[slug];
  resolved.push({
    slug,
    candidates: routed.map(({ provider, modelId }) => ({
      provider,
      modelId,
      configMetadata: candidateConfigMetadata(policy, provider.id),
      upstreamMetadata: provider.upstreamMetadata?.[modelId],
    })),
  });
}
```

with the private helper (same file):

```ts
// Slug-level metadata with this provider's cost/limit override applied.
// Overrides replace the whole cost/limit object; other fields are never
// overridable per provider by design.
function candidateConfigMetadata(
  policy: RouterModelPolicy | undefined,
  providerId: string,
): ModelMetadata | undefined {
  if (policy === undefined) return undefined;
  const override = policy.providers[providerId];
  const base = policy.metadata;
  if (override?.cost === undefined && override?.limit === undefined) return base;
  return {
    ...base,
    ...(override.cost === undefined ? {} : { cost: override.cost }),
    ...(override.limit === undefined ? {} : { limit: override.limit }),
  };
}
```

- [ ] **Step 4: Run downstream list-model tests, fix fixtures, commit**

Run: `bun test packages/server/src/server`
Expected: PASS after updating fixtures in `list-models.test.ts`, `agent-catalog.test.ts`, `codex-client-models.test.ts`, `codex-assembly.test.ts` that previously set `provider.configMetadata` — they now set `config.router.models[slug].metadata` (and keep asserting the same client-facing outputs; the assertions themselves should not change, which is the point of keeping `ResolvedModelCandidate` stable).

```bash
git add packages/server/src/server
git commit -m "feat(server): resolve model metadata from router.models with per-provider cost/limit overrides"
```

### Task 9: Billing lookup uses the leased router policy

Two review-critical invariants live here: (1) the price comes from the SAME leased snapshot that selected the candidates — `pipeline/index.ts:264` already passes `config: lease.snapshot.config` into `attemptCandidates`, so the loop context threads it; `source.currentProviderSnapshot()` must never be consulted for pricing. (2) A provider-qualified request (`providerId/slug`) bills the underlying public slug, keeping both the slug cost and that provider's override.

**Files:**
- Move + modify: `packages/server/src/routes/pipeline/attempt-base.ts` → `attempt-base/` directory (`index.ts` export-only, `attempt-base/attempt-base.ts`, new `attempt-base/attempt-base.test.ts`) per the colocated-test layout rule; update importers
- Modify call sites: `packages/server/src/routes/pipeline/attempt/model.ts:43`, `attempt/raw.ts:91`, `attempt/image.ts:88`, `attempt/embedding.ts:96` — each uses `publicSlug` from Task 7's `routes/pipeline/public-slug/`
- Test: `attempt-base/attempt-base.test.ts` (pure lookup), `attempt/embedding.test.ts` (snapshot-swap regression)

**Interfaces:**
- Consumes: `ctx.routerModels` (added to `AttemptLoopContext` in Task 7 — the leased-snapshot policy record shared by dispatch grants and billing) and Task 7's `publicSlug`.
- Produces:

```ts
export function candidateConfigPrice(
  models: Readonly<Record<string, RouterModelPolicy>> | undefined,
  slug: string,
  providerId: string,
): OpenRouterModelPrice | undefined;
```

- [ ] **Step 1: Write the failing unit tests in `attempt-base/attempt-base.test.ts`**

(`configModelPrice` — `packages/core/src/usage-pricing/usage-pricing.ts:51` — emits `{ id, input?, output?, … }` with only the fields the cost sets, so the expected objects below are exact.)

```ts
test('per-provider cost override outranks slug cost for billing', () => {
  const models = {
    pub: {
      metadata: { cost: { input: 10 } },
      providers: { cheap: { cost: { input: 1 } }, other: {} },
    },
  };
  expect(candidateConfigPrice(models, 'pub', 'cheap')).toEqual({ id: 'pub', input: 1 });
  expect(candidateConfigPrice(models, 'pub', 'other')).toEqual({ id: 'pub', input: 10 });
  expect(candidateConfigPrice(models, 'missing', 'cheap')).toBeUndefined();
});
```

(Qualified-id stripping is already pinned by `public-slug.test.ts` from Task 7; the call-site composition `candidateConfigPrice(ctx.routerModels, publicSlug(...), provider.id)` is covered by the embedding-level test in Step 4.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/server/src/routes/pipeline/attempt-base`
Expected: FAIL

- [ ] **Step 3: Implement**

In `attempt-base/attempt-base.ts`:

```ts
// The slug's config cost for this provider attempt, mapped into the pricing
// engine's shape. Provider override wins over the slug default; undefined
// falls back to the models.dev catalog in priceUsage.
export function candidateConfigPrice(
  models: Readonly<Record<string, RouterModelPolicy>> | undefined,
  slug: string,
  providerId: string,
): OpenRouterModelPrice | undefined {
  const policy = models?.[slug];
  if (policy === undefined) return undefined;
  const cost = policy.providers[providerId]?.cost ?? policy.metadata?.cost;
  return cost === undefined ? undefined : configModelPrice(slug, cost);
}
```

Update the four call sites to (import `publicSlug` from `../public-slug`; `ctx.routerModels` exists since Task 7):

```ts
const configPrice = candidateConfigPrice(ctx.routerModels, publicSlug(ctx.requestedModelId, candidate), provider.id);
```

(`candidate` and `ctx` are already in scope at all four sites; `slot.candidate` where the slot is what's in scope.)

- [ ] **Step 4: Snapshot-swap regression test**

In `attempt/embedding.test.ts`, the harness builds the ctx literal directly and `__tests__/pipeline-helpers/providers.ts` already exports `withSnapshotConfigs(source, acquired, current)` — built for exactly this split. Add:

- `configA = ConfigSchema.parse({ providers: {}, router: { models: { [MODEL_ID]: { metadata: { cost: { input: 1 } } } } } })` and `configB` identical but `input: 99`.
- Build the harness, then set `ctx.routerModels = configA.router.models` (extend `harness()` with an optional `routerModels` parameter) and wrap the source with `withSnapshotConfigs(route.source, configA, configB)` so the live snapshot disagrees with the lease.
- Run `attemptEmbeddingCandidate` against a succeeding provider fixture and assert `usage.embedding[0]?.configPrice` equals `{ id: MODEL_ID, input: 1 }` (the fake `usageCapture.embedding` in `defineProviderRouteSource` records its options in `usage.embedding`).

This pins billing to the leased config: if a future edit re-reads the live snapshot, the test sees `99`.

- [ ] **Step 5: Run and commit**

Run: `bun test packages/server/src/routes/pipeline && bun run check`
Expected: PASS

```bash
git add packages/server/src/routes
git commit -m "feat(server): bill from the leased router.models cost with per-provider overrides"
```

### Task 10: Server-wide sweep and green build

**Files:**
- Modify: any remaining `configMetadata` / `provider.metadata` references — known stragglers: `packages/server/src/server/list-models/codex-client-models/codex-client-models.ts` (compiles unchanged — it reads candidate.configMetadata), `packages/server/src/dashboard-routes/provider-routes.ts` (edit-view no longer needs to preserve unresolved `metadata.extend` for providers — remove that handling), `packages/server/src/dashboard-routes/provider-mutation/*` (mutation bodies no longer carry `metadata`), token-count/provider fixtures.

- [ ] **Step 1: Sweep**

Run: `rg -n 'configMetadata|\.metadata\b' packages/server packages/core --type ts` and resolve every hit against the new design (most remaining hits are legitimate: plugin-sdk `PluginDescriptor.metadata`, egress wire metadata, request-tracing).

- [ ] **Step 2: Full workspace check + tests**

Run: `bun run check && bun test packages/server packages/core packages/types`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A packages
git commit -m "chore(server): finish provider metadata removal sweep"
```

---

## Phase 4 — Dashboard

Follow `packages/dashboard/AGENTS.md` throughout (module layout, services via `createDashboardClient`, TanStack Form + Zod, i18n keys in all five locales, `bun run i18n:compile` after copy changes).

### Task 11: Routing DTO + server route carry authored metadata

**Files:**
- Modify: `packages/types/src/dashboard/routing/routing.ts`
- Modify: `packages/server/src/model-routing/mutation.ts` (write path + new `rawModelPolicySlugs`), `packages/server/src/model-routing/inventory.ts` (`assembleRoutingInventory`, `finalizeModel`, `overrideView`)
- Test: `packages/types/src/dashboard/routing/routing.test.ts`, `packages/server/src/model-routing/inventory.test.ts`, mutation tests

**Interfaces:**
- Produces (types):

```ts
export type DashboardRoutingModel = {
  // …existing fields…
  readonly metadata?: ModelMetadataInput;              // authored slug metadata (pre-extend, raw from config file)
};
export type DashboardRoutingProvider = {
  // …existing fields…
  readonly override?: {
    readonly priority?: DashboardRoutingNumber;
    readonly weight?: DashboardRoutingNumber;
    readonly cost?: ModelCostInput;                    // authored per-provider cost override
    readonly limit?: ModelLimitInput;                  // authored per-provider limit override
  };
};
export type DashboardRoutingModelMutation = {
  // …existing fields…
  readonly metadata?: ModelMetadataInput | null;       // null clears the slug metadata
  readonly providers: Readonly<Record<string, RouterProviderOverride>>; // now includes cost/limit
};
```

Zod: extend `DashboardRoutingProviderOverrideViewSchema`, `DashboardRoutingModelSchema`, `DashboardRoutingModelMutationSchema` accordingly (`metadata: ModelMetadataSchema.nullable().optional()` on the mutation; the mutation's `DashboardRoutingProviderOverrideSchema` gains `cost: ModelCostSchema.nullable().optional(), limit: ModelLimitSchema.nullable().optional()` and its non-empty refine extends to `priority/weight/cost/limit`).

**Mutation contract (round-3 P1 — the board flows must not delete drawer data):** the routing board submits full routing state but knows nothing about cost/limit, so the two field groups get different write semantics per provider entry:

- `priority`/`weight`: the submission owns them — absent means *clear the authored value* (unchanged semantics; `omitDefault` relies on this).
- `cost`/`limit`: absent (`undefined`) means *preserve the existing authored value*; `null` means *clear*; an object means *replace*.
- Unknown keys already present on the raw provider entry are always preserved.

This makes every existing client flow (drag, share slider) safe without threading cost/limit through `use-routing-form`/`routing-board` drafts — those drafts stay priority/weight-only by design, and only the drawer's dedicated editors ever submit cost/limit.

- [ ] **Step 1: Failing type/schema tests** — extend `routing.test.ts` with a mutation containing `metadata` and a provider override containing `cost`; expect parse success. Run `bun test packages/types/src/dashboard` → FAIL → implement → PASS.

- [ ] **Step 2: Server mutation writes metadata**

In `mutation.ts`, each submitted provider entry is merged against the existing raw entry per the contract above (pseudocode; keep the existing revision check and provider preservation around it):

```ts
// The board owns priority/weight (absent = clear); the drawer owns cost/limit
// (absent = preserve, null = clear). Unknown raw keys always survive — a
// priority-only submission must never delete a cost override or a future field.
function mergeProviderOverride(existingRaw: unknown, submitted: RouterProviderOverride): Record<string, unknown> {
  const base = isPlainObject(existingRaw) ? { ...existingRaw } : {};
  delete base['priority'];
  delete base['weight'];
  if (submitted.priority !== undefined) base['priority'] = submitted.priority;
  if (submitted.weight !== undefined) base['weight'] = submitted.weight;
  for (const key of ['cost', 'limit'] as const) {
    const value = submitted[key];
    if (value === null) delete base[key];
    else if (value !== undefined) base[key] = value;
  }
  return base;
}
```

`applyRoutingMutation` builds the next providers record from `mergeProviderOverride(rawEntry, submittedEntry)` per provider; an entry is dropped when the merge result is empty (this replaces `isEmptyOverride` — emptiness is judged AFTER the merge, so an entry holding only a preserved cost survives a priority-clearing submission).

`writeRawModelPolicy(current, modelId, providers, metadata?)`: when `metadata` is an object, write it as the policy's `metadata` key; when `null`, delete the key; when `undefined`, preserve whatever `futurePolicyFields` already carries (current behavior). Update the "policy is empty" deletion condition to account for metadata.

Inventory/read side (`inventory.ts`):

1. Add `rawModelPolicySlugs(rawRecord): readonly string[]` next to `readRawModelPolicy` in `mutation.ts` (the keys of the raw record's `router.models` object, guarded with the same `isPlainObject` pattern).
2. In `assembleRoutingInventory`, after the provider loop (line 59), union in metadata-only slugs so they stay visible and editable:

```ts
for (const slug of rawModelPolicySlugs(input.rawRecord)) {
  if (!models.has(slug)) models.set(slug, emptyModel(slug, input.rawRecord));
}
```

3. In `finalizeModel` (via a new field on `WritableModel`, populated in `emptyModel` from `readRawModelPolicy(rawRecord, modelId)`), surface the authored slug metadata: include `metadata` on the returned `DashboardRoutingModel` when the raw policy's `metadata` value passes `ModelMetadataSchema.safeParse` (authored value, not the parse output — the dashboard edits what the user wrote).
4. In `overrideView` (line 162), parse `cost`/`limit` alongside priority/weight: `ModelCostSchema.safeParse` / `ModelLimitSchema.safeParse` on the raw override keys, included as authored values when valid; the `if (priority === undefined && weight === undefined)` guard extends to all four fields.
5. `hasOverrides` (round-3 P2): slug metadata IS an override — a metadata-only model must not show "No" in the routing table's Overrides column. Extend `finalizeModel`'s computation to `providers.some(...) || metadata !== undefined` (`metadata` being the value surfaced in point 3). No rename: the column's meaning ("this row carries authored configuration") is unchanged, it just gained a source.

- [ ] **Step 3: Behavior tests (metadata-only slugs + override round-trip)**

In `mutation` tests:

```ts
test('routing mutation writes and clears slug metadata', () => {
  const written = applyRoutingMutation({}, { modelId: 'pub', revision: digestProviderEntry(null), baselineProviderIds: [], providers: {}, metadata: { name: 'Pub' } });
  expect(readRawModelPolicy(written, 'pub')).toEqual({ metadata: { name: 'Pub' } });
  const cleared = applyRoutingMutation(written, { modelId: 'pub', revision: digestProviderEntry(readRawModelPolicy(written, 'pub') ?? null), baselineProviderIds: [], providers: {}, metadata: null });
  expect(readRawModelPolicy(cleared, 'pub')).toBeUndefined();
});

test('a routing-only submission preserves cost, limit, and unknown keys on the provider entry', () => {
  // Raw state as if the drawer and a future version wrote it:
  const seeded = {
    router: { models: { pub: { providers: { p1: { priority: 5, cost: { input: 1 }, limit: { context: 8000 }, futureKey: 'keep' } } } } },
  };
  // The board submits routing fields only (a drag changed priority):
  const written = applyRoutingMutation(seeded, { modelId: 'pub', revision: /* digest of seeded policy */, baselineProviderIds: ['p1'], providers: { p1: { priority: 7 } } });
  expect(readRawModelPolicy(written, 'pub')?.providers?.p1).toEqual({ priority: 7, cost: { input: 1 }, limit: { context: 8000 }, futureKey: 'keep' });
});

test('null clears a cost override; clearing routing fields keeps a preserved cost entry alive', () => {
  // providers: { p1: { cost: null } } removes cost but keeps priority handling intact;
  // providers: { p1: {} } (routing cleared) still leaves { cost: ... } when one was authored.
});
```

In `inventory.test.ts` (reuse its existing `assembleRoutingInventory` fixtures for config/summaries/repository):

```ts
test('a metadata-only slug appears with its metadata and no providers', async () => {
  const rawRecord = {
    providers: {},
    router: { models: { 'meta-only': { metadata: { name: 'Meta', cost: { input: 2 } } } } },
  };
  const response = await assembleRoutingInventory({ rawRecord, config, summaries: [], repository, writable: true });
  const model = response.models.find((entry) => entry.modelId === 'meta-only');
  expect(model?.providerCount).toBe(0);
  expect(model?.metadata).toEqual({ name: 'Meta', cost: { input: 2 } });
  expect(model?.hasOverrides).toBe(true); // metadata counts as an override (round-3 P2)
});

test('per-provider cost and limit overrides round-trip through the GET view', async () => {
  // one provider p1 routing slug 'pub' (existing fixture style), plus:
  // rawRecord.router.models.pub.providers.p1 = { cost: { input: 1 }, limit: { context: 8000 } }
  const model = response.models.find((entry) => entry.modelId === 'pub');
  const row = model?.providers.find((entry) => entry.id === 'p1');
  expect(row?.override?.cost).toEqual({ input: 1 });
  expect(row?.override?.limit).toEqual({ context: 8000 });
});
```

Run `bun test packages/server/src/model-routing` → PASS. Commit:

```bash
git add packages/types packages/server
git commit -m "feat(dashboard-api): routing models carry authored metadata and cost/limit overrides"
```

### Task 12: Move the metadata editor from the provider editor to `/routing/` (one atomic task)

One task on purpose: the editor components are *moved*, not deleted-then-recreated, so the provider-editor removal and the routing-page wiring must land together (`git mv` preserves history; a delete in one task and an mv in the next would conflict).

**Files — move first (git mv, update imports):**
- `packages/dashboard/src/modules/providers/components/provider-editor/model-metadata-visual-tab/` → `packages/dashboard/src/modules/routing/components/model-metadata-visual-tab/`
- `packages/dashboard/src/modules/providers/components/provider-editor/provider-model-metadata-drawer/provider-model-metadata-drawer-content.tsx` → `packages/dashboard/src/modules/routing/components/model-metadata-editor/model-metadata-editor.tsx` (rename component `ModelMetadataEditor`, props `{ value: ModelMetadataInput | undefined; onChange: (next: ModelMetadataInput | undefined) => void }`, keep the Visual/JSON tabs); delete the rest of `provider-model-metadata-drawer/`
- Move `models-dev-service` usage (the `extend` slug combobox queries) into the routing module if it was provider-owned

**Files — provider editor removal:**
- Modify: `packages/dashboard/src/modules/providers/components/provider-editor/models-section/models-section.tsx` (drop `metadataModel` state, drawer render, `form.Field name="metadata"`), `model-row-item.tsx` (drop the Metadata button / `onEditMetadata`)
- Modify: `packages/dashboard/src/modules/providers/lib/model-rows/model-rows.ts` (`toModelRows`/`applyModelRows` drop metadata coupling)
- Modify: `packages/dashboard/src/modules/providers/templates/provider-editor-page/use-provider-editor-page.ts` (`saveConfigProvider` stops sending `metadata`; drop it from the form shape and OAuth copy helpers)
- Modify tests: `models-section.test.tsx`, `provider-editor-page.test.tsx` (delete metadata-related assertions)

**Files — routing page wiring (round-3 P1 corrected scope):**

The routing UI has NO priority/weight number inputs — it is a drag board (`routing-board.tsx`, tiers + share slider) whose transformations (`omitDefault`, `applyRoutingBoardMove`, `applyRoutingShare`) rebuild `{providerId, priority?, weight?}` rows from scratch, and `use-routing-form.ts` / `RoutingProviderDraft` / `routingDraftRecord` carry exactly those three fields. **These drafts intentionally stay priority/weight-only** — Task 11's mutation contract (cost/limit absent = preserved server-side) is what makes drag/share/reset/reload flows safe without threading new fields through `routing-summary`, `routing-board`, or `reconcileRoutingFormRows`. Do NOT extend the board drafts. What changes on the client:

- Modify: `packages/dashboard/src/modules/routing/components/routing-editor-drawer.tsx` — add a "Metadata" section rendering `ModelMetadataEditor` bound to the model's authored `metadata` (from `DashboardRoutingModel.metadata`), and a per-provider cost/limit editor: for each provider row shown in the drawer, editors seeded from `provider.override?.cost` / `override?.limit` (reuse `ModelMetadataNumberField` from the moved visual tab; a new small component per the one-component-per-file rule, e.g. `routing-provider-override-fields.tsx`). Drawer-local TanStack Form state, separate from the board rows.
- Modify: `packages/dashboard/src/modules/routing/hooks/use-routing-mutation.ts` and `services/routing-service.ts` — the PUT body merges the board rows (`routingDraftRecord`, routing fields only) with the drawer's metadata + per-provider cost/limit state: untouched cost/limit fields are OMITTED from the body (server preserves), an explicitly cleared field sends `null`, an edited field sends the object. `metadata` follows the same tri-state.

- [ ] **Step 1:** `git mv` the components, rename `ModelMetadataEditor`, then remove the provider-editor wiring and add the routing-page wiring in the same working tree.
- [ ] **Step 2:** Drawer tests (extend `routing-editor-drawer.test.tsx`):
  - editing metadata name + a provider cost override produces a PUT body containing `metadata.name` and `providers.<id>.cost`; clearing all metadata fields sends `metadata: null`; clearing a cost override sends `providers.<id>.cost: null`.
  - **data-preservation regression:** with a model whose provider carries authored `cost`/`limit` overrides, a board-only change (simulate a priority change through the board flow, cost/limit editors untouched) produces a PUT body whose provider entries contain NO `cost`/`limit` keys — pairing with Task 11's server test, this pins the end-to-end "drag does not delete drawer data" guarantee.
- [ ] **Step 3:** Run `bun run check && bun test packages/dashboard` — expect PASS (existing `routing-board.test.ts` / `routing-summary.test.ts` / `routing-page.test.tsx` stay green untouched — the board layer is deliberately out of scope).
- [ ] **Step 4:** Commit: `git commit -m "feat(dashboard)!: move model metadata editing from the provider editor to the routing page"`

### Task 14: i18n

**Files:**
- Modify: `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json`

- [ ] **Step 1:** Move the metadata editor keys from `dashboard.providers.form.*` / `dashboard.providers.editor.*` (`metadata`, `edit_metadata`, `metadata_title`, `metadata_description`, `metadata_json_label`, `metadata_json_error`, `metadata_schema_error`, `save_metadata`, `metadata_tab_visual/json`, `metadata_group_*`, `metadata_extend_*`, `metadata_capability_*`, `metadata_limit_label_*`, `metadata_cost_label_*`, `metadata_field_label_*`, `metadata_name_placeholder`, `metadata_inherit_placeholder`) to `dashboard.routing.*`, adding new keys for the per-provider cost/limit override labels. Delete keys that no longer have a consumer.
- [ ] **Step 2:** Run `bun run i18n:compile` and `bun run check`; fix any missing-key errors.
- [ ] **Step 3:** Commit: `git commit -m "feat(dashboard): move model metadata copy to routing"`

---

## Phase 5 — Docs, changesets, preflight

### Task 15: User-facing docs, changesets, stale-note check

- [ ] **Step 0: Rewrite the shipped documentation (the README currently teaches the deleted config)**
  - `README.md:136-213` "Model metadata and pricing": rewrite for `router.models.<slug>.metadata` + per-provider `cost`/`limit` overrides, keyed by exposed slug (not upstream id); keep the per-field precedence explanation, updating the config layer's name. Update the embedded JSON examples (`"metadata"` blocks at lines ~153 and ~202) to the router shape.
  - `README.md:~300` (Images providers): "metadata keys" no longer create a finite id set or routes — reword to `models`, preserved alias targets only.
  - Sweep for stragglers: `rg -n 'providers\.[^ ]*\.metadata|provider.s. metadata' README.md docs/ examples/ 2>/dev/null` and fix every user-facing instruction that would now be silently ignored by the schema.
- [ ] **Step 1:** `rg -i 'metadata' .changeset/` — correct/delete any stale unreleased note describing provider-level metadata (currently none pending; verify).
- [ ] **Step 2:** `bun changeset` — one changeset, **minor**, targeting `aio-proxy`, `@aio-proxy/plugin-sdk`, `@aio-proxy/core`, `@aio-proxy/server`, `@aio-proxy/types` (and the plugin packages). Body covers, from the user's perspective:
  - model metadata now configured once per exposed model at `router.models.<slug>.metadata` (with `extend` support), per-provider `cost`/`limit` overrides at `router.models.<slug>.providers.<id>`;
  - `providers.<id>.metadata` removed (silently ignored if present);
  - config metadata keys no longer create model routes — list models in `providers.<id>.models` or `alias`;
  - plugin SDK: `ModelDescriptor.metadata`/`ModelCatalog.metadata`/raw-resolve `metadata` renamed to `extra`; new `ModelDescriptor.modelMetadata` typed field; `@aio-proxy/types` is now published to npm as the SDK's metadata type source;
  - dashboard: metadata editing moved from the provider editor to the routing page.
- [ ] **Step 3:** Update the routing spec docs if present: add a superseding note to `docs/superpowers/specs/2026-08-08-model-metadata-source-precedence-design.md` ("user-config layer relocated to router.models — see this plan") rather than rewriting history.

### Task 16: Preflight

- [ ] **Step 1:** Run `bun run preflight` (oxlint + oxfmt + all unit tests). Fix anything it flags.
- [ ] **Step 2:** Final commit.

---

## Self-review notes (already applied)

- `ResolvedModelCandidate.configMetadata` deliberately keeps its name; `codex-client-models.ts` (`resolveCodexWindows`, `projectCodexMetadata`, display-name/description chains) compiles and behaves unchanged.
- `writeRawModelPolicy` already preserves unknown future policy fields, so the Task 11 change is additive on that path.
- `config-schema-ref.test.ts` path update is covered in Task 5 Step 4.

## Review findings incorporated

Round 1 (P1×4, P2×3):

- **Billing snapshot**: pricing reads `router.models` from the leased snapshot via `AttemptLoopContext.routerModels` (`options.config` at `pipeline/index.ts:264`), never `currentProviderSnapshot()`; snapshot-swap regression test in Task 9 Step 4 (using `withSnapshotConfigs`).
- **Persisted catalogs**: static catalogs never refresh and TTL catalogs serve stale rows, so `readCatalog` performs an idempotent, key-rename-only `metadata`→`extra` migration with a stale-catalog regression test (Task 4b).
- **Provider-qualified pricing**: `publicSlug` strips the provider prefix exactly when `selectionSource === 'provider_qualified'`, so `p/alias` keeps `router.models[alias]` cost plus `providers[p]` override (Tasks 7/9).
- **Shipped docs**: README metadata/pricing section, its JSON examples, the Images finite-id note, and the stale `ModelMetadataSchema` doc comment are all in scope (Tasks 5, 15).

Round 2 (P1×2, P2×3 + hygiene):

- **Slug isolation** (supersedes round 1's upstream-id union): projecting per-slug metadata into the upstream-id-keyed `capabilityIndex` cannot preserve slug isolation — shared upstream targets would leak capabilities across slugs, and hidden direct routes would leak hidden-slug metadata. Router-metadata capability grants therefore moved to the pipeline capability filter, resolved per request against the requested public slug from the leased config (Task 7). This also covers oauth and the `providerInstances`/`buildSnapshotWithProviders` path with zero materialization threading (round 2 P2 resolved by design).
- **Descriptor validation schema**: plugin `modelMetadata` is validated with a strict-by-default `z.object` picking the five descriptor fields (never the loose `ModelMetadataSchema` — unknown keys like `protocol` would leak into `RuntimeModelMetadata`), plus an `isJsonValue` guard against non-serializable values admitted by nested loose schemas; SDK type is `Pick<ModelMetadataInput, …>` excluding `extend` (Tasks 1–2).
- **Migration is rename-only**: `migrateStoredCatalogShape` no longer defaults missing modalities to `[]`; structural damage flows through to `validateModelCatalog` (Task 4b), with tests for both-keys precedence and untouched damage.
- **Metadata-only slugs**: `assembleRoutingInventory` unions `rawModelPolicySlugs` into the model map with behavior tests for metadata-only GET visibility and cost/limit override round-trip (Task 11).
- **Hygiene**: `catalog-migration/` uses the same-name-directory layout; the provider-editor→routing UI move is one atomic task (Task 12, `git mv` first); remaining placeholder phrasing replaced with concrete paths, fixtures, and rg sweeps.

Round 3 (P1×3, P2×3):

- **Image grant end-to-end**: the request-time grant now survives dispatch, not just the filter — shared `candidateSupportsImage` predicate gates both, `attachImageTransport` attaches on `routerModelsGrantImage` (provider-agnostic plumbing boolean), plugin-runtime attaches the lazy image invoke unconditionally in the language branch, and OAuth raw needs no change (descriptor fallback at `capabilities.ts:57-60`). Dispatch-level grant test + materialize-image test added; `AttemptLoopContext.routerModels` moved from Task 9 to Task 7 (Task 7).
- **npm first-publish**: `scripts/release.ts` gains a topological publish order (dependencies before dependents — glob order could publish plugin-sdk before types and strand an uninstallable SDK), plus an operator checklist for the `NPM_TOKEN` bootstrap/trusted-publisher setup and a packed-consumer tarball install verification (Task 1).
- **Dashboard data loss**: the mutation contract became preserve-by-default — submitted provider entries own priority/weight, while cost/limit are tri-state (absent=preserve, null=clear, object=replace) and unknown raw keys always survive, merged server-side in `mergeProviderOverride`. Board/share/reset flows stay priority/weight-only BY DESIGN; only the drawer's dedicated editors submit cost/limit. Server preservation test + drawer no-cost/limit-keys regression test added (Tasks 11–12).
- **Cross-modality metadata merge**: `modelMetadataRecord` merges typed fields across modalities (earlier non-language modality wins its conflicts, language wins overall, protocol from language only) with a shared language+image test (Task 3).
- **Metadata-only overrides column**: `hasOverrides` counts slug metadata; inventory test asserts it (Task 11).
- **Migration guards**: `migrateStoredCatalogShape`/`migrateDescriptor` check `isPlainObject` before any `in` probe; null/primitive descriptors and non-object catalogs pass through for `validateModelCatalog` to reject (Task 4b).
