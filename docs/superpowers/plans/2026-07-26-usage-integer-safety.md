# Usage Integer Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make usage token and cost persistence/aggregation exact across SQLite, the dashboard JSON wire, and dashboard summaries while keeping single-request usage and OpenTelemetry number-based.

**Architecture:** Validate each captured single-request `UsageRow` before accounting, convert its USD cost once to a safe nano-USD integer at the database boundary, and keep aggregate integer math as SQLite integer text plus server-side `bigint`. The trace-backed overview converts every aggregate bigint to a canonical decimal string before Hono serializes it; the dashboard decodes those strings immediately and converts to `number` only when constructing Recharts data.

**Tech Stack:** Bun 1.3.14, TypeScript 7, Zod 4, Drizzle ORM/SQLite, Hono, React 19, TanStack Query 5, Recharts 3, Rstest.

## Global Constraints

- Work only in `/Users/bytedance/Documents/self/aio-proxy/.worktrees/usage-bigint-fixed-cost` on branch `fix/usage-bigint-fixed-cost`, stacked on `origin/trace-session-affinity` at `34fbbf7706f272e30c68ca48bf1ad6c083c338ac`.
- Prefix every shell command with `rtk`; use `apply_patch` for handwritten edits.
- `COST_SCALE` is exactly `1_000_000_000`; persisted aggregate cost is nano-USD in SQLite `INTEGER` columns.
- `UsageRow`, request logs, trace detail, upstream protocol values, and OpenTelemetry attributes remain `number`-based and retain `estimatedCostUsd`.
- Every captured token value must be a nonnegative safe integer. Cost must be finite, nonnegative, and convertible with `Math.round(value * COST_SCALE)` to a safe integer.
- If any token or cost field in one captured request is invalid, emit one structured `usage.accounting_dropped` server log and omit the entire accounting `UsageRow`; do not alter the client response and do not add a metric.
- Raw Anthropic total tokens are `input + cache_creation + cache_read + output`. OpenAI, Gemini, and AI SDK parent totals are inclusive; never add cache or reasoning detail buckets to those totals.
- Keep `usage_daily` keyed only by `local_day + model_dimension`, with no provider column. It remains write-only in this change.
- The repository is unreleased and existing local databases are disposable. Regenerate/amend migration `0001`; do not add `0002`, a backfill, or an old-schema upgrade test. Existing databases must be recreated.
- Do not enable Bun SQLite `safeIntegers` globally.
- Integer `COUNT`/`SUM` queries must use `CAST(... AS TEXT)` and parse to `bigint`; do not use `.mapWith(Number)` for usage overview aggregates.
- Explicit `total_tokens` wins per row; when absent, fall back to `coalesce(input_tokens, 0) + coalesce(output_tokens, 0)`. Never add cache/reasoning details again.
- All aggregate integer fields on `/dashboard/api/usage` are canonical nonnegative decimal strings. Ratios, RPM, and TPM remain `number`.
- The legacy `createRequestLogStore`/`usage` table is not in the server runtime path. Do not migrate its storage; decouple its old numeric overview result from the new dashboard wire DTO if type checking requires it.
- Handwritten code and tests must stay under 300 lines; split `trace-lifecycle.ts` by responsibility before growing it.
- Each implementation task follows RED → verify expected failure → GREEN → focused tests → commit with `Co-authored-by: Codex <noreply@openai.com>`.
- Baseline note: `bun run check` passes at the base commit. `bun run preflight` currently fails on parent-branch `lint:types` errors; full unit execution can also fail when the external Paraglide fetch times out and leaves generated i18n messages missing. Record fresh output rather than attributing those failures to this branch.

---

### Task 1: Safe usage primitives, capture validation, and Anthropic totals

**Files:**
- Create: `packages/core/src/usage-numbers/index.ts`
- Create: `packages/core/src/usage-numbers/usage-numbers.ts`
- Create: `packages/core/src/usage-numbers/usage-numbers.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/types/src/usage.ts`
- Create: `packages/server/src/usage-capture/usage-validation.ts`
- Modify: `packages/server/src/usage-capture/usage-capture.ts`
- Modify: `packages/server/src/usage-capture/pricing.ts`
- Modify: `packages/server/src/server-log.ts`
- Modify: `packages/server/src/server-state/index.ts`
- Modify: `packages/server/src/passthrough-usage/shared.ts`
- Modify: `packages/server/src/passthrough-usage/usage.ts`
- Modify: `packages/server/src/passthrough-usage/passthrough-usage.ts`
- Test: `packages/server/src/usage-capture/usage-capture.stream.lifecycle.test.ts`
- Test: `packages/server/src/usage-capture/usage-capture.passthrough.test.ts`
- Test: `packages/server/__tests__/passthrough-usage.anthropic.test.ts`

