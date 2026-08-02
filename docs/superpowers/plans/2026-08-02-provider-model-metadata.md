# Per-Provider Model Metadata & Cost Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each `api`/`ai-sdk` Provider declare a `metadata` map keyed by upstream model id that overrides client-visible model metadata (display name, token limits, capability flags, date metadata) and per-model cost accounting, taking precedence over models.dev auto-discovery.

**Architecture:** A field-allowlisted, `.loose()` Zod schema in `@aio-proxy/types` defines the config shape (`metadata."<upstream-id>": { displayName, description, extend, limit, capabilities, cost }`), mirroring the models.dev / OpenRouter field vocabulary in camelCase. `@aio-proxy/server` materializes config `metadata` onto each runtime Provider instance; model resolution and the Codex `/models` assembly apply overrides with a config > models.dev > default priority and aggregate context windows across providers. Billing maps the hit channel's config `cost` into the existing `OpenRouterModelPrice` pricing engine (extended with split audio, per-event fees, and context-size tiers), recording a `priceSource` provenance on each usage row.

**Tech Stack:** Bun, TypeScript, Zod 4, Turborepo, `@opencode-ai/models` (models.dev catalog), `bun:test`/Rstest.

## Global Constraints

- Config keys are **camelCase** (`baseURL`/`apiKey`/`parseReasoningContent` house style); config supports JSON/JSONC/YAML — no TOML.
- Field names mirror **models.dev** where one exists; `cost` per-token prices are **USD per 1,000,000 tokens** (bare numbers, zero conversion, same unit as the internal `OpenRouterModelPrice`); per-event fees (`image`/`webSearch`/`request`) are **USD per event**.
- Schemas are `.loose()`: unknown keys are **preserved and warned about**, never rejected; invalid values (negative cost, non-positive/non-integer limit) **fail validation**.
- User config **wins over** models.dev auto-discovery, which wins over built-in defaults.
- Billing uses the **actual hit channel's** config cost, not the cross-provider aggregate; the client-facing catalog uses the aggregate.
- `priceSource` provenance lives on the **per-request `UsageRow`/trace**, never on `usage_daily` (would collapse across days).
- The google-antigravity plugin's `modelMetadata` (a Google CCA wire field) and its catalog `contextWindow` are a **separate concept** — out of scope, never renamed.
- `exactOptionalPropertyTypes: true` — use the conditional-spread pattern `...(x === undefined ? {} : { x })`.
- `@aio-proxy/types` and `@aio-proxy/core` resolve to `dist/`; rebuild them (`bunx turbo run build --filter=@aio-proxy/types --filter=@aio-proxy/core`) before downstream typecheck/tests.
- Handwritten non-test implementation files stay below 300 lines; reassess splitting at 240.
- Verify with `bun run lint:types`, `bun run format:check`, and affected package unit tests. Known sandbox-only failures (paraglide i18n CDN compile: i18n `test:artifact`, core `createPluginDiagnosticFactory`) are environmental and pass in CI.

## Field Shape (agreed, from the design spec)

`docs/superpowers/specs/2026-08-02-provider-model-metadata-design.md` holds the full rationale and the models.dev / OpenRouter evidence. Final shape:

```jsonc
"metadata": {
  "<upstream-model-id>": {
    "displayName": "GPT-5 Codex",
    "description": "OpenAI GPT-5 tuned for agentic coding",
    "extend": "openai/gpt-5",
    "limit": { "context": 400000, "input": 272000, "output": 128000 },
    "capabilities": {
      "reasoning": true, "temperature": true, "toolCall": true,
      "attachment": true, "structuredOutput": true,
      "modalities": { "input": ["text","image"], "output": ["text"] },
      "knowledge": "2025-01", "releaseDate": "2025-06", "lastUpdated": "2025-07"
    },
    "cost": {
      "input": 1.25, "output": 10, "reasoning": 10,
      "cacheRead": 0.125, "cacheWrite": 1.25,
      "inputAudio": 40, "outputAudio": 80,
      "image": 0.01, "webSearch": 0.03, "request": 0.004,
      "tiers": [ { "tier": { "type": "context", "size": 200000 }, "input": 2.5, "output": 15 } ]
    }
  }
}
```

## File Map

### Shared schema (`@aio-proxy/types`)

