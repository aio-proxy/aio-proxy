# Effort Clamping: Runtime Capabilities, `max` Preservation, Alias Ceiling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all three follow-ups in [aio-proxy/aio-proxy#130](https://github.com/aio-proxy/aio-proxy/issues/130) — resolve reasoning-effort capabilities from the runtime provider catalog (not only models.dev), preserve `max` through per-candidate clamping, and stop alias routing from dropping to the base model when the request asks above the alias's effort ceiling.

**Architecture:** Three independent seams, one per issue. (1) `resolveSupportedEfforts` gains a second, higher-precedence source: the candidate's `RuntimeModelMetadata.capabilities.reasoningOptions`, reachable at every call site via `slot.candidate.provider.upstreamMetadata?.[modelId]`; the Google Antigravity plugin starts publishing that metadata so the source is non-empty for it. (2) The canonical effort string (full ladder, including `max`) travels in `settings.providerOptions.aioProxy.effort` from ingress to per-candidate clamping, and only the AI SDK's narrower `settings.reasoning` is folded to the SDK union; Antigravity reads the canonical value back. (3) `matchAliasRows` gains one rule: a request whose effort rank is above every effort row reuses the highest effort row instead of the alias base.

**Tech Stack:** Bun workspace monorepo (Turborepo), TypeScript, Zod 4, `bun:test`, `es-toolkit`, Changesets.

## Global Constraints

- Packages touched: `@aio-proxy/types`, `@aio-proxy/core`, `@aio-proxy/server`, `@aio-proxy/plugin-google-antigravity`.
- Handwritten non-test implementation files: hard limit 500 lines, evaluate splitting at 400. Current sizes to respect: `alias-variant.ts` 224, `reasoning-effort.ts` 108, `effort-capability.ts` 26, `discover.ts` 290, `thinking.ts` 247.
- Colocated tests only: `foo/index.ts` (exports only), `foo/foo.ts`, `foo/foo.test.ts`. Do not add files under `_test/`.
- `isPlainObject` from `es-toolkit/predicate` for parsed/plain data; `isRecord` from `@aio-proxy/shared` for structural TypeScript contracts.
- Effort ladder is fixed and ascending: `none, minimal, low, medium, high, xhigh, max`. Index = rank.
- Clamping is **downgrade-only**. It must never raise the effort above what the client asked for. An empty supported set means verbatim pass-through.
- Per-package test commands:
  - `@aio-proxy/types`: `bun test ./__tests__ ./src`
  - `@aio-proxy/core`: `bun test`
  - `@aio-proxy/server`: `bun test --preload=./__tests__/setup.ts`
  - `@aio-proxy/plugin-google-antigravity`: `bun test --preload=./test/setup.ts`
- Before considering the work complete: `bun run preflight` from the repo root.
- Changesets: the final changeset MUST target `aio-proxy` plus every internal package touched, all at the same bump level. Never a changeset targeting only internal packages.

---

## File Structure

**Create:**
- `packages/plugins/google-antigravity/src/catalog/effort-metadata/index.ts` — exports only.
- `packages/plugins/google-antigravity/src/catalog/effort-metadata/effort-metadata.ts` — derives per-wire `modelMetadata.capabilities.reasoningOptions` from a collapsed family list.
- `packages/plugins/google-antigravity/src/catalog/effort-metadata/effort-metadata.test.ts`
- `.changeset/effort-clamping-runtime-capabilities.md`

**Modify:**
- `packages/types/src/alias-variant/alias-variant.ts` — export `EFFORT_LADDER`, `effortRank`; add the above-ceiling rule to `matchAliasRows`.
- `packages/types/src/index.ts` — export the two new symbols.
- `packages/types/src/alias-variant/alias-variant.test.ts` — new tests.
- `packages/core/src/protocol/reasoning-effort/reasoning-effort.ts` — import the ladder from types; add `reasoningSettings`; teach `clampSdkReasoning` to read/write the canonical effort.
- `packages/core/src/protocol/reasoning-effort/index.ts` — export `reasoningSettings`.
- `packages/core/src/protocol/reasoning-effort/reasoning-effort.test.ts` — new tests.
- `packages/core/src/protocol/openai-responses.ts` — use `reasoningSettings`.
- `packages/core/src/transform/openai-completions/openai-completions.ts` — use `reasoningSettings`.
- `packages/server/src/routes/pipeline/attempt/effort-capability/effort-capability.ts` — accept runtime metadata, prefer it over models.dev.
- `packages/server/src/routes/pipeline/attempt/effort-capability/effort-capability.test.ts` — new tests.
- `packages/server/src/routes/pipeline/attempt/model-prepare.ts`, `attempt/raw.ts`, `routes/token-count/token-count.ts`, `routes/token-count/raw/raw.ts` — pass the candidate's metadata.
- `packages/plugins/google-antigravity/src/catalog/discover.ts` — attach the derived metadata in `assembleAntigravityCatalog`.
- `packages/plugins/google-antigravity/src/runtime/private-options.ts` — accept `aioProxy.effort`.
- `packages/plugins/google-antigravity/src/runtime/google-model.ts` — prefer the canonical effort in `synthesizeThinking`.
- `packages/plugins/google-antigravity/src/runtime/token-count.ts` — third `synthesizeThinking` caller, updated for the new signature.
- `packages/plugins/google-antigravity/src/runtime/google-model.test.ts` — new tests.

**Deliberately NOT changed:** `packages/plugins/google-antigravity/src/catalog/aliases.ts` `xhighRow`. It is not redundant with Task 1: `xhighRow` maps `xhigh` to `tiered ?? high`, deliberately preferring the *tiered* wire, whereas the generic ceiling rule reuses the highest **effort row** (the `high` wire). Both must stay — the explicit row wins because `matchAliasRows` finds an exact match and never consults the ceiling rule.

---

### Task 1: Alias routing reuses the effort ceiling instead of the base model

**Problem:** `matchAliasRows` matches `when.effort` by exact equality. An alias with rows through `high` receives an `xhigh` or `max` request, matches nothing, and returns the alias *base* — which for a split family is typically the lowest or medium wire. Clamping runs later, in `prepareModelInvocation`, and cannot undo the routing choice.

**Scope decision (do not widen):** only the *above-ceiling* case is fixed — a request whose effort rank is strictly greater than every matching effort row's rank — and only when that ceiling row is itself at or above `medium`. Two cases keep falling back to the alias base:

- **Middle gaps** (rows `{low, high}`, request `medium`): a higher row exists, so this is a gap, not a ceiling.
- **Ceiling below medium** (rows `{low}`, request `medium` or `high`): the alias base is conventionally the medium tier, so reusing a `low` wire would *downgrade* traffic below the base. Falling back to the base is the better answer.

The `medium` floor is what makes "the base is conventionally the medium tier" actually hold: without it, a single-`low`-row alias would steal every request above `low` down to `low`. The existing test `missing row returns alias default` (`resolveAliasTarget`, variants `{low}`, request `medium`) is a **ceiling-below-medium** case and MUST keep passing unchanged.

**Files:**
- Modify: `packages/types/src/alias-variant/alias-variant.ts`
- Modify: `packages/types/src/index.ts:3-13`
- Test: `packages/types/src/alias-variant/alias-variant.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export const EFFORT_LADDER: readonly ['none','minimal','low','medium','high','xhigh','max']`
  - `export function effortRank(effort: string): number` — index in `EFFORT_LADDER` after `canonicalEffort` folding, or `-1` when off-ladder.
  - `matchAliasRows(rows: readonly AliasSelectRow[], dimensions: AliasDimensions, fallback: AliasTarget): AliasTarget` — signature unchanged, behavior extended.

