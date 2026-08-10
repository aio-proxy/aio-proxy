# Model Metadata Source Precedence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Provider model-metadata provenance so user configuration overrides relevant upstream metadata, upstream metadata overrides models.dev fallback, and every protocol projects `limit.context`, `limit.input`, and `limit.output` with the correct semantics.

**Architecture:** Replace the ambiguous runtime `metadata` field with the two source-bearing fields `configMetadata` and `upstreamMetadata`; `metadata.extend` remains fully materialized in `configMetadata`. `resolveEnabledModels()` groups public routes and retains each candidate's two sources plus the public-slug models.dev fallback, while small field resolvers perform per-candidate precedence and existing `min`/`max` aggregation on demand. Standard and Codex model-list code project those semantic values last; no merged metadata object or cache is stored.

**Tech Stack:** Bun 1.3, TypeScript 7, Zod 4, es-toolkit, Turborepo, `bun:test`.

## Global Constraints

- Source priority is **user config > relevant upstream metadata > models.dev fallback > protocol default**.
- Resolve priority per field; only `undefined` falls through, so explicit `false`, `[]`, and other schema-valid values win.
- A materialized `metadata.extend` result is user config and may raise an official value.
- Resolve each Provider candidate before applying `router.modelContextAggregation`; aggregate `limit.context`, `limit.input`, and `limit.output` independently.
- Lookup models.dev fallback by public slug only; never inherit from a route's upstream `modelId` unless the user explicitly uses `metadata.extend`.
- Standard `/v1/models` projects `max_input_tokens = limit.input` and `max_tokens = limit.output`.
- Codex synthesis projects `context_window = limit.input ?? limit.context` and `max_context_window = limit.context ?? limit.input`.
- A matching official Codex row outranks provider-generic upstream metadata and models.dev when the user did not configure the projected field.
- Keep official Codex instructions, service tiers, promo fields, cache behavior, and routing behavior unchanged.
- User limit values are positive integers; when both sides are configured, require `input <= context` and `output <= context`. Do not clamp invalid user config.
- External metadata is fail-soft: ignore invalid token-limit values or rows, preserve stale-cache behavior, and never make model discovery return 500 solely because a catalog is unavailable.
- Every emitted Codex row must satisfy `context_window <= max_context_window`.
- Do not add a resolved/merged metadata cache, Codex-specific config keys, named-model exceptions, dependencies, or new pricing-source machinery.
- Keep Responses stream-error work isolated in PR #170; this plan only implements issue #169.
- Use `rtk` for every shell command, `apply_patch` for edits, and leave the untracked `.aio-proxy-dev` directory untouched.
- Every commit must include `Co-authored-by: Codex <noreply@openai.com>`.

---

## File Map

- `packages/types/src/model-metadata/model-metadata.ts`: enforce valid configured limit pairs.
- `packages/types/src/provider.ts`: expose the existing `metadata` authoring shape on OAuth runtime, authoring, and mutation schemas.
- `packages/types/src/model-metadata/model-metadata.test.ts`, `packages/types/src/plugin.test.ts`, `packages/types/src/provider-oauth-mutation.test.ts`, `packages/types/src/config/config.test.ts`: protect validation and OAuth config behavior.
- `packages/server/src/dashboard-routes/provider-mutation/provider-mutation.ts`: retain authored metadata when an older dashboard request omits it.
- `packages/server/src/runtime.ts`: replace ambiguous runtime `metadata` with `configMetadata` and `upstreamMetadata`.
- `packages/server/src/provider-runtime/materialize.ts`: put API/AI SDK config metadata in `configMetadata`.
- `packages/server/src/plugin-runtime/capabilities.ts`: keep OAuth config and catalog metadata separate, including on cached runtime reuse.
- `packages/server/src/routes/pipeline/attempt-base.ts`: read prices only from `configMetadata`.
- `packages/server/src/server-state/resolve-extend/extend-e2e.test.ts`: prove materialized `extend` remains in the config layer and still reaches pricing.
- `packages/server/src/server/model-resolution/model-resolution.ts`: retain per-candidate sources and provide per-field resolution/aggregation without a stored effective object.
- `packages/server/src/server/model-resolution/index.ts`: export the source-aware result types and on-demand resolvers to both protocol projections.
- `packages/server/src/server/list-models/list-models.ts`: project resolved generic fields to the standard model-list response.
- `packages/server/src/server/list-models/codex-client-models/codex-client-models.ts`: insert official Codex metadata at the correct priority and aggregate valid candidate window pairs.
- `packages/server/src/server/list-models/codex-client-models/codex-assembly.ts`: accept distinct default and maximum windows and share metadata-to-Codex projection logic.
- `npm/aio-proxy/README.md`: document all-Provider metadata support, precedence, and distinct limit meanings (`README.md` is its symlink).
- `.changeset/*.md`: publish the user-visible schema and model-list correction.

## Task 1: Validate Limit Pairs and Accept OAuth Metadata

**Files:**
- Modify: `packages/types/src/model-metadata/model-metadata.ts` (`ModelLimitSchema`)
- Modify: `packages/types/src/provider.ts` (`OAuthPluginProviderSchema`, `OAuthProviderMutationBodySchema`)
- Test: `packages/types/src/model-metadata/model-metadata.test.ts`
- Test: `packages/types/src/plugin.test.ts`
- Test: `packages/types/src/provider-oauth-mutation.test.ts`
- Test: `packages/types/src/config/config.test.ts`
- Modify: `packages/server/src/dashboard-routes/provider-mutation/provider-mutation.ts` (`replaceProvider`)
- Test: `packages/server/src/dashboard-routes/provider-mutation/provider-mutation.test.ts`