**Interfaces:**
- Produces: `COST_SCALE`, `usdToNanoUsd(value: number): number`, `nanoUsdToUsd(value: number | bigint): number`, and `parseSqliteInteger(value: string): bigint` from `@aio-proxy/core`.
- Produces: `UsageRowSchema` whose token fields reject values outside `[0, Number.MAX_SAFE_INTEGER]` and whose cost rejects non-finite or negative values.
- Produces: `createUsageCapture({ priceCatalogTask, logger? })`, which logs and drops invalid accounting usage without changing the streamed/buffered response.
- Produces: corrected raw Anthropic JSON and SSE `totalTokens` semantics for later persistence and aggregation.

- [ ] **Step 1: Write failing numeric-boundary tests**

Add literal, independently derived expectations to `usage-numbers.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { nanoUsdToUsd, parseSqliteInteger, usdToNanoUsd } from '.';

describe('usage number boundaries', () => {
  test('converts USD to nano-USD with one rounding step', () => {
    expect(usdToNanoUsd(0.000_000_002)).toBe(2);
    expect(usdToNanoUsd(0.1)).toBe(100_000_000);
    expect(nanoUsdToUsd(250_000_000)).toBe(0.25);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('rejects invalid USD %p', (value) => {
    expect(() => usdToNanoUsd(value)).toThrow();
  });

  test('rejects nano-USD outside the safe single-request range', () => {
    expect(() => usdToNanoUsd((Number.MAX_SAFE_INTEGER + 1) / 1_000_000_000)).toThrow();
  });

  test('parses exact SQLite integer text', () => {
    expect(parseSqliteInteger('9007199254740993')).toBe(9_007_199_254_740_993n);
    expect(() => parseSqliteInteger('1.5')).toThrow();
  });
});
```

- [ ] **Step 2: Run the numeric tests and verify RED**

Run:

```bash
rtk bun test packages/core/src/usage-numbers/usage-numbers.test.ts
```

Expected: FAIL because the `usage-numbers` module does not exist.

- [ ] **Step 3: Implement the minimum shared numeric primitives**

Implement `usage-numbers.ts` with one conversion boundary and no extra abstraction:

```ts
export const COST_SCALE = 1_000_000_000;

export function usdToNanoUsd(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError('USD cost must be finite and non-negative');
  const nanoUsd = Math.round(value * COST_SCALE);
  if (!Number.isSafeInteger(nanoUsd)) throw new RangeError('Nano-USD cost exceeds the safe integer range');
  return nanoUsd;
}

export function nanoUsdToUsd(value: number | bigint): number {
  return Number(value) / COST_SCALE;
}

export function parseSqliteInteger(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new TypeError('SQLite integer must be non-negative decimal text');
  return BigInt(value);
}
```

Export these names from the local `index.ts` and `packages/core/src/index.ts`. Update `UsageRowSchema` as follows:

```ts
const TokenCountSchema = z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER);

// unchanged UsageRow shape
estimatedCostUsd: z.number().finite().min(0).optional(),
```

- [ ] **Step 4: Verify the numeric tests are GREEN**

Run:

```bash
rtk bun test packages/core/src/usage-numbers/usage-numbers.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing capture-validation and Anthropic regression tests**

In the stream lifecycle test, construct a finish part with `inputTokens: Number.MAX_SAFE_INTEGER + 1`; assert the output part is still drained unchanged, completion is `{ outcome: 'success' }` with no `usage`, and the logger receives exactly one entry matching:

```ts
{
  event: 'usage.accounting_dropped',
  source: 'ai-sdk',
  providerId: 'provider',
  modelId: 'model',
  reason: 'invalid_usage',
  issues: expect.any(Array),
}
```

In the passthrough capture test, use byte-identical JSON containing `prompt_tokens: 1.5`; assert the response body is unchanged, completion remains successful with no `usage`, and one `source: 'passthrough'` accounting-drop log is emitted.

Add a priced stream case whose catalog produces a negative or non-finite cost; assert the entire usage row is dropped and logged.

Change the Anthropic cache expectations from `24` to `36` in both JSON and SSE tests:

```ts
expect(usage).toMatchObject({
  inputTokens: 11,
  cacheWriteTokens: 5,
  cacheReadTokens: 7,
  outputTokens: 13,
  totalTokens: 36,
});
```

- [ ] **Step 6: Run the capture tests and verify RED**

Run:

```bash
rtk bun test --preload=./packages/server/__tests__/setup.ts \
  packages/server/src/usage-capture/usage-capture.stream.lifecycle.test.ts \
  packages/server/src/usage-capture/usage-capture.passthrough.test.ts \
  packages/server/__tests__/passthrough-usage.anthropic.test.ts