- [ ] **Step 1: Write the failing tests**

Append to `packages/types/src/alias-variant/alias-variant.test.ts`:

```ts
describe('matchAliasRows effort ceiling', () => {
  const rows: AliasSelectRow[] = [
    { when: { effort: 'low' }, model: 'wire-low', preserve: false },
    { when: { effort: 'medium' }, model: 'wire-medium', preserve: false },
    { when: { effort: 'high' }, model: 'wire-high', preserve: false },
  ];
  const fallback = { model: 'wire-base', preserve: true };

  test('an effort above every row reuses the highest effort row', () => {
    expect(matchAliasRows(rows, { effort: 'xhigh' }, fallback)).toEqual({ model: 'wire-high', preserve: false });
    expect(matchAliasRows(rows, { effort: 'max' }, fallback)).toEqual({ model: 'wire-high', preserve: false });
  });

  test('folds alias spellings before comparing against the ceiling', () => {
    expect(matchAliasRows(rows, { effort: 'X-High' }, fallback)).toEqual({ model: 'wire-high', preserve: false });
  });

  test('an off-ladder effort still falls back', () => {
    expect(matchAliasRows(rows, { effort: 'lowx' }, fallback)).toEqual(fallback);
  });

  test('an effort inside a gap still falls back to the alias default', () => {
    // Deliberate: a higher row exists, so this is a gap, not a ceiling.
    const gapped: AliasSelectRow[] = [
      { when: { effort: 'low' }, model: 'wire-low', preserve: false },
      { when: { effort: 'high' }, model: 'wire-high', preserve: false },
    ];
    expect(matchAliasRows(gapped, { effort: 'medium' }, fallback)).toEqual(fallback);
  });

  test('a ceiling below medium never captures the request', () => {
    // The alias base is conventionally the medium tier, so reusing a `low`
    // wire would downgrade below the base rather than approximate it.
    const lowOnly: AliasSelectRow[] = [{ when: { effort: 'low' }, model: 'wire-low', preserve: false }];
    expect(matchAliasRows(lowOnly, { effort: 'medium' }, fallback)).toEqual(fallback);
    expect(matchAliasRows(lowOnly, { effort: 'max' }, fallback)).toEqual(fallback);
    const mediumOnly: AliasSelectRow[] = [{ when: { effort: 'medium' }, model: 'wire-medium', preserve: false }];
    expect(matchAliasRows(mediumOnly, { effort: 'max' }, fallback)).toEqual({
      model: 'wire-medium',
      preserve: false,
    });
  });

  test('the ceiling row must agree with the request on thinking and speed', () => {
    const mixed: AliasSelectRow[] = [
      { when: { effort: 'high', thinking: true }, model: 'wire-thinking-high', preserve: false },
      { when: { effort: 'medium' }, model: 'wire-medium', preserve: false },
    ];
    // thinking is absent from the request, so the thinking:true row is not eligible.
    expect(matchAliasRows(mixed, { effort: 'xhigh' }, fallback)).toEqual({ model: 'wire-medium', preserve: false });
    expect(matchAliasRows(mixed, { effort: 'xhigh', thinking: true }, fallback)).toEqual({
      model: 'wire-thinking-high',
      preserve: false,
    });
  });

  test('rows without an effort constraint never act as the ceiling', () => {
    const thinkingOnly: AliasSelectRow[] = [{ when: { thinking: true }, model: 'wire-thinking', preserve: false }];
    expect(matchAliasRows(thinkingOnly, { effort: 'max' }, fallback)).toEqual(fallback);
  });
});

describe('effortRank', () => {
  test('ranks the ladder ascending and folds spellings', () => {
    expect(effortRank('none')).toBe(0);
    expect(effortRank('max')).toBe(6);
    expect(effortRank('X_HIGH')).toBe(5);
  });

  test('returns -1 for an off-ladder effort', () => {
    expect(effortRank('ultra')).toBe(-1);
  });
});
```

Add `effortRank` to that file's existing import from `./alias-variant`, and `AliasSelectRow` to its type imports if it is not already imported there.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/types && bun test ./src/alias-variant
```

Expected: FAIL — `effortRank is not a function`, and the ceiling tests return `wire-base`.

- [ ] **Step 3: Implement the ladder and the ceiling rule**

In `packages/types/src/alias-variant/alias-variant.ts`, add below `canonicalEffort` (around line 19):

```ts
/** Ascending reasoning-effort ladder shared by alias routing and wire-path clamping. Index = rank. */
export const EFFORT_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Rank of an effort on EFFORT_LADDER after spelling folding, or -1 when off-ladder. */
export function effortRank(effort: string): number {
  return EFFORT_LADDER.indexOf(canonicalEffort(effort) as (typeof EFFORT_LADDER)[number]);
}
```

Replace the body of `matchAliasRows` (currently at line 201) with:

```ts
export function matchAliasRows(
  rows: readonly AliasSelectRow[],
  dimensions: AliasDimensions,
  fallback: AliasTarget,
): AliasTarget {
  const bag = canonicalizeDimensions(dimensions);
  const matches = rows.filter((row) => rowMatches(row.when, bag));
  if (matches.length === 0) return effortCeiling(rows, bag) ?? fallback;
  const maximal = matches.filter(
    (row) => !matches.some((other) => other !== row && isStrictSubset(row.when, other.when)),
  );
  let winner = maximal[0]!;
  for (const row of maximal.slice(1)) {
    if (whenRank(row.when) > whenRank(winner.when)) winner = row;
  }
  return { model: winner.model, preserve: winner.preserve };
}

// A request asking above every effort row this alias declares must reuse the
// alias's top effort row, not drop to the base model (which is typically a lower
// tier). Two cases deliberately fall back instead: an effort inside a gap between
// rows (a higher row exists), and a ceiling below `medium` (the alias base is
// conventionally the medium tier, so a `low` wire would downgrade below it).
const CEILING_FLOOR_RANK = EFFORT_LADDER.indexOf('medium');

function effortCeiling(rows: readonly AliasSelectRow[], bag: AliasDimensions): AliasTarget | undefined {
  const wanted = bag.effort === undefined ? -1 : effortRank(bag.effort);
  if (wanted === -1) return undefined;
  let best: { readonly row: AliasSelectRow; readonly rank: number } | undefined;
  for (const row of rows) {
    if (row.when.effort === undefined) continue;
    // Every non-effort constraint must still hold, so a thinking-only variant
    // never captures a non-thinking request.
    if (!rowMatches({ ...row.when, effort: undefined }, bag)) continue;
    const rank = effortRank(row.when.effort);
    if (rank === -1 || rank >= wanted) return undefined;
    if (best === undefined || rank > best.rank || (rank === best.rank && whenRank(row.when) > whenRank(best.row.when)))
      best = { row, rank };
  }
  if (best === undefined || best.rank < CEILING_FLOOR_RANK) return undefined;
  return { model: best.row.model, preserve: best.row.preserve };
}
```

Note: `rowMatches` skips `undefined` values, so `{ ...row.when, effort: undefined }` checks exactly the non-effort constraints. The `rank >= wanted` early return guarantees the rule only fires when the request is strictly above every eligible row (an equal-rank row would have matched exactly, and a higher-rank row means this is a gap, not a ceiling). Equal-rank eligible rows break the tie by `whenRank` — most specific wins — mirroring the main match path. `CEILING_FLOOR_RANK` keeps a sub-medium ceiling from downgrading traffic below the alias base.

- [ ] **Step 4: Export the new symbols**

In `packages/types/src/index.ts`, extend the existing named export block from `./alias-variant` (lines 3-12) to include `EFFORT_LADDER` and `effortRank`, keeping the list alphabetically sorted:

```ts
export {
  canonicalEffort,
  EFFORT_LADDER,
  effortRank,
  flattenAliasVariants,
  foldEffortSpelling,
  isAliasVariantSelect,
  isAliasVariantsObject,
  matchAliasRows,
  whenIdentity,
  whenRank,
} from './alias-variant';
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/types && bun test ./__tests__ ./src
```

Expected: PASS, including the pre-existing `missing row returns alias default` and `missing effort level returns fallback` tests.

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/alias-variant packages/types/src/index.ts && git commit -m "fix(types): route above-ceiling effort to the top alias variant"
```