**Interfaces:**
- Consumes: existing `ModelMetadataSchema` and `metadataField`.
- Produces: `OAuthProvider.metadata?: Readonly<Record<ModelId, ModelMetadata>>`, the same field on OAuth authoring/mutation types, and pair diagnostics at `limit.input` / `limit.output`.
- Preserves: an existing authored `metadata` map when a mutation omits it; an explicit `{ metadata: {} }` still clears it.

- [ ] **Step 1: Add failing configured-limit validation tests**

Add these cases to `model-metadata.test.ts`:

```ts
test.each([
  [{ context: 272_000, input: 400_000 }, 'input'],
  [{ context: 272_000, output: 400_000 }, 'output'],
] as const)('rejects limit.%s above limit.context', (limit, field) => {
  const result = ModelMetadataSchema.safeParse({ limit });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toContainEqual(['limit', field]);
});

test('accepts distinct input and output limits within the total context', () => {
  expect(
    ModelMetadataSchema.parse({ limit: { context: 400_000, input: 272_000, output: 128_000 } }).limit,
  ).toEqual({ context: 400_000, input: 272_000, output: 128_000 });
});
```

- [ ] **Step 2: Run the validation tests and confirm the regression is exposed**

Run:

```bash
rtk bun test packages/types/src/model-metadata/model-metadata.test.ts
```

Expected: the two invalid pairs are accepted, so the parameterized test fails.

- [ ] **Step 3: Enforce the two pair invariants at the config trust boundary**

Change `ModelLimitSchema` to retain `.loose()` while adding issues on the offending child field:

```ts
export const ModelLimitSchema = z
  .object({
    context: z.number().int().positive().optional().describe('Total context window in tokens exposed to clients.'),
    input: z.number().int().positive().optional().describe('Maximum input tokens.'),
    output: z.number().int().positive().optional().describe('Maximum output tokens.'),
  })
  .loose()
  .superRefine((limit, context) => {
    if (limit.context !== undefined && limit.input !== undefined && limit.input > limit.context) {
      context.addIssue({ code: 'custom', path: ['input'], message: 'Input limit must not exceed context limit' });
    }
    if (limit.context !== undefined && limit.output !== undefined && limit.output > limit.context) {
      context.addIssue({ code: 'custom', path: ['output'], message: 'Output limit must not exceed context limit' });
    }
  });
```

Do not add a relationship between `input` and `output`; both are independently bounded by total context.

- [ ] **Step 4: Add failing OAuth schema and degraded-config tests**

Extend the OAuth schema test with a real `metadata.extend` entry:

```ts
test('accepts metadata and extend on an OAuth Provider', () => {
  const provider = OAuthPluginProviderSchema.parse({
    id: 'person',
    kind: 'oauth',
    plugin: '@example/oauth',
    capability: 'default',
    metadata: {
      model: { extend: 'openai/gpt-5.6-sol', limit: { context: 400_000, input: 272_000 } },
    },
  });

  expect(provider.metadata?.model).toEqual({
    extend: 'openai/gpt-5.6-sol',
    limit: { context: 400_000, input: 272_000 },
  });
});
```

Update `provider-oauth-mutation.test.ts` so the valid body includes:

```ts
metadata: { model: { limit: { context: 400_000, input: 272_000, output: 128_000 } } },
```

Add a `ConfigSchema` behavior test proving an invalid pair degrades only that Provider:

```ts
test('marks an OAuth Provider invalid when an input limit exceeds context', () => {
  const config = ConfigSchema.parse({
    providers: {
      bad: {
        kind: 'oauth',
        plugin: '@example/oauth',
        capability: 'default',
        metadata: { model: { limit: { context: 272_000, input: 400_000 } } },
      },
    },
  });

  expect(config.providers).toEqual([]);
  expect(config.invalidProviders[0]?.issuePaths).toContainEqual(['metadata', 'model', 'limit', 'input']);
});
```

- [ ] **Step 5: Run the OAuth/type tests and confirm metadata is currently stripped or rejected**

Run:

```bash
rtk bun test packages/types/src/plugin.test.ts packages/types/src/provider-oauth-mutation.test.ts packages/types/src/config/config.test.ts
```

Expected: OAuth metadata assertions fail before the schema change.

- [ ] **Step 6: Reuse `metadataField` in every OAuth config entry point**

Make the two schema additions; authoring types inherit the first automatically:

```ts
export const OAuthPluginProviderSchema = z.object({
  kind: z.literal(ProviderKind.OAuth),
  ...SharedProviderSchemaBase,
  ...metadataField,
  plugin: PluginPackageNameSchema,
  capability: CapabilityIdSchema,
  options: z.record(z.string(), z.unknown()).optional(),
});

export const OAuthProviderMutationBodySchema = z.strictObject({
  kind: z.literal(ProviderKind.OAuth),
  id: z.string().min(1),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  weight: z.number().optional(),
  ...metadataField,
  alias: z.record(z.string().min(1), AliasConfigSchema).optional(),
  transforms: ProviderTransformsSchema.optional(),
});
```

- [ ] **Step 7: Protect manually-authored metadata from older dashboard updates**

First add this failing shared-writer test:

```ts
test('preserves existing metadata when an older client omits it and clears it when explicitly empty', () => {
  const previous = { openai: { kind: 'api', metadata: { model: { limit: { context: 400_000 } } } } };

  expect(replaceProvider(previous, 'openai', { kind: 'api' })['openai']).toMatchObject({
    metadata: { model: { limit: { context: 400_000 } } },
  });
  expect(replaceProvider(previous, 'openai', { kind: 'api', metadata: {} })['openai']).toMatchObject({ metadata: {} });
});
```

Then add `'metadata'` to the existing omission-preservation loop:

```ts
for (const key of ['headers', 'metadata', 'proxy', 'transforms'] as const) {
  if (provider[key] === undefined && previous[key] !== undefined) next[key] = previous[key];
}
```

- [ ] **Step 8: Run all Task 1 tests**

Run:

```bash
rtk bun test packages/types/src/model-metadata/model-metadata.test.ts packages/types/src/plugin.test.ts packages/types/src/provider-oauth-mutation.test.ts packages/types/src/config/config.test.ts
rtk bun test --preload=./packages/server/__tests__/setup.ts packages/server/src/dashboard-routes/provider-mutation/provider-mutation.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit the config contract**

```bash
rtk git add packages/types/src/model-metadata/model-metadata.ts packages/types/src/model-metadata/model-metadata.test.ts packages/types/src/provider.ts packages/types/src/plugin.test.ts packages/types/src/provider-oauth-mutation.test.ts packages/types/src/config/config.test.ts packages/server/src/dashboard-routes/provider-mutation/provider-mutation.ts packages/server/src/dashboard-routes/provider-mutation/provider-mutation.test.ts
rtk git commit -m "feat(models): accept validated OAuth metadata" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 2: Separate Runtime Config and Upstream Metadata

**Files:**
- Modify: `packages/server/src/runtime.ts` (`RuntimeProviderBase`)
- Modify: `packages/server/src/provider-runtime/materialize.ts` (`materializeRuntimeProvider`)
- Test: `packages/server/src/provider-runtime/materialize.test.ts`
- Modify: `packages/server/src/plugin-runtime/capabilities.ts` (`createRuntimeProvider`, `withRoutingConfig`)
- Test: `packages/server/src/plugin-runtime/capabilities.test.ts`
- Test: `packages/server/src/plugin-runtime/materialize.test.ts`
- Modify: `packages/server/src/routes/pipeline/attempt-base.ts` (`candidateConfigPrice`)
- Test: `packages/server/src/server-state/resolve-extend/resolve-extend.test.ts`
- Test: `packages/server/src/server-state/resolve-extend/extend-e2e.test.ts`

**Interfaces:**
- Produces on `RuntimeProviderInstance`:

```ts
readonly configMetadata?: Readonly<Record<ModelId, ModelMetadata>>;
readonly upstreamMetadata?: Readonly<Record<ModelId, RuntimeModelMetadata>>;
```

- `configMetadata` contains parsed Provider config, including fully materialized `extend` entries.
- `upstreamMetadata` contains provider-discovered metadata; today OAuth catalogs normalize display name and protocol only.
- `candidateConfigPrice(provider, modelId)` reads `configMetadata` only. models.dev remains the existing fallback price source.

- [ ] **Step 1: Write failing API/AI SDK materialization assertions**

Extend `provider-runtime/materialize.test.ts` with configured metadata and assert its source:

```ts
test('materializes API metadata into the config layer only', () => {
  const config = ConfigSchema.parse({
    providers: {
      api: {
        kind: 'api',
        protocol: 'openai-compatible',
        baseURL: 'https://api.example.com',
        models: ['model'],
        metadata: { model: { name: 'Configured', cost: { input: 2 } } },
      },
    },
  });

  const provider = materializeProviders(config).providers[0];
  expect(provider?.configMetadata?.model).toMatchObject({ name: 'Configured', cost: { input: 2 } });
  expect(provider?.upstreamMetadata).toBeUndefined();
});
```

- [ ] **Step 2: Write a failing OAuth provenance test**

Use the existing plugin fixture with catalog display name/protocol and config metadata:

```ts
expect(result.provider?.configMetadata?.model).toEqual({
  name: 'Configured Name',
  limit: { context: 400_000, input: 272_000 },
});
expect(result.provider?.upstreamMetadata?.model).toEqual({
  name: 'Catalog Name',
  protocol: ProviderProtocol.Anthropic,
});
expect(result.provider?.model?.targetProtocol?.('model')).toBe(ProviderProtocol.Anthropic);
```

Also extend the cached-runtime reuse test in `plugin-runtime/materialize.test.ts`: change config metadata between disable/re-enable operations and assert the reused runtime exposes the new `configMetadata` without another `createRuntime` call.

- [ ] **Step 3: Run the provenance tests and confirm the old shared field fails them**

Run:

```bash
rtk bun test --preload=./packages/server/__tests__/setup.ts packages/server/src/provider-runtime/materialize.test.ts packages/server/src/plugin-runtime/capabilities.test.ts packages/server/src/plugin-runtime/materialize.test.ts
```

Expected: `configMetadata` / `upstreamMetadata` assertions fail because only `metadata` exists.

- [ ] **Step 4: Replace the ambiguous runtime field**

In `runtime.ts`, use the existing types rather than adding a source abstraction:

```ts
type RuntimeProviderBase = {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly enabled: boolean;
  readonly models?: readonly ModelId[];
  readonly alias?: Readonly<Record<string, AliasConfig>>;
  readonly configMetadata?: Readonly<Record<ModelId, ModelMetadata>>;
  readonly upstreamMetadata?: Readonly<Record<ModelId, RuntimeModelMetadata>>;
  // existing plugin/capability/transport fields stay unchanged
};
```

Remove `RuntimeProviderBase.metadata`; do not keep a compatibility alias because that would retain the provenance ambiguity.

In both API and AI SDK branches of `materializeRuntimeProvider`, translate the legacy factory instance field into the config source:

```ts
...(provider.metadata === undefined ? {} : { configMetadata: provider.metadata }),
```

- [ ] **Step 5: Materialize both OAuth sources and refresh only routing config**

In `createRuntimeProvider`:

```ts
const upstreamMetadata = modelMetadataRecord(catalog);
return {
  // identity, models, routing fields unchanged
  ...(config.metadata === undefined ? {} : { configMetadata: config.metadata }),
  upstreamMetadata,
  // capabilities unchanged
  model: {
    invoke: createProviderV4Invoke(config.id, result.provider),
    supportsProviderTool: (type) => supportedProviderTools.has(type),
    targetProtocol: (modelId) => upstreamMetadata[modelId]?.protocol,
  },
};
```