```

Expected: FAIL because invalid rows are retained or silently field-dropped, no structured log exists, and Anthropic cache tokens are omitted from totals.

- [ ] **Step 7: Implement capture validation and structured logging**

Add `UsageAccountingDroppedLog` to the `ServerLog` union:

```ts
export type UsageAccountingDroppedLog = {
  readonly event: 'usage.accounting_dropped';
  readonly source: 'ai-sdk' | 'passthrough';
  readonly providerId: string;
  readonly modelId: string;
  readonly reason: 'invalid_usage';
  readonly issues: readonly { readonly code: string; readonly path: readonly (string | number)[] }[];
};
```

Pass the existing server logger into `createUsageCapture`. In `usage-validation.ts`, validate before pricing and again after pricing; the second pass must call `usdToNanoUsd` when `estimatedCostUsd` exists. On failure, emit one log and return `undefined`:

```ts
export async function finalizeUsage(input: {
  readonly usage: UsageRow | undefined;
  readonly accounting: UsageAccounting;
  readonly priceCatalogTask: () => Promise<OpenRouterPriceCatalog | undefined>;
  readonly logger?: ServerLogSink;
}): Promise<UsageRow | undefined> {
  const normalized = validUsage(input.usage, input.accounting, input.logger);
  if (normalized === undefined) return undefined;
  const priced = await priceUsage(normalized, input.priceCatalogTask, input.accounting);
  return validUsage(priced, input.accounting, input.logger);
}
```

Use `UsageRowSchema.safeParse`; translate Zod issues without values. If nano conversion throws, add an issue at `['estimatedCostUsd']` with code `unsafe_nano_usd`. Do not log raw usage values.

For passthrough fields, treat only `undefined` as absent. Replace the current `number | undefined` helper contract with a discriminated result such as `{ kind: 'absent' } | { kind: 'valid'; value: number } | { kind: 'invalid'; issue: UsageIssue }`; do not use `NaN` as a sentinel. A present value that is not a nonnegative safe integer marks the whole observation invalid. Keep that invalid state sticky across SSE events so later valid events cannot restore a partial row. Surface normalized issue paths to `finalizeUsage`; `extractPassthroughUsage()` must continue returning `undefined` rather than throwing.

Replace the Anthropic helper with:

```ts
export function anthropicTotalTokens(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  cacheWriteTokens: number | undefined,
  cacheReadTokens: number | undefined,
): number | undefined {
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return inputTokens + outputTokens + (cacheWriteTokens ?? 0) + (cacheReadTokens ?? 0);
}
```

Use it for both JSON extraction and merged Anthropic SSE observations. Do not alter totals for other protocols.

- [ ] **Step 8: Run focused Task 1 tests and commit**

Run:

```bash
rtk bun test packages/core/src/usage-numbers/usage-numbers.test.ts
rtk bun test --preload=./packages/server/__tests__/setup.ts \
  packages/server/src/usage-capture/usage-capture.stream.lifecycle.test.ts \
  packages/server/src/usage-capture/usage-capture.passthrough.test.ts \
  packages/server/__tests__/passthrough-usage.anthropic.test.ts
rtk git diff --check
```

Expected: all focused tests PASS and `git diff --check` exits 0.

Commit:

```bash
rtk git add packages/core/src/usage-numbers packages/core/src/index.ts packages/types/src/usage.ts \
  packages/server/src/usage-capture packages/server/src/server-log.ts packages/server/src/server-state/index.ts \
  packages/server/src/passthrough-usage packages/server/__tests__/passthrough-usage.anthropic.test.ts
rtk git commit -m "fix(usage): validate accounting inputs" \
  -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Nano-USD persistence, regenerated migration 0001, and number-based projections

**Files:**
- Modify: `packages/core/src/db/schema/trace-span.ts`
- Modify: `packages/core/src/db/schema/usage-daily.ts`
- Delete: `packages/core/src/db/trace-store/trace-lifecycle.ts`
- Create: `packages/core/src/db/trace-store/trace-lifecycle/index.ts`
- Create: `packages/core/src/db/trace-store/trace-lifecycle/trace-lifecycle.ts`
- Create: `packages/core/src/db/trace-store/trace-lifecycle/usage-persistence.ts`
- Modify: `packages/core/src/db/trace-store/usage-fields.ts`
- Modify: `packages/core/src/db/trace-store/trace-queries.ts`
- Modify: `packages/core/src/db/trace-store/request-logs/request-logs.ts`
- Regenerate: `packages/core/src/db/migrations/0001_violet_mentallo.sql`
- Regenerate: `packages/core/src/db/migrations/meta/0001_snapshot.json`
- Modify: `packages/core/src/db/migrations/meta/_journal.json`
- Regenerate: `packages/core/src/db/migrations.manifest.ts`
- Test: `packages/core/src/db/trace-store/trace-store.test.ts`
- Test: `packages/core/src/db/trace-store/request-logs/request-logs.test.ts`
- Test: `packages/core/src/db/migrations/migrations.test.ts`

