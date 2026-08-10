# Plan: implement `metadata.extend` (two-layer models.dev catalog inheritance)

## Problem

`ModelMetadataSchema.extend` (packages/types/src/model-metadata/model-metadata.ts:121) is
declared, accepted, described ("models.dev slug to inherit metadata from when names
differ"), and in `MODEL_METADATA_KNOWN_KEYS` — but **no code consumes it**. It is a
half-wired field: config authors can set it and it silently does nothing. Same class of
defect as the fee/audio gap just fixed.

## Confirmed semantics (from the user)

- **`extend: 'openai/gpt-5.5'`** on a provider's per-model metadata means: use the
  models.dev catalog entry for that slug (`provider=openai, model=gpt-5.5`, resolved via
  the existing `resolveModel`) as the **base**, then deep-merge the user's other explicit
  fields on top (user wins).
- **Two layers only.** Base = the `extend` target's catalog entry. The model's *own*
  upstream id is NOT auto-matched against the catalog for this purpose (extend exists
  precisely because the name doesn't line up). Layering = `deepMerge(extendTargetCatalog, userExplicitFields)`.
- Deep merge via `es-toolkit` `merge` (object/array deep-merge, later wins).
- Provenance: inherited `cost` is still `priceSource: 'config'` — the user actively opted
  in through `extend`, so it is a config-sourced price, not `'models-dev'`. This falls out
  for free: resolution bakes the merged cost into `provider.metadata[modelId].cost`, which
  `candidateConfigPrice` already reads and tags `'config'`.

## Key architectural facts (verified)

- `provider.metadata` (a `Record<upstreamModelId, ModelMetadata>`) is copied verbatim onto
  the runtime instance in `packages/server/src/provider-runtime/materialize.ts`
  (`materializeRuntimeProvider`, both Api and AiSdk branches).
- Two independent downstream consumers read `provider.metadata[modelId]`:
  1. **Client metadata** — `packages/server/src/server/model-resolution/model-resolution.ts`
     reads `provider.metadata?.[modelId]?.{name,limit}` (name + context window).
  2. **Cost** — `packages/server/src/routes/pipeline/attempt-base.ts` `candidateConfigPrice`
     reads `provider.metadata?.[modelId]?.cost`.
- `materializeProviders(nonOAuth)` is called at exactly one site: `snapshot.ts:79`, inside
  the already-`async` `buildSnapshot`. So an async catalog lookup at build time is natural
  and does NOT force `materializeRuntimeProvider` itself to become async.
- Catalog access: `getProviders()` (core) returns the full `ProviderMap`; `resolveModel`
  (core, models-dev/resolve.ts) resolves a slug → models.dev `Model`. `getModels(ids)`
  batches this. The `Model` shape (verified from @opencode-ai/models types) carries
  `name, description, limit{context,input?,output}, cost{input,output,cache_read?,cache_write?,reasoning?,input_audio?,output_audio?,context_over_200k?,tiers?}, attachment, reasoning, reasoning_options?, tool_call, structured_output?, temperature?, modalities, knowledge?, release_date, last_updated`.

## Design: resolve `extend` once, before materialize

Because both consumers read the same `provider.metadata[modelId]`, the least-surprising and
lowest-blast-radius injection is a **single resolution step that rewrites the config
metadata map into its effective merged form** before/at materialization. Downstream code is
then completely unchanged — it keeps reading `provider.metadata[modelId]` and transparently
sees inherited-then-overridden values for both cost and client metadata.

### Core mapper (new): models.dev `Model` → `ModelMetadata` base

Add `catalogModelToMetadata(model: Model): ModelMetadata` in a new colocated core module
under `packages/core/src/models-dev/` (e.g. `catalog-metadata/`). It maps snake_case
catalog fields into the config metadata shape, reusing the existing conventions:
- `name`, `description`
- `limit`: `{context, input?, output}`
- `capabilities`: `{reasoning, temperature?, toolCall←tool_call, attachment, structuredOutput←structured_output, reasoningOptions (budget_tokens→budgetTokens), modalities, knowledge?, releaseDate←release_date, lastUpdated←last_updated}`
- `cost`: reuse/extend the existing `toPrice`-style mapping but into the config `ModelCost`
  shape (`cacheRead←cache_read`, `inputAudio←input_audio`, `outputAudio←output_audio`,
  `tiers` snake→camel, `context_over_200k`→ a synthesized 200k tier only if `tiers` absent).
  All optional fields conditional-spread (exactOptionalPropertyTypes).

Colocate with models-dev because it depends on the `Model` type and the catalog domain.

### Server resolution step (new): rewrite metadata with extend applied

Add an async helper (server side, near materialize / snapshot) that:
1. Scans every provider's `metadata` for entries with `extend`.
2. Collects the distinct `extend` target slugs and batch-resolves them via `getModels`.
3. For each `extend` entry: `merge(catalogModelToMetadata(target), userMetadataWithoutSemanticExtendField)`.
   - The `extend` key itself is dropped from the merged result (it has served its purpose;
     leaving it would re-trigger and is not a metadata value).
   - If the target slug does not resolve (typo / missing catalog), leave the user's metadata
     as-is (no base) and log a warning — never throw, never block snapshot build.
4. Return a new config (or a metadata-rewritten provider list) with merged metadata.

Call it in `buildSnapshot` before `materializeProviders(nonOAuth)` so the materialized
`provider.metadata` is already effective.

### Merge tool

Use `es-toolkit` `mergeWith` from `es-toolkit/object` — NOT plain `merge`. Verified against
the installed `es-toolkit@1.49.0` type docs:

- `merge`/`mergeWith` **mutate the target in place** → always pass the fresh
  `catalogModelToMetadata(target)` result as target (never a cached catalog `Model` or the
  user's config object).
- Plain `merge` merges **arrays by index** (`[1,2] + [3] → [3,2]`), which is WRONG for our
  semantics: a user overriding `capabilities.reasoningOptions` / `modalities.input` /
  `cost.tiers` must REPLACE the inherited array, not index-merge it.
- Therefore use `mergeWith(base, userFields, (t, s) => (Array.isArray(s) ? s : undefined))`:
  arrays replace wholesale, nested objects deep-merge, scalars source-wins, and a
  `undefined` user field does not clobber an inherited value. This is exactly two-layer
  "user explicit fields override the extend-target base."

`@aio-proxy/core` (owner of `catalogModelToMetadata`) and/or `@aio-proxy/server` (owner of
the resolution step) must declare `"es-toolkit": "catalog:"` if not already present.

## Tasks

- **T1 (core mapper):** `catalogModelToMetadata` + colocated test. Test asserts snake→camel
  field mapping and cost/limit/capabilities shape for a representative catalog `Model`
  (including `input_audio`/`context_over_200k`). File < 300 lines; `foo/{index.ts,foo.ts,foo.test.ts}`.
- **T2 (server resolution):** extend-resolution helper (batch `getModels`, deep-merge,
  drop `extend`, missing-target warning) + colocated test covering: (a) two-layer merge
  with user override winning; (b) own-id NOT auto-matched (only extend target is the base);
  (c) unresolved target → user metadata preserved + warned, no throw; (d) entries without
  `extend` pass through untouched. Wire into `buildSnapshot` before materialize.
- **T3 (end-to-end guard + docs + changeset):** one behavior test proving both consumers see
  inherited values — cost billed from an `extend`-inherited `cost` is tagged `priceSource:'config'`,
  and `model-resolution` surfaces the inherited `name`/limit. README `Model metadata and pricing`
  section documents `extend` (two-layer semantics, models.dev slug form, user-overrides-win).
  Changeset targets `aio-proxy` + `@aio-proxy/types`(none—no schema change) → actually
  `aio-proxy` + `@aio-proxy/core` + `@aio-proxy/server` at minor.

## Verification

Rebuild types+core; `bun run lint:types` (only known monaco/dashboard noise);
`bun run format:check`; targeted tests for the new modules; then `bun run preflight`.

## Non-goals / guardrails

- No chained `extend` (extend target that itself has `extend`) — single hop only. If a
  target's own metadata had extend, we resolve against the *catalog*, not other config
  entries, so chaining does not arise.
- No change to `priceUsage` provenance logic, no change to the fee/audio wiring just landed.
- `extend` stays a models.dev slug (`ModelIdSchema`); no cross-provider config referencing.