Make cached runtime reuse replace stale config metadata while retaining its catalog layer:

```ts
export function withRoutingConfig(provider: RuntimeProviderInstance, config: OAuthProvider): RuntimeProviderInstance {
  const { alias: _previousAlias, configMetadata: _previousConfigMetadata, ...previousProvider } = provider;
  return {
    ...previousProvider,
    enabled: config.enabled,
    ...(config.alias === undefined ? {} : { alias: config.alias }),
    ...(config.metadata === undefined ? {} : { configMetadata: config.metadata }),
  };
}
```

Do not copy opaque plugin catalog metadata into config pricing. `modelMetadataRecord()` keeps its existing display-name/protocol normalization.

- [ ] **Step 6: Move pricing and extend assertions to the config source**

Change the pricing lookup once at the shared attempt boundary:

```ts
export function candidateConfigPrice(
  provider: RuntimeProviderInstance,
  modelId: string,
): OpenRouterModelPrice | undefined {
  const cost = provider.configMetadata?.[modelId]?.cost;
  return cost === undefined ? undefined : configModelPrice(modelId, cost);
}
```

In `extend-e2e.test.ts`, replace `provider.metadata?.[modelId]` with `provider.configMetadata?.[modelId]`. Keep the existing price assertion: inherited `cost.output` must still reach `candidateConfigPrice`, proving `extend` is an explicit config-layer decision.

Add an OAuth `applyMetadataExtend` test so the newly accepted schema follows the same materialization path as API/AI SDK config:

```ts
test('materializes metadata.extend for an OAuth Provider', async () => {
  const config = ConfigSchema.parse({
    providers: {
      person: {
        kind: 'oauth',
        plugin: '@example/oauth',
        capability: 'default',
        metadata: { model: { extend: 'openai/gpt-5.5', name: 'Configured OAuth Name' } },
      },
    },
  });
  const resolved = await applyMetadataExtend(config, undefined, {
    getModels: stubGetModels({ 'openai/gpt-5.5': catalogModel() }),
  });
  const provider = resolved.providers[0];
  if (provider?.kind !== ProviderKind.OAuth) throw new Error('expected OAuth Provider');

  expect(provider.metadata?.model).toMatchObject({
    name: 'Configured OAuth Name',
    limit: { context: 400_000, input: 300_000, output: 128_000 },
  });
  expect(provider.metadata?.model.extend).toBeUndefined();
});
```

- [ ] **Step 7: Run Task 2 tests and check source naming**

Run:

```bash
rtk bun test --preload=./packages/server/__tests__/setup.ts packages/server/src/provider-runtime/materialize.test.ts packages/server/src/plugin-runtime/capabilities.test.ts packages/server/src/plugin-runtime/materialize.test.ts packages/server/src/server-state/resolve-extend/resolve-extend.test.ts packages/server/src/server-state/resolve-extend/extend-e2e.test.ts
rtk rg -n "provider\.metadata" packages/server/src/runtime.ts packages/server/src/provider-runtime packages/server/src/plugin-runtime packages/server/src/routes/pipeline/attempt-base.ts packages/server/src/server-state/resolve-extend
```

Expected: tests PASS; the search has no runtime consumer of `provider.metadata` (comments and legacy factory reads in `provider-runtime/materialize.ts` are acceptable).

- [ ] **Step 8: Commit runtime provenance**

```bash
rtk git add packages/server/src/runtime.ts packages/server/src/provider-runtime/materialize.ts packages/server/src/provider-runtime/materialize.test.ts packages/server/src/plugin-runtime/capabilities.ts packages/server/src/plugin-runtime/capabilities.test.ts packages/server/src/plugin-runtime/materialize.test.ts packages/server/src/routes/pipeline/attempt-base.ts packages/server/src/server-state/resolve-extend/resolve-extend.test.ts packages/server/src/server-state/resolve-extend/extend-e2e.test.ts
rtk git commit -m "refactor(server): preserve model metadata sources" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 3: Resolve Generic Fields Per Candidate and Project Standard Models

**Files:**
- Modify: `packages/server/src/server/model-resolution/model-resolution.ts`
- Modify: `packages/server/src/server/model-resolution/index.ts`
- Test: `packages/server/src/server/model-resolution/model-resolution.test.ts`
- Modify: `packages/server/src/server/list-models/list-models.ts`
- Test: `packages/server/src/server/list-models/list-models.test.ts`

**Interfaces:**
- Produces:

```ts
export type ResolvedModelCandidate = {
  readonly modelId: string;
  readonly provider: RuntimeProviderInstance;
  readonly configMetadata: ModelMetadata | undefined;
  readonly upstreamMetadata: RuntimeModelMetadata | undefined;
};

export type ResolvedModel = {
  readonly slug: string;
  readonly modelId: string;
  readonly provider: RuntimeProviderInstance;
  readonly candidates: readonly ResolvedModelCandidate[];
  readonly fallbackMetadata: ModelMetadata | undefined;
  readonly aggregation: (typeof ModelContextAggregation)[keyof typeof ModelContextAggregation];
};

export function resolveModelField<T>(
  model: ResolvedModel,
  select: (metadata: ModelMetadata) => T | undefined,
): T | undefined;

export function resolveModelCapabilities(model: ResolvedModel): ModelCapabilities | undefined;