**Interfaces:**
- Consumes: `usdToNanoUsd` and `nanoUsdToUsd` from Task 1.
- Produces: nullable `trace_span.estimated_cost_nano_usd INTEGER` and non-null `usage_daily.estimated_cost_nano_usd INTEGER DEFAULT 0`.
- Produces: `usage_daily.total_tokens INTEGER NOT NULL DEFAULT 0` with the existing two-column primary key and no provider dimension.
- Preserves: `TraceStore.complete()` first-transition dedupe, request-log `UsageRow`, trace summary/detail `UsageRow`, and OTel attributes as numbers in USD/token units.

- [ ] **Step 1: Write failing persistence and projection tests**

Extend the trace-store lifecycle test so the first successful completion contains:

```ts
usage: {
  providerId: 'provider-b',
  modelId: 'model-b',
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 20,
  estimatedCostUsd: 0.1,
}
```

After calling `complete()` twice, assert only the first transition contributes:

```ts
expect(rows).toEqual([
  expect.objectContaining({
    requestCount: 1,
    usageRequestCount: 1,
    pricedRequestCount: 1,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 20,
    estimatedCostNanoUsd: 100_000_000,
  }),
]);
```

Add a completion whose only accounting field is `totalTokens`; assert `usageRequestCount` increments and daily `totalTokens` stores that explicit value. Add request-log and trace-detail assertions that `estimatedCostUsd` still reads back as `0.1`, never nano-USD.

In the migration test, query `PRAGMA table_info` and assert:

```ts
expect(traceColumns).toEqual(expect.arrayContaining([
  expect.objectContaining({ name: 'estimated_cost_nano_usd', type: 'INTEGER' }),
]));
expect(traceColumns.some(({ name }) => name === 'estimated_cost_usd')).toBeFalse();
expect(dailyColumns).toEqual(expect.arrayContaining([
  expect.objectContaining({ name: 'total_tokens', type: 'INTEGER' }),
  expect.objectContaining({ name: 'estimated_cost_nano_usd', type: 'INTEGER' }),
]));
expect(dailyColumns.some(({ name }) => name.includes('provider'))).toBeFalse();
```

- [ ] **Step 2: Run persistence tests and verify RED**

Run:

```bash
rtk bun test \
  packages/core/src/db/trace-store/trace-store.test.ts \
  packages/core/src/db/trace-store/request-logs/request-logs.test.ts \
  packages/core/src/db/migrations/migrations.test.ts
```

Expected: FAIL because the nano-USD and daily total columns do not exist and projections still read `estimatedCostUsd` directly.

- [ ] **Step 3: Change schema and extract usage persistence from the oversized lifecycle module**

Change the schema fields exactly:

```ts
// trace-span.ts
estimatedCostNanoUsd: integer('estimated_cost_nano_usd'),

// usage-daily.ts
totalTokens: integer('total_tokens').notNull().default(0),
estimatedCostNanoUsd: integer('estimated_cost_nano_usd').notNull().default(0),
```

Move the existing lifecycle implementation under `trace-lifecycle/`, leaving `index.ts` export-only:

```ts
export { complete, prune, recover, startRoot } from './trace-lifecycle';
```

Put only usage persistence concerns in `usage-persistence.ts`. Compute the single-request nano cost once and reuse it for both the root span and daily delta. Daily total tokens use the same fallback as overview:

```ts
const totalTokens = usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
const estimatedCostNanoUsd =
  usage?.estimatedCostUsd === undefined ? undefined : usdToNanoUsd(usage.estimatedCostUsd);
const hasUsage =
  usage !== undefined &&
  [
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.reasoningTokens,
    usage.estimatedCostUsd,
  ].some((value) => value !== undefined);
```

Keep the existing SQLite `ON CONFLICT` atomic increments and add:

```ts
estimatedCostNanoUsd: estimatedCostNanoUsd ?? 0,

// onConflictDoUpdate.set
totalTokens: sql`total_tokens + excluded.total_tokens`,
estimatedCostNanoUsd: sql`estimated_cost_nano_usd + excluded.estimated_cost_nano_usd`,
```

Do not add a provider column or change completion dedupe ordering.

- [ ] **Step 4: Convert stored nano-USD back to number-based public projections**

Replace the cost key in `usage-fields.ts` with `estimatedCostNanoUsd`. In request-log and trace summary projection, emit:

```ts
...(row.estimatedCostNanoUsd !== null
  ? { estimatedCostUsd: nanoUsdToUsd(row.estimatedCostNanoUsd) }
  : {}),
```

Do not emit nano-USD in `UsageRow`, trace span attributes, dashboard logs, or OTel.

- [ ] **Step 5: Regenerate migration 0001 without creating 0002**

Use `apply_patch` to remove the current `0001` SQL/snapshot and its journal entry, then run Drizzle generation from `packages/core`. If Drizzle chooses a different generated tag, normalize the SQL filename and journal tag back to `0001_violet_mentallo` with `apply_patch`. Finally regenerate the manifest:

```bash
rtk bunx drizzle-kit generate
rtk bun run build:migrations
```

Run those commands with working directory `packages/core`. Verify:

```bash
rtk git status --short packages/core/src/db/migrations packages/core/src/db/migrations.manifest.ts
rtk rg -n "estimated_cost_(usd|nano_usd)|total_tokens" \
  packages/core/src/db/migrations/0001_violet_mentallo.sql \
  packages/core/src/db/migrations/meta/0001_snapshot.json
```

Expected: journal still has exactly entries `0000` and `0001`; no `0002` file exists; `trace_span` and `usage_daily` use nano-USD integer columns; daily has `total_tokens`.

- [ ] **Step 6: Run focused Task 2 tests and commit**

Run:

```bash
rtk bun test \
  packages/core/src/db/trace-store/trace-store.test.ts \
  packages/core/src/db/trace-store/request-logs/request-logs.test.ts \
  packages/core/src/db/migrations/migrations.test.ts
rtk bun run --filter @aio-proxy/core build
rtk git diff --check
```

Expected: focused tests and core build PASS; `git diff --check` exits 0.

Commit:

```bash
rtk git add packages/core/src/db/schema packages/core/src/db/trace-store \
  packages/core/src/db/migrations packages/core/src/db/migrations.manifest.ts
rtk git commit -m "fix(core): persist usage cost as nano usd" \
  -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Exact trace overview and decimal-string dashboard wire DTO

**Files:**
- Modify: `packages/types/src/dashboard.ts`
- Test: `packages/types/__tests__/schemas-events.test.ts`
- Modify: `packages/core/src/db/trace-store/usage-overview/usage-overview.ts`
- Test: `packages/core/src/db/trace-store/usage-overview/usage-overview.test.ts`
- Modify: `packages/core/src/db/request-log/types.ts`
- Modify: `packages/core/src/db/request-log/overview.ts`
- Modify: `packages/core/__tests__/request-log.test-support.ts`
- Modify: `packages/core/__tests__/request-log-write.test.ts`
- Test: `packages/server/__tests__/usage-dashboard.test.ts`

**Interfaces:**
- Consumes: `parseSqliteInteger` from Task 1 and nano-USD columns from Task 2.
- Produces: `NonNegativeIntegerStringSchema` for canonical decimal strings.
- Produces: `DashboardUsageOverviewResponse` where summary integer aggregates and every bucket value are strings; `estimatedCostNanoUsd` replaces aggregate `estimatedCostUsd`.
- Preserves: `pricingCoverage`, `successRate`, `averageRpm`, and `averageTpm` as numbers.
- Preserves: legacy `createRequestLogStore` numeric storage/overview behavior under a legacy internal result type; it no longer claims to implement the dashboard wire DTO.

- [ ] **Step 1: Write failing wire-schema and exact-aggregation tests**

Change the types fixture to use canonical strings:

```ts
summary: {
  estimatedCostNanoUsd: '1250000000',
  pricingCoverage: 0.8,
  pricedRequestCount: '8',
  usageRequestCount: '10',
  requestCount: '12',
  successCount: '10',
  failureCount: '1',
  cancelledCount: '1',
  successRate: 10 / 11,
  inputTokens: '100',
  outputTokens: '50',
  totalTokens: '150',
  averageRpm: 12 / 1440,
  averageTpm: 150 / 1440,
},
buckets: [{ key: '2026-07-11 08:00', values: { 'openai/gpt-5': '1250000000', __other__: '0' } }],
```

Add a schema rejection for `'-1'`, `'01'`, and a numeric aggregate.

In the trace overview test, seed two successful requests with safe per-request `totalTokens` values `4_503_599_627_370_496` and `4_503_599_627_370_497`. Assert summary and the token chart preserve `'9007199254740993'` exactly. Add a total-only row and assert it increments `usageRequestCount` and contributes its explicit total.

Seed costs `0.1`, `0.2`, and `0.000_000_002`; assert nano-USD summary/chart values are `'300000002'`, not a floating approximation.

Add a Top-5 fixture whose dimension totals differ above `Number.MAX_SAFE_INTEGER`; assert ranking and `__other__` use exact bigint ordering.

- [ ] **Step 2: Run Task 3 tests and verify RED**

Run:

```bash
rtk bun test packages/types/__tests__/schemas-events.test.ts
rtk bun test packages/core/src/db/trace-store/usage-overview/usage-overview.test.ts
rtk bun test --preload=./packages/server/__tests__/setup.ts packages/server/__tests__/usage-dashboard.test.ts
```

Expected: FAIL because the DTO is numeric, sums use `.mapWith(Number)`, total-only rows contribute zero, and cost is still returned in USD.

- [ ] **Step 3: Define the decimal-string aggregate DTO**

Add the shared schema:

```ts
export const NonNegativeIntegerStringSchema = z.string().regex(/^(?:0|[1-9]\d*)$/u);
```

Change the aggregate summary and buckets:

```ts
export const DashboardUsageSummarySchema = z.object({
  estimatedCostNanoUsd: NonNegativeIntegerStringSchema,
  pricingCoverage: z.number().min(0).max(1).nullable(),
  pricedRequestCount: NonNegativeIntegerStringSchema,
  usageRequestCount: NonNegativeIntegerStringSchema,
  requestCount: NonNegativeIntegerStringSchema,
  successCount: NonNegativeIntegerStringSchema,
  failureCount: NonNegativeIntegerStringSchema,
  cancelledCount: NonNegativeIntegerStringSchema,
  successRate: z.number().min(0).max(1).nullable(),
  inputTokens: NonNegativeIntegerStringSchema,
  outputTokens: NonNegativeIntegerStringSchema,
  totalTokens: NonNegativeIntegerStringSchema,
  averageRpm: z.number().min(0),
  averageTpm: z.number().min(0),
});

