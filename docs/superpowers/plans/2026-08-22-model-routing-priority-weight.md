# Model Routing Priority and Weight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate Provider priority from same-tier weight, add exact client-model routing policies, apply stable-session weighted ordering across generation and token-count, and expose the complete contract through traces and the Dashboard.

**Architecture:** `@aio-proxy/types` owns normalized routing schemas and Dashboard DTOs. `@aio-proxy/core` owns slash-safe model resolution plus priority-tier/weighted candidate ordering; `@aio-proxy/server` keeps the only sequential attempt loops, builds public/inactive model inventories, records routing-v2 facts as generic OTel span attributes in `attributes_json`, and applies model-policy mutations atomically. The Dashboard edits Provider defaults and one model policy at a time through typed Hono APIs. There is no routing-v2 database migration unless a later SQL query or index needs typed columns.

**Tech Stack:** Bun 1.4, TypeScript 7, Zod 4.4, React 19, Hono, TanStack Query/Form/Table/Router, Drizzle ORM/Drizzle Kit, SQLite, Rstest, oxlint, oxfmt.

**Spec:** `docs/superpowers/specs/2026-08-22-model-routing-priority-weight-design.md`

## Global Constraints

- Read the spec and the root `AGENTS.md` before starting; read `packages/dashboard/AGENTS.md` before Dashboard tasks.
- At execution time, create or select an isolated worktree with `superpowers:using-git-worktrees`; the current checkout contains unrelated user changes.
- Prefix shell commands with `rtk` as required by `/Users/baran/.codex/RTK.md`.
- When `.codegraph/` exists, use `rtk codegraph explore` before grep or file reads for code discovery.
- Use Bun APIs in Bun-executed code and add no dependency; existing Zod, es-toolkit, TanStack, Hono, Drizzle, and shadcn primitives cover the feature.
- Provider ID is the stable upstream identifier. Provider priority is an integer `0..10000`, default `0`, higher first. Provider weight is a finite authored number normalized with `Math.round` and clamped to `0..10000`, default `1`.
- Provider `enabled: false` is the hard disable. Effective weight `0` excludes normal model routing but does not block an exact Provider-qualified request.
- `router.models.<clientModel>.providers.<providerId>` is an exact, sparse override map. It never creates a model candidate or changes an upstream target.
- Request classification is exact Provider-qualified match first, then exact normal client-model match with the complete string, including `/`.
- Stable non-generated logical sessions use deterministic weighted ordering; generated sessions use independent random draws. Token-count never mutates affinity and only shares the pre-attempt order, not guaranteed final Provider outcome.
- Final precedence is response owner > active affinity > priority tier > deterministic/random weight order.
- `packages/server/src/routes/pipeline/` remains the only generation candidate loop. Token-count keeps its existing separate count-capability loop but consumes the same Router order.
- New unit tests are colocated with their modules. Existing behavior tests may be updated in place when they already protect the public contract.
- Keep handwritten non-test implementation files below 500 lines; split only by responsibility.
- Dashboard API calls live in `modules/<domain>/services`, server state uses TanStack Query, editable controls use TanStack Form, data tables use TanStack Table plus shadcn Table, and all user-facing copy comes from i18n.
- Never edit `packages/dashboard/src/route-tree.gen.ts` manually; regenerate it through the Dashboard build.
- Every commit must include `Co-authored-by: Codex <noreply@openai.com>`.

---

### Task 1: Define routing schemas, normalization, and Dashboard contracts

**Files:**
- Modify: `packages/types/src/provider.ts:69-76, 197-265`
- Modify: `packages/types/src/config/config.ts:137-218`
- Modify: `packages/types/src/config/config-acceptance.test.ts:1-60`
- Modify: `packages/types/src/config/config-acceptance.test-support.ts`
- Modify: `packages/types/src/config/config-acceptance.oauth-aisdk.test.ts`
- Modify: `packages/types/src/config/config-acceptance.mixed.test.ts`
- Modify: `packages/types/__tests__/schemas-provider-mutation.test.ts:1-70`
- Modify: `packages/types/src/dashboard/dashboard.ts:18-35`
- Create: `packages/types/src/dashboard/routing/index.ts`
- Create: `packages/types/src/dashboard/routing/routing.ts`
- Create: `packages/types/src/dashboard/routing/routing.test.ts`
- Modify: `packages/types/src/dashboard/index.ts`
- Modify: `packages/types/src/index.ts`

**Interfaces:**
- Produces: `ROUTING_VALUE_MAX`, `RoutingPrioritySchema`, `RoutingWeightSchema`, `RouterProviderOverride`, `RouterModelPolicy`, and normalized `Config['router']['models']`.
- Produces: `DashboardRoutingModelsResponse`, `DashboardRoutingModelMutation`, and their Zod schemas for Tasks 7 and 9.
- Provider config output always has effective `priority` and `weight`; mutation input keeps both optional so existing clients remain valid.

- [ ] **Step 1: Write failing schema tests for normalization and model policies**

Add behavior tests to `config-acceptance.test.ts` and `schemas-provider-mutation.test.ts`:

```ts
test('normalizes Provider routing defaults while preserving authoring order', () => {
  const config = ConfigSchema.parse({
    providers: {
      first: { ...apiProvider, weight: 1.6 },
      second: { ...apiProvider, priority: 20, weight: 20_000 },
      third: { ...apiProvider, priority: -3, weight: -2 },
    },
  });

  expect(config.providers.map(({ id, priority, weight }) => ({ id, priority, weight }))).toEqual([
    { id: 'first', priority: 0, weight: 2 },
    { id: 'second', priority: 20, weight: 10_000 },
    { id: 'third', priority: 0, weight: 0 },
  ]);
});

test('parses sparse exact model policies without validating references', () => {
  const config = ConfigSchema.parse({
    router: {
      models: {
        'openai/gpt-5': {
          providers: {
            primary: { priority: 30 },
            missing: { weight: 0.6 },
          },
        },
      },
    },
    providers: { primary: apiProvider },
  });

  expect(config.router.models['openai/gpt-5']).toEqual({
    providers: { primary: { priority: 30 }, missing: { weight: 1 } },
  });
});

test('rejects fractional priorities and non-number weights', () => {
  expect(ProviderMutationBodySchema.safeParse({
    kind: 'ai-sdk', id: 'x', priority: 1.5, packageName: '@ai-sdk/openai-compatible',
  }).success).toBe(false);
  expect(ProviderMutationBodySchema.safeParse({
    kind: 'ai-sdk', id: 'x', weight: '2', packageName: '@ai-sdk/openai-compatible',
  }).success).toBe(false);
});
```

- [ ] **Step 2: Run the schema tests and confirm the old contract fails**

Run:

```bash
rtk bun test packages/types/src/config/config-acceptance.test.ts packages/types/__tests__/schemas-provider-mutation.test.ts
```

Expected: FAIL because `priority` and `router.models` are stripped, weight is not rounded/clamped, and Providers are still sorted by weight.

- [ ] **Step 3: Add canonical routing-number schemas and Provider fields**

In `provider.ts`, define one no-default schema for each authored value, then apply defaults only on persisted Provider schemas:

```ts
export const ROUTING_VALUE_MAX = 10_000;
const clampRoutingValue = (value: number): number => Math.min(ROUTING_VALUE_MAX, Math.max(0, value));

export const RoutingPrioritySchema = z.int().transform(clampRoutingValue);
export const RoutingWeightSchema = z.number().transform((value) => clampRoutingValue(Math.round(value)));

const SharedProviderSchemaBase = {
  id: z.string().describe('Stable provider id used in routing.'),
  enabled: z.boolean().default(true),
  priority: RoutingPrioritySchema.prefault(0).describe('Provider failover priority; higher values are tried first.'),
  weight: RoutingWeightSchema.prefault(1).describe('Same-priority traffic weight; zero disables normal routing.'),
  // existing fields unchanged
} as const;
```

Use `RoutingPrioritySchema.optional()` and `RoutingWeightSchema.optional()` in API, AI SDK, and OAuth mutation bodies. Do not use `z.coerce`: strings must remain invalid. Zod 4 `.prefault()` is required because `.default()` would bypass the transform.

