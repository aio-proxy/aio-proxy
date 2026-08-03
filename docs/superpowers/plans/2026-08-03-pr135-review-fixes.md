# PR #135 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three pre-existing billing/projection correctness gaps surfaced by the model-metadata + `extend` follow-ups, and make the config `extend` field advertise the models.dev slug enum via an external `$ref` in the generated JSON Schema.

**Architecture:** Compute one effective `ModelMetadata` per resolved slug (catalog under, config override on top, arrays replace) so `/v1/models` reads every field — capabilities, `limit.output`, modalities — from the merged view instead of the raw catalog record; split `max_input_tokens` from the total context window; bill a flat `cost.request` fee even when the upstream returns no token usage; and inject an external `$ref` into the emitted `config.schema.json` for the `extend` field.

**Tech Stack:** Bun workspace monorepo (Turborepo), zod 4 (`z.toJSONSchema` with `override`), es-toolkit (`mergeWith`), `@opencode-ai/models` (models.dev catalog).

## Global Constraints

- All bash commands run from the worktree root: `cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712 &&`.
- Handwritten non-test implementation files must stay under 300 lines; split by responsibility (`foo/{index.ts,foo.ts,bar.ts}`, index = export-only barrel) if a touched file approaches the limit.
- Colocated tests only: `foo/foo.test.ts` next to source. Do not add to legacy `_test/`.
- `exactOptionalPropertyTypes: true` — use conditional spread `...(x === undefined ? {} : { x })`, never assign `undefined`.
- Prefer `es-toolkit` (narrow imports, e.g. `es-toolkit/object`) over hand-written collection/object utilities.
- Commits use conventional type prefixes (`fix`/`feat`/`refactor`/`test`/`docs`). A bare `server:` prefix is rejected by commitlint.
- Every user-facing change needs a changeset targeting the product package `aio-proxy` (plus the internal packages where the fix lives) or its Release note silently vanishes.
- Array-replace merge customizer (used by `resolve-extend` already): `(_target, source) => (Array.isArray(source) ? source : undefined)`.
- Audio/cache/reasoning tokens are subsets peeled from their parent totals before the text rate applies — do not reintroduce double-billing.

---

## File Structure