export const DashboardUsageBucketSchema = z.object({
  key: z.string().min(1),
  values: z.record(z.string(), NonNegativeIntegerStringSchema),
});
```

Do not modify `UsageRowSchema` to strings.

- [ ] **Step 4: Rewrite trace overview integer aggregation around bigint**

Every aggregate uses text SQL, for example:

```ts
estimatedCostNanoUsd: sql<string>`cast(coalesce(sum(${traceSpan.estimatedCostNanoUsd}), 0) as text)`,
requestCount: sql<string>`cast(count(*) as text)`,
totalTokens: sql<string>`cast(coalesce(sum(
  coalesce(${traceSpan.totalTokens}, coalesce(${traceSpan.inputTokens}, 0) + coalesce(${traceSpan.outputTokens}, 0))
), 0) as text)`,
```

Apply the same rule to chart rows, not only the summary:

```ts
const value =
  metric === 'cost'
    ? sql<string>`cast(coalesce(sum(${traceSpan.estimatedCostNanoUsd}), 0) as text)`
    : sql<string>`cast(coalesce(sum(
        coalesce(${traceSpan.totalTokens}, coalesce(${traceSpan.inputTokens}, 0) + coalesce(${traceSpan.outputTokens}, 0))
      ), 0) as text)`;

// requests chart
value: sql<string>`cast(count(*) as text)`,
```

Parse once with `parseSqliteInteger`. Keep chart rows as bigint until the final DTO. Compare ranking without subtraction:

```ts
const compareBigIntDescending = (left: bigint, right: bigint) => (left === right ? 0 : left > right ? -1 : 1);
```

Use bigint addition for totals and `Other`. Convert only at the return boundary:

```ts
estimatedCostNanoUsd: estimatedCostNanoUsd.toString(),
requestCount: requestCount.toString(),
// ...all integer summary fields
values: Object.fromEntries(entries.map(([key, value]) => [key, value.toString()])),
```

For ratios and rates, use `Number(bigint)` only in those calculations:

```ts
const ratio = (numerator: bigint, denominator: bigint) =>
  denominator === 0n ? null : Number(numerator) / Number(denominator);
```

- [ ] **Step 5: Keep the legacy request-log store out of the new wire contract**

Define a private structural `LegacyUsageOverviewResponse` in `request-log/types.ts` with the existing numeric fields and change `RequestLogStore.overview`/`overviewRequestLogs` to return it. Remove legacy tests' `DashboardUsageOverviewResponseSchema` assertion, but keep their behavior assertions. Do not alter the legacy `usage` table, its REAL cost, or its chart implementation.

- [ ] **Step 6: Prove the Hono response is JSON-safe and string-valued for all metrics**

Update the dashboard route test to assert string summary fields and run requests for `cost`, `tokens`, and `requests`. For each response:

```ts
expect(() => JSON.stringify(body)).not.toThrow();
expect(DashboardUsageOverviewResponseSchema.parse(body)).toEqual(body);
expect(typeof body.summary.requestCount).toBe('string');
for (const bucket of body.buckets) {
  for (const value of Object.values(bucket.values)) expect(typeof value).toBe('string');
}
```

Also assert the seeded cost is `estimatedCostNanoUsd: '250000000'` and no response property contains a bigint.

- [ ] **Step 7: Run focused Task 3 tests and commit**

Run:

```bash
rtk bun test packages/types/__tests__/schemas-events.test.ts
rtk bun test \
  packages/core/src/db/trace-store/usage-overview/usage-overview.test.ts \
  packages/core/__tests__/request-log-write.test.ts