Add optional `priority` beside `weight` in `DashboardProviderSummarySchema`; valid Provider summaries will populate both from normalized Config, while invalid summaries may omit them.

- [ ] **Step 4: Add `router.models` schemas and stop sorting Providers**

In `config.ts`, extend the current Router schema:

```ts
export const RouterProviderOverrideSchema = z.object({
  priority: RoutingPrioritySchema.optional(),
  weight: RoutingWeightSchema.optional(),
});

export const RouterModelPolicySchema = z.object({
  providers: z.record(z.string().min(1), RouterProviderOverrideSchema).default({}),
});

export const RouterConfigSchema = z.object({
  modelContextAggregation: z.enum([ModelContextAggregation.Min, ModelContextAggregation.Max])
    .default(ModelContextAggregation.Min),
  models: z.record(z.string().min(1), RouterModelPolicySchema).default({}),
});
```

Delete `providers.sort(...)` from `ConfigSchema.transform`; `Object.entries(input.providers)` already preserves authored order. Export the new output types from `packages/types/src/config/index.ts` or the root index.

```ts
export type RouterProviderOverride = z.output<typeof RouterProviderOverrideSchema>;
export type RouterModelPolicy = z.output<typeof RouterModelPolicySchema>;
export type RouterConfig = z.output<typeof RouterConfigSchema>;
```

Update `defaultRouter` to `{ modelContextAggregation: 'min', models: {} }` and update exact Config/Provider output assertions to include `priority: 0, weight: 1` for valid Providers. Do not add these fields to authoring input fixtures; the tests must prove runtime defaults.

- [ ] **Step 5: Add typed Dashboard routing DTOs**

Create `packages/types/src/dashboard/routing/routing.ts` with these public shapes and matching strict Zod schemas:

```ts
export type DashboardRoutingNumber = {
  readonly authored?: number;
  readonly effective: number;
  readonly wasNormalized: boolean;
};

export type DashboardRoutingProvider = {
  readonly id: string;
  readonly name?: string;
  readonly kind: ProviderKind;
  readonly enabled: boolean;
  readonly state: ProviderState;
  readonly defaults: { readonly priority: DashboardRoutingNumber; readonly weight: DashboardRoutingNumber };
  readonly override?: {
    readonly priority?: DashboardRoutingNumber;
    readonly weight?: DashboardRoutingNumber;
  };
  readonly effective: {
    readonly priority: number;
    readonly weight: number;
    readonly prioritySource: 'provider' | 'model';
    readonly weightSource: 'provider' | 'model';
    readonly eligible: boolean;
    readonly share: number | null;
  };
};

export type DashboardRoutingModel = {
  readonly modelId: string;
  readonly revision: string;
  readonly baselineProviderIds: readonly string[];
  readonly providerCount: number;
  readonly eligibleProviderCount: number;
  readonly hasOverrides: boolean;
  readonly tiers: readonly {
    readonly priority: number;
    readonly providers: readonly { readonly providerId: string; readonly weight: number; readonly share: number }[];
  }[];
  readonly providers: readonly DashboardRoutingProvider[];
};

export type DashboardRoutingModelsResponse = {
  readonly writable: boolean;
  readonly models: readonly DashboardRoutingModel[];
};

export type DashboardRoutingModelMutation = {
  readonly modelId: string;
  readonly revision: string;
  readonly baselineProviderIds: readonly string[];
  readonly providers: Readonly<Record<string, RouterProviderOverride>>;
};
```

The mutation schema uses `RoutingPrioritySchema` and `RoutingWeightSchema`, requires unique baseline IDs, and rejects an override object containing neither field. Add `DashboardRoutingMutationErrorCodeSchema = z.enum(['config_unavailable', 'stale_revision', 'validation_failed'])`.

- [ ] **Step 6: Run Types tests and artifact build**

Run:

```bash
rtk bun run --filter @aio-proxy/types test:unit
rtk bun run --filter @aio-proxy/types build
```

Expected: all tests PASS and generated declarations expose the new schemas/types.

- [ ] **Step 7: Commit the Types contract**

```bash
rtk git add packages/types
rtk git commit -m "feat(types): define model routing policies" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Implement slash-safe Router ordering

**Files:**
- Delete: `packages/core/src/router.ts`
- Create: `packages/core/src/router/index.ts`
- Create: `packages/core/src/router/router.ts`
- Create: `packages/core/src/router/weighted-order.ts`
- Create: `packages/core/src/router/router.test.ts`
- Create: `packages/core/src/router/weighted-order.test.ts`
- Modify: `packages/core/src/index.ts:169-181`
- Modify: `packages/core/__tests__/router-resolution.test.ts:1-130`
- Modify: `packages/core/__tests__/router-aliases.routing.test.ts:1-130`

**Interfaces:**
- Consumes: `RouterConfig['models']`, normalized Provider `priority`/`weight`, and `LogicalRequestContext['session']`.
- Produces: `Router.resolve(model, dimensions, { session })`, `Router.modelIds()`, and `Router.catalogCandidates(model)`.
- Produces candidate routing metadata used by Tasks 5, 6, and 7.

- [ ] **Step 1: Write failing weighted-order tests**

Create `weighted-order.test.ts`:

```ts
const candidate = (id: string, priority: number, weight: number, configurationIndex: number) => ({
  provider: { id },
  routing: { priority, weight, configurationIndex },
});

test('orders higher priority tiers before weighted candidates', () => {
  const candidates = [
    candidate('low', 10, 10, 0),
    candidate('high-a', 20, 3, 1),
    candidate('high-b', 20, 1, 2),
  ];

  expect(orderWeightedCandidates(candidates, () => 0).map((item) => item.provider.id)).toEqual([
    'high-a', 'high-b', 'low',
  ]);
});

test('draws without replacement inside a tier', () => {
  const draws = [0.9, 0];
  expect(orderWeightedCandidates([
    candidate('a', 0, 3, 0),
    candidate('b', 0, 1, 1),
  ], () => draws.shift()!).map((item) => item.provider.id)).toEqual(['b', 'a']);
});
```

- [ ] **Step 2: Write failing Router contract tests**

Create `router.test.ts` with the public cases:

```ts
const provider = (
  id: string,
  alias: Record<string, { model: string; preserve: boolean }>,
  routing: { priority?: number; weight?: number } = {},
) => ({
  id,
  kind: ProviderKind.Api,
  enabled: true,
  protocol: ProviderProtocol.OpenAICompatible,
  models: Object.values(alias).map(({ model }) => model),
  alias,
  ...routing,
}) satisfies ProviderInstance;

test('prefers an exact Provider-qualified route over a slash alias', () => {
  const qualifiedProvider = provider('provider-a', {
    'openai/gpt-5': { model: 'qualified-wire', preserve: false },
  });
  const slashAliasProvider = provider('provider-b', {
    'provider-a/openai/gpt-5': { model: 'normal-wire', preserve: false },
  });
  const router = new Router([qualifiedProvider, slashAliasProvider]);
  expect(router.resolve('provider-a/openai/gpt-5')[0]?.provider.id).toBe('provider-a');
});

test('falls back to a normal slash alias when no qualified route matches', () => {
  const slashAliasProvider = provider('alias-provider', {
    'openai/gpt-5': { model: 'normal-wire', preserve: false },
  });
  const router = new Router([slashAliasProvider]);
  expect(router.resolve('openai/gpt-5')[0]?.provider.id).toBe('alias-provider');
});

test('applies exact model overrides and filters zero weight only on normal routes', () => {
  const providerA = provider('a', { shared: { model: 'a-wire', preserve: false } }, { weight: 3 });
  const providerB = provider('b', { shared: { model: 'b-wire', preserve: false } }, { weight: 1 });
  const router = new Router([providerA, providerB], {
    models: { shared: { providers: { a: { weight: 0 }, b: { priority: 20 } } } },
    random: () => 0,
  });
  expect(router.resolve('shared').map(({ provider }) => provider.id)).toEqual(['b']);
  expect(router.resolve('a/shared').map(({ provider }) => provider.id)).toEqual(['a']);
});