- `packages/server/src/server/model-resolution/model-resolution.ts` — add `effectiveMetadata` + `maxInput` to `ResolvedModel`; build effective metadata via `catalogModelToMetadata` + `mergeWith`. (Currently 108 lines; adding ~30 stays well under 300.)
- `packages/server/src/server/model-resolution/model-resolution.test.ts` — update existing `toEqual` full-object assertions for the new fields; add override + max-input cases.
- `packages/server/src/server/model-capabilities/model-capabilities.ts` — add `toAnthropicCapabilitiesFromMetadata(meta: ModelMetadata)` deriving the Anthropic subset from merged config capabilities.
- `packages/server/src/server/model-capabilities/index.ts` — export the new function.
- `packages/server/src/server/model-capabilities/model-capabilities.test.ts` — test the metadata-driven derivation honors config overrides.
- `packages/server/src/server/list-models/list-models.ts` — read `capabilities`/`max_tokens`/`max_input_tokens` from effective metadata + `maxInput`.
- `packages/server/src/server/list-models/list-models.test.ts` — create; assert projected item honors config overrides (new file — check it doesn't already exist).
- `packages/server/src/usage-capture/usage-validation.ts` — add `providerId`/`modelId` params; synthesize minimal row when no usage but a positive request fee is configured.
- `packages/server/src/usage-capture/usage-validation.test.ts` — create or extend; success bills request fee with no tokens, failure does not.
- `packages/server/src/usage-capture/stream-capture.ts` + `passthrough-capture/passthrough-capture.ts` — thread `providerId`/`modelId` into `finalizeUsage` for the no-usage case.
- `packages/types/src/model-metadata/model-metadata.ts` — tag `extend` with a discriminable `.meta({ id: 'ModelsDevModelRef' })` marker.
- `packages/types/rslib.config.ts` — add `override` to `z.toJSONSchema` to emit the external `$ref` for the tagged `extend` node.
- `packages/types/src/config/config-schema-ref.test.ts` — create; assert the generated schema's `extend` node is the external `$ref`.
- `.changeset/pr135-review-fixes.md` — create.
- `docs/superpowers/plans/2026-08-03-pr135-review-fixes.md` — this plan.

---

## Task 1: Effective metadata + max-input in model resolution (P1-#1 core + P1-#3)

**Files:**
- Modify: `packages/server/src/server/model-resolution/model-resolution.ts`
- Modify: `packages/server/src/server/model-resolution/model-resolution.test.ts`

**Interfaces:**
- Consumes: `catalogModelToMetadata(model: ModelsDevModel): ModelMetadata` from `@aio-proxy/core`; `mergeWith` from `es-toolkit/object`; `RuntimeProviderInstance.metadata?: Record<ModelId, RuntimeModelMetadata>` where `RuntimeModelMetadata = ModelMetadata & { protocol? }`.
- Produces: `ResolvedModel` gains `readonly effectiveMetadata: ModelMetadata | undefined` and `readonly maxInput: number | undefined`. `metadata: ModelsDevModel | undefined` (raw catalog) stays for release-date timestamps.

- [ ] **Step 1: Update the existing `toEqual` assertions to expect the new fields (failing)**

In `model-resolution.test.ts`, the two full-object `toEqual([{...}])` assertions (the "reads metadata only from the alias slug" case and the "de-dupes by slug" case) must gain the new fields. For the alias-only case (no catalog, no config metadata) both new fields are `undefined`:

```ts
expect(resolved).toEqual([
  {
    slug: 'my-alias',
    modelId: 'gpt-5.6-sol',
    provider: aliasOnlyProvider,
    metadata: undefined,
    displayName: 'my-alias',
    contextWindow: undefined,
    effectiveMetadata: undefined,
    maxInput: undefined,
  },
]);
```

For the de-dupes case (catalog `gpt-5` exists, config metadata `{ name: 'Vendor Name' }`), effectiveMetadata is the merged catalog+config object and maxInput comes from catalog `limit` (the seed uses `limit: { context: 128_000, output: 8_000 }`, no `input`, so `maxInput` is `undefined`):

```ts
expect(resolved[0]).toMatchObject({
  slug: 'gpt-5',
  modelId: 'gpt-5.6-sol',
  displayName: 'Vendor Name',
  contextWindow: 128_000,
  maxInput: undefined,
});
expect(resolved[0]?.effectiveMetadata?.name).toBe('Vendor Name');
expect(resolved[0]?.effectiveMetadata?.limit?.context).toBe(128_000);
```
(Switch that second case from `toEqual` on the whole array to `toMatchObject` + field asserts, because `effectiveMetadata` is a large merged object not worth restating.)

- [ ] **Step 2: Add the new max-input regression test (failing)**

Append to `model-resolution.test.ts`:

```ts
test('maxInput uses config limit.input over catalog, and never falls back to context', async () => {
  // catalog input 500k; config input 272k; both carry a context. maxInput must be
  // the config input (272k), NOT the context window (300k).
  await seedCatalog({ 'gpt-mi': modelsDevModel('gpt-mi', 'gpt-mi', { limit: { input: 500_000, output: 8_000 } }) });
  const provider = slugProvider('p1', 'gpt-mi', 'up-mi', { context: 300_000, input: 272_000 });
  const resolved = await resolveEnabledModels(fakeState([provider]));
  expect(resolved[0]?.maxInput).toBe(272_000);
  expect(resolved[0]?.contextWindow).toBe(300_000);
});

test('maxInput uses catalog limit.input when config has none, and is undefined when neither has input', async () => {
  await seedCatalog({ 'gpt-ci': modelsDevModel('gpt-ci', 'gpt-ci', { limit: { input: 400_000, output: 8_000 } }) });
  const withCatalogInput = slugProvider('p1', 'gpt-ci', 'up-ci');
  expect((await resolveEnabledModels(fakeState([withCatalogInput])))[0]?.maxInput).toBe(400_000);

  await seedCatalog({ 'gpt-nc': modelsDevModel('gpt-nc', 'gpt-nc', { limit: { context: 128_000, output: 8_000 } }) });
  const noInput = slugProvider('p2', 'gpt-nc', 'up-nc');
  expect((await resolveEnabledModels(fakeState([noInput])))[0]?.maxInput).toBeUndefined();
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712 && bun test packages/server/src/server/model-resolution/model-resolution.test.ts`
Expected: FAIL — `effectiveMetadata`/`maxInput` are `undefined`-not-present / property does not exist.

- [ ] **Step 4: Implement effectiveMetadata + maxInput**

In `model-resolution.ts`:

Add imports:
```ts
import { catalogModelToMetadata, getModels, type ModelsDevModel, modelRoutes } from '@aio-proxy/core';
import type { ModelMetadata } from '@aio-proxy/types';
import { mergeWith } from 'es-toolkit/object';
```

Extend the type:
```ts
export type ResolvedModel = {
  readonly slug: string;
  readonly modelId: string;
  readonly provider: RuntimeProviderInstance;
  readonly metadata: ModelsDevModel | undefined;
  readonly displayName: string;
  readonly contextWindow: number | undefined;
  // Config-overridden metadata merged over the alias-slug catalog entry (catalog
  // under, config wins, arrays replace). Drives the /v1/models projection so
  // config capabilities/limit.output/modalities surface, not just the raw catalog.
  readonly effectiveMetadata: ModelMetadata | undefined;
  // Max input tokens (config limit.input ?? catalog limit.input). Distinct from
  // contextWindow (total context); never falls back to context.
  readonly maxInput: number | undefined;
};
```

Add builders (place near `candidateContextWindow`):
```ts
// Effective metadata for the public slug: the alias-slug catalog entry as the
// base layer, config metadata for the primary candidate's upstream modelId merged
// on top (user wins; arrays replace). Same direction/customizer as resolve-extend.
function effectiveMetadata(
  provider: RuntimeProviderInstance,
  modelId: string,
  metadata: ModelsDevModel | undefined,
): ModelMetadata | undefined {
  const config = provider.metadata?.[modelId];
  const base = metadata === undefined ? undefined : catalogModelToMetadata(metadata);
  if (base === undefined) return config === undefined ? undefined : stripProtocol(config);
  if (config === undefined) return base;
  return mergeWith(base, stripProtocol(config), (_target, source) => (Array.isArray(source) ? source : undefined));
}

// RuntimeModelMetadata carries a runtime-only `protocol`; drop it so the merged
// view is a clean ModelMetadata (protocol is not a client-facing metadata field).
function stripProtocol(meta: ModelMetadata & { protocol?: unknown }): ModelMetadata {
  const { protocol: _protocol, ...rest } = meta;
  return rest;
}

// Max input tokens for one candidate: config limit.input wins over catalog
// limit.input. Never falls back to the context window (context !== max input).
function candidateMaxInput(
  provider: RuntimeProviderInstance,
  modelId: string,
  metadata: ModelsDevModel | undefined,
): number | undefined {
  return provider.metadata?.[modelId]?.limit?.input ?? metadata?.limit.input;
}
```

In the `slugs.map(...)` body, compute both from the primary candidate and aggregate maxInput the same way as context:
```ts
const maxInput = aggregateContextWindow(
  candidates.map((candidate) => candidateMaxInput(candidate.provider, candidate.modelId, metadata)),
  aggregation,
);
return {
  slug,
  modelId: primary.modelId,
  provider: primary.provider,
  metadata,
  displayName: resolveDisplayName(primary.provider, primary.modelId, slug, metadata),
  contextWindow,
  effectiveMetadata: effectiveMetadata(primary.provider, primary.modelId, metadata),
  maxInput,
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712 && bun test packages/server/src/server/model-resolution/model-resolution.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712
git add packages/server/src/server/model-resolution/model-resolution.ts packages/server/src/server/model-resolution/model-resolution.test.ts
git commit -m "fix(server): resolve effective metadata and max-input per model

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Metadata-driven Anthropic capabilities (P1-#1 capabilities)

**Files:**
- Modify: `packages/server/src/server/model-capabilities/model-capabilities.ts`
- Modify: `packages/server/src/server/model-capabilities/index.ts`
- Modify: `packages/server/src/server/model-capabilities/model-capabilities.test.ts`

**Interfaces:**
- Consumes: `ModelMetadata`, `ModelCapabilities`, `ReasoningOption` from `@aio-proxy/types`; existing `ModelCapabilitiesSubset`.
- Produces: `toAnthropicCapabilitiesFromMetadata(meta: ModelMetadata): ModelCapabilitiesSubset` exported from `model-capabilities/index.ts`.

- [ ] **Step 1: Write the failing test**

Add to `model-capabilities.test.ts`:
```ts
import { toAnthropicCapabilitiesFromMetadata } from './model-capabilities';

test('derives Anthropic capabilities from merged metadata, honoring config overrides', () => {
  const meta = {
    capabilities: {
      reasoning: true,
      structuredOutput: false, // config override: catalog might say true
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
    },
  } as const;
  const caps = toAnthropicCapabilitiesFromMetadata(meta);
  expect(caps.structured_outputs).toEqual({ supported: false });
  expect(caps.image_input).toEqual({ supported: true });
  expect(caps.pdf_input).toEqual({ supported: true });
  expect(caps.thinking.supported).toEqual({ supported: true }.supported);
  expect(caps.effort.supported).toBe(true);
  expect(caps.effort.high).toEqual({ supported: true });
  expect(caps.effort.medium).toEqual({ supported: false });
});

test('metadata with no capabilities yields all-unsupported subset', () => {
  const caps = toAnthropicCapabilitiesFromMetadata({});
  expect(caps.structured_outputs).toEqual({ supported: false });
  expect(caps.effort.supported).toBe(false);
  expect(caps.thinking.supported).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712 && bun test packages/server/src/server/model-capabilities/model-capabilities.test.ts`
Expected: FAIL — `toAnthropicCapabilitiesFromMetadata` is not exported.

- [ ] **Step 3: Implement the metadata-driven derivation**

In `model-capabilities.ts` add (reuse the existing `support` helper):
```ts
import type { ModelMetadata } from '@aio-proxy/types';

// Derives the Anthropic capabilities subset from merged config metadata (catalog
// base + config overrides), so /v1/models reflects config capability overrides.
// Mirrors toAnthropicCapabilities but reads the camelCased ModelMetadata shape.
export function toAnthropicCapabilitiesFromMetadata(meta: ModelMetadata): ModelCapabilitiesSubset {
  const caps = meta.capabilities;
  const options = caps?.reasoningOptions ?? [];
  const effort = options.find((option) => option.type === 'effort');
  const values = new Set(effort?.values ?? []);
  const inputs = caps?.modalities?.input ?? [];
  return {
    effort: {
      high: support(values.has('high')),
      low: support(values.has('low')),
      max: support(values.has('max')),
      medium: support(values.has('medium')),
      supported: effort !== undefined,
      xhigh: support(values.has('xhigh')),
    },
    image_input: support(inputs.includes('image')),
    pdf_input: support(inputs.includes('pdf')),
    structured_outputs: support(caps?.structuredOutput === true),
    thinking: {
      supported: caps?.reasoning === true,
      types: {
        adaptive: support(effort !== undefined),
        enabled: support(options.some((option) => option.type === 'budgetTokens' || option.type === 'toggle')),
      },
    },
  };
}
```
Note: config `ReasoningOption` uses `budgetTokens` (camelCase), unlike the catalog's `budget_tokens` — the `enabled` check must use `budgetTokens`.

- [ ] **Step 4: Export it**

In `model-capabilities/index.ts`:
```ts
export {
  type ModelCapabilitiesSubset,
  toAnthropicCapabilities,
  toAnthropicCapabilitiesFromMetadata,
} from './model-capabilities';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712 && bun test packages/server/src/server/model-capabilities/model-capabilities.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712
git add packages/server/src/server/model-capabilities/
git commit -m "feat(server): derive Anthropic capabilities from merged metadata

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Wire effective metadata + max-input into /v1/models projection (P1-#1 + P1-#3)

**Files:**
- Modify: `packages/server/src/server/list-models/list-models.ts`
- Create: `packages/server/src/server/list-models/list-models.test.ts` (verify it does not already exist; if it does, extend it)

**Interfaces:**
- Consumes: `ResolvedModel.effectiveMetadata`, `ResolvedModel.maxInput` (Task 1); `toAnthropicCapabilitiesFromMetadata` (Task 2).
- Produces: `/v1/models` items whose `capabilities`, `max_tokens`, `max_input_tokens` reflect config overrides.

- [ ] **Step 1: Write the failing test**

Create `list-models.test.ts`. Build a `ServerState` via `resolveEnabledModels` the same way `model-resolution.test.ts` does (copy the `seedCatalog`/`fakeState`/`slugProvider` harness setup — or import shared helpers if extracted; simplest is to seed catalog + a provider with config metadata overrides and call `listModels`).

```ts
test('projects config capability and limit.output overrides, and max_input distinct from context', async () => {
  // catalog: structured_output true, output 8k, input 500k, context 128k
  await seedCatalog({
    'gpt-x': modelsDevModel('gpt-x', 'gpt-x', {
      structured_output: true,
      limit: { context: 128_000, input: 500_000, output: 8_000 },
    }),
  });
  // config overrides: structuredOutput false, limit.output 4k, limit.input 272k
  const provider = {
    id: 'p1',
    kind: ProviderKind.Api,
    enabled: true,
    alias: { 'gpt-x': { model: 'up-x', preserve: false } },
    metadata: {
      'up-x': { capabilities: { structuredOutput: false }, limit: { input: 272_000, output: 4_000 } },
    },
    model: { invoke: async function* () {} },
  } as unknown as RuntimeProviderInstance;

  const result = await listModels(fakeState([provider]));
  const item = result.data[0]!;
  expect(item.capabilities?.structured_outputs).toEqual({ supported: false });
  expect(item.max_tokens).toBe(4_000); // config limit.output wins
  expect(item.max_input_tokens).toBe(272_000); // config limit.input, NOT context 128k or catalog 500k
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712 && bun test packages/server/src/server/list-models/list-models.test.ts`
Expected: FAIL — `max_tokens`/`capabilities` read from raw catalog, `max_input_tokens` uses context window.

- [ ] **Step 3: Implement the projection change**

In `list-models.ts`, destructure the new fields and read from effective metadata:
```ts
import { toAnthropicCapabilitiesFromMetadata } from '../model-capabilities';
// remove the toAnthropicCapabilities import if no longer used elsewhere in this file

const data = resolved.map(
  ({ slug, provider, metadata, effectiveMetadata, displayName, maxInput }): ModelListItem => {
    const timestamps = modelTimestamps(metadata?.release_date);
    return {
      capabilities: effectiveMetadata === undefined ? null : toAnthropicCapabilitiesFromMetadata(effectiveMetadata),
      created: timestamps.created,
      created_at: timestamps.createdAt,
      display_name: displayName,
      id: slug,
      // Max input tokens (config limit.input ?? catalog limit.input); distinct
      // from the total context window.
      max_input_tokens: maxInput ?? null,
      max_tokens: effectiveMetadata?.limit?.output ?? null,
      object: 'model',
      owned_by: provider.id,
      type: 'model',
    };
  },
);
```
Keep `metadata` (raw catalog) only for `modelTimestamps(metadata?.release_date)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712 && bun test packages/server/src/server/list-models/`
Expected: PASS.

- [ ] **Step 5: Run the Codex-client list-models test (regression guard)**

Run: `cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712 && bun test packages/server/src/server/list-models/codex-client-models/`
Expected: PASS (or update expectations only if they asserted the old conflated `max_input_tokens`/raw-catalog capabilities — if so, correct them to the new, config-honoring values and note it in the commit).

- [ ] **Step 6: Commit**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712
git add packages/server/src/server/list-models/
git commit -m "fix(server): honor config metadata overrides in /v1/models projection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Bill cost.request when no token usage (P1-#2)

**Files:**
- Modify: `packages/server/src/usage-capture/usage-validation.ts`
- Modify: `packages/server/src/usage-capture/stream-capture.ts`
- Modify: `packages/server/src/usage-capture/passthrough-capture/passthrough-capture.ts`
- Create/Modify: `packages/server/src/usage-capture/usage-validation.test.ts`

**Interfaces:**
- Consumes: `finalizeUsage` input already has `usage`, `accounting`, `logger`, `requestedModelId`, `configPrice: OpenRouterModelPrice`. `configPrice.request?: number`.
- Produces: `finalizeUsage` input gains `providerId?: string` and `modelId?: string`. When `usage === undefined` and `configPrice?.request` is a positive number, `finalizeUsage` synthesizes `{ providerId, modelId }` and prices it (yielding a row with `estimatedCostUsd` = request fee, `priceSource: 'config'`).

- [ ] **Step 1: Write the failing test**

Create/extend `usage-validation.test.ts`:
```ts
import { expect, test } from 'bun:test';
import { finalizeUsage } from './usage-validation';

test('bills configured cost.request when the response carries no token usage', async () => {
  const row = await finalizeUsage({
    usage: undefined,
    accounting: { source: 'ai-sdk' },
    providerId: 'p1',
    modelId: 'm1',
    configPrice: { id: 'm1', request: 0.02 }, // USD 0.02 per request
  });
  expect(row).toBeDefined();
  expect(row?.providerId).toBe('p1');
  expect(row?.modelId).toBe('m1');
  expect(row?.estimatedCostUsd).toBe(0.02);
  expect(row?.priceSource).toBe('config');
});

test('does not synthesize a row when there is no usage and no request fee', async () => {
  const row = await finalizeUsage({
    usage: undefined,
    accounting: { source: 'ai-sdk' },
    providerId: 'p1',
    modelId: 'm1',
    configPrice: { id: 'm1', input: 2 }, // token price only, no request fee
  });
  expect(row).toBeUndefined();
});

test('does not synthesize a row when providerId/modelId are absent', async () => {
  const row = await finalizeUsage({
    usage: undefined,
    accounting: { source: 'ai-sdk' },
    configPrice: { id: 'm1', request: 0.02 },
  });
  expect(row).toBeUndefined();
});
```
(Callers only reach `finalizeUsage` on success — see stream-capture `complete()` and passthrough `complete()` early-returning on `obs.failed` — so no failure-path test is needed at this layer; the "no request fee" case guards against billing on ordinary empty-usage successes.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712 && bun test packages/server/src/usage-capture/usage-validation.test.ts`
Expected: FAIL — `finalizeUsage` returns `undefined` for undefined usage.

- [ ] **Step 3: Implement the synthesized-row path**

In `usage-validation.ts`, extend the input type and short-circuit before the existing early return:
```ts
export async function finalizeUsage(input: {
  readonly usage: UsageRow | undefined;
  readonly accounting: UsageAccounting;
  readonly logger?: ServerLogSink;
  readonly issues?: readonly UsageIssue[];
  readonly requestedModelId?: string;
  readonly configPrice?: OpenRouterModelPrice;
  readonly providerId?: string;
  readonly modelId?: string;
}): Promise<UsageRow | undefined> {
  const seed = seedForRequestFee(input);
  const normalized = validUsage(input.usage ?? seed, input.accounting, input.logger, input.issues);
  if (normalized === undefined) return undefined;
  const priced = await priceUsage(normalized, input.accounting, input.requestedModelId, input.configPrice);
  return validUsage(priced, input.accounting, input.logger, undefined, true);
}

// A successful response can carry a flat per-request fee (cost.request) with no
// token usage. Callers reach finalizeUsage only on success, so when there is no
// usage but a positive request fee is configured, seed a minimal row so the fee
// is billed instead of silently dropped.
function seedForRequestFee(input: {
  readonly usage: UsageRow | undefined;
  readonly configPrice?: OpenRouterModelPrice;
  readonly providerId?: string;
  readonly modelId?: string;
}): UsageRow | undefined {
  if (input.usage !== undefined) return undefined;
  const requestFee = input.configPrice?.request;
  if (requestFee === undefined || !(requestFee > 0)) return undefined;
  if (input.providerId === undefined || input.modelId === undefined) return undefined;
  return { providerId: input.providerId, modelId: input.modelId };
}
```
(`UsageRowSchema` must accept a row with only `providerId`/`modelId` — confirm by running the test; the existing passthrough path already constructs `{ ...obs.usage, providerId, modelId }` so the minimal shape is valid.)

- [ ] **Step 4: Thread providerId/modelId from the callers**

In `stream-capture.ts` `complete()`:
```ts
const usage = await finalizeUsage({
  usage: finishUsage,
  accounting: { source: 'ai-sdk' },
  providerId,
  modelId,
  ...(requestedModelId === undefined ? {} : { requestedModelId }),
  ...(configPrice === undefined ? {} : { configPrice }),
  ...(logger === undefined ? {} : { logger }),
});
```
In `passthrough-capture.ts` `finalizePassthroughUsage()`:
```ts
return finalizeUsage({
  usage:
    obs.usage === undefined && obs.issues === undefined
      ? undefined
      : { ...obs.usage, providerId: ctx.providerId, modelId: ctx.modelId },
  accounting: { source: 'passthrough', protocol: ctx.protocol },
  providerId: ctx.providerId,
  modelId: ctx.modelId,
  ...(ctx.requestedModelId === undefined ? {} : { requestedModelId: ctx.requestedModelId }),
  ...(ctx.configPrice === undefined ? {} : { configPrice: ctx.configPrice }),
  ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
  ...(obs.issues === undefined ? {} : { issues: obs.issues }),
});
```

- [ ] **Step 5: Run the usage-capture tests to verify they pass**

Run: `cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712 && bun test packages/server/src/usage-capture/`
Expected: PASS (new tests pass; existing capture tests still pass — empty-usage successes without a request fee still produce no row).

- [ ] **Step 6: Commit**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712
git add packages/server/src/usage-capture/
git commit -m "fix(server): bill flat cost.request fee when response has no token usage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Emit external models.dev $ref for `extend` in the config JSON Schema (maintainer)

**Files:**
- Modify: `packages/types/src/model-metadata/model-metadata.ts`
- Modify: `packages/types/rslib.config.ts`
- Create: `packages/types/src/config/config-schema-ref.test.ts`

**Interfaces:**
- Consumes: `z.toJSONSchema(schema, { io, override })`; the `override` callback receives `ctx.zodSchema` (original) and `ctx.jsonSchema` (mutable default output).
- Produces: the generated `config.schema.json` renders the `extend` field as `{ "$ref": "https://models.dev/model-schema.json#/$defs/Model" }`. Runtime validation is unchanged (`extend` stays a `z.string().min(1)`).

Background: models.dev's `Model` schema (`https://models.dev/model-schema.json#/$defs/Model`) is a `{ type: "string", enum: [...~6000 slugs...] }`. `$ref`-ing it lets config editors autocomplete/validate the slug. We inject the external `$ref` rather than inlining ~250KB of enum.

- [ ] **Step 1: Tag the `extend` field with a discriminable marker**

In `model-metadata.ts`, give `extend` a stable `.meta({ id })` so the override can identify its emitted node:
```ts
export const MODELS_DEV_MODEL_REF = 'https://models.dev/model-schema.json#/$defs/Model';

// ... inside ModelMetadataSchema:
    extend: ModelIdSchema.meta({ id: 'ModelsDevModelRef' })
      .optional()
      .describe('models.dev slug to inherit metadata from when names differ.'),
```
Confirm `.meta({ id })` is chainable before `.optional()` in this zod version; if `.optional()` drops the meta, apply `.meta()` to the outer optional or define a named `const ModelsDevSlugSchema = ModelIdSchema.meta({ id: 'ModelsDevModelRef' })` and use it. Export `MODELS_DEV_MODEL_REF` from the package index for the rslib config + test to import.

- [ ] **Step 2: Write the failing test**

Create `config-schema-ref.test.ts`:
```ts
import { expect, test } from 'bun:test';
import { z } from 'zod';

import { ConfigAuthoringSchema, MODELS_DEV_MODEL_REF } from '../index';
import { configSchemaOverride } from '../index'; // the override fn extracted for reuse (see Step 4)

test('extend renders as an external $ref to the models.dev Model schema', () => {
  const schema = JSON.stringify(z.toJSONSchema(ConfigAuthoringSchema, { io: 'input', override: configSchemaOverride }));
  // The emitted schema must reference the external models.dev slug enum for extend,
  // and must NOT inline the multi-thousand-entry enum.
  expect(schema).toContain(MODELS_DEV_MODEL_REF);
  expect(schema).not.toContain('302ai/'); // no inlined slug enum
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712 && bun test packages/types/src/config/config-schema-ref.test.ts`
Expected: FAIL — `configSchemaOverride`/`MODELS_DEV_MODEL_REF` not exported.

- [ ] **Step 4: Implement the override and share it with the build**

Add a small module `packages/types/src/config/config-json-schema.ts` (keeps the build config thin and lets the test import the same override):
```ts
import { z } from 'zod';

import { ConfigAuthoringSchema } from '../index';
import { MODELS_DEV_MODEL_REF } from '../model-metadata/model-metadata';

// The `extend` field is a models.dev slug. Emit an external $ref to models.dev's
// Model slug enum so config editors autocomplete/validate it, instead of inlining
// the ~6000-entry enum. Runtime validation stays a plain non-empty string.
export function configSchemaOverride(ctx: { readonly zodSchema: unknown; jsonSchema: Record<string, unknown> }): void {
  const meta = (ctx.zodSchema as { _zod?: { def?: { meta?: { id?: string } } } })._zod?.def?.meta;
  const id = (ctx.zodSchema as { meta?: () => { id?: string } | undefined }).meta?.()?.id ?? meta?.id;
  if (id === 'ModelsDevModelRef') {
    for (const key of Object.keys(ctx.jsonSchema)) delete ctx.jsonSchema[key];
    ctx.jsonSchema.$ref = MODELS_DEV_MODEL_REF;
  }
}

export function buildConfigJsonSchema(): unknown {
  return z.toJSONSchema(ConfigAuthoringSchema, { io: 'input', override: configSchemaOverride });
}
```
Adjust the meta-reading to whatever actually surfaces the `id` in this zod version (verify by logging `ctx.zodSchema` in the test once). Export `configSchemaOverride`, `buildConfigJsonSchema`, and `MODELS_DEV_MODEL_REF` from `packages/types/src/index.ts`.

Then simplify `rslib.config.ts` to use it:
```ts
import { buildConfigJsonSchema } from './src/config/config-json-schema.ts';
// ...
      const schema = buildConfigJsonSchema();
      compilation.emitAsset('config.schema.json', new sources.RawSource(JSON.stringify(schema, null, 2)));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712 && bun test packages/types/src/config/`
Expected: PASS. Also confirm the existing `config-acceptance.oauth-aisdk.test.ts` (which calls `z.toJSONSchema` without the override) still passes.

- [ ] **Step 6: Build types to confirm the emitted asset is valid**

Run: `cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712 && bunx turbo run build --filter=@aio-proxy/types`
Expected: build succeeds; the `override` runs during asset emission without throwing.

- [ ] **Step 7: Commit**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712
git add packages/types/src/model-metadata/model-metadata.ts packages/types/src/config/config-json-schema.ts packages/types/src/config/config-schema-ref.test.ts packages/types/rslib.config.ts packages/types/src/index.ts
git commit -m "feat(types): emit models.dev \$ref for metadata.extend in config schema

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Preflight, changeset, and PR reply

**Files:**
- Create: `.changeset/pr135-review-fixes.md`

- [ ] **Step 1: Run type-aware lint**

Run: `cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712 && bun run lint:types`
Expected: no NEW errors in touched files. The known monaco/`@monaco-editor/react` dashboard cascade is pre-existing noise — ignore only those, in untouched packages.

- [ ] **Step 2: Run format check**

Run: `cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712 && bun run format:check`
If it fails on touched files: `bun run format` then re-check, and amend into the relevant commit or add a `style:` follow-up.

- [ ] **Step 3: Run the touched packages' tests**

Run: `cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712 && bun test packages/server/src packages/types/src`
Expected: PASS. (Full `bun run preflight` also runs dashboard/i18n which fail on pre-existing env issues unrelated to this change; verify those failures are byte-identical to base if they appear.)

- [ ] **Step 4: Write the changeset**

Create `.changeset/pr135-review-fixes.md`:
```markdown
---
'aio-proxy': patch
'@aio-proxy/core': patch
'@aio-proxy/types': patch
'@aio-proxy/server': patch
---

Fix model-metadata projection and billing gaps:

- `/v1/models` now reflects per-provider config metadata overrides — capabilities,
  `limit.output` (max tokens), and modalities — not just the display name and
  context window. Metadata inherited via `extend` surfaces the same way.
- `max_input_tokens` now reports the model's maximum input tokens
  (`limit.input`) rather than the total context window, so a model with a larger
  context than input limit no longer over-advertises its input capacity.
- A flat per-request fee (`cost.request`) is now billed on a successful response
  that carries no token usage, instead of being silently dropped.
- The generated config JSON Schema references the models.dev model-id enum for
  `metadata.extend`, so editors can autocomplete and validate the slug.
```
Adjust the `@aio-proxy/server` package name to whatever the workspace uses (check `packages/server/package.json` `name`). If `core`/`types` were not actually modified by the final implementation, drop them — but `aio-proxy` MUST stay.

- [ ] **Step 5: Commit the changeset**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712
git add .changeset/pr135-review-fixes.md docs/superpowers/plans/2026-08-03-pr135-review-fixes.md
git commit -m "docs: changeset and plan for PR #135 review fixes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 6: Push and reply to PR #135**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/epic-kapitsa-8ee712
git push
```
Then post a PR comment addressing each item: the three Codex P1 findings (now fixed, with the note that they were pre-existing base-feature gaps surfaced by the metadata/`extend` follow-ups) and @baranwang's `extend` question — clarifying that models.dev's `Model` is a string enum of ~6000 slugs (not an object), so `extend` stays a slug string at runtime and now emits an external `$ref` to that enum in the generated schema for editor autocomplete/validation.

---

## Self-Review Notes

- **Spec coverage:** P1-#1 → Tasks 1–3; P1-#3 → Tasks 1 & 3; P1-#2 → Task 4; maintainer `extend` → Task 5; release/verification → Task 6. All four review items covered.
- **Type consistency:** `effectiveMetadata`/`maxInput` defined in Task 1 are consumed by name in Task 3; `toAnthropicCapabilitiesFromMetadata` defined in Task 2 consumed in Task 3; `finalizeUsage` new params in Task 4 match caller wiring; `MODELS_DEV_MODEL_REF`/`configSchemaOverride` defined and exported in Task 5, consumed by its test and the build.
- **Risk — zod meta identification (Task 5):** the exact way `ctx.zodSchema` exposes the `.meta({ id })` marker may differ; Step 4 says to verify by logging once and adjust the accessor. If `.meta()` on an optional string proves unreliable, fall back to matching on the emitted `description` string (the extend description is unique) — but prefer the meta id.
- **Risk — Codex-client models test (Task 3 Step 5):** may assert the old conflated values; correcting them is in-scope and expected.

---

## Follow-up: Codex Re-Review Findings A/B/C (BASE b1673e7c)

Adjudicated 7 Codex findings (A–G). A/B/C are real, in-scope regressions or gaps
introduced/surfaced by this PR's own fixes; D/G not real; E/F real but pre-existing
and out of scope (call out as separate issues in the PR reply).

### Task 7 — Finding A (P1): bill cost.request on body-less passthrough success

`packages/server/src/usage-capture/passthrough-capture/passthrough-capture.ts`
`nonStreamingCompletion` short-circuits a body-null 2xx to
`{ outcome: 'success', statusCode }` WITHOUT going through `finalizeUsage`, so the
Task-4 `seedForRequestFee` path never runs and a configured flat `cost.request` fee
is dropped for no-body successes (e.g. 204). Route the body-null success through the
same finalize path so a positive `configPrice.request` is still billed with
providerId/modelId. Keep the file at/under the 300-line ceiling (currently ~257) —
split a private collaborator if needed rather than growing it. Colocated test must
assert: body-null 2xx WITH positive request fee → captured usage carries the fee;
body-null 2xx WITHOUT request fee → still bare success (no phantom usage).

### Task 8 — Finding B (P1): thread effectiveMetadata into codex client models

`packages/server/src/server/list-models/codex-client-models/codex-client-models.ts`
passes raw `model.metadata` (ModelsDevModel, snake_case) to `assembleCodexModel`,
ignoring config overrides merged into `model.effectiveMetadata` (ModelMetadata,
camelCase). Description / modalities / reasoning options therefore ignore config
metadata overrides in the codex client model list. Feed the merged metadata:
either adapt `assembleCodexModel` to read `ModelMetadata` (camelCase:
`description`, `capabilities.modalities.input`, `capabilities.reasoningOptions`)
with raw catalog as fallback, or derive those fields from `effectiveMetadata` in
codex-client-models before calling assemble. `contextWindow` is already threaded
correctly — do not regress it. Colocated test: a config `description`/reasoning
override is reflected in the assembled codex model.

### Task 9 — Finding C (P2 regression): null capabilities when no signals

`packages/server/src/server/model-capabilities/model-capabilities.ts`
`toAnthropicCapabilitiesFromMetadata` returns a FULL all-`{supported:false}` object
even when `meta.capabilities` is undefined (no capabilities/modalities/
reasoningOptions signals). The /v1/models projection should surface `null` in that
case (as it did before this PR) rather than fabricating an all-false capability
block. Fix in model-capabilities (return undefined/null when there is no capability
signal) and/or its caller in `list-models.ts`. Colocated test: metadata with no
capability signal → capabilities === null; metadata WITH a signal → populated block.

Verification for all three: `turbo run test:unit --filter=@aio-proxy/server`
(NOT `bun test <path>` — that bypasses the preload/env and gives false results).