export function resolveAggregatedLimit(
  model: ResolvedModel,
  field: keyof ModelLimit,
): number | undefined;
```

- Removes: `ResolvedModel.metadata`, `displayName`, `contextWindow`, `effectiveMetadata`, and `maxInput`.
- The retained `modelId` / `provider` are the first candidate's public identity; `candidates` carries the source data needed by protocol-specific projection.

- [ ] **Step 1: Rewrite fixtures to name their sources and add failing precedence tests**

Replace runtime test fixture `metadata` fields with `configMetadata` or `upstreamMetadata`. Keep the alias-isolation test and assert the fallback remains absent when only the upstream routing target exists in models.dev.

Add one behavior test that covers field precedence and all three limits:

```ts
test('resolves config over upstream over public-slug fallback for each limit field', async () => {
  await seedCatalog({
    shared: modelsDevModel('shared', 'Fallback', {
      limit: { context: 1_050_000, input: 922_000, output: 128_000 },
    }),
  });
  const provider = {
    id: 'p1',
    kind: ProviderKind.Api,
    enabled: true,
    alias: { shared: { model: 'upstream', preserve: false } },
    configMetadata: { upstream: { name: 'Configured', limit: { input: 272_000 } } },
    upstreamMetadata: { upstream: { name: 'Catalog', limit: { context: 400_000, output: 64_000 } } },
    model: { invoke: async function* () {} },
  } as unknown as RuntimeProviderInstance;

  const model = (await resolveEnabledModels(fakeState([provider])))[0]!;
  expect(resolveModelField(model, (metadata) => metadata.name)).toBe('Configured');
  expect(resolveAggregatedLimit(model, 'context')).toBe(400_000);
  expect(resolveAggregatedLimit(model, 'input')).toBe(272_000);
  expect(resolveAggregatedLimit(model, 'output')).toBe(64_000);
});
```

Add a two-Provider test for both aggregation modes. Candidate A uses `{ context: 400_000, input: 272_000, output: 128_000 }`; candidate B uses `{ context: 300_000, input: 250_000, output: 64_000 }`. Assert min returns `300_000 / 250_000 / 64_000`, max returns `400_000 / 272_000 / 128_000`.

Add a capabilities test where fallback says `structuredOutput: true` and supplies reasoning options, while config says `structuredOutput: false` and `modalities.input: []`. Assert `false` and the empty array survive source resolution.

- [ ] **Step 2: Run model-resolution tests and confirm the current eager merge fails**

Run:

```bash
rtk bun test --preload=./packages/server/__tests__/setup.ts packages/server/src/server/model-resolution/model-resolution.test.ts
```

Expected: source-bearing result fields and independent output aggregation are absent.

- [ ] **Step 3: Make `resolveEnabledModels()` retain sources instead of effective values**

Keep the existing route grouping and one batched `getModels(slugs)` call. Convert each public-slug fallback once with `catalogModelToMetadata()` and construct candidates as follows:

```ts
const candidate: ResolvedModelCandidate = {
  modelId: route.modelId,
  provider,
  configMetadata: provider.configMetadata?.[route.modelId],
  upstreamMetadata: provider.upstreamMetadata?.[route.modelId],
};
```

Return the first candidate as `modelId` / `provider`, the full ordered candidates, converted public-slug fallback, and the snapshot aggregation mode. Do not merge metadata or query models.dev using `modelId`.

Update the export-only `index.ts` with the exact public surface used by the two list-model protocols:

```ts
export {
  type ResolvedModel,
  type ResolvedModelCandidate,
  resolveAggregatedLimit,
  resolveEnabledModels,
  resolveModelCapabilities,
  resolveModelField,
} from './model-resolution';
```

- [ ] **Step 4: Implement the three narrow on-demand resolvers**

Use nullish selection for scalar/array fields so explicit falsey values win:

```ts
export function resolveModelField<T>(
  model: ResolvedModel,
  select: (metadata: ModelMetadata) => T | undefined,
): T | undefined {
  const primary = model.candidates[0]!;
  const read = (metadata: ModelMetadata | undefined) =>
    metadata === undefined ? undefined : select(metadata);
  return read(primary.configMetadata) ?? read(primary.upstreamMetadata) ?? read(model.fallbackMetadata);
}
```

For capabilities, merge only the `capabilities` object in fallback → upstream → config order, using the existing `mergeWith` array customizer so arrays replace wholesale. Return `undefined` when all three capability objects are absent; do not build a full `effectiveMetadata` object:

```ts
export function resolveModelCapabilities(model: ResolvedModel): ModelCapabilities | undefined {
  const primary = model.candidates[0]!;
  const sources = [
    model.fallbackMetadata?.capabilities,
    primary.upstreamMetadata?.capabilities,
    primary.configMetadata?.capabilities,
  ].filter((value): value is ModelCapabilities => value !== undefined);
  if (sources.length === 0) return undefined;

  let resolved: ModelCapabilities = {};
  for (const source of sources) {
    resolved = mergeWith(resolved, source, (_target, sourceValue) =>
      Array.isArray(sourceValue) ? sourceValue : undefined,
    );
  }
  return resolved;
}
```

For a limit field, resolve every candidate independently, then apply the configured aggregate to present values only:

```ts
export function resolveAggregatedLimit(model: ResolvedModel, field: keyof ModelLimit): number | undefined {
  const values = model.candidates.flatMap((candidate) => {
    const value =
      candidate.configMetadata?.limit?.[field] ??
      candidate.upstreamMetadata?.limit?.[field] ??
      model.fallbackMetadata?.limit?.[field];
    return value === undefined ? [] : [value];
  });
  if (values.length === 0) return undefined;
  return model.aggregation === ModelContextAggregation.Max ? Math.max(...values) : Math.min(...values);
}
```

- [ ] **Step 5: Add a failing standard `/v1/models` composite projection test**

Use config `{ context: 400_000, input: 272_000, output: 128_000 }` over a different models.dev fallback and assert:

```ts
expect(item.max_input_tokens).toBe(272_000);
expect(item.max_tokens).toBe(128_000);
expect(item.display_name).toBe('Configured Name');
```

Add a two-candidate assertion that `max_tokens` follows the same min/max aggregation setting as the other limit fields.

- [ ] **Step 6: Project only fields emitted by `listModels()`**

Map each `ResolvedModel` with the new helpers:

```ts
const capabilities = resolveModelCapabilities(model);
const displayName = resolveModelField(model, (metadata) => metadata.name) ?? model.slug;
const releaseDate = resolveModelField(model, (metadata) => metadata.capabilities?.releaseDate);