---

### Task 2: Resolve effort capabilities from the runtime provider catalog

**Problem:** `resolveSupportedEfforts` reads only the models.dev cached catalog. A plugin-backed provider whose wire ids are not models.dev ids returns an empty set, which `normalizeEffort` treats as pass-through, so an unsupported level reaches the provider unchanged.

**Files:**
- Modify: `packages/server/src/routes/pipeline/attempt/effort-capability/effort-capability.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/model-prepare.ts:60-69`
- Modify: `packages/server/src/routes/pipeline/attempt/raw.ts:25-31`
- Modify: `packages/server/src/routes/token-count/token-count.ts:226-233`
- Modify: `packages/server/src/routes/token-count/raw/raw.ts:66-73`
- Test: `packages/server/src/routes/pipeline/attempt/effort-capability/effort-capability.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `resolveSupportedEfforts(modelId: string, metadata?: RuntimeModelMetadata): Promise<ReadonlySet<string>>`
  - `resolveSupportedEffortsForDimensions(dimensions: AliasDimensions, modelId: string, metadata?: RuntimeModelMetadata): Promise<ReadonlySet<string>>`
  - `RuntimeModelMetadata` is `ModelMetadata & { protocol?: ProviderProtocol }` from `packages/server/src/runtime.ts:37`; its `capabilities.reasoningOptions` is the camelCased `ReasoningOptionSchema` array (`{ type: 'effort', values: (string | null)[] }`).
  - Both are re-exported unchanged from `packages/server/src/routes/pipeline/index.ts:328`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/src/routes/pipeline/attempt/effort-capability/effort-capability.test.ts`:

```ts
describe('runtime provider metadata precedence', () => {
  test('prefers the runtime provider capabilities over models.dev', async () => {
    await seedModelsDevCatalog({
      'claude-opus-4-6-thinking': modelsDevModel('claude-opus-4-6-thinking', 'Opus', {
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] }],
      }),
    });
    const result = await resolveSupportedEfforts('claude-opus-4-6-thinking', {
      capabilities: { reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high', 'max'] }] },
    });
    expect([...result].sort()).toEqual(['high', 'low', 'max', 'medium']);
  });

  test('falls back to models.dev when the runtime metadata advertises no effort option', async () => {
    await seedModelsDevCatalog({
      'gpt-effort': modelsDevModel('gpt-effort', 'GPT Effort', {
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      }),
    });
    expect([...(await resolveSupportedEfforts('gpt-effort', { capabilities: { reasoning: true } }))].sort()).toEqual([
      'high',
      'low',
    ]);
    expect([...(await resolveSupportedEfforts('gpt-effort', undefined))].sort()).toEqual(['high', 'low']);
  });

  test('drops null and default placeholders from advertised values', async () => {
    await seedEmptyModelsDevCatalog();
    const result = await resolveSupportedEfforts('wire-model', {
      capabilities: { reasoningOptions: [{ type: 'effort', values: [null, 'default', 'low', 'high'] }] },
    });
    expect([...result].sort()).toEqual(['high', 'low']);
  });

  test('an empty runtime effort list falls back rather than disabling clamping', async () => {
    await seedModelsDevCatalog({
      'gpt-effort': modelsDevModel('gpt-effort', 'GPT Effort', {
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low'] }],
      }),
    });
    const result = await resolveSupportedEfforts('gpt-effort', {
      capabilities: { reasoningOptions: [{ type: 'effort', values: [] }] },
    });
    expect([...result]).toEqual(['low']);
  });

  test('forDimensions passes runtime metadata through and still skips when effort is absent', async () => {
    await seedEmptyModelsDevCatalog();
    const metadata = { capabilities: { reasoningOptions: [{ type: 'effort' as const, values: ['low', 'high'] }] } };
    expect((await resolveSupportedEffortsForDimensions({}, 'wire-model', metadata)).size).toBe(0);
    expect([...(await resolveSupportedEffortsForDimensions({ effort: 'max' }, 'wire-model', metadata))].sort()).toEqual([
      'high',
      'low',
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts ./src/routes/pipeline/attempt/effort-capability
```

Expected: FAIL — the extra argument is ignored, so every metadata-preferring assertion returns the models.dev set (or an empty set).

- [ ] **Step 3: Implement the runtime-first lookup**

Replace `packages/server/src/routes/pipeline/attempt/effort-capability/effort-capability.ts` with:

```ts
import { getModelsCachedOnly, modelEffortValues } from '@aio-proxy/core';
import type { AliasDimensions } from '@aio-proxy/types';

import type { RuntimeModelMetadata } from '../../../../runtime';

// Resolve the effort levels a candidate model advertises. The selected runtime
// provider's own catalog metadata wins: a plugin-backed wire id (e.g. Antigravity's
// `claude-opus-4-6-thinking`) is not a models.dev id, and models.dev would return an
// empty set — which normalizeEffort treats as pass-through, forwarding a level the
// provider rejects. models.dev remains the fallback for API providers that publish
// no capability metadata of their own.
//
// The models.dev read is cached-only: this runs on the request hot path and must
// never trigger or await a network catalog fetch. The catalog is warmed elsewhere
// (e.g. the /v1/models route), so steady-state requests still clamp.
export async function resolveSupportedEfforts(
  modelId: string,
  metadata?: RuntimeModelMetadata,
): Promise<ReadonlySet<string>> {
  const advertised = runtimeEffortValues(metadata);
  if (advertised.size > 0) return advertised;
  try {
    const models = await getModelsCachedOnly([modelId]);
    return modelEffortValues(models[modelId]);
  } catch {
    return new Set();
  }
}

// When the inbound request carries no effort, there is nothing to clamp and
// the capability lookup is pure overhead — short-circuit before touching it.
export async function resolveSupportedEffortsForDimensions(
  dimensions: AliasDimensions,
  modelId: string,
  metadata?: RuntimeModelMetadata,
): Promise<ReadonlySet<string>> {
  if (dimensions.effort === undefined) return new Set();
  return resolveSupportedEfforts(modelId, metadata);
}

// Reads the camelCased ModelMetadata shape (mirrors toAnthropicCapabilitiesFromMetadata).
// `null` means "reasoning can be disabled" and `default` is a placeholder; neither is a
// clampable ladder level, so both are dropped.
function runtimeEffortValues(metadata: RuntimeModelMetadata | undefined): ReadonlySet<string> {
  const option = metadata?.capabilities?.reasoningOptions?.find((entry) => entry.type === 'effort');
  if (option === undefined) return new Set();
  return new Set(option.values.filter((value): value is string => value !== null && value !== 'default'));
}
```