- `packages/types/src/model-metadata/model-metadata.ts`: `ModelLimitSchema`, `ModalitySchema`, `ModelModalitiesSchema`, `ModelCapabilitiesSchema`, `ModelCostTierSchema`, `ModelCostSchema`, `ModelMetadataSchema`; allowlist set `MODEL_METADATA_KNOWN_KEYS` + `MODEL_COST_KNOWN_KEYS`; `collectUnknownModelMetadataKeys`. All public types.
- `packages/types/src/model-metadata/index.ts`: export-only barrel.
- `packages/types/src/model-metadata/model-metadata.test.ts`: schema accept/reject + collector behavior.
- `packages/types/src/provider.ts`: `metadataField` const (`metadata:` record) spread into `ApiProviderSharedFields`, `AiSdkProviderSharedFields`, and both mutation shared field sets.
- `packages/types/src/config/config.ts`: top-level `router.modelContextAggregation` (`min`|`max`, default `min`).
- `packages/types/src/usage.ts`: `PriceSourceSchema` enum + `priceSource?` on `UsageRowSchema`.

### Runtime carriers (`@aio-proxy/core`, `@aio-proxy/server`)

- `packages/core/src/provider/api/api.ts`, `packages/core/src/provider/ai-sdk/ai-sdk.ts`: carry `metadata` on the instance (spread from config).
- `packages/core/src/usage-pricing/usage-pricing.ts`: `OpenRouterModelPrice`/`OpenRouterModelPriceTier` (split audio, per-event fees, tiers); `calculateEstimatedCost`; `tierAdjustedPrice`; `configModelPrice(modelId, cost: ModelCost)`.
- `packages/core/src/usage-pricing/index.ts`, `packages/core/src/index.ts`: export `configModelPrice`, `OpenRouterModelPrice`, `OpenRouterModelPriceTier`.
- `packages/server/src/runtime.ts`: `RuntimeModelMetadata = ModelMetadata & { protocol? }`; `RuntimeProviderBase.metadata?`.
- `packages/server/src/provider-runtime/materialize.ts`: spread config `metadata` onto api/ai-sdk runtime instances.
- `packages/server/src/plugin-runtime/catalog.ts`: `modelMetadataRecord(catalog)` builds the runtime metadata record.
- `packages/server/src/plugin-runtime/capabilities.ts`: populate the `metadata` field from `modelMetadataRecord`.

### Consumers (`@aio-proxy/server`)

- `packages/server/src/server/model-resolution/model-resolution.ts`: `resolveDisplayName` and `candidateContextWindow` read `provider.metadata?.[id]`; aggregate context window across candidates by `router.modelContextAggregation`.
- `packages/server/src/server/list-models/list-models.ts`, `.../codex-client-models/codex-assembly.ts`, `.../codex-client-models.ts`: project the resolved single-value `contextWindow` (name unchanged) into catalog output.
- `packages/server/src/routes/pipeline/attempt-base.ts`: `candidateConfigPrice(provider, modelId)` reads `provider.metadata?.[id]?.cost` → `configModelPrice`.
- `packages/server/src/routes/pipeline/attempt/model.ts`, `.../raw.ts`: pass `configPrice` into usage capture.
- `packages/server/src/usage-capture/{pricing,usage-validation,shared,stream-capture,passthrough-capture/passthrough-capture}.ts`: thread `configPrice` through to `priceUsage`, which short-circuits the catalog and tags `priceSource: 'config'`.

### Docs

- `npm/aio-proxy/README.md` (symlink → `docs`): "Model metadata and pricing" section using `metadata`/`limit`/`capabilities`/`cost`.
- `.changeset/provider-model-metadata.md`: targets `aio-proxy` + `@aio-proxy/types`/`@aio-proxy/core`/`@aio-proxy/server` at minor.

---

## Task 1: Metadata schema in `@aio-proxy/types`

**Files:**
- Modify: `packages/types/src/model-metadata/model-metadata.ts`
- Test: `packages/types/src/model-metadata/model-metadata.test.ts`

**Interfaces:**
- Produces: `ModelMetadataSchema`, `ModelCostSchema`, `ModelLimitSchema`, `ModelCapabilitiesSchema`, `ModelCostTierSchema`, `ModalitySchema`; types `ModelMetadata`, `ModelCost`, `ModelCostTier`, `ModelLimit`, `ModelCapabilities`, `Modality`; `MODEL_METADATA_KNOWN_KEYS`; `collectUnknownModelMetadataKeys(record): readonly string[]`.

- [ ] **Step 1: Write failing tests** for: accepts a full record (`displayName`/`description`/`extend`/`limit`/`capabilities`/`cost` with split audio + nested tier); preserves unknown top-level & unknown `cost` keys under `.loose()`; rejects negative cost (`cost.input: -1`), non-positive limit (`limit.context: 0`), non-integer limit (`limit.context: 1.5`), negative tier size; `collectUnknownModelMetadataKeys` reports `up-a.mystery` and `up-a.cost.surcharge`.