return {
  capabilities:
    capabilities === undefined ? null : toAnthropicCapabilitiesFromMetadata({ capabilities }),
  ...modelTimestamps(releaseDate),
  display_name: displayName,
  id: model.slug,
  max_input_tokens: resolveAggregatedLimit(model, 'input') ?? null,
  max_tokens: resolveAggregatedLimit(model, 'output') ?? null,
  object: 'model',
  owned_by: model.provider.id,
  type: 'model',
};
```

Keep the current deterministic unknown timestamps. Do not emit `limit.context` as `max_input_tokens`.

- [ ] **Step 7: Run Task 3 tests**

Run:

```bash
rtk bun test --preload=./packages/server/__tests__/setup.ts packages/server/src/server/model-resolution/model-resolution.test.ts packages/server/src/server/list-models/list-models.test.ts packages/server/src/server/model-capabilities/model-capabilities.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit source-aware generic resolution**

```bash
rtk git add packages/server/src/server/model-resolution/model-resolution.ts packages/server/src/server/model-resolution/model-resolution.test.ts packages/server/src/server/model-resolution/index.ts packages/server/src/server/list-models/list-models.ts packages/server/src/server/list-models/list-models.test.ts
rtk git commit -m "fix(models): resolve metadata per provider candidate" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 4: Apply Official Codex Priority and Distinct Window Projection

**Files:**
- Modify: `packages/server/src/server/list-models/codex-client-models/codex-client-models.ts`
- Test: `packages/server/src/server/list-models/codex-client-models/codex-client-models.test.ts`
- Modify: `packages/server/src/server/list-models/codex-client-models/codex-assembly.ts`
- Test: `packages/server/src/server/list-models/codex-client-models/codex-assembly.test.ts`
- Verify unchanged: `packages/server/src/server/list-models/codex-client-models/codex-cache.ts`
- Test: `packages/server/src/server/list-models/codex-client-models/codex-cache.test.ts`

**Interfaces:**
- Produces internal `CodexWindows`:

```ts
type CodexWindows = {
  readonly contextWindow: number;
  readonly maxContextWindow: number;
};
```

- Changes `assembleCodexModel()` to consume distinct required `contextWindow` and `maxContextWindow` values; it no longer reads token limits from a merged metadata object.
- Keeps config `name`, `description`, input modalities, and reasoning options able to override mapped official fields while unrelated Codex-only fields stay verbatim.

- [ ] **Step 1: Replace the bug with focused failing regressions**

Add these `codex-client-models.test.ts` cases using `configMetadata` fixtures:

1. Official row `{ context_window: 272_000, max_context_window: 272_000 }` plus models.dev `{ context: 1_050_000, input: 922_000, output: 128_000 }`, with no configured limit, emits `272_000 / 272_000`.
2. Config `{ context: 1_050_000, input: 922_000, output: 128_000 }` over the same official row emits `922_000 / 1_050_000`.
3. Config `{ context: 400_000, input: 272_000, output: 128_000 }` emits `272_000 / 400_000` in both matching-row Case A and synthesized Case B.
4. Config `name`, `description`, `modalities.input`, and `reasoningOptions` override their mapped Case A fields while `availability_nux`, instructions, and service tiers remain from the official row.
5. An official row with non-positive/non-integer windows or `context_window > max_context_window` is ignored for window selection; fallback/default produces a valid pair and the endpoint resolves normally.
6. An empty models.dev map does not change a valid official pair and does not make the endpoint fail.

The central regression expectation is:

```ts
const official = models.find((entry) => entry.id === 'gpt-5') as Record<string, unknown>;
expect(official.context_window).toBe(272_000);
expect(official.max_context_window).toBe(272_000);
```

- [ ] **Step 2: Add failing assembly tests for separate window fields**

Change assembly calls to pass both fields and add:

```ts
test('writes distinct default and maximum Codex windows', () => {
  const entry = assembleCodexModel({
    slug: 'm',
    displayName: 'M',
    metadata: undefined,
    contextWindow: 272_000,
    maxContextWindow: 400_000,
    template: undefined,
  });
  expect(entry.context_window).toBe(272_000);
  expect(entry.max_context_window).toBe(400_000);
});
```

- [ ] **Step 3: Run Codex tests and confirm fallback currently overwrites official values**

Run:

```bash
rtk bun test --preload=./packages/server/__tests__/setup.ts packages/server/src/server/list-models/codex-client-models/codex-client-models.test.ts packages/server/src/server/list-models/codex-client-models/codex-assembly.test.ts
```

Expected: the official-row regression reports the models.dev value, and distinct max-window tests fail.

- [ ] **Step 4: Resolve one valid Codex window pair per candidate**

Keep this logic local to `codex-client-models.ts`; it is a protocol projection, not generic model metadata.

```ts
const DEFAULT_CODEX_WINDOWS: CodexWindows = {
  contextWindow: 272_000,
  maxContextWindow: 272_000,
};

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

function projectGenericWindows(limit: ModelLimit | undefined): CodexWindows | undefined {
  const input = positiveInteger(limit?.input);
  const context = positiveInteger(limit?.context);
  if (input === undefined && context === undefined) return undefined;
  if (input !== undefined && context !== undefined && input > context) return undefined;
  return {
    contextWindow: input ?? context!,
    maxContextWindow: context ?? input!,
  };
}