- [ ] **Step 4: Pass the candidate's metadata at all four call sites**

`packages/server/src/routes/pipeline/attempt/model-prepare.ts`, inside `prepareModelInvocation`:

```ts
  const supportedEfforts = await resolveSupportedEffortsForDimensions(
    ctx.adapter.dimensions(ctx.request, ctx.context),
    slot.candidate.modelId,
    slot.candidate.provider.upstreamMetadata?.[slot.candidate.modelId],
  );
```

`packages/server/src/routes/pipeline/attempt/raw.ts`, inside `attemptRawCandidate`:

```ts
  const supportedEfforts = await resolveSupportedEffortsForDimensions(
    adapter.dimensions(request, context),
    slot.candidate.modelId,
    slot.candidate.provider.upstreamMetadata?.[slot.candidate.modelId],
  );
```

`packages/server/src/routes/token-count/token-count.ts` (the `dimensions` const stays hoisted above the loop):

```ts
    const supportedEfforts = await resolveSupportedEffortsForDimensions(
      dimensions,
      candidate.modelId,
      provider.upstreamMetadata?.[candidate.modelId],
    );
```

`packages/server/src/routes/token-count/raw/raw.ts`, inside the `try` block:

```ts
    const supportedEfforts = await resolveSupportedEffortsForDimensions(
      adapter.dimensions(request, context),
      candidate.modelId,
      candidate.provider.upstreamMetadata?.[candidate.modelId],
    );
```

- [ ] **Step 5: Run the package tests**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts
```

Expected: PASS. `upstreamMetadata` is optional on `RuntimeProviderBase`, so existing tests that build providers without it keep the previous models.dev behavior.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routes && git commit -m "fix(server): resolve effort capabilities from the runtime provider catalog first"
```

---

### Task 3: Google Antigravity publishes its per-wire effort capabilities

**Problem:** Task 2 gives the host a runtime-metadata source, but Antigravity descriptors carry only `extra.antigravity` and never `modelMetadata`, so the new source is empty for exactly the provider that motivated the issue. The host must not read `extra` — `DescriptorModelMetadata` is the typed boundary.

The per-wire effort sets follow the plugin's own thinking implementation in `src/protocol/thinking.ts`:
- `claude` mode: `CLAUDE_ADAPTIVE` keys — `low, medium, high, max`.
- `gemini` mode: `none, low, medium, high` (from `GEMINI_EFFORTS`, minus `off` which is not a ladder level), plus `minimal` only when the wire satisfies `geminiMinimal` — id ends with `-extra-low` and `thinkingBudget > 0`.
- `none` mode: no `reasoningOptions` at all, so the host falls back to models.dev exactly as today.

**Files:**
- Create: `packages/plugins/google-antigravity/src/catalog/effort-metadata/effort-metadata.ts`
- Create: `packages/plugins/google-antigravity/src/catalog/effort-metadata/index.ts`
- Create: `packages/plugins/google-antigravity/src/catalog/effort-metadata/effort-metadata.test.ts`
- Modify: `packages/plugins/google-antigravity/src/catalog/discover.ts:204-235`

**Interfaces:**
- Consumes: `resolveSupportedEfforts` from Task 2 reads `modelMetadata.capabilities.reasoningOptions`.
- Produces:
  - `export function withEffortMetadata(language: readonly ModelDescriptor[], families: readonly AntigravityFamily[]): ModelDescriptor[]`
  - `ModelDescriptor.modelMetadata` is `DescriptorModelMetadata = Pick<ModelMetadataInput, 'name'|'description'|'limit'|'capabilities'|'cost'>` (`packages/plugin-sdk/src/runtime.ts:93`). Anything outside that allowlist is dropped by `DescriptorModelMetadataSchema` in `packages/core/src/plugins/catalog.ts:44` — the gate is fail-soft, so an invalid shape silently disables clamping again.
  - `AntigravityFamily` and `Effort` come from `../collapse`; `ThinkingMode` and `classifyProvider` from `../classify`.

- [ ] **Step 1: Write the failing test**

Create `packages/plugins/google-antigravity/src/catalog/effort-metadata/effort-metadata.test.ts`:

```ts
import { expect, test } from 'bun:test';

import type { ModelDescriptor } from '@aio-proxy/plugin-sdk';

import type { AntigravityFamily } from '../collapse';
import { withEffortMetadata } from './effort-metadata';

const claudeFamily: AntigravityFamily = {
  logicalId: 'claude-opus-4-6',
  kind: 'same-wire',
  thinking: { mode: 'claude' },
  base: 'claude-opus-4-6-thinking',
  variants: [
    { effort: 'low', model: 'claude-opus-4-6-thinking' },
    { effort: 'medium', model: 'claude-opus-4-6-thinking' },
    { effort: 'high', model: 'claude-opus-4-6-thinking' },
  ],
};

const geminiFamily: AntigravityFamily = {
  logicalId: 'gemini-3.5-flash',
  kind: 'split',
  thinking: { mode: 'gemini' },
  base: 'gemini-3.5-flash-low',
  variants: [
    { effort: 'low', model: 'gemini-3.5-flash-extra-low' },
    { effort: 'medium', model: 'gemini-3.5-flash-low' },
    { effort: 'high', model: 'gemini-3-flash-agent' },
  ],
};

function effortValues(descriptors: readonly ModelDescriptor[], id: string): readonly (string | null)[] | undefined {
  const option = descriptors
    .find((descriptor) => descriptor.id === id)
    ?.modelMetadata?.capabilities?.reasoningOptions?.find((entry) => entry.type === 'effort');
  return option?.values;
}

test('a claude wire advertises the adaptive budget ladder including max', () => {
  const result = withEffortMetadata([{ id: 'claude-opus-4-6-thinking' }], [claudeFamily]);
  expect(effortValues(result, 'claude-opus-4-6-thinking')).toEqual(['low', 'medium', 'high', 'max']);
});

test('a gemini wire advertises the gemini ladder without xhigh or max', () => {
  const result = withEffortMetadata([{ id: 'gemini-3.5-flash-low' }], [geminiFamily]);
  expect(effortValues(result, 'gemini-3.5-flash-low')).toEqual(['none', 'low', 'medium', 'high']);
});

test('only an extra-low gemini wire with a positive budget advertises minimal', () => {
  const withBudget: ModelDescriptor = {
    id: 'gemini-3.5-flash-extra-low',
    extra: { antigravity: { thinkingBudget: 1000 } },
  };
  const withoutBudget: ModelDescriptor = {
    id: 'gemini-3.5-flash-extra-low',
    extra: { antigravity: { thinkingBudget: -1 } },
  };
  expect(effortValues(withEffortMetadata([withBudget], [geminiFamily]), 'gemini-3.5-flash-extra-low')).toEqual([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
  ]);
  expect(effortValues(withEffortMetadata([withoutBudget], [geminiFamily]), 'gemini-3.5-flash-extra-low')).toEqual([
    'none',
    'low',
    'medium',
    'high',
  ]);
});

test('a non-reasoning wire advertises nothing so the host falls back to models.dev', () => {
  const result = withEffortMetadata([{ id: 'gpt-oss-120b', extra: { antigravity: { apiProvider: 'openai' } } }], []);
  expect(result[0]?.modelMetadata).toBeUndefined();
});

test('preserves every other descriptor field and existing modelMetadata', () => {
  const result = withEffortMetadata(
    [
      {
        id: 'claude-opus-4-6-thinking',
        displayName: 'Claude Opus 4.6 (Thinking)',
        extra: { antigravity: { apiProvider: 'anthropic' } },
        modelMetadata: { description: 'kept' },
      },
    ],
    [claudeFamily],
  );
  expect(result[0]?.displayName).toBe('Claude Opus 4.6 (Thinking)');
  expect(result[0]?.extra).toEqual({ antigravity: { apiProvider: 'anthropic' } });
  expect(result[0]?.modelMetadata?.description).toBe('kept');
});

test('classifies an unfamilied wire by its descriptor when no family claims it', () => {
  const result = withEffortMetadata([{ id: 'claude-sonnet-4-6', extra: { antigravity: { apiProvider: 'anthropic' } } }], []);
  expect(effortValues(result, 'claude-sonnet-4-6')).toEqual(['low', 'medium', 'high', 'max']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/plugins/google-antigravity && bun test --preload=./test/setup.ts ./src/catalog/effort-metadata
```