rtk bun test --preload=./packages/server/__tests__/setup.ts packages/server/__tests__/usage-dashboard.test.ts
rtk bun run --filter @aio-proxy/types build
rtk bun run --filter @aio-proxy/core build
rtk git diff --check
```

Expected: all focused tests and builds PASS; `git diff --check` exits 0.

Commit:

```bash
rtk git add packages/types/src/dashboard.ts packages/types/__tests__/schemas-events.test.ts \
  packages/core/src/db/trace-store/usage-overview packages/core/src/db/request-log packages/core/__tests__ \
  packages/server/__tests__/usage-dashboard.test.ts
rtk git commit -m "fix(core): aggregate usage with bigint" \
  -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Dashboard bigint decoding, exact summaries, and Recharts boundary

**Files:**
- Modify: `packages/dashboard/src/modules/usage/services/usage-service.ts`
- Modify: `packages/dashboard/src/modules/usage/services/usage-value-formatter.ts`
- Modify: `packages/dashboard/src/modules/usage/components/usage-summary-grid.tsx`
- Modify: `packages/dashboard/src/modules/usage/components/usage-trend-chart.tsx`
- Modify: `packages/dashboard/src/components/token-count/format-token-count.ts`
- Modify: `packages/dashboard/src/components/token-count/format-token-count.test.ts`
- Modify: `packages/dashboard/src/components/token-count/token-count.tsx`
- Test: `packages/dashboard/src/modules/usage/templates/usage-overview.test.ts`

**Interfaces:**
- Consumes: the Task 3 wire DTO containing decimal strings.
- Produces: dashboard-local `UsageOverviewData` with bigint summary integers and `Record<string, bigint>` bucket values.
- Produces: exact token/count and nano-USD summary formatting.
- Preserves: logs and trace detail on number-based `UsageRow`; chart data passed to Recharts contains numbers only.

- [ ] **Step 1: Write failing dashboard decode/format tests**

In `usage-overview.test.ts`, build a complete wire fixture containing `'9007199254740993'` summary/bucket values and call an exported `decodeUsageOverview`. Assert:

```ts
expect(decoded.summary.totalTokens).toBe(9_007_199_254_740_993n);
expect(decoded.summary.requestCount).toBe(12n);
expect(decoded.buckets[0]?.values['model']).toBe(9_007_199_254_740_993n);
expect(decoded.summary.averageTpm).toBe(wire.summary.averageTpm);
```

Add exact formatting assertions:

```ts
expect(formatExactTokenCount(9_007_199_254_740_993n, 'en-US')).toBe('9,007,199,254,740,993');
expect(formatNanoUsd(2n, 'en-US')).toBe('$0.000000002');
expect(formatNanoUsd(9_007_199_254_740_993_000_000_002n, 'en-US'))
  .toBe('$9,007,199,254,740,993.000000002');
```

- [ ] **Step 2: Run dashboard tests and verify RED**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- \
  src/modules/usage/templates/usage-overview.test.ts \
  src/components/token-count/format-token-count.test.ts
```

Expected: FAIL because the query returns strings unchanged and the formatters accept only numbers/lose exact nano-USD precision.

- [ ] **Step 3: Decode the wire response immediately in the query service**

Keep the inferred Hono wire type, then explicitly decode every integer field:

```ts
type DashboardUsageWireResponse = InferResponseType<typeof dashboardClient.dashboard.api.usage.$get, 200>;

export const decodeUsageOverview = (wire: DashboardUsageWireResponse) => ({
  ...wire,
  summary: {
    ...wire.summary,
    estimatedCostNanoUsd: BigInt(wire.summary.estimatedCostNanoUsd),
    pricedRequestCount: BigInt(wire.summary.pricedRequestCount),
    usageRequestCount: BigInt(wire.summary.usageRequestCount),
    requestCount: BigInt(wire.summary.requestCount),
    successCount: BigInt(wire.summary.successCount),
    failureCount: BigInt(wire.summary.failureCount),
    cancelledCount: BigInt(wire.summary.cancelledCount),
    inputTokens: BigInt(wire.summary.inputTokens),
    outputTokens: BigInt(wire.summary.outputTokens),
    totalTokens: BigInt(wire.summary.totalTokens),
  },
  buckets: wire.buckets.map((bucket) => ({
    ...bucket,
    values: Object.fromEntries(Object.entries(bucket.values).map(([key, value]) => [key, BigInt(value)])),
  })),
});