test('uses the same stable-session order and randomizes generated sessions', () => {
  const providerA = provider('a', { shared: { model: 'a-wire', preserve: false } }, { weight: 3 });
  const providerB = provider('b', { shared: { model: 'b-wire', preserve: false } }, { weight: 1 });
  const router = new Router([providerA, providerB], { random: () => 0.99 });
  const stable = { key: 'sha256:stable', source: 'header-session' } as const;
  expect(router.resolve('shared', {}, { session: stable })).toEqual(router.resolve('shared', {}, { session: stable }));
  expect(router.resolve('shared', {}, { session: { key: 'sha256:generated', source: 'generated' } })[0]?.provider.id)
    .toBe('b');
});
```

- [ ] **Step 3: Run Router tests and confirm failure**

```bash
rtk bun test packages/core/src/router/router.test.ts packages/core/src/router/weighted-order.test.ts packages/core/__tests__/router-resolution.test.ts packages/core/__tests__/router-aliases.routing.test.ts
```

Expected: FAIL because the new files and APIs do not exist and slash aliases currently never fall back to the normal map.

- [ ] **Step 4: Implement weighted ordering and deterministic draws**

In `weighted-order.ts`, define:

```ts
export type WeightedCandidate = {
  readonly routing: {
    readonly priority: number;
    readonly weight: number;
    readonly configurationIndex: number;
  };
};

export function orderWeightedCandidates<T extends WeightedCandidate>(
  candidates: readonly T[],
  draw: (priority: number, drawIndex: number) => number,
): readonly T[] {
  const tiers = new Map<number, T[]>();
  for (const candidate of candidates) {
    const tier = tiers.get(candidate.routing.priority) ?? [];
    tier.push(candidate);
    tiers.set(candidate.routing.priority, tier);
  }
  const ordered: T[] = [];
  for (const priority of [...tiers.keys()].sort((left, right) => right - left)) {
    const remaining = [...tiers.get(priority)!];
    for (let drawIndex = 0; remaining.length > 0; drawIndex++) {
      const total = remaining.reduce((sum, candidate) => sum + candidate.routing.weight, 0);
      let target = Math.min(draw(priority, drawIndex), 1 - Number.EPSILON) * total;
      let selected = remaining.length - 1;
      for (const [index, candidate] of remaining.entries()) {
        if (target < candidate.routing.weight) { selected = index; break; }
        target -= candidate.routing.weight;
      }
      ordered.push(remaining.splice(selected, 1)[0]!);
    }
  }
  return ordered;
}
```

Implement a SHA-256 counter draw in `router.ts` using `Bun.CryptoHasher('sha256')`, the session key, exact requested model, priority, and draw index. Convert the first 13 hex digits to a value in `[0, 1)`. Generated sessions and calls without a session use the injected `random` function, defaulting to `Math.random`.

```ts
function stableDraw(sessionKey: string, model: string, priority: number, drawIndex: number): number {
  const hex = new Bun.CryptoHasher('sha256')
    .update(`${sessionKey}\0${model}\0${priority}\0${drawIndex}`)
    .digest('hex');
  return Number.parseInt(hex.slice(0, 13), 16) / 0x10_0000_0000_0000;
}
```

- [ ] **Step 5: Implement Router route classification and policy merging**

Define these exported types:

```ts
export type RoutingValueSource = 'provider' | 'model';
export type RouterSelectionSource = 'provider_qualified' | 'deterministic_session' | 'weighted_random';
export type EffectiveCandidateRouting = {
  readonly priority: number;
  readonly weight: number;
  readonly prioritySource: RoutingValueSource;
  readonly weightSource: RoutingValueSource;
  readonly configurationIndex: number;
};
export type RouterCandidate<TProvider extends RoutableProvider = ProviderInstance> = RouterResolution<TProvider> & {
  readonly routing: EffectiveCandidateRouting;
  readonly selectionSource: RouterSelectionSource;
};
export type RouterCatalogCandidate<TProvider extends RoutableProvider = ProviderInstance> =
  RouterResolution<TProvider> & { readonly routing: EffectiveCandidateRouting };
```

`Router.resolve()` must:

1. Return the exact `providerAliases` match immediately with `provider_qualified` and Provider defaults, without weight filtering.
2. Otherwise resolve the exact normal alias map, merge model overrides by Provider ID, remove effective weight zero, and throw `RouterModelNotFoundError` if none remain.
3. Use deterministic draws only when `session.source !== 'generated'`.

`Router.catalogCandidates(model)` must use the normal alias map only, filter weight zero, and sort deterministically by priority descending, weight descending, then configuration index. `Router.modelIds()` returns normal alias keys in insertion order.

- [ ] **Step 6: Preserve existing Router exports and tests**

Make `packages/core/src/router/index.ts` export the public Router types/functions. Keep `packages/core/src/index.ts` exporting from `./router`, so external import paths do not change. Update existing Router test fixtures only where the new candidate routing metadata changes deep equality; prefer `toMatchObject` for existing provider/model assertions.

- [ ] **Step 7: Run Core tests and build**

```bash
rtk bun run --filter @aio-proxy/core test:unit
rtk bun run --filter @aio-proxy/core build
```

Expected: PASS with deterministic, slash-safe, zero-weight, and catalog ordering behavior.

- [ ] **Step 8: Commit Router ordering**

```bash
rtk git add packages/core/src/router packages/core/src/router.ts packages/core/src/index.ts packages/core/__tests__/router-resolution.test.ts packages/core/__tests__/router-aliases.test.ts packages/core/__tests__/router-aliases.routing.test.ts
rtk git commit -m "feat(core): order model routes by priority and weight" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Record routing-v2 facts as generic OTel attributes

**Files:**
- Modify: `packages/core/src/db/trace-store/span-projection/span-projection.ts`
- Modify: `packages/core/src/db/trace-store/span-projection/span-projection.test.ts`
- Modify: `packages/server/src/request-tracing/semantic.ts:20-75`

**Interfaces:**
- Emits and round-trips these span attributes through generic `attributes_json`:
  - `aio_proxy.route.contract_version`
  - `aio_proxy.route.effective_priority`
  - `aio_proxy.route.effective_weight`
  - `aio_proxy.route.priority_source`
  - `aio_proxy.route.weight_source`
  - `aio_proxy.route.selection_source`
- Leaves them out of `ProjectedColumns`, `trace_span` typed columns, and any schema migration.
- Leaves legacy `providerWeight` and `selectionReason` readable; v2 consumers read the contract-versioned attributes from JSON.
- Task 5 emits the attributes defined here.

`trace_span` is a hybrid OTel read model: all attributes are generically supported by `attributes_json`, and only attributes with a concrete SQL filter, index, or aggregation need are promoted into typed columns. These six routing-v2 attributes have no SQL consumer, so column promotion is YAGNI. Do not add a database migration unless a later query needs typed columns.

- [ ] **Step 1: Write failing projection and store tests**

Add projection assertions that keep routing-v2 values in `remaining`:

```ts
const attributes = {
  'aio_proxy.route.contract_version': 2,
  'aio_proxy.route.effective_priority': 30,
  'aio_proxy.route.effective_weight': 6000,
  'aio_proxy.route.priority_source': 'model',
  'aio_proxy.route.weight_source': 'provider',
  'aio_proxy.route.selection_source': 'deterministic_session',
};

const projected = projectAttributes(attributes, false);
expect(projected.columns).toEqual({});
expect(projected.remaining).toEqual(attributes);
```

Persist an attempt span with those attributes plus a long-tail key. Assert the raw `attributes_json` still contains the six routing-v2 keys, `find()` reconstructs them from JSON, and the row has no typed routing-v2 columns.

- [ ] **Step 2: Run trace tests and confirm failure**

```bash
rtk bun test packages/core/src/db/trace-store/span-projection/span-projection.test.ts
```

Expected: FAIL if projection still promotes routing-v2 keys into typed columns.

- [ ] **Step 3: Keep routing-v2 names on the allowlist without column promotion**

Do not add routing-v2 fields to `ATTR`, `ProjectedColumns`, `projectAttributes`, `mergeAttributes`, `trace-queries.ts`, or `traceSpan`. Do not generate `0006_routing_trace_v2` or any replacement migration.