Expected: FAIL — `Cannot find module './effort-metadata'`.

- [ ] **Step 3: Implement the derivation**

Create `packages/plugins/google-antigravity/src/catalog/effort-metadata/effort-metadata.ts`:

```ts
import type { ModelDescriptor } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { classifyProvider, type ThinkingMode } from '../classify';
import type { AntigravityFamily } from '../collapse';

// Effort levels each thinking mode actually accepts, mirroring src/protocol/thinking.ts:
// claude wires resolve an adaptive budget from CLAUDE_ADAPTIVE, gemini wires go through
// normalizeGeminiEffort (which folds xhigh down to high and rejects everything above).
// Publishing these lets the host clamp before the plugin has to throw.
//
// The literal type matters: ModelMetadataInput types reasoningOptions[].values as the
// ReasoningEffort enum union, so a plain string[] is not assignable.
type AdvertisedEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'max';

const CLAUDE_EFFORTS: readonly AdvertisedEffort[] = ['low', 'medium', 'high', 'max'];
const GEMINI_EFFORTS: readonly AdvertisedEffort[] = ['none', 'low', 'medium', 'high'];
const GEMINI_MINIMAL_EFFORTS: readonly AdvertisedEffort[] = ['none', 'minimal', 'low', 'medium', 'high'];
const GEMINI_MINIMAL_SUFFIX = '-extra-low';

export function withEffortMetadata(
  language: readonly ModelDescriptor[],
  families: readonly AntigravityFamily[],
): ModelDescriptor[] {
  const modeByWire = new Map<string, ThinkingMode>();
  for (const family of families) {
    // suppressedWireIds are hidden from the picker but still routable, so they
    // must inherit their family's mode rather than fall back to classifyProvider.
    for (const id of [
      family.base,
      ...family.variants.map((variant) => variant.model),
      ...(family.suppressedWireIds ?? []),
    ]) {
      modeByWire.set(id, family.thinking.mode);
    }
  }
  return language.map((descriptor) => {
    const values = effortValues(descriptor, modeByWire.get(descriptor.id) ?? classifyProvider(descriptor));
    if (values === undefined) return descriptor;
    return {
      ...descriptor,
      modelMetadata: {
        ...descriptor.modelMetadata,
        capabilities: {
          ...descriptor.modelMetadata?.capabilities,
          reasoning: true,
          reasoningOptions: [{ type: 'effort', values: [...values] }],
        },
      },
    };
  });
}

function effortValues(descriptor: ModelDescriptor, mode: ThinkingMode): readonly AdvertisedEffort[] | undefined {
  if (mode === 'claude') return CLAUDE_EFFORTS;
  if (mode !== 'gemini') return undefined;
  // geminiMinimal only accepts an extra-low wire carrying a positive budget.
  const minimal = descriptor.id.endsWith(GEMINI_MINIMAL_SUFFIX) && thinkingBudget(descriptor) > 0;
  return minimal ? GEMINI_MINIMAL_EFFORTS : GEMINI_EFFORTS;
}

function thinkingBudget(descriptor: ModelDescriptor): number {
  if (!isPlainObject(descriptor.extra)) return 0;
  const source = isPlainObject(descriptor.extra['antigravity']) ? descriptor.extra['antigravity'] : descriptor.extra;
  const budget = source['thinkingBudget'];
  return typeof budget === 'number' && Number.isFinite(budget) ? budget : 0;
}
```

Create `packages/plugins/google-antigravity/src/catalog/effort-metadata/index.ts`:

```ts
export { withEffortMetadata } from './effort-metadata';
```

- [ ] **Step 4: Attach it in `assembleAntigravityCatalog`**

In `packages/plugins/google-antigravity/src/catalog/discover.ts`, add the import next to the existing `./collapse` import:

```ts
import { withEffortMetadata } from './effort-metadata';
```

Then rewrite `assembleAntigravityCatalog`'s body so families are computed once and reused (they were previously built inline inside the returned object):

```ts
export function assembleAntigravityCatalog(
  language: readonly ModelDescriptor[],
  picker: AntigravityPickerFields = {},
): ModelCatalog {
  const languageIds = new Set(language.map((model) => model.id));
  const pickerIds = pickerModelIds({
    languageIds,
    tieredModelIds: picker.tieredModelIds,
    agentModelSorts: picker.agentModelSorts,
  });
  const descriptorsById = new Map(language.map((model) => [model.id, model]));
  const families = collapseAntigravityFamilies({
    pickerIds,
    descriptorsById,
    deprecatedModelIds: picker.deprecatedModelIds,
  });
  return {
    language: withEffortMetadata(language, families),
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
    extra: {
      antigravityPicker: {
        ...(picker.agentModelSorts === undefined ? {} : { agentModelSorts: picker.agentModelSorts }),
        ...(picker.tieredModelIds === undefined ? {} : { tieredModelIds: picker.tieredModelIds }),
        ...(picker.deprecatedModelIds === undefined ? {} : { deprecatedModelIds: picker.deprecatedModelIds }),
      },
      antigravityFamilies: families,
    } as JsonValue,
  };
}
```

`withEffortMetadata` receives the original `language` array, so `descriptorsById`, `pickerIds`, and family collapsing all still see the un-annotated descriptors — the annotation is the last step.

- [ ] **Step 5: Run the package tests**

```bash
cd packages/plugins/google-antigravity && bun test --preload=./test/setup.ts
```