function officialWindowOverrides(row: CodexUpstreamModel | undefined): Partial<CodexWindows> {
  if (row === undefined) return {};
  const context = positiveInteger(row['context_window']);
  const maximum = positiveInteger(row['max_context_window']);
  if (context !== undefined && maximum !== undefined && context > maximum) return {};
  return {
    ...(context === undefined ? {} : { contextWindow: context }),
    ...(maximum === undefined ? {} : { maxContextWindow: maximum }),
  };
}
```

For each candidate, a projected config pair wins immediately. Otherwise choose one valid generic base pair from provider upstream → models.dev fallback → static default, then overlay each valid official field independently:

```ts
const configured = projectGenericWindows(candidate.configMetadata?.limit);
if (configured !== undefined) return configured;

const generic =
  projectGenericWindows(candidate.upstreamMetadata?.limit) ??
  projectGenericWindows(model.fallbackMetadata?.limit) ??
  DEFAULT_CODEX_WINDOWS;
const official = officialWindowOverrides(codexBySlug.get(candidate.modelId));
const overlaid = {
  contextWindow: official.contextWindow ?? generic.contextWindow,
  maxContextWindow: official.maxContextWindow ?? generic.maxContextWindow,
};
return overlaid.contextWindow <= overlaid.maxContextWindow ? overlaid : generic;
```

The fallback to `generic` makes a partial official field fail-soft when combining it with the remaining lower-priority field would create an invalid pair. It does not clamp user config or duplicate one official field into the other.

Aggregate candidate `contextWindow` and `maxContextWindow` independently with the model's min/max mode. The inequality is preserved by min/max over valid pairs; retain a final fail-soft guard that returns `DEFAULT_CODEX_WINDOWS` if malformed runtime data ever violates it.

- [ ] **Step 5: Keep Case A identity upstream-owned but apply mapped config fields**

Select the primary Case A row with `codexBySlug.get(model.modelId)`. Clone/spread it as today, normalize instructions unchanged, write aggregated windows, and keep `slug` / `id` equal to the public alias.

Apply mapped fields with these exact priorities:

- `display_name`: primary config `name` → official `display_name` → primary upstream `name` → fallback `name` → public slug.
- `description`: primary config `description` → official `description` → primary upstream `description` → fallback `description` → `''`.
- `input_modalities`: primary config modalities → official field → primary upstream modalities → fallback modalities → existing default.
- `supported_reasoning_levels`: primary config reasoning flag/options → official field → primary upstream reasoning flag/options → fallback reasoning flag/options → existing default.

For the last two fields, reuse one projection function extracted from `codex-assembly.ts`:

```ts
export function projectCodexMetadata(
  metadata: Pick<ModelMetadata, 'description' | 'capabilities'> | undefined,
  fillDefaults: boolean,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (metadata?.description !== undefined || fillDefaults) {
    patch['description'] = metadata?.description ?? '';
  }

  const inputs = metadata?.capabilities?.modalities?.input;
  if (inputs !== undefined || fillDefaults) {
    patch['input_modalities'] = ['text', ...((inputs ?? ['image']).includes('image') ? ['image'] : [])];
  }

  const options = metadata?.capabilities?.reasoningOptions;
  const levels = reasoningLevelsFor(options, metadata?.capabilities?.reasoning, fillDefaults);
  if (levels !== undefined) {
    patch['supported_reasoning_levels'] = levels.map(reasoningLevel);
    const defaultLevel = levels.includes('low') ? 'low' : levels[0];
    if (defaultLevel !== undefined) patch['default_reasoning_level'] = defaultLevel;
  }
  return patch;
}
```

`reasoningLevelsFor(options, reasoning, fillDefaults)` returns an empty list when `reasoning === false`, returns `undefined` only when the field is absent and defaults are disabled, returns the existing full level list when defaults are enabled, and filters configured `effort.values` otherwise. The projection must:

- filter modalities to Codex-supported `text` / `image`;
- treat an explicit empty input-modality array as present (emit required `text` only instead of the image default) and an explicit empty reasoning-options array as no supported levels;
- remove `default_reasoning_level` when no levels remain;
- choose `low` when present, otherwise the first supported level;
- omit a missing field when `fillDefaults` is false, so an untouched official field remains verbatim.

When applying this patch over a Case A clone, explicitly delete an inherited `default_reasoning_level` if the patch contains an empty `supported_reasoning_levels` array; object spread alone cannot remove that official field.

Do not map `limit.output` to a Codex wire field.

- [ ] **Step 6: Make Case B consume resolved emitted fields only**

Build the small metadata input at the protocol boundary:

```ts
const capabilities = resolveModelCapabilities(model);
const description = resolveModelField(model, (metadata) => metadata.description);
const metadata =
  capabilities === undefined && description === undefined
    ? undefined
    : {
        ...(description === undefined ? {} : { description }),
        ...(capabilities === undefined ? {} : { capabilities }),
      };
```

Change `assembleCodexModel` input to:

```ts
type AssembleInput = {
  readonly slug: string;
  readonly displayName: string;
  readonly metadata: Pick<ModelMetadata, 'description' | 'capabilities'> | undefined;
  readonly contextWindow: number;
  readonly maxContextWindow: number;
  readonly template: CodexUpstreamModel | undefined;
};
```

Write the two supplied values directly. Continue cloning the complete template, deleting promo/routing fields only for synthesized rows, and applying the current instructions/default-required-fields logic.

- [ ] **Step 7: Prove per-candidate Codex aggregation order**

Add one two-Provider test where one candidate has a configured composite pair and the other has a matching official pair. Assert min and max results separately, demonstrating that each candidate resolves config/official/fallback before cross-Provider aggregation.

- [ ] **Step 8: Run all Codex behavior and degraded-cache tests**

Run:

```bash
rtk bun test --preload=./packages/server/__tests__/setup.ts packages/server/src/server/list-models/codex-client-models/codex-client-models.test.ts packages/server/src/server/list-models/codex-client-models/codex-assembly.test.ts packages/server/src/server/list-models/codex-client-models/codex-cache.test.ts
```

Expected: PASS, including existing fresh, stale, missing, malformed-row, read-failed, and write-failed cache paths.

- [ ] **Step 9: Commit the Codex projection fix**

```bash
rtk git add packages/server/src/server/list-models/codex-client-models/codex-client-models.ts packages/server/src/server/list-models/codex-client-models/codex-client-models.test.ts packages/server/src/server/list-models/codex-client-models/codex-assembly.ts packages/server/src/server/list-models/codex-client-models/codex-assembly.test.ts
rtk git commit -m "fix(codex): honor model metadata source priority" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 5: Document, Release, and Verify the Complete Change