```ts
test('accepts a full metadata record', () => {
  const parsed = ModelMetadataSchema.parse({
    displayName: 'X',
    limit: { context: 1_000_000, input: 900_000, output: 65_536 },
    capabilities: { reasoning: true, modalities: { input: ['text', 'image'], output: ['text'] }, knowledge: '2025-01' },
    cost: { input: 2, output: 10, inputAudio: 40, outputAudio: 80, image: 0.01, request: 0.004,
      tiers: [{ tier: { type: 'context', size: 200_000 }, input: 3 }] },
  });
  expect(parsed.limit?.context).toBe(1_000_000);
  expect(parsed.cost?.tiers?.[0]?.tier.size).toBe(200_000);
  expect(parsed.capabilities?.modalities?.input).toEqual(['text', 'image']);
});
test('rejects negative cost and non-positive limit', () => {
  expect(ModelMetadataSchema.safeParse({ cost: { input: -1 } }).success).toBe(false);
  expect(ModelMetadataSchema.safeParse({ limit: { context: 0 } }).success).toBe(false);
  expect(ModelMetadataSchema.safeParse({ limit: { context: 1.5 } }).success).toBe(false);
});
test('reports unknown top-level and nested cost keys', () => {
  const rec = { 'up-a': ModelMetadataSchema.parse({ limit: { context: 1 }, mystery: 1, cost: { input: 2, surcharge: 9 } }) };
  expect(collectUnknownModelMetadataKeys(rec)).toEqual(['up-a.mystery', 'up-a.cost.surcharge']);
});
```

- [ ] **Step 2: Run tests, verify they fail** — Run: `cd packages/types && bun test src/model-metadata/model-metadata.test.ts` — Expected: FAIL (schema/fields missing).
- [ ] **Step 3: Implement** the schemas per the Field Shape section: `TokenClassPriceFields` (adds `inputAudio`/`outputAudio`), `ModelCostTierSchema` (`tier: { type: literal('context'), size: int().nonnegative() }` + token fields), `ModelCostSchema` (`.loose()`, token + `image`/`webSearch`/`request` + `tiers`), `ModelLimitSchema` (`context`/`input`/`output` = `int().positive().optional()`, `.loose()`), `ModalitySchema` = `z.enum(['text','audio','image','video','pdf'])`, `ModelModalitiesSchema`, `ModelCapabilitiesSchema` (booleans + modalities + `knowledge`/`releaseDate`/`lastUpdated` strings, `.loose()`), `ModelMetadataSchema` (`displayName`/`description`/`extend`/`limit`/`capabilities`/`cost`, `.loose()`). `MODEL_METADATA_KNOWN_KEYS = {displayName, description, extend, limit, capabilities, cost}`; `MODEL_COST_KNOWN_KEYS` = token + audio + fees + `tiers`; `collectUnknownModelMetadataKeys` checks top-level + `cost` subkeys.
- [ ] **Step 4: Run tests, verify pass** — Run: `cd packages/types && bun test src/model-metadata/model-metadata.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** — `git add packages/types/src/model-metadata && git commit -m "feat(types): per-model metadata schema (limit/capabilities/cost)"`

## Task 2: Wire `metadata` into Provider schemas

**Files:**
- Modify: `packages/types/src/provider.ts`
- Modify: `packages/types/src/config/config.ts` (router aggregation)
- Test: existing `packages/types/src/config/config-acceptance*.test.ts`

**Interfaces:**
- Consumes: `ModelMetadataSchema` (Task 1).
- Produces: `metadata?` on `ApiProvider`, `AiSdkProvider`, and both mutation body schemas; `router.modelContextAggregation` on config.

- [ ] **Step 1: Write a failing acceptance test** that a provider config with `metadata: { 'up-x': { limit: { context: 1000 }, cost: { input: 2 } } }` parses and round-trips through `ProviderSchema`, and that a `ProviderMutationBodySchema` PUT preserves `metadata`.
- [ ] **Step 2: Run, verify fail** — Run: `cd packages/types && bun test src/config/config-acceptance.test.ts` — Expected: FAIL (`metadata` stripped).
- [ ] **Step 3: Implement** `metadataField = { metadata: z.record(ModelIdSchema, ModelMetadataSchema).optional().describe(...) }`; spread into `ApiProviderSharedFields`, `AiSdkProviderSharedFields`, `ApiProviderMutationSharedFields`, `AiSdkProviderMutationSharedFields`. Confirm `router.modelContextAggregation` exists on the config schema.
- [ ] **Step 4: Run, verify pass** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(types): accept provider metadata + router aggregation"`