Add the attribute names to `request-tracing/semantic.ts` and `ALLOWED_ATTRIBUTES`:

```ts
routingContractVersion: 'aio_proxy.route.contract_version',
effectivePriority: 'aio_proxy.route.effective_priority',
effectiveWeight: 'aio_proxy.route.effective_weight',
prioritySource: 'aio_proxy.route.priority_source',
weightSource: 'aio_proxy.route.weight_source',
selectionSource: 'aio_proxy.route.selection_source',
```

Do not remove `providerWeight` or `selectionReason`; historical rows still use them.

- [ ] **Step 4: Confirm the compiled schema stays at six migrations**

```bash
rtk bun run --filter @aio-proxy/core build:migrations
```

Expected: Drizzle reports no schema diff and the generated manifest still lists the existing six migrations. Do not invent a replacement migration.

- [ ] **Step 5: Run projection, store, and Core tests**

```bash
rtk bun test packages/core/src/db/trace-store/span-projection/span-projection.test.ts packages/core/src/db/migrations/migrations.test.ts packages/core/src/db/trace-store/trace-store.test.ts
rtk bun run --filter @aio-proxy/core build
```

Expected: PASS for JSON round-trip of routing-v2 attributes, fresh DB, version-six upgrade, and legacy `providerWeight` reconstruction.

- [ ] **Step 6: Commit trace observability**

```bash
rtk git add packages/core/src/db packages/server/src/request-tracing/semantic.ts
rtk git commit -m "feat(core): record routing v2 trace attributes" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Propagate routing defaults through runtime snapshots

**Files:**
- Modify: `packages/server/src/runtime.ts:47-74`
- Modify: `packages/server/src/provider-runtime/materialize.ts:25-85, 135-270`
- Modify: `packages/server/src/provider-runtime/materialize.test.ts:150-220`
- Modify: `packages/server/src/plugin-runtime/capabilities.ts:55-115`
- Modify: `packages/server/src/plugin-runtime/catalog.ts:18-50`
- Modify: `packages/server/src/plugin-runtime/catalog.test.ts`
- Modify: `packages/server/src/server-state/types.ts:45-60`
- Modify: `packages/server/src/server-state/lifecycle.ts:35-95`
- Modify: `packages/server/src/server-state/index.ts:125-155`
- Modify: `packages/server/src/server-state/snapshot.ts:55-135, 205-280`
- Modify: `packages/server/src/plugin-quota/test-support.ts`
- Modify: `packages/server/src/routes/token-count/token-count.test-support.ts`
- Modify: `packages/server/__tests__/plugin-snapshot/lease.test.ts`

**Interfaces:**
- Consumes: normalized Provider defaults and `RouterConfig` from Task 1; Router constructor options from Task 2.
- Produces: runtime Providers carrying `priority`/`weight`, summaries exposing them, and every snapshot Router receiving `config.router.models`.

- [ ] **Step 1: Write failing runtime materialization tests**

Update `provider-runtime/materialize.test.ts`:

```ts
test('materializes and summarizes normalized Provider routing defaults', () => {
  const config = ConfigSchema.parse({
    providers: {
      api: { kind: 'api', protocol: 'openai-compatible', baseURL: 'https://api.test', priority: 7, weight: 2.6 },
    },
  });
  const runtime = materializeProviders(config, {
    createApiProvider: (provider) => {
      const passthrough = async () => new Response();
      return {
        ...provider,
        endpointTransports: [{ protocol: provider.protocol, passthrough }],
        passthrough,
      };
    },
    bridgeApiProvider: () => ({
      enabled: true,
      id: 'api:bridge',
      invoke: () => new ReadableStream(),
      kind: ProviderKind.AiSdk,
    }),
  });
  expect(runtime.providers[0]).toMatchObject({ priority: 7, weight: 3 });
  expect(runtime.summaries[0]).toMatchObject({ priority: 7, weight: 3 });
});
```

Add a plugin-runtime test proving `withRoutingConfig()` refreshes priority/weight on a reused OAuth runtime.

Add a snapshot lease test that acquires the old snapshot, reloads a config with a different `router.models` policy, then proves the retained lease still resolves the old candidate order while `currentProviderSnapshot()` resolves the new order.

- [ ] **Step 2: Run runtime tests and confirm failure**

```bash
rtk bun test packages/server/src/provider-runtime/materialize.test.ts packages/server/src/plugin-runtime/catalog.test.ts
```

Expected: FAIL because runtime Providers and summaries do not carry priority.

- [ ] **Step 3: Copy routing defaults into all runtime Provider kinds**

Extend `RuntimeProviderBase` with optional `priority` and `weight` so legacy test/provider injection remains source-compatible. In normal materialization, always copy normalized values:

```ts
return {
  id: provider.id,
  kind: provider.kind,
  enabled: provider.enabled,
  priority: provider.priority,
  weight: provider.weight,
  // existing capabilities
};
```

Apply the same fields in `createRuntimeProvider()` and `withRoutingConfig()` for OAuth. Add `priority` beside `weight` in API/AI SDK and OAuth summaries; invalid summaries may omit both.

- [ ] **Step 4: Pass Router config through snapshot construction**

Change the test hook and internal factory signature to:

```ts
type CreateRouter = (
  providers: readonly RuntimeProviderInstance[],
  routerConfig: Config['router'],
) => Router<RuntimeProviderInstance>;
```

The production factory is:

```ts
(providers, routerConfig) => new Router(providers, { models: routerConfig.models })
```

Pass `configWithExtend.router` in `buildSnapshot()` and `config.router` in `buildSnapshotWithProviders()`. Update test-support Routers to use `defaultRouter` when no explicit config is relevant.

- [ ] **Step 5: Run snapshot/runtime tests**

```bash
rtk bun run --filter @aio-proxy/server test:unit
```

Expected: PASS with config order preserved and snapshot Routers receiving model policies.

- [ ] **Step 6: Commit runtime propagation**

```bash
rtk git add packages/server/src/runtime.ts packages/server/src/provider-runtime packages/server/src/plugin-runtime packages/server/src/server-state packages/server/src/plugin-quota/test-support.ts packages/server/src/routes/token-count/token-count.test-support.ts packages/server/__tests__/plugin-snapshot/lease.test.ts
rtk git commit -m "feat(server): propagate Provider routing defaults" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Use the shared Router order in generation and token-count

**Files:**
- Modify: `packages/server/src/routes/pipeline/index.ts:205-270`
- Modify: `packages/server/src/routes/pipeline/attempt/attempt.ts:85-176`
- Modify: `packages/server/src/routes/pipeline/attempt-base.ts:1-40`
- Modify: `packages/server/src/routes/pipeline/attempt/context.ts:55-80`
- Modify: `packages/server/src/routes/pipeline/attempt/emit.ts:40-75`
- Modify: `packages/server/src/routes/pipeline/attempt-metadata.test.ts`
- Modify: `packages/server/src/routes/pipeline/response-owner.test.ts`
- Modify: `packages/server/src/routes/pipeline/selection.test.ts`
- Modify: `packages/server/src/routes/pipeline/test-support.ts`
- Modify: `packages/server/__tests__/pipeline-helpers/providers.ts`
- Modify: `packages/server/src/routes/token-count/token-count.ts:108-145, 180-310`
- Modify: `packages/server/src/routes/token-count/shared.ts:1-70`
- Modify: `packages/server/src/routes/token-count/token-count.test.ts`
- Modify: `packages/server/src/routes/token-count/token-count.trace-spans.test.ts`
- Modify: `packages/server/__tests__/provider-ordering.test.ts:1-90`

**Interfaces:**
- Consumes: `RouterCandidate.routing`, `RouterCandidate.selectionSource`, and logical session context.
- Produces: final attempt metadata with routing contract v2 and selection source. `attemptIndex > 0` remains the only fallback indicator.

- [ ] **Step 1: Write failing end-to-end routing tests**

Add or update behavior tests for:

```ts
const attemptProviderIds = (recording: Recording): string[] =>
  recording.attempts.map(({ providerId }) => providerId);

test('tries the remaining same-priority Provider before a lower tier', async () => {
  const failingA = modelProvider({ id: 'a', invoke: () => { throw new Error('a failed'); } });
  const succeedingB = modelProvider({ id: 'b', invoke: () => textStream('b') });
  const lowerC = modelProvider({ id: 'c', invoke: () => textStream('c') });
  const config = ConfigSchema.parse({
    router: {
      models: {
        [REQUESTED_MODEL]: {
          providers: {
            a: { priority: 20, weight: 3 },
            b: { priority: 20, weight: 1 },
            c: { priority: 10, weight: 1 },
          },
        },
      },
    },
    providers: {},
  });
  const harness = pipeline([failingA, succeedingB, lowerC], {
    config,
    random: () => 0,
  });
  await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
  expect(attemptProviderIds(harness.recording)).toEqual(['a', 'b']);
});
```

Extend `pipeline()`/`defineProviderRouteSource()` with optional `{ config, random }`. Build the test Router as `new Router(providers, { models: config?.router.models, random })` and include the same Config in both acquired/current snapshots. Keep existing callers source-compatible.

In `response-owner.test.ts`, adapt the existing owner/affinity fixture so owner has priority `0`, affinity has `10`, and the ordinary candidate has `20`; assert the first attempt remains `owner`. Add a second case where the stored affinity points at a model override with weight `0`; assert its Provider ID never appears in recorded attempts.

In token-count tests, send the same `session_id` through count and generation harnesses and assert their Router candidate order is equal while allowing count to skip a no-capability first candidate. Add a generated-session case using an injected random source to prove independent ordering.

- [ ] **Step 2: Run pipeline/token-count tests and confirm failure**

```bash
rtk bun test packages/server/src/routes/pipeline/selection.test.ts packages/server/src/routes/pipeline/attempt-metadata.test.ts packages/server/src/routes/pipeline/response-owner.test.ts packages/server/src/routes/token-count/token-count.test.ts packages/server/src/routes/token-count/token-count.trace-spans.test.ts packages/server/__tests__/provider-ordering.test.ts
```

Expected: FAIL because session context is not passed to Router, attempt metadata reads config weight directly, and token-count still relies on globally sorted Providers.

- [ ] **Step 3: Pass logical session context into Router resolution**

In generation and token-count, call:

```ts
const candidates = lease.snapshot.router.resolve(
  requestedModel,
  adapter.dimensions(request, context),
  { session: resolution.context.session },
);
```

Keep the existing affinity then response-owner moves after Router resolution. Do not write affinity from token-count; preserve `mutateSessionState: false`.

- [ ] **Step 4: Emit candidate routing metadata instead of rebuilding weight maps**

Delete `weightByProviderId` from `attempt.ts`. Extend `AttemptTraceMetadata` with:

```ts
readonly routingContractVersion: 2;
readonly providerWeight: number;
readonly effectivePriority: number;
readonly effectiveWeight: number;
readonly prioritySource: 'provider' | 'model';
readonly weightSource: 'provider' | 'model';
readonly selectionSource:
  | 'provider_qualified'
  | 'response_owner'
  | 'session_affinity'
  | 'deterministic_session'
  | 'weighted_random';
```

Start with `candidate.selectionSource`; replace it with `session_affinity` or `response_owner` when those moves select the current Provider. Keep legacy `providerWeight` as the Provider default. Emit all Task 3 attributes. Never encode fallback in `selectionSource`; use the existing attempt index.

Extend `CountAttempt` and `startAttemptSpan()` with the same candidate routing attributes. Skipped count candidates also carry v2 facts so local-estimate traces show why each candidate was passed over.

- [ ] **Step 5: Update behavior-level ordering assertions**

Replace old “descending Provider weight” expectations with explicit priority/weight policies. Preserve these user-visible contracts:

- same tier uses injected deterministic weight draws;
- lower priority follows only after the current tier;
- affinity can cross priority but cannot restore weight zero;
- response owner wins over affinity;
- Provider-qualified routes bypass weight zero;
- count capability/local estimate can diverge after a shared pre-attempt order.

- [ ] **Step 6: Run all affected routing tests**

```bash
rtk bun test packages/server/src/routes/pipeline packages/server/src/routes/token-count packages/server/__tests__/provider-ordering.test.ts
```

Expected: PASS with no probability-based assertions; all randomized paths use injected draws or stable session keys.

- [ ] **Step 7: Commit request routing integration**

```bash
rtk git add packages/server/src/routes/pipeline packages/server/src/routes/token-count packages/server/__tests__/pipeline-helpers/providers.ts packages/server/__tests__/provider-ordering.test.ts
rtk git commit -m "feat(server): route requests by model priority and weight" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 6: Stabilize `/v1/models` on routable candidates

**Files:**
- Modify: `packages/server/src/server/model-resolution/model-resolution.ts:1-110`
- Modify: `packages/server/src/server/model-resolution/model-resolution.test.ts`
- Modify: `packages/server/src/server/list-models/list-models.test.ts`
- Modify: `packages/server/__tests__/server-model-ordering.test.ts`

**Interfaces:**
- Consumes: `Router.modelIds()` and `Router.catalogCandidates(model)` from Task 2.
- Produces: public catalog candidates filtered to enabled, positive effective weight and ranked priority > weight > config order.
- Preserves `modelContextAggregation` only across that filtered candidate set.

- [ ] **Step 1: Write failing catalog behavior tests**

Add tests:

```ts
test('chooses the deterministic representative by priority then weight then config order', async () => {
  const first = slugProvider('first', 'shared', 'a', undefined, { priority: 10, weight: 1 });
  const second = slugProvider('second', 'shared', 'b', undefined, { priority: 20, weight: 1 });
  const model = (await resolveEnabledModels(fakeState([first, second])))[0]!;
  expect(model.provider.id).toBe('second');
});

test('excludes zero-weight candidates from limit aggregation', async () => {
  const positiveLimit = slugProvider('positive', 'shared', 'up-positive', { context: 400_000 }, { weight: 1 });
  const zeroWeightSmallLimit = slugProvider('zero', 'shared', 'up-zero', { context: 8_000 }, { weight: 0 });
  const model = (await resolveEnabledModels(fakeState([positiveLimit, zeroWeightSmallLimit])))[0]!;
  expect(resolveAggregatedLimit(model, 'context')).toBe(400_000);
});

test('omits a model when every normal candidate has zero weight', async () => {
  const zeroA = slugProvider('a', 'shared', 'up-a', undefined, { weight: 0 });
  const zeroB = slugProvider('b', 'shared', 'up-b', undefined, { weight: 0 });
  expect(await resolveEnabledModels(fakeState([zeroA, zeroB]))).toEqual([]);
});
```

Extend the local `slugProvider()` test helper with a final routing argument and make `fakeState()` construct `new Router(providers, { models: config?.router.models })` in its snapshot.

- [ ] **Step 2: Run model-resolution tests and confirm failure**

```bash
rtk bun test packages/server/src/server/model-resolution packages/server/src/server/list-models packages/server/__tests__/server-model-ordering.test.ts
```

Expected: FAIL because the resolver still iterates snapshot Providers in array order and aggregates every enabled Provider.

- [ ] **Step 3: Resolve public models from Router catalog candidates**

Replace the `bySlug` loop with:

```ts
for (const slug of lease.snapshot.router.modelIds()) {
  const routed = lease.snapshot.router.catalogCandidates(slug);
  if (routed.length === 0) continue;
  const candidates = routed.map(({ provider, modelId }) => ({
    provider,
    modelId,
    configMetadata: provider.configMetadata?.[modelId],
    upstreamMetadata: provider.upstreamMetadata?.[modelId],
  }));
  // existing models.dev fallback and aggregation fields
}
```

The first candidate becomes the representative for `owned_by` and non-limit metadata. `resolveAggregatedLimit()` remains unchanged because its candidate array is now already filtered.

- [ ] **Step 4: Update server model-ordering expectations**

Rewrite the existing highest-weight test to prove:

- priority beats weight;
- weight breaks ties for deterministic catalog ownership;
- config order breaks equal priority/equal weight ties;
- request routing remains random and is not inferred from `/v1/models` order.

- [ ] **Step 5: Run catalog/list tests**

```bash
rtk bun test packages/server/src/server/model-resolution packages/server/src/server/list-models packages/server/__tests__/server-model-ordering.test.ts
```

Expected: PASS with stable metadata and positive-weight-only limit aggregation.

- [ ] **Step 6: Commit catalog resolution**

```bash
rtk git add packages/server/src/server/model-resolution packages/server/src/server/list-models packages/server/__tests__/server-model-ordering.test.ts
rtk git commit -m "feat(server): stabilize routed model catalogs" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 7: Build the model-routing control plane and typed API