Expected: PASS. The existing `discover.test.ts` assertions that use `toEqual` on a whole descriptor (`omits maxOutputTokens…`, `persists thinking budgets…`) call `normalizeDiscoveredModels` directly, which this task does not change; the ones that go through `assembleAntigravityCatalog` assert only `.id` lists or `.extra`, which are untouched. If any assertion does fail, the annotation leaked somewhere it should not have — fix the code, not the assertion.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/google-antigravity/src/catalog && git commit -m "feat(antigravity): publish per-wire reasoning effort capabilities"
```

---

### Task 4: Preserve `max` through per-candidate clamping

**Problem:** `reasoningSetting` folds `max` to `xhigh` at ingress, before candidate capabilities are known. A candidate advertising `low/medium/high/max` then receives `xhigh`, and `normalizeEffort('xhigh', {…max})` clamps it to `high` — a provider that actually supports `max` gets `high`.

**Approach:** the AI SDK v4 `LanguageModelCallOptions.reasoning` union has no `max` (`@ai-sdk/provider@4.0.1` `index.d.ts:2166`), so the canonical effort cannot ride in `settings.reasoning`. It rides in `settings.providerOptions.aioProxy.effort` — the private channel that already carries `logicalRequest`, `routingContinuity`, and (for Anthropic inbound) `thinking`. Ingress writes both representations; clamping reads the canonical one, clamps once, and writes both back. The Anthropic path already carries the raw effort in `aioProxy.thinking.effort` and needs no change.

**Files:**
- Modify: `packages/core/src/protocol/reasoning-effort/reasoning-effort.ts`
- Modify: `packages/core/src/protocol/reasoning-effort/index.ts`
- Modify: `packages/core/src/protocol/openai-responses.ts:70-82`
- Modify: `packages/core/src/transform/openai-completions/openai-completions.ts:104-111`
- Test: `packages/core/src/protocol/reasoning-effort/reasoning-effort.test.ts`

**Interfaces:**
- Consumes: `EFFORT_LADDER` from Task 1 (`@aio-proxy/types`), replacing the module-local `LADDER`.
- Produces:
  - `export function reasoningSettings<T extends object>(settings: T, effort: string | undefined): T` — merges `reasoning` (SDK-folded) and `providerOptions.aioProxy.effort` (canonical, full ladder) into an existing settings object without clobbering other `providerOptions` namespaces.
  - **Why `T extends object` and not `T extends AiSdkCallSettings`:** `AiSdkCallSettings` is `LanguageModelCallOptions & Partial<Pick<RequestOptions, …>>` (`packages/core/src/ai-sdk-bridge/index.ts`), and `LanguageModelCallOptions` (`ai@7.0.8` `dist/index.d.ts:524-586`) declares **no** `providerOptions` member. The two call sites also pass transform-level settings shapes carrying keys the SDK type does not have (`stream`, `responseFormat`), so a tighter constraint fails assignability. The function reaches `providerOptions` through a local carrier type instead — the same idiom as `SettingsWithThinking` in `packages/core/src/protocol/anthropic-messages/effort.ts` and `AiSdkProviderInvokeRequest.settings` in `packages/core/src/provider/ai-sdk/ai-sdk.ts:48`.
  - `clampSdkReasoning(invocation, supported)` — signature unchanged; now sources the effort from `providerOptions.aioProxy.effort` when present, and writes the clamped canonical value back there as well as into `settings.reasoning`. It reads that key through the same carrier cast, because `ModelInvocation['settings']` is `AiSdkCallSettings` and likewise has no declared `providerOptions`.
  - `reasoningSetting(effort)` is **removed**; both call sites move to `reasoningSettings`.
  - Wire contract consumed by Task 5: `settings.providerOptions.aioProxy.effort` is a canonical lowercase ladder value.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/protocol/reasoning-effort/reasoning-effort.test.ts`, replace the `reasoningSetting` import with `reasoningSettings` and replace the existing `describe('reasoningSetting', …)` block with:

```ts
// `reasoningSettings` returns `T` unchanged, so the new key is not statically visible
// on the caller's type. Read it back through one narrow local helper rather than
// sprinkling casts through every assertion.
function carriedEffort(value: unknown): string | undefined {
  const providerOptions = (value as { providerOptions?: { aioProxy?: { effort?: string } } }).providerOptions;
  return providerOptions?.aioProxy?.effort;
}

function aioProxyBag(value: unknown): Record<string, unknown> | undefined {
  return (value as { providerOptions?: { aioProxy?: Record<string, unknown> } }).providerOptions?.aioProxy;
}

describe('reasoningSettings', () => {
  test('carries the canonical effort alongside the SDK representation', () => {
    const result = reasoningSettings({}, 'max');
    expect((result as { reasoning?: string }).reasoning).toBe('xhigh');
    expect(carriedEffort(result)).toBe('max');
  });

  test('folds spellings into both representations', () => {
    const result = reasoningSettings({}, 'X-High');
    expect((result as { reasoning?: string }).reasoning).toBe('xhigh');
    expect(carriedEffort(result)).toBe('xhigh');
  });

  test('returns the settings untouched when there is no effort', () => {
    const settings = { temperature: 0.5 };
    expect(reasoningSettings(settings, undefined)).toBe(settings);
  });

  test('carries an off-ladder effort canonically even when the SDK cannot express it', () => {
    const result = reasoningSettings({}, 'ultra');
    expect((result as { reasoning?: string }).reasoning).toBeUndefined();
    expect(carriedEffort(result)).toBe('ultra');
  });

  test('preserves sibling providerOptions namespaces and aioProxy keys', () => {
    const result = reasoningSettings(
      { providerOptions: { openai: { store: false }, aioProxy: { thinking: { mode: 'disabled' } } } },
      'high',
    );
    expect(result.providerOptions.openai).toEqual({ store: false });
    expect(aioProxyBag(result)).toEqual({ thinking: { mode: 'disabled' }, effort: 'high' });
  });
});

describe('clampSdkReasoning canonical effort', () => {
  // ModelInvocation['settings'] is AiSdkCallSettings, which declares no providerOptions;
  // the canonical key rides along at runtime, so build these fixtures through a cast.
  const withEffort = (reasoning: string, effort: string): ModelInvocation =>
    ({ messages: [], settings: { reasoning, providerOptions: { aioProxy: { effort } } } }) as unknown as ModelInvocation;

  test('keeps max for a candidate that advertises max', () => {
    const result = clampSdkReasoning(withEffort('xhigh', 'max'), new Set(['low', 'medium', 'high', 'max']));
    expect(carriedEffort(result.settings)).toBe('max');
    // The SDK union has no `max`; its highest expressible level stands in.
    expect(result.settings?.reasoning).toBe('xhigh');
  });

  test('clamps max down for a candidate that stops at high', () => {
    const result = clampSdkReasoning(withEffort('xhigh', 'max'), new Set(['low', 'medium', 'high']));
    expect(carriedEffort(result.settings)).toBe('high');
    expect(result.settings?.reasoning).toBe('high');
  });

  test('falls back to settings.reasoning when no canonical effort is present', () => {
    const invocation = { messages: [], settings: { reasoning: 'xhigh' as const } };
    expect(clampSdkReasoning(invocation, new Set(['low', 'medium', 'high'])).settings?.reasoning).toBe('high');
  });

  test('is identity when the canonical effort is already supported', () => {
    const invocation = withEffort('high', 'high');
    expect(clampSdkReasoning(invocation, new Set(['low', 'medium', 'high']))).toBe(invocation);
  });

  test('passes through untouched when the supported set is empty', () => {
    const invocation = withEffort('xhigh', 'max');
    expect(clampSdkReasoning(invocation, new Set())).toBe(invocation);
  });
});
```

Add `import type { ModelInvocation } from '../adapter';` to the test file if it does not already import it.

Delete the existing test `downgrades an out-of-union max (carried as xhigh) to a supported level` — its premise (ingress already folded `max` away) is exactly what this task removes; the two `clampSdkReasoning canonical effort` tests above replace it.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/core && bun test ./src/protocol/reasoning-effort
```

Expected: FAIL — `reasoningSettings is not exported`, and `max` still clamps to `high`.

- [ ] **Step 3: Implement the canonical-effort carrier**

In `packages/core/src/protocol/reasoning-effort/reasoning-effort.ts`:

Replace the top-of-file ladder with the shared one:

```ts
import { EFFORT_LADDER as LADDER, foldEffortSpelling } from '@aio-proxy/types';
```

and delete the module-local `const LADDER = [...] as const;`. Everything downstream (`LADDER.indexOf`, `LADDER.map`) is unchanged — `EFFORT_LADDER` has the identical members and order.

Replace `clampSdkReasoning` and `reasoningSetting` with:

```ts
// Neither LanguageModelCallOptions (ai@7.0.8 dist/index.d.ts:524-586) nor the
// transform-level settings shapes declare providerOptions, so reach it through a
// local carrier — the same idiom as SettingsWithThinking in
// protocol/anthropic-messages/effort.ts.
type ProviderOptionsCarrier = {
  readonly providerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
};