## Task 3: Pricing engine cost mapping (`@aio-proxy/core`)

**Files:**
- Modify: `packages/core/src/usage-pricing/usage-pricing.ts`
- Modify: `packages/core/src/usage-pricing/index.ts`, `packages/core/src/index.ts`
- Test: `packages/core/src/usage-pricing/usage-pricing.test.ts`

**Interfaces:**
- Consumes: `ModelCost` (Task 1).
- Produces: `configModelPrice(modelId: string, cost: ModelCost): OpenRouterModelPrice`; `OpenRouterModelPrice` (adds `inputAudio`, `outputAudio`, `image`, `webSearch`, `request`, `tiers`); `UsagePricingInput` (adds `inputAudioTokens`, `outputAudioTokens`, `imageCount`, `webSearchCount`).

- [ ] **Step 1: Write failing tests**: `configModelPrice('p/m', { input: 2 })` → `{ id: 'p/m', input: 2 }`; a full cost maps every field and turns each config tier `{ tier: { size }, ... }` into an engine `{ threshold: size, ... }`; `calculateEstimatedCost` charges split audio (`inputAudioTokens`×`inputAudio` + `outputAudioTokens`×`outputAudio`), per-event fees (image/webSearch/request once), and selects the highest crossed context tier. Use exact `N / 1_000_000` literals in expectations to avoid float drift.
- [ ] **Step 2: Run, verify fail** — Run: `cd packages/core && bun test src/usage-pricing/usage-pricing.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the type extensions + `configModelPrice` (field-copy, tiers read `tier.tier.size` → `threshold`), `calculateEstimatedCost` audio-split + `addFee` for image/webSearch/`request` (once), and `tierAdjustedPrice` overlay (including `inputAudio`/`outputAudio`). Export `configModelPrice` + tier type.
- [ ] **Step 4: Run, verify pass** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(core): map config cost into pricing engine"`

## Task 4: Runtime materialization + capability record

**Files:**
- Modify: `packages/core/src/provider/api/api.ts`, `packages/core/src/provider/ai-sdk/ai-sdk.ts`
- Modify: `packages/server/src/runtime.ts`, `packages/server/src/provider-runtime/materialize.ts`
- Modify: `packages/server/src/plugin-runtime/catalog.ts`, `packages/server/src/plugin-runtime/capabilities.ts`
- Test: `packages/server/src/plugin-runtime/capabilities.test.ts`

**Interfaces:**
- Consumes: `ModelMetadata` (Task 1), provider schema `metadata` (Task 2).
- Produces: `RuntimeProviderInstance.metadata?: Readonly<Record<ModelId, RuntimeModelMetadata>>`; `modelMetadataRecord(catalog): Readonly<Record<string, RuntimeModelMetadata>>`.

- [ ] **Step 1: Write a failing test** that `capabilities()` output for a plugin provider exposes `metadata[modelId]` with the catalog descriptor's protocol/displayName.
- [ ] **Step 2: Run, verify fail** — Run: `cd packages/server && bun test src/plugin-runtime/capabilities.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the `metadata` spread on api/ai-sdk instances; rename runtime field to `metadata`; materialize config `metadata` in both `materialize.ts` branches; `modelMetadataRecord` + `metadata` field in `capabilities.ts`. Rebuild core: `bunx turbo run build --filter=@aio-proxy/core`.
- [ ] **Step 4: Run, verify pass** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): materialize provider metadata onto runtime"`

## Task 5: Model resolution + catalog projection

**Files:**
- Modify: `packages/server/src/server/model-resolution/model-resolution.ts`
- Modify: `packages/server/src/server/list-models/list-models.ts`, `.../codex-client-models/codex-assembly.ts`, `.../codex-client-models.ts`
- Test: `packages/server/src/server/model-resolution/model-resolution.test.ts`, `.../codex-client-models/codex-assembly.test.ts`, `.../codex-client-models.test.ts`

**Interfaces:**
- Consumes: `RuntimeProviderInstance.metadata` (Task 4).
- Produces: `ResolvedModel.contextWindow` (resolved single value, name unchanged).