**Files:**
- Create: `packages/server/src/model-routing/index.ts`
- Create: `packages/server/src/model-routing/control-plane.ts`
- Create: `packages/server/src/model-routing/inventory.ts`
- Create: `packages/server/src/model-routing/inventory.test.ts`
- Create: `packages/server/src/model-routing/mutation.ts`
- Create: `packages/server/src/model-routing/mutation.test.ts`
- Create: `packages/server/src/model-routing/number-view.ts`
- Create: `packages/server/src/model-routing/number-view.test.ts`
- Modify: `packages/server/src/server-state/types.ts:70-100`
- Modify: `packages/server/src/server-state/lifecycle.ts:130-185`
- Modify: `packages/server/src/server-state/index.ts:220-260`
- Create: `packages/server/src/dashboard-routes/routing/routing.ts`
- Create: `packages/server/src/dashboard-routes/routing/routing.test.ts`
- Create: `packages/server/src/dashboard-routes/routing/index.ts`
- Modify: `packages/server/src/dashboard-routes/config.ts:1-65`
- Modify: `packages/server/src/dashboard-routes/provider-routes.ts:20-45`

**Interfaces:**
- Consumes: Task 1 DTOs/schemas, raw `AtomicConfigFile`, `PluginRepository.readCatalog`, current Config/summaries, and `digestProviderEntry`.
- Produces: `ModelRoutingControlPlane.list()`, `.update(input)`, and `.providerNumberViews(providerId)`.
- Dashboard endpoints: `GET /routing/models` and `PUT /routing/models`; model IDs stay in JSON, never route params.

- [ ] **Step 1: Write failing normalization-view tests**

Create `number-view.test.ts`:

```ts
test('reports authored and effective routing values without rewriting raw config', () => {
  expect(routingNumberView(1.6, 2)).toEqual({ authored: 1.6, effective: 2, wasNormalized: true });
  expect(routingNumberView(undefined, 1)).toEqual({ effective: 1, wasNormalized: false });
});
```

- [ ] **Step 2: Write failing inventory tests for inactive Providers**

Create fixtures containing:

- disabled API and AI SDK Providers with authored models/aliases;
- disabled OAuth with a persisted catalog;
- unavailable OAuth with a persisted catalog and alias targeting a model no longer in the catalog;
- Provider/model overrides with positive, zero, inherited, and unknown entries.

Assert the inventory contains all known client model routes, does not create runtime Providers, calculates effective tiers/shares, exposes raw/default/override normalization facts, and excludes unknown entries from display while retaining them in raw config.

- [ ] **Step 3: Write failing CAS mutation tests**

In `mutation.test.ts`, cover:

```ts
test('replaces only baseline Provider entries and preserves newly known or unknown entries', async () => {
  const originalPolicy = {
    providers: { a: { priority: 10 }, b: { weight: 2 }, c: { weight: 7 } },
  };
  const current = { router: { models: { shared: originalPolicy } }, providers: {} };
  const input = {
    modelId: 'shared',
    revision: digestProviderEntry(originalPolicy),
    baselineProviderIds: ['a', 'b'],
    providers: { a: { priority: 30 } },
  };
  const next = applyRoutingMutation(current, input);
  expect(next).toMatchObject({
    router: { models: { shared: { providers: {
      a: { priority: 30 },
      c: { weight: 7 },
    } } } },
  });
});

test('rejects a stale raw policy without changing config', () => {
  const current = { router: { models: { shared: { providers: { a: { priority: 20 } } } } }, providers: {} };
  const staleInput = {
    modelId: 'shared',
    revision: digestProviderEntry({ providers: { a: { priority: 10 } } }),
    baselineProviderIds: ['a'],
    providers: { a: { priority: 30 } },
  };
  expect(() => applyRoutingMutation(current, staleInput)).toThrow(ModelRoutingStaleRevisionError);
});
```

- [ ] **Step 4: Run model-routing tests and confirm failure**

```bash
rtk bun test packages/server/src/model-routing packages/server/src/dashboard-routes/routing
```

Expected: FAIL because the module and routes do not exist.

- [ ] **Step 5: Implement inventory assembly independent of runtime materialization**

`inventory.ts` must:

1. Read the latest raw config record from `configStore.file` when available; otherwise derive a read-only normalized record from current Config.
2. For API/AI SDK, combine authored `models` and `alias` directly.
3. For OAuth, read/validate the persisted catalog and combine its language model IDs with authored aliases.
4. Call Core `modelRoutes()` on synthetic route sources only; never create Provider transports.
5. Join current Provider summaries/states by Provider ID.
6. Merge Provider defaults and model overrides; compute eligibility, priority tiers, shares, baseline IDs, and the raw-policy revision.

Use config order for Provider rows. A missing config path returns `{ writable: false }` but still returns the read-only inventory.

Catch per-Provider catalog read/validation failures: keep authored aliases, expose the Provider's existing unavailable state, and continue building other models instead of failing the whole Routing page.

- [ ] **Step 6: Implement raw-policy CAS mutation**

Use `digestProviderEntry(rawPolicy ?? null)` as the opaque revision. Inside `configStore.mutateConfig()`:

```ts
const currentPolicy = readRawModelPolicy(current, input.modelId);
if (digestProviderEntry(currentPolicy ?? null) !== input.revision) {
  throw new ModelRoutingStaleRevisionError();
}
const preserved = Object.fromEntries(
  Object.entries(currentPolicy?.providers ?? {}).filter(([id]) => !input.baselineProviderIds.includes(id)),
);
const providers = { ...preserved, ...input.providers };
return writeRawModelPolicy(current, input.modelId, providers);
```

`writeRawModelPolicy()` removes empty Provider overrides and deletes the model/router containers only when no preserved or future fields remain. It never validates whether Provider/model references currently exist.

- [ ] **Step 7: Expose the control plane on ServerState and add Hono routes**

Add `readonly modelRouting: ModelRoutingControlPlane` to `ServerState`. Construct it with snapshot access, repository, and configStore during lifecycle assembly.

Implement:

```ts
.get('/routing/models', async (c) => c.json(await state.modelRouting.list()))
.put('/routing/models', validator('json', ...), async (c) => {
  try { return c.json(await state.modelRouting.update(c.req.valid('json'))); }
  catch (error) {
    if (error instanceof ConfigPathMissingError) return c.json({ error: 'config_unavailable' }, 409);
    if (error instanceof ModelRoutingStaleRevisionError) return c.json({ error: 'stale_revision' }, 409);
    throw error;
  }
})
```

Mount the route under `/` in `dashboard-routes/config.ts`.

Make Provider edit-view async and add raw/effective routing-number views from `state.modelRouting.providerNumberViews(id)` so Task 8 can show pending normalization.

- [ ] **Step 8: Run API/control-plane tests**

```bash
rtk bun run --filter @aio-proxy/server test:unit
```

Expected: PASS for inactive OAuth inventory, exact aliases, zero effective routes, read-only state, CAS, baseline preservation, and provider raw/effective views.

- [ ] **Step 9: Commit the control plane**