function providerOptionsOf(settings: unknown): ProviderOptionsCarrier['providerOptions'] {
  return (settings as ProviderOptionsCarrier | undefined)?.providerOptions;
}

// The canonical (full-ladder) effort travels in providerOptions.aioProxy.effort because
// the AI SDK's `reasoning` union stops at `xhigh` — folding `max` into `xhigh` at ingress
// would make per-candidate clamping pick `high` for a provider that really supports `max`.
function canonicalRequestedEffort(settings: ModelInvocation['settings']): string | undefined {
  const carried = providerOptionsOf(settings)?.['aioProxy']?.['effort'];
  if (typeof carried === 'string') return carried;
  return typeof settings?.reasoning === 'string' ? settings.reasoning : undefined;
}

function mergeEffort<T>(settings: T, sdk: AiSdkReasoning | undefined, effort: string): T {
  const providerOptions = providerOptionsOf(settings);
  return {
    ...settings,
    ...(sdk === undefined ? {} : { reasoning: sdk }),
    providerOptions: {
      ...providerOptions,
      aioProxy: { ...providerOptions?.['aioProxy'], effort },
    },
  } as T;
}

// Merge both effort representations into a settings object: the canonical value for
// providers that can express more than the SDK union, and the SDK value for the AI SDK
// model path. Sibling providerOptions namespaces and other aioProxy keys are preserved.
// T is only loosely constrained because callers pass transform-level settings shapes
// whose extra keys (stream, responseFormat) are not in LanguageModelCallOptions.
export function reasoningSettings<T extends object>(settings: T, effort: string | undefined): T {
  if (effort === undefined) return settings;
  return mergeEffort(settings, toAiSdkReasoning(effort), canonical(effort));
}

// Clamp the requested effort shared by the OpenAI Responses/Completions and Gemini model
// paths down to what this candidate advertises. Identity when nothing is requested, the
// supported set is empty, or the request is already supported. Both representations are
// rewritten together so a provider reading either one sees the same decision.
export function clampSdkReasoning(invocation: ModelInvocation, supported: ReadonlySet<string>): ModelInvocation {
  const requested = canonicalRequestedEffort(invocation.settings);
  if (requested === undefined || supported.size === 0) return invocation;
  const clamped = normalizeEffort(requested, supported);
  const sdk = toAiSdkReasoning(clamped);
  const settings = invocation.settings as NonNullable<ModelInvocation['settings']>;
  if (clamped === providerOptionsOf(settings)?.['aioProxy']?.['effort'] && sdk === settings.reasoning) {
    return invocation;
  }
  return { ...invocation, settings: mergeEffort(settings, sdk, clamped) };
}
```

Keep `AiSdkReasoning`, `AI_SDK_REASONING`, `toAiSdkReasoning`, `canonical`, `normalizeEffort`, and `modelEffortValues` as they are, but update the `toAiSdkReasoning` comment so it no longer claims `reasoningSetting` folded `max` before this point.

In `packages/core/src/protocol/reasoning-effort/index.ts`, replace the `reasoningSetting` export with `reasoningSettings`.

- [ ] **Step 4: Move both ingress call sites**

`packages/core/src/protocol/openai-responses.ts`, in `modelInvocation` — the destructuring that split `reasoning` out of the transform settings goes away, because `reasoningSettings` merges into the whole object:

```ts
  modelInvocation(request, context) {
    if (context.operation === 'compact') {
      throw new OpenAIResponsesUnsupportedFeatureError('responses_compact', 'POST /v1/responses/compact');
    }
    const transformed = openAIResponsesToModelMessages(request as OpenAIResponsesRequest);
    const tools = functionToolSet(transformed.tools);
    const { reasoning, ...settings } = transformed.settings;
    return {
      messages: transformed.messages,
      settings: reasoningSettings(settings, reasoning),
      ...(tools === undefined ? {} : { tools }),
      ...(transformed.diagnostics.length === 0 ? {} : { diagnostics: transformed.diagnostics }),
    };
  },
```

Update the import on line 17 from `reasoningSetting` to `reasoningSettings`.

`packages/core/src/transform/openai-completions/openai-completions.ts` — replace the trailing `...reasoningSetting(req.reasoning_effort)` spread with a wrap of the whole settings object:

```ts
    settings: reasoningSettings(
      {
        ...(req.stream !== undefined ? { stream: req.stream } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.max_completion_tokens !== undefined ? { maxTokens: req.max_completion_tokens } : {}),
        ...(req.max_completion_tokens === undefined && req.max_tokens !== undefined
          ? { maxTokens: req.max_tokens }
          : {}),
        ...(req.response_format !== undefined ? { responseFormat: req.response_format } : {}),
      },
      req.reasoning_effort,
    ),
```

Update its import on line 7 from `reasoningSetting` to `reasoningSettings`.

**Neither transform settings type needs a new field.** `reasoningSettings` returns `T`, so the canonical key is present at runtime but invisible to the caller's static type — `OpenAIResponsesTransformSettings.providerOptions` keeps its narrow `{ openai: … }` shape and `OpenAICompletionsTransformSettings` keeps having no `providerOptions` at all. Downstream readers are unaffected: `openai-completions-from-model.ts:67` still reads only `settings.reasoning`, and `clampSdkReasoning` reads the canonical key through its own carrier cast. Adding `providerOptions.aioProxy.effort` to those types (the way `AnthropicMessagesSettings` declares `providerOptions?: { aioProxy?: { thinking?: … } }`) is possible but not required, and would force both transform types to widen `providerOptions` for a key only the core clamp reads — do not do it.

- [ ] **Step 5: Run the package tests**

```bash
cd packages/core && bun test
```

Expected: PASS. If a protocol test asserts an exact `settings` object, it now also carries `providerOptions.aioProxy.effort` — update that assertion, since the new key is the deliverable.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/protocol packages/core/src/transform && git commit -m "fix(core): carry the canonical reasoning effort through per-candidate clamping"
```

---

### Task 5: Antigravity honours the canonical effort

**Problem:** even after Task 4, the plugin only sees `options.reasoning`, which the AI SDK caps at `xhigh`; `synthesizeThinking` would build `{ mode: 'adaptive', effort: 'xhigh' }` and `claudeAdaptiveBudget` folds that to the `high` budget (16 384) instead of `max` (32 768). The plugin must read the canonical value that Task 4 puts on `aioProxy`.

**Files:**
- Modify: `packages/plugins/google-antigravity/src/runtime/private-options.ts:35-53`
- Modify: `packages/plugins/google-antigravity/src/runtime/google-model.ts:57-65`
- Modify: `packages/plugins/google-antigravity/src/runtime/token-count.ts:130-133` (third `synthesizeThinking` caller)
- Test: `packages/plugins/google-antigravity/src/runtime/google-model.test.ts`