export type UsageOverviewData = ReturnType<typeof decodeUsageOverview>;
```

Change `getUsage` to `return decodeUsageOverview(await response.json())`. Keep query keys string-only and do not add persistence/dehydration.

- [ ] **Step 4: Format bigint summaries exactly**

Widen token formatters and `TokenCount` to `number | bigint`; pass values directly to `Intl.NumberFormat`.

Add an exact nano-USD formatter that constructs decimal text before Intl formatting:

```ts
const NANO_USD_SCALE = 1_000_000_000n;

export const formatNanoUsd = (value: bigint, locale: string) => {
  const whole = value / NANO_USD_SCALE;
  const fraction = (value % NANO_USD_SCALE).toString().padStart(9, '0').replace(/0+$/u, '');
  const decimal = fraction === '' ? whole.toString() : `${whole}.${fraction}`;
  return new Intl.NumberFormat(locale, {
    currency: 'USD',
    maximumFractionDigits: 9,
    style: 'currency',
  }).format(decimal);
};
```

This must pass the decimal string directly to `Intl.NumberFormat`; do not insert `Number(decimal)`. Bun 1.3.14's Intl mathematical-value path has been probed with `9007199254740993.000000002` and preserves the exact digits, and the test above locks that browser-facing contract.

In `UsageSummaryGrid`, use `formatNanoUsd(summary.estimatedCostNanoUsd, getLocale())`. Pass request counts directly to `Intl.NumberFormat.format`, and keep ratios/RPM/TPM unchanged as numbers.

- [ ] **Step 5: Make Recharts the only lossy conversion boundary**

Build numeric chart data explicitly:

```ts
const chartData = data.buckets.map((bucket) => ({
  bucket: bucket.key,
  ...Object.fromEntries(
    Object.entries(bucket.values).map(([key, value]) => [
      key,
      data.metric === 'cost' ? Number(value) / 1_000_000_000 : Number(value),
    ]),
  ),
}));
```

Use `data.metric`, not a potentially stale atom value, when scaling bucket values. Keep tooltip/axis formatters number-based. Do not pass bigint to Recharts and do not call `JSON.stringify` on decoded query data.

- [ ] **Step 6: Run dashboard tests/build and commit**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit
rtk bun run --filter @aio-proxy/dashboard build
rtk git diff --check
```

Expected: dashboard tests and build PASS; `git diff --check` exits 0.

Commit:

```bash
rtk git add packages/dashboard/src/modules/usage packages/dashboard/src/components/token-count
rtk git commit -m "fix(dashboard): decode usage aggregates as bigint" \
  -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Final Verification and Delivery

After all four task reviews are clean:

1. Run the complete affected-package suites:

```bash
rtk bun run --filter @aio-proxy/types test:unit
rtk bun run --filter @aio-proxy/core test:unit
rtk bun run --filter @aio-proxy/server test:unit
rtk bun run --filter @aio-proxy/dashboard test:unit
```

2. Verify migration generation is clean and there is no `0002`:

```bash
rtk bun run build:migrations
rtk git status --short
rtk proxy rg --files packages/core/src/db/migrations | rtk rg '/0002_'
```

The last command should produce no migration path.

3. Run repository gates with fresh evidence:

```bash
rtk bun run check
rtk bun run preflight
rtk git diff --check origin/trace-session-affinity...HEAD
```

If `preflight` reproduces the known parent-branch type-aware lint or Paraglide network failures, record the exact commands and output alongside passing affected tests; do not claim the full gate passed.

4. Run a final whole-branch review against merge base `34fbbf7706f272e30c68ca48bf1ad6c083c338ac`, fix any Critical/Important findings in one reviewed wave, then push `fix/usage-bigint-fixed-cost`.

5. Create a stacked PR with base `trace-session-affinity`, title `fix(core): make usage aggregation integer-safe`, and a body stating:

- stacked on #74 and must not merge before #74;
- token sums remain exact beyond `2^53`;
- cost persists/aggregates in nano-USD integers;
- `UsageRow` and OTel remain number-based;
- aggregate JSON uses decimal strings and dashboard decodes to bigint;
- `usage_daily` retains only day + model dimensions;
- migration `0001` was regenerated and existing local databases must be recreated.

6. Comment `@cursor review` and `@codex review` on the created PR.