```bash
rtk git add packages/server/src/model-routing packages/server/src/dashboard-routes/routing packages/server/src/dashboard-routes/config.ts packages/server/src/dashboard-routes/provider-routes.ts packages/server/src/server-state
rtk git commit -m "feat(server): expose the model routing control plane" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 8: Update Provider default routing controls

**Files:**
- Modify: `packages/dashboard/src/modules/providers/hooks/use-provider-form.ts:35-90`
- Modify: `packages/dashboard/src/modules/providers/hooks/use-oauth-provider-edit-form.ts:1-70`
- Modify: `packages/dashboard/src/modules/providers/lib/oauth-provider-edit/oauth-provider-edit.ts`
- Modify: `packages/dashboard/src/modules/providers/lib/oauth-provider-edit/oauth-provider-edit.test.ts`
- Modify: `packages/dashboard/src/modules/providers/components/provider-common-fields.tsx:20-60`
- Modify: `packages/dashboard/src/modules/providers/components/oauth-provider-edit-fields.tsx:45-90`
- Modify: `packages/dashboard/src/modules/providers/components/providers-table-columns.tsx:115-150, 205-220`
- Modify: `packages/dashboard/src/modules/providers/components/providers-table/providers-table.test.tsx`
- Modify: `packages/dashboard/src/routes/providers/new.$kind.tsx:8-28`
- Modify: `packages/dashboard/src/modules/providers/templates/use-oauth-provider-edit-page.ts`
- Modify: `packages/dashboard/src/modules/providers/services/providers-service.ts`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/ja.json`
- Modify: `packages/i18n/messages/ko.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Modify: `packages/i18n/messages/zh-Hant.json`
- Modify (generated): `packages/i18n/src/paraglide/`

**Interfaces:**
- Consumes: Task 1 Provider schemas and Task 7 provider edit-view normalization facts.
- Produces Provider form values `{ priority?: number; weight?: number }` and Provider table columns for both concepts.

- [ ] **Step 1: Write failing Provider form/table tests**

Add assertions that:

- new Provider forms start with `priority: 0, weight: 1`;
- API/AI SDK and OAuth submit both fields;
- priority input uses integer step and weight input accepts fractional authored values;
- a normalization notice renders when edit-view reports `wasNormalized`;
- Provider table renders separate Priority and Weight columns, defaulting real Providers to `0` and `1`.

Example:

```ts
expect(within(screen.getByTestId('provider-row-api')).getAllByRole('cell')[priorityIndex]).toHaveTextContent('0');
expect(within(screen.getByTestId('provider-row-api')).getAllByRole('cell')[weightIndex]).toHaveTextContent('1');
```

- [ ] **Step 2: Run Provider Dashboard tests and confirm failure**

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit
```

Expected: FAIL because priority controls/copy do not exist and omitted weight still renders as zero.

- [ ] **Step 3: Add priority to all Provider form schemas and payloads**

Update TanStack Form shapes and Zod picks:

```ts
const ApiRoutingSchema = ApiProviderMutationBodySchema.pick({
  kind: true,
  enabled: true,
  priority: true,
  weight: true,
  transforms: true,
});
```

Mirror the field in AI SDK and OAuth forms, `oauthAccountSubmission`, and provider edit initial values. Use `step="1"` for priority and `step="any"` for authored weight; Zod remains authoritative for rounding/clamping on Save.

In `useOAuthProviderEditForm`, submit the parsed routing values rather than spreading the raw draft:

```ts
if (result.success) {
  onSubmit({
    ...value,
    priority: result.data.priority,
    weight: result.data.weight,
    proxy: result.data.proxy,
    transforms: result.data.transforms,
  });
}
```

- [ ] **Step 4: Render Provider priority and normalization copy**

Add a priority field before weight in common and OAuth routing sections. Weight description must say it controls traffic only within one priority. When the edit-view reports authored/effective divergence, render a non-blocking `FieldDescription` such as “Saving will normalize 1.6 to 2.” through i18n.

Do not emit startup toasts or warnings for unknown model/Provider references.

- [ ] **Step 5: Add separate Provider table columns**

Add a sortable priority column and update weight to use the normalized default:

```ts
const priorityColumn = numericRoutingColumn('priority', () => m['dashboard.providers.table.col_priority'](), 0);
const weightColumn = numericRoutingColumn('weight', () => m['dashboard.providers.table.col_weight'](), 1);
```

Keep the helper local to `providers-table-columns.tsx`; it has business-specific table behavior and does not justify a shared utility.

- [ ] **Step 6: Add i18n copy and compile messages**

Add keys for Provider priority, weight distribution, normalization, and table headers in all five locale files. Then run:

```bash
rtk bun run i18n:compile
```

- [ ] **Step 7: Run Provider Dashboard tests**

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit
```

Expected: PASS for API, AI SDK, OAuth, table columns, defaults, and normalization copy.

- [ ] **Step 8: Commit Provider controls**

```bash
rtk git add packages/dashboard/src/modules/providers packages/dashboard/src/routes/providers packages/i18n/messages packages/i18n/src/paraglide
rtk git commit -m "feat(dashboard): edit Provider routing defaults" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 9: Add the Routing Dashboard workspace

**Files:**
- Create: `packages/dashboard/src/routes/routing/index.tsx`
- Modify (generated): `packages/dashboard/src/route-tree.gen.ts`
- Modify: `packages/dashboard/src/components/side-menu/side-menu.tsx:55-85`
- Modify: `packages/dashboard/src/components/side-menu/side-menu.test.tsx`
- Create: `packages/dashboard/src/modules/routing/services/routing-service.ts`
- Create: `packages/dashboard/src/modules/routing/hooks/use-routing-query.ts`
- Create: `packages/dashboard/src/modules/routing/hooks/use-routing-mutation.ts`
- Create: `packages/dashboard/src/modules/routing/hooks/use-routing-form.ts`
- Create: `packages/dashboard/src/modules/routing/lib/routing-summary/routing-summary.ts`
- Create: `packages/dashboard/src/modules/routing/lib/routing-summary/routing-summary.test.ts`
- Create: `packages/dashboard/src/modules/routing/lib/routing-summary/index.ts`
- Create: `packages/dashboard/src/modules/routing/components/routing-table.tsx`
- Create: `packages/dashboard/src/modules/routing/components/routing-table.test.tsx`
- Create: `packages/dashboard/src/modules/routing/components/routing-table-columns.tsx`
- Create: `packages/dashboard/src/modules/routing/components/routing-editor-sheet.tsx`
- Create: `packages/dashboard/src/modules/routing/components/routing-editor-sheet.test.tsx`
- Create: `packages/dashboard/src/modules/routing/components/routing-provider-fields.tsx`
- Create: `packages/dashboard/src/modules/routing/templates/routing-page.tsx`
- Create: `packages/dashboard/src/modules/routing/templates/routing-page.test.tsx`
- Modify: `packages/dashboard/src/lib/query-keys.ts`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/ja.json`
- Modify: `packages/i18n/messages/ko.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Modify: `packages/i18n/messages/zh-Hant.json`
- Modify (generated): `packages/i18n/src/paraglide/`

**Interfaces:**
- Consumes: typed Hono `GET/PUT /routing/models` endpoints and Task 1 DTOs.
- Produces: `/routing` page, model table, one-model Sheet editor, stale-revision recovery, and live tier/share preview.

- [ ] **Step 1: Run the Impeccable context check before UI edits**

```bash
rtk node /Users/baran/.codex/plugins/cache/impeccable/impeccable/4.1.1/skills/impeccable/scripts/context.mjs --target packages/dashboard/src/routes/providers/index.tsx
```

Read the emitted PRODUCT/DESIGN context and `packages/dashboard/AGENTS.md`. Immediately before editing the UI, read Impeccable `reference/craft-floor.md`; do not change the established quiet operational visual system.

- [ ] **Step 2: Write failing pure routing-summary tests**

Create `routing-summary.test.ts`:

```ts
const effective = (providerId: string, priority: number, weight: number) => ({
  providerId,
  priority,
  weight,
  eligible: weight > 0,
});

test('groups eligible Providers into descending priority tiers with shares', () => {
  expect(buildRoutingTiers([
    effective('a', 30, 6000),
    effective('b', 30, 4000),
    effective('c', 20, 1000),
    effective('off', 50, 0),
  ])).toEqual([
    { priority: 30, providers: [{ providerId: 'a', weight: 6000, share: 0.6 }, { providerId: 'b', weight: 4000, share: 0.4 }] },
    { priority: 20, providers: [{ providerId: 'c', weight: 1000, share: 1 }] },
  ]);
});
```