**Files:**
- Modify: `npm/aio-proxy/README.md`
- Create: one `.changeset/*.md` generated by the Changesets CLI

**Interfaces:**
- Documents all Provider kinds, source priority, pair validation, and the distinct meanings of `context` / `input` / `output`.
- Publishes a minor change for `aio-proxy`, `@aio-proxy/types`, and `@aio-proxy/server` with the same bump level.

- [ ] **Step 1: Update the model metadata documentation**

Change “Each `api` or `ai-sdk` Provider” to all three Provider kinds. Document:

```text
metadata config (including extend) > protocol/provider catalog > models.dev > protocol default
limit.context = maximum total context
limit.input   = maximum input tokens
limit.output  = maximum output tokens
Codex: context_window = input ?? context; max_context_window = context ?? input
```

Update the JSONC example to the composite values `context: 400000`, `input: 272000`, `output: 128000`. State that configured `input` and `output` cannot exceed configured `context`, and that aliases only auto-discover fallback by their public slug.

- [ ] **Step 2: Generate the user-visible changeset**

Run:

```bash
rtk bun changeset --minor aio-proxy --minor @aio-proxy/types --minor @aio-proxy/server --message "Resolve model metadata per source so configured limits override provider catalogs, official Codex limits override models.dev fallback, and OAuth Providers support metadata."
```

Inspect the generated `.changeset/*.md`; it must list all three packages at `minor` and no internal-only release note.

- [ ] **Step 3: Run focused package verification**

Run:

```bash
rtk bun test packages/types/src/model-metadata/model-metadata.test.ts packages/types/src/plugin.test.ts packages/types/src/provider-oauth-mutation.test.ts packages/types/src/config/config.test.ts
rtk bun test --preload=./packages/server/__tests__/setup.ts packages/server/src/provider-runtime/materialize.test.ts packages/server/src/plugin-runtime/capabilities.test.ts packages/server/src/plugin-runtime/materialize.test.ts packages/server/src/server-state/resolve-extend/resolve-extend.test.ts packages/server/src/server-state/resolve-extend/extend-e2e.test.ts packages/server/src/server/model-resolution/model-resolution.test.ts packages/server/src/server/model-capabilities/model-capabilities.test.ts packages/server/src/server/list-models/list-models.test.ts packages/server/src/server/list-models/codex-client-models/codex-client-models.test.ts packages/server/src/server/list-models/codex-client-models/codex-assembly.test.ts packages/server/src/server/list-models/codex-client-models/codex-cache.test.ts packages/server/src/dashboard-routes/provider-mutation/provider-mutation.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run repository verification**

Run:

```bash
rtk bun run check
rtk bun run preflight
```

Expected: both commands exit 0. Existing warnings are acceptable only if the command exits successfully; do not classify a new failure as pre-existing without confirming it on `origin/main`.

- [ ] **Step 5: Inspect the final diff for scope and stale names**

Run:

```bash
rtk git diff --check
rtk git diff --check origin/main...HEAD
rtk rg -n "effectiveMetadata|contextWindow.*max_context_window|provider\.metadata" packages/server/src/server packages/server/src/routes/pipeline packages/server/src/plugin-runtime packages/server/src/provider-runtime
rtk git status --short
```

Expected:

- `git diff --check` is clean;
- no stored `effectiveMetadata` remains;
- no code copies one generic context value into both Codex fields;
- no runtime consumer reads `provider.metadata` (legacy API/AI SDK factory translation may still read its input field);
- `.aio-proxy-dev` remains untracked and untouched.

- [ ] **Step 6: Commit documentation and changeset**

Stage the README, inspect the generated filename, then stage that one file by its exact path; do not stage the entire `.changeset` directory or `.aio-proxy-dev`:

```bash
rtk git add npm/aio-proxy/README.md
rtk git status --short .changeset
rtk git commit -m "docs(models): document metadata source priority" -m "Co-authored-by: Codex <noreply@openai.com>"
```

Between the status and commit commands, run `rtk git add` with the single generated `.changeset/*.md` path printed by status.

## Self-Review Record

- **Spec coverage:** Task 1 covers strict user validation, OAuth authoring/mutation, and safe persistence. Task 2 preserves config/upstream provenance, `extend`, and config-only billing. Task 3 covers public-slug fallback, per-field resolution, all three generic limits, falsey explicit values, and per-candidate aggregation. Task 4 covers official Codex priority, user overrides above official values, composite projection, final pair validity, and existing degraded cache behavior. Task 5 covers docs, release notes, stale-name scans, and full verification.
- **No speculative layer:** The plan introduces only two runtime source fields and on-demand resolvers in the existing model-resolution module. It does not introduce `ModelMetadataSources`, a merged object, a cache, provider-reported pricing normalization, or a new dependency.
- **Type consistency:** Provider config remains `ModelMetadata`; OAuth catalog data remains `RuntimeModelMetadata`; `ResolvedModelCandidate` refers to those exact types; all generic limits use `keyof ModelLimit`; Codex uses its separate `CodexWindows` pair.
- **Protocol separation:** Standard models use `input` / `output`; Codex uses `input ?? context` / `context ?? input`; `output` never becomes a Codex field. Responses error propagation remains outside this branch.