- [ ] **Step 1: Write failing tests**: config `displayName` wins over catalog name; `candidateContextWindow` prefers config `limit.context`, then `limit.input`, then models.dev `limit.input`/`limit.context`; `min`/`max` aggregation across two providers exposes 200k / 1M respectively; a config context override wins over the models.dev limit in codex assembly.
- [ ] **Step 2: Run, verify fail** — Run: `cd packages/server && bun test src/server/model-resolution` — Expected: FAIL.
- [ ] **Step 3: Implement** the `provider.metadata?.[id]?.displayName` read and `candidateContextWindow` reading `limit.context ?? limit.input ?? metadata?.limit.input ?? metadata?.limit.context`; keep the resolved-single-value `contextWindow` name in list-models/codex.
- [ ] **Step 4: Run, verify pass** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): apply metadata overrides in model resolution"`

## Task 6: Billing chain with config cost + provenance

**Files:**
- Modify: `packages/server/src/routes/pipeline/attempt-base.ts`, `.../attempt/model.ts`, `.../attempt/raw.ts`
- Modify: `packages/server/src/usage-capture/{pricing,usage-validation,shared,stream-capture,passthrough-capture/passthrough-capture}.ts`
- Modify: `packages/types/src/usage.ts` (`priceSource`)
- Test: `packages/server/src/usage-capture/usage-capture.pricing.passthrough.test.ts`, `.../usage-capture.stream.lifecycle.test.ts`

**Interfaces:**
- Consumes: `configModelPrice`/`OpenRouterModelPrice` (Task 3), `RuntimeProviderInstance.metadata` (Task 4).
- Produces: `candidateConfigPrice(provider, modelId): OpenRouterModelPrice | undefined`; `priceUsage(..., configPrice?)` returning `priceSource: 'config' | 'models-dev'`.

- [ ] **Step 1: Write failing tests**: with a hit-channel `configPrice`, a passthrough usage row is billed from config and tagged `priceSource: 'config'`; without one, a priced row is tagged `priceSource: 'models-dev'`.
- [ ] **Step 2: Run, verify fail** — Run: `cd packages/server && bun test src/usage-capture` — Expected: FAIL.
- [ ] **Step 3: Implement** `candidateConfigPrice` reading `provider.metadata?.[id]?.cost`; thread `configPrice` through capture → finalize → `priceUsage` (short-circuit catalog when present); add `PriceSourceSchema` + `priceSource?` to `UsageRowSchema`.
- [ ] **Step 4: Run, verify pass** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): bill from hit-channel config cost with provenance"`

## Task 7: Docs, changeset, and full verification

**Files:**
- Modify: `npm/aio-proxy/README.md`
- Create: `.changeset/provider-model-metadata.md`

- [ ] **Step 1:** Update the README "Model metadata and pricing" section with a jsonc example using `metadata`/`limit`/`capabilities`/`cost` and `router.modelContextAggregation`; note config-vs-models.dev precedence and `priceSource`.
- [ ] **Step 2:** Author the changeset targeting `aio-proxy` + `@aio-proxy/types`/`@aio-proxy/core`/`@aio-proxy/server` at `minor` (summary prefixed by area).
- [ ] **Step 3: Rebuild + verify** — Run: `bunx turbo run build --filter=@aio-proxy/types --filter=@aio-proxy/core && bun run lint:types && bun run format:check`. Then affected tests: `cd packages/types && bun test`; `cd packages/core && bun test src/usage-pricing`; `cd packages/server && bun test src/server/model-resolution src/usage-capture src/plugin-runtime src/server/list-models`. Known sandbox-only i18n failures are environmental.
- [ ] **Step 4: Commit** — `git commit -am "docs: document provider metadata & cost overrides"`

## Self-Review Notes

- **Spec coverage:** displayName/description/extend/limit/capabilities/cost all in Task 1; provider wiring Task 2; cost engine Task 3; runtime Task 4; resolution/catalog Task 5; billing+provenance Task 6; docs Task 7. `capabilities` is stored end-to-end; downstream *projection* of capability flags into Codex ModelInfo is limited to what Codex consumes (context window) — remaining flags are stored/served but not yet mapped into every client field (acceptable for v1; flagged for a follow-up if a client needs them).
- **Type consistency:** config type is `ModelCost`; the pricing engine's shape is the distinct `OpenRouterModelPrice` (kept as its own naming layer, not renamed). `configModelPrice` bridges the two. Runtime field is `metadata`; catalog helper is `modelMetadataRecord`.
- **Out of scope:** google-antigravity `modelMetadata` wire field and catalog `contextWindow`; models.dev→engine audio/tier auto-discovery mapping in `price.ts` (config override path only).