- [ ] **Step 3: Write failing page and Sheet tests**

Mock only the service boundary. Cover:

- all known models render, including zero-eligible and single-Provider models;
- search/filter/pagination use the existing DataTable controls;
- row Edit opens the Sheet;
- blank priority/weight fields mean inherit;
- weight zero shows the model-disabled state;
- changing draft values recomputes tier shares;
- Reset removes one Provider override;
- Save sends the exact revision, baseline IDs, and explicit override map;
- `409 stale_revision` keeps the Sheet open and offers reload;
- `writable: false` disables Save while preserving read-only inspection;
- query error shows Retry; pending save disables duplicate submission.

- [ ] **Step 4: Run Routing UI tests and confirm failure**

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit
```

Expected: FAIL because the route, module, query key, and menu entry do not exist.

- [ ] **Step 5: Implement the typed service, Query hooks, and form**

`routing-service.ts` uses `createDashboardClient()` only:

```ts
export const routingModelsQueryOptions = () => queryOptions({
  queryKey: queryKeys.routingModels,
  queryFn: async () => {
    const response = await dashboardClient.dashboard.api.routing.models.$get();
    if (!response.ok) throw new Error(`routing models failed: ${response.status}`);
    return response.json();
  },
});

export async function updateRoutingModelMutationFn(body: DashboardRoutingModelMutation) {
  const response = await dashboardClient.dashboard.api.routing.models.$put({ json: body });
  if (response.status === 409) {
    const error = new Error('stale routing model');
    Object.assign(error, { code: (await response.json()).error });
    throw error;
  }
  if (!response.ok) throw new Error(`update routing model failed: ${response.status}`);
  return response.json();
}
```

TanStack Form draft values are `Record<providerId, { priority?: number; weight?: number }>` seeded only from explicit overrides. On submit, omit Provider entries with both fields undefined.

- [ ] **Step 6: Implement the table and model editor**

Use `useDataTable`, `DataTableControls`, shared Table, and Pagination. Columns are Model ID, effective route tiers, eligible/known Provider counts, override state, and Edit action.

The Sheet uses shared `Sheet`, `Field`, `Input`, `Badge`, and `Button` components. `RoutingProviderFields` is one component per Provider row and shows:

- Provider ID/name and state;
- default priority/weight with normalization state;
- blank override inputs with inherited default hints;
- effective values and source;
- disabled-for-model label when effective weight is zero.

The Sheet computes live tiers through `buildRoutingTiers()` and saves the full explicit draft for the model. Keep transient open/draft state inside the Routing page/Sheet boundary.

- [ ] **Step 7: Add route, navigation, i18n, and generated route tree**

Create `/routing/` route rendering `RoutingPage`. Add a Configuration menu item labeled `dashboard.menus.routing`, using a Lucide `Shuffle` icon and active match `pathname.startsWith('/routing')`.

Add all Routing page/table/editor/error/save/reset/inherited/disabled/normalized copy to five locale files, then run:

```bash
rtk bun run i18n:compile
rtk bun run --filter @aio-proxy/dashboard build
```

The build regenerates `route-tree.gen.ts`; inspect but do not manually edit it.

- [ ] **Step 8: Run Routing UI tests and build**

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit
rtk bun run --filter @aio-proxy/dashboard build
```

Expected: PASS with typed routes, i18n, responsive table, Sheet focus behavior, read-only mode, and stale-draft preservation.

- [ ] **Step 9: Run the Impeccable detector once**

```bash
rtk node /Users/baran/.codex/plugins/cache/impeccable/impeccable/4.1.1/skills/impeccable/scripts/detect.mjs --json packages/dashboard/src/modules/routing packages/dashboard/src/routes/routing/index.tsx packages/dashboard/src/components/side-menu/side-menu.tsx
```

Fix all reported accessibility, responsive, component, i18n, and design-system violations in one batch. Rerun the affected tests and at most one final detector confirmation.

- [ ] **Step 10: Commit the Routing workspace**

```bash
rtk git add packages/dashboard/src/modules/routing packages/dashboard/src/routes/routing packages/dashboard/src/route-tree.gen.ts packages/dashboard/src/components/side-menu packages/dashboard/src/lib/query-keys.ts packages/i18n/messages packages/i18n/src/paraglide
rtk git commit -m "feat(dashboard): add the model routing workspace" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 10: Document migration, add Changeset, and verify the release

**Files:**
- Modify: `README.md:35-45, 219-230`
- Modify: `AGENTS.md` routing invariants and Domain Language sections
- Create (CLI-generated): one new Markdown file under `.changeset/`

**Interfaces:**
- Consumes: the completed runtime/UI behavior.
- Produces: user migration instructions, authoritative agent invariants, public release note, and a fully verified workspace.

- [ ] **Step 1: Update README routing rules and configuration examples**

Document this exact example and behavior:

```yaml
providers:
  provider-a:
    priority: 0
    weight: 1000
router:
  models:
    model-m:
      providers:
        provider-a: { priority: 30, weight: 6000 }
        provider-b: { priority: 30, weight: 4000 }
        provider-c: { priority: 20 }
```

Explain exact model matching, Provider-qualified precedence, weight zero, stable-session deterministic order, generated-session random order, affinity/owner precedence, and `/v1/models` deterministic representation.

Include the spec migration table: unique weights, equal-weight config-order ties, omitted weight, old zero, fractional values, negative/out-of-range values, and `enabled: false`.

- [ ] **Step 2: Update root AGENTS.md invariants**

Replace every statement that defines weight as fixed priority. The authoritative routing section must say:

1. Resolve the exact Provider-qualified route first, then the exact normal model.
2. Merge Provider defaults with exact model overrides.
3. Remove normal candidates with effective weight zero.
4. Order priority tiers descending and weight within the tier.
5. Stable sessions use deterministic draws; generated sessions use random draws.
6. Response owner and session affinity override candidate order only for eligible normal candidates.
7. The server pipeline remains the only generation candidate loop.

- [ ] **Step 3: Author the minor Changeset with the project CLI**

Run the Changesets CLI non-interactively so the selected packages and bump levels are unambiguous:

```bash
rtk bun changeset \
  --minor aio-proxy \
  --minor @aio-proxy/types \
  --minor @aio-proxy/core \
  --minor @aio-proxy/server \
  --minor @aio-proxy/dashboard \
  --minor @aio-proxy/i18n \
  --message "Add model-level Provider priority and weighted routing, stable-session candidate ordering, routing-v2 diagnostics, and a Dashboard Routing workspace. Provider weight now controls same-priority traffic instead of fixed global order; existing configurations should follow the documented migration table."
```

The command prints the single generated `.changeset/*.md` path. Inspect that file and verify its frontmatter lists exactly the six packages above at `minor` and its body exactly matches the message.

Do not run `changeset version` or `changeset publish`.

- [ ] **Step 4: Run targeted package verification**

```bash
rtk bun run --filter @aio-proxy/types test:unit
rtk bun run --filter @aio-proxy/core test:unit
rtk bun run --filter @aio-proxy/server test:unit
rtk bun run --filter @aio-proxy/dashboard test:unit
rtk bun run --filter @aio-proxy/dashboard build
```

Expected: all commands exit `0` with no failed tests.

- [ ] **Step 5: Run repository preflight**

```bash
rtk bun run preflight
```

Expected: type-aware lint, formatting check, all unit tests, and artifact tests exit `0`.

- [ ] **Step 6: Inspect the final diff for scope and generated files**

```bash
rtk git status --short
rtk git diff --check
rtk git diff --stat origin/main...HEAD
```

Confirm the diff contains only routing feature files, generated migration/route/i18n outputs, README, root AGENTS.md, and the Changeset. Confirm no implementation file exceeds 500 handwritten lines.

- [ ] **Step 7: Commit documentation and release metadata**

```bash
rtk git add README.md AGENTS.md .changeset
rtk git commit -m "docs(router): publish the weighted routing migration" -m "Co-authored-by: Codex <noreply@openai.com>"
```