**Interfaces:**
- Consumes: `settings.providerOptions.aioProxy.effort` — a canonical lowercase ladder value, produced by `reasoningSettings`/`clampSdkReasoning` in Task 4. `aioProxy.thinking` (from Anthropic inbound) keeps its existing precedence.
- Produces:
  - `takeAioProxyOptions(providerOptions)` — `privateOptions` gains `effort?: string`.
  - `synthesizeThinking(existing: AntigravityThinkingOption | undefined, effort: string | undefined, reasoning: unknown): AntigravityThinkingOption | undefined` — a third parameter; precedence is `existing` → `effort` → `reasoning`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/plugins/google-antigravity/src/runtime/google-model.test.ts` (create the file with the same `bun:test` import style as its siblings if it does not exist):

```ts
import { expect, test } from 'bun:test';

import { synthesizeThinking } from './google-model';

test('prefers an explicit thinking option over both effort sources', () => {
  expect(synthesizeThinking({ mode: 'fixed', budgetTokens: 2048 }, 'max', 'high')).toEqual({
    mode: 'fixed',
    budgetTokens: 2048,
  });
});

test('uses the canonical effort so max survives the AI SDK ceiling', () => {
  expect(synthesizeThinking(undefined, 'max', 'xhigh')).toEqual({ mode: 'adaptive', effort: 'max' });
});

test('maps a canonical none onto disabled thinking', () => {
  expect(synthesizeThinking(undefined, 'none', 'none')).toEqual({ mode: 'disabled' });
});

test('falls back to the SDK reasoning when no canonical effort was carried', () => {
  expect(synthesizeThinking(undefined, undefined, 'high')).toEqual({ mode: 'adaptive', effort: 'high' });
  expect(synthesizeThinking(undefined, undefined, 'provider-default')).toBeUndefined();
  expect(synthesizeThinking(undefined, undefined, undefined)).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/plugins/google-antigravity && bun test --preload=./test/setup.ts ./src/runtime/google-model.test.ts
```

Expected: FAIL — `synthesizeThinking` takes two parameters, so `'max'` lands in the `reasoning` slot only by accident and `{ mode: 'disabled' }` / precedence assertions break.

- [ ] **Step 3: Accept `aioProxy.effort`**

In `packages/plugins/google-antigravity/src/runtime/private-options.ts`, add the field to `aioProxySchema` and to the returned `privateOptions`:

```ts
const aioProxySchema = zod
  .object({
    logicalRequest: logicalRequestSchema,
    thinking: thinkingSchema.optional(),
    // The host's canonical reasoning effort, already clamped to what this wire
    // advertises. It can exceed the AI SDK's `reasoning` union (e.g. `max`).
    effort: zod.string().min(1).optional(),
    providerTools: zod.array(providerToolSchema).optional(),
  })
  .loose();

export function takeAioProxyOptions(providerOptions: SharedV4ProviderOptions | undefined) {
  const { aioProxy, ...rest } = providerOptions ?? {};
  const parsed = aioProxySchema.parse(aioProxy);
  const providerTools = parsed.providerTools?.map(providerTool);
  const privateOptions = {
    logicalRequest: parsed.logicalRequest,
    ...(parsed.thinking === undefined ? {} : { thinking: parsed.thinking }),
    ...(parsed.effort === undefined ? {} : { effort: parsed.effort }),
    ...(providerTools === undefined ? {} : { providerTools }),
  };
  return { context: parsed.logicalRequest, privateOptions, providerOptions: rest };
}
```

Note that `aioProxySchema.parse` throws on an invalid shape; `effort` is a plain optional string, so no previously-accepted payload becomes invalid.

- [ ] **Step 4: Prefer the canonical effort in `synthesizeThinking`**

In `packages/plugins/google-antigravity/src/runtime/google-model.ts`:

```ts
export function synthesizeThinking(
  existing: AntigravityThinkingOption | undefined,
  effort: string | undefined,
  reasoning: unknown,
): AntigravityThinkingOption | undefined {
  if (existing !== undefined) return existing;
  // The host's canonical effort wins: it is already clamped to this wire's
  // advertised set and can carry a level the AI SDK union cannot express.
  const requested =
    effort ?? (typeof reasoning === 'string' && reasoning !== 'provider-default' ? reasoning : undefined);
  if (requested === undefined) return undefined;
  return requested === 'none' ? { mode: 'disabled' } : { mode: 'adaptive', effort: requested };
}
```

There are **three** call sites, all of which must be updated or the package will not typecheck.

Two are in `google-model.ts` itself — one in `doGenerate` (line 27) and one in `doStream` (line 39) — and take the identical new form:

```ts
      const thinking = synthesizeThinking(split.privateOptions.thinking, split.privateOptions.effort, options.reasoning);
```

The third is in `packages/plugins/google-antigravity/src/runtime/token-count.ts:130-133`, inside `splitInvocation`. It already has the parsed `split`, so it reads the canonical effort from the same place:

```ts
  const thinking = synthesizeThinking(
    split.privateOptions.thinking,
    split.privateOptions.effort,
    settings === undefined ? undefined : Reflect.get(settings, 'reasoning'),
  );
```

- [ ] **Step 5: Run the package tests**

```bash
cd packages/plugins/google-antigravity && bun test --preload=./test/setup.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/google-antigravity/src/runtime && git commit -m "fix(antigravity): honour the host's canonical reasoning effort"
```

---

### Task 6: Changeset and full preflight

**Files:**
- Create: `.changeset/effort-clamping-runtime-capabilities.md`

**Interfaces:**
- Consumes: every package touched by Tasks 1-5.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the changeset**

Per `CLAUDE.md`, a user-facing change must target a product package (`aio-proxy`), listing the internal packages alongside at the same bump level. All three fixes are behavioral bug fixes, so `patch`.

Create `.changeset/effort-clamping-runtime-capabilities.md`:

```markdown
---
'aio-proxy': patch
'@aio-proxy/types': patch
'@aio-proxy/core': patch
'@aio-proxy/server': patch
'@aio-proxy/plugin-google-antigravity': patch
---

Reasoning effort now clamps against what the selected provider actually supports.
Capabilities come from the provider's own catalog first and models.dev only as a
fallback, so plugin-backed models whose wire ids are not models.dev ids no longer
forward a level the upstream rejects. A request for `max` keeps that level all the
way to a provider that supports it instead of being downgraded to `high`, and an
alias asked for more effort than its highest variant declares now routes to that
variant rather than falling back to the alias's default model.
```

- [ ] **Step 2: Verify the changeset is well-formed**

```bash
bun changeset status
```

Expected: it lists all five packages at `patch`.

- [ ] **Step 3: Run the full preflight**

```bash
bun run preflight
```

Expected: PASS (oxlint + oxfmt check + every package's unit tests).

- [ ] **Step 4: Commit**

```bash
git add .changeset && git commit -m "chore: add changeset for effort clamping fixes"
```

---

## Verification Against Issue #130

| Issue item | Task | Observable outcome |
| --- | --- | --- |
| [P1] capabilities from the runtime provider catalog | 2 (host) + 3 (Antigravity producer) | An `xhigh` request routed to `claude-opus-4-6-thinking` clamps to `high` before `takeAioProxyOptions` sees it, instead of passing through and 400ing. |
| [P2] preserve `max` until per-candidate clamping | 4 (core carrier) + 5 (plugin reader) | A `max` request to a candidate advertising `max` reaches the provider as `max` (Antigravity: 32 768 budget), not `high`. |
| [P2] alias routing chooses the correct wire model | 1 | An alias whose variants stop at `high` routes an `xhigh`/`max` request to the `high` wire, not to the alias base. |
