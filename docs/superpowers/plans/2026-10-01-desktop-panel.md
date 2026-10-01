# Desktop Panel Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the menu-bar panel as one scrolling body of three groups (Usage with its own 24h/7d/30d switch, Quota with pace projections, the last 12 months). Move every service action into the icon's right-click menu. Back it with a range-driven `desktop-summary`.

**Architecture:**

- **Core.** A new trace-store method `desktopUsage({ range, now })` reuses the Dashboard overview's row sources:
  - span rows for `24h`;
  - `usage_daily` rows for `7d` and `30d`;
  - a grouped root-span scan for the per-Provider breakdown, which `usage_daily` cannot provide.

  It returns the current and previous windows' totals, buckets and the model breakdown.
- **Server.** `desktop-summary?range=` returns it, memoizes `7d`/`30d` for 60 s, and adds `accountLabel`, `quota.plan` and `diagnostic.suggestedCommand`.
- **Rust app.**
  - Parses the new DTO.
  - Keeps the last usage per range.
  - Computes metric deltas, quota pace and the heatmap grid in pure, tested modules.
  - Renders the new layout.
  - Builds the tray menu from the same offer table the old action row used.

**Tech Stack:**

- Bun + TypeScript: `bun:test`, zod v4, Hono, `bun:sqlite` via drizzle.
- Rust 1.98.1 with gpui-kit `=0.7.0` (gpui-pre 0.3.7), tray-icon 0.25.1 and muda 0.20, serde.

**Spec:** `docs/superpowers/specs/2026-10-01-desktop-panel-design.md`. It refines `docs/superpowers/specs/2026-09-29-desktop-client-design.md` (rev 4), which stays binding for everything the panel spec does not change.

**Branch:** create `claude/desktop-panel` from `claude/aio-proxy-desktop-client-27770c`.

## Global Constraints

- **Panel size and bands.** The panel stays 360 × 560 pt, laid out as header, one vertically scrolling body, and footer. There are no tabs and no ⋯ menu.
- **Groups.** The body holds three groups in order: **Usage**, **Quota**, **Last 12 months**. Only Usage follows the window switch, and the switch sits in the Usage group header.
- **Windows.** The choices are exactly `24h | 7d | 30d`.
  - `24h` is the rolling 24 hours, bucketed by hour.
  - `7d` and `30d` are today plus the previous 6 or 29 local days, bucketed by day (`resolveRange`).
  - The selection is remembered across panel closes and resets to `24h` on app launch.
- **Metric cards.** Four cards (Requests, Failed, Tokens, Cost) act as the metric picker. Exactly one is selected, Requests by default. The picked metric drives the trend chart and both breakdowns.
- **Card colors.**
  - Failed and Cost: increases are red (`danger`), decreases are teal (`success`).
  - Requests and Tokens: muted.
  - A previous value of 0 shows `new` when the current value is above 0, and `—` when both are 0.
- **Breakdowns.**
  - Top models shows the top **5** by the picked metric.
  - By Provider lists every Provider with traffic, with zero values last.
  - A zero total shows `No <metric> in this window`.
- **Quota group.**
  - It lists only Providers whose `quota.status` is `loading`, `failed` or `ready`.
  - A window below **15%** remaining fills amber.
  - Ranks: (1) failed quota or a diagnostic, (2) any window below 15%, (3) any window behind pace, (4) the rest by name.
  - Only ranks 1–2 count as "need attention".
- **Pace math (spec):**
  - `elapsed = clamp(1 − left/length, 0.01, 1)`
  - `expected = 1 − elapsed`
  - `burn = (1 − remaining)/(elapsed × length)`
  - `runsOutIn = remaining / burn`
  - `behind = remaining < expected && runsOutIn < left`
  - A `null` `windowMinutes`, `resetsAt` or `remainingRatio` means no tick and no projection.
- **Heatmap.** 53 weekly columns × 7 days, Sunday first, 10 pt cells with 2 pt gaps, five levels. It scrolls horizontally, opens at the latest week, and clicking a day selects it while clicking again clears the selection.
- **Right-click menu, in order:**
  1. Open Dashboard
  2. ---
  3. Install and start / Start / Stop / Restart / Reload config (as offered)
  4. Open logs
  5. ---
  6. Open at login (check item, persistent install only; `RequiresApproval` → "Open at login (needs approval)", which opens System Settings)
  7. Check for Updates…
  8. ---
  9. Quit AIO Proxy
- **DTO.** It stays `protocolVersion: 1` (unreleased) and changes in place. `?range=24h|7d|30d` defaults to `24h`; an unknown value returns 400. `usage24h` and `trend7d` are replaced by `usage`.
  - `providers[].accountLabel: string | null`
  - `diagnostic.suggestedCommand: string | null`
  - `quota.ready.plan: LocalizedText | null`
- **Usage memo.** The server memoizes `7d`/`30d` `usage` for **60 s** per range. `24h` is never memoized, and `refresh=true` bypasses and replaces the memo.
- **`byModel` and `byProvider`.** `byModel` holds at most **20** entries, ordered by cost then requests. `byProvider` groups root spans by `final_provider_id`. Tokens are always `input + output`.
- **Repo rules (CLAUDE.md):**
  - Colocated tests: `foo/index.ts` + `foo/foo.ts` + `foo/foo.test.ts` in TS, and `foo.rs` + `foo/tests.rs` in Rust.
  - Handwritten non-test files stay under 500 lines, with a split evaluated at 400.
  - Every user-facing changeset targets `aio-proxy`.
  - Run `bun run check` and the affected tests; `bun run preflight` before finishing.
- **Environment.**
  - Never touch the real service on 127.0.0.1:9317, `~/.aio-proxy`, `com.aio-proxy.agent`, `~/Library/LaunchAgents`, `/Applications` or `~/Applications`.
  - Never register a login item.
  - Never push.
  - Run Rust with plain `cargo` from `desktop/`.

## Review Focus

1. **A window switch while a fetch for the old window is in flight.** The old response must never land in the new window's cards. Task 7 drops the in-flight request on `set_range` and has a scheduler test for it.
2. **Switching back to a window seen this session.** It renders at once from the per-range cache, and Quota and the heatmap never blank while a new window loads. Task 7 (cache test) and Task 9 (skeleton only when uncached) cover this.
3. **Quota windows with missing fields or exhausted quota.** A `null` `resetsAt`, `null` `windowMinutes`, `remainingRatio` 0, or `remainingRatio` `null` must not panic or show a bogus projection. Task 5 has a table test.
4. **Requests that fail over across Providers.** A request that fails on A and succeeds on B counts once, under B, in By Provider. Task 1 has a test.
5. **Menu offers drifting from the old action row.** The right-click menu must offer exactly what the old panel row did, for every ownership and offer case, and Open at login must be absent outside a persistent install. Task 8 has a table test.

---

### Task 1: Core `desktopUsage` query

**Files:**
- Create: `packages/core/src/db/trace-store/desktop-usage/index.ts`, `desktop-usage.ts`, `desktop-usage.test.ts`
- Modify: `packages/core/src/db/trace-store/overview/overview.ts` (export three helpers), `packages/core/src/db/trace-store/overview/index.ts`, `packages/core/src/db/trace-store/types.ts`, `packages/core/src/db/trace-store/trace-store.ts`, `packages/core/src/db/trace-store/index.ts`
- Modify: `packages/types/src/desktop-summary/desktop-summary.ts` (add the range enum only)

**Interfaces:**
- Consumes the existing `resolveRange`, `rangeRows` (`spanRows`/`dailyRows`), `shiftRangeBack` and `bucketKeys` from `overview/`.
- Produces:
  - `DesktopUsageRangeSchema = z.enum(['24h', '7d', '30d'])`, plus `type DesktopUsageRange`, from `@aio-proxy/types`.
  - `TraceStore.desktopUsage(query: DesktopUsageQuery): DesktopUsageResult`, with:
    - `DesktopUsageQuery = { range: DesktopUsageRange; now?: Date }`
    - `DesktopUsageResult = { range; bucketUnit: 'hour' | 'day'; rangeStart: string; rangeEnd: string; current: DesktopUsageTotals; previous: DesktopUsageTotals; buckets: ({ start: string } & DesktopUsageSlice)[]; byModel: ({ modelId: string } & DesktopUsageSlice)[]; byProvider: ({ providerId: string } & DesktopUsageSlice)[] }`
    - `DesktopUsageTotals = { requests: string; failedRequests: string; inputTokens: string; outputTokens: string; estimatedCostNanoUsd: string; pricingCoverage: number | null }`
    - `DesktopUsageSlice = { requests: string; failedRequests: string; totalTokens: string; estimatedCostNanoUsd: string }`

- [ ] **Step 1: Add the range enum to `@aio-proxy/types`**

In `packages/types/src/desktop-summary/desktop-summary.ts`, directly after the imports, add:

```ts
// The panel's usage windows: a subset of the Dashboard overview ranges with the same boundaries.
export const DesktopUsageRangeSchema = z.enum(['24h', '7d', '30d']);
export type DesktopUsageRange = z.output<typeof DesktopUsageRangeSchema>;
```

In `packages/types/src/desktop-summary/index.ts`, add `DesktopUsageRangeSchema` and `type DesktopUsageRange` to the export list.

- [ ] **Step 2: Export the overview helpers the new query reuses**

In `packages/core/src/db/trace-store/overview/overview.ts`, add `export` to these three existing functions; leave their bodies unchanged:

```ts
export function rangeRows(db: BunSQLiteDatabase, range: ResolvedRange): readonly RootRow[] {
export function shiftRangeBack(range: ResolvedRange): ResolvedRange {
export function bucketKeys(range: DashboardOverviewRange, start: Date, end: Date): readonly ChartBucket[] {
```

Replace `packages/core/src/db/trace-store/overview/index.ts` with:

```ts
export { overviewDashboardActivity } from './activity';
export { overviewDashboardDiagnostics } from './diagnostics';
export { bucketKeys, overviewDashboard, rangeRows, shiftRangeBack } from './overview';
export { resolveRange, type ResolvedRange } from './range';
export type { RootRow } from './span-rows';
```

- [ ] **Step 3: Write the failing tests**

Create `packages/core/src/db/trace-store/desktop-usage/desktop-usage.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { createTraceStore } from '../index';
import { openTestDb } from '../test-support';
import { attemptSpan, completion, rootSpan, rootStart } from '../trace-store.test-support';
import type { TraceStore } from '../types';

const NOW = new Date('2026-07-11T08:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Seed = {
  readonly id: number;
  readonly endedAt: Date;
  readonly model?: string;
  /** Attempts in order; `fail: true` marks a failed attempt. The last non-failed one is final. */
  readonly attempts: readonly { readonly provider: string; readonly fail?: boolean }[];
  readonly input?: number;
  readonly output?: number;
  readonly costUsd?: number;
};

function seed(store: TraceStore, s: Seed): void {
  const traceId = s.id.toString(16).padStart(32, '0');
  const spanId = s.id.toString(16).padStart(16, '0');
  const startedAt = new Date(s.endedAt.getTime() - 1_000);
  const model = s.model ?? 'model-a';
  const final = s.attempts.findLast((attempt) => attempt.fail !== true);
  const attributes = {
    'aio_proxy.request.id': `request-${s.id}`,
    'aio_proxy.protocol.inbound': 'openai-response',
    'gen_ai.request.model': model,
    ...(final === undefined ? {} : { 'aio_proxy.route.final_provider_id': final.provider, 'gen_ai.response.model': model }),
  };
  store.startRoot(rootStart({ traceId, spanId, requestId: `request-${s.id}`, startedAt, attributes }));
  const inference = rootSpan({
    traceId,
    spanId: s.id.toString(16).padStart(16, 'f'),
    parentSpanId: spanId,
    name: 'aio_proxy.inference',
    startedAt,
    endedAt: s.endedAt,
    attributes: { 'gen_ai.request.model': model },
  });
  const attempts = s.attempts.map((attempt, index) =>
    attemptSpan({
      traceId,
      spanId: `${s.id.toString(16)}${index.toString(16)}`.padStart(16, 'a'),
      parentSpanId: inference.spanId,
      name: `chat ${model}`,
      startedAt,
      endedAt: s.endedAt,
      statusCode: attempt.fail === true ? 2 : 0,
      attributes: {
        'aio_proxy.attempt.index': index,
        'aio_proxy.provider.id': attempt.provider,
        'aio_proxy.transport': 'ai_sdk',
        'aio_proxy.protocol.target': 'openai-response',
        ...(attempt.fail === true ? { 'aio_proxy.termination.reason': 'failure' } : {}),
      },
    }),
  );
  const usage =
    final === undefined
      ? undefined
      : {
          providerId: final.provider,
          modelId: model,
          inputTokens: s.input ?? 10,
          outputTokens: s.output ?? 5,
          estimatedCostUsd: s.costUsd ?? 0.001,
        };
  store.complete(
    completion({
      traceId,
      rootSpanId: spanId,
      spans: [rootSpan({ traceId, spanId, startedAt, endedAt: s.endedAt, attributes }), inference, ...attempts],
      summary:
        final === undefined
          ? { terminationReason: 'failure' }
          : { finalProviderId: final.provider, finalModelId: model, ...(usage === undefined ? {} : { usage }) },
    }),
  );
}

function withStore(run: (store: TraceStore) => void): void {
  const handle = openTestDb();
  try {
    run(createTraceStore(handle.db));
  } finally {
    handle.close();
  }
}

test('24h: totals, failures, the previous window, and 24 hourly buckets', () => {
  withStore((store) => {
    seed(store, { id: 1, endedAt: new Date(NOW.getTime() - HOUR), attempts: [{ provider: 'a' }], input: 100, output: 20 });
    seed(store, { id: 2, endedAt: new Date(NOW.getTime() - 2 * HOUR), attempts: [{ provider: 'a', fail: true }] });
    // One minute before the window starts: previous window only.
    seed(store, { id: 3, endedAt: new Date(NOW.getTime() - DAY - 60_000), attempts: [{ provider: 'b' }] });

    const usage = store.desktopUsage({ range: '24h', now: NOW });

    expect(usage.bucketUnit).toBe('hour');
    expect(usage.buckets).toHaveLength(24);
    expect(usage.current.requests).toBe('2');
    expect(usage.current.failedRequests).toBe('1');
    expect(usage.current.inputTokens).toBe('100');
    expect(usage.current.outputTokens).toBe('20');
    expect(usage.previous.requests).toBe('1');
    expect(usage.buckets.reduce((sum, bucket) => sum + Number(bucket.requests), 0)).toBe(2);
    expect(usage.rangeStart).toBe(new Date(NOW.getTime() - DAY).toISOString());
    expect(usage.rangeEnd).toBe(NOW.toISOString());
  });
});

test('a request that fails over from A to B counts once, under B', () => {
  withStore((store) => {
    seed(store, {
      id: 1,
      endedAt: new Date(NOW.getTime() - HOUR),
      attempts: [{ provider: 'a', fail: true }, { provider: 'b' }],
      input: 7,
      output: 3,
    });

    const { byProvider } = store.desktopUsage({ range: '24h', now: NOW });

    expect(byProvider).toEqual([
      { providerId: 'b', requests: '1', failedRequests: '0', totalTokens: '10', estimatedCostNanoUsd: '1000000' },
    ]);
  });
});

test('7d: day buckets, and the previous window is the 7 local days before', () => {
  withStore((store) => {
    seed(store, { id: 1, endedAt: new Date(NOW.getTime() - HOUR), attempts: [{ provider: 'a' }] });
    seed(store, { id: 2, endedAt: new Date(NOW.getTime() - 8 * DAY), attempts: [{ provider: 'a' }] });
    seed(store, { id: 3, endedAt: new Date(NOW.getTime() - 20 * DAY), attempts: [{ provider: 'a' }] });

    const usage = store.desktopUsage({ range: '7d', now: NOW });

    expect(usage.bucketUnit).toBe('day');
    expect(usage.buckets).toHaveLength(7);
    expect(usage.current.requests).toBe('1');
    expect(usage.previous.requests).toBe('1');
  });
});

test('byModel is ordered by cost then requests and capped at 20', () => {
  withStore((store) => {
    for (let index = 0; index < 22; index++) {
      seed(store, {
        id: index + 1,
        endedAt: new Date(NOW.getTime() - HOUR),
        model: `model-${String(index).padStart(2, '0')}`,
        attempts: [{ provider: 'a' }],
        costUsd: index === 5 ? 1 : 0.001,
      });
    }

    const { byModel } = store.desktopUsage({ range: '24h', now: NOW });

    expect(byModel).toHaveLength(20);
    expect(byModel[0]?.modelId).toBe('model-05');
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `bun test packages/core/src/db/trace-store/desktop-usage`

Expected: FAIL. `store.desktopUsage` is not a function.

- [ ] **Step 5: Implement**

Create `packages/core/src/db/trace-store/desktop-usage/desktop-usage.ts`:

```ts
import type { Database, SQLQueryBindings } from 'bun:sqlite';

import type { DesktopUsageRange } from '@aio-proxy/types';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { parseSqliteInteger } from '../../../usage-numbers';
import { type ResolvedRange, type RootRow, bucketKeys, rangeRows, resolveRange, shiftRangeBack } from '../overview';

type IterableDatabase = BunSQLiteDatabase & { readonly $client: Database };

export type DesktopUsageQuery = { readonly range: DesktopUsageRange; readonly now?: Date };

export type DesktopUsageTotals = {
  readonly requests: string;
  readonly failedRequests: string;
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly estimatedCostNanoUsd: string;
  readonly pricingCoverage: number | null;
};

export type DesktopUsageSlice = {
  readonly requests: string;
  readonly failedRequests: string;
  readonly totalTokens: string;
  readonly estimatedCostNanoUsd: string;
};

export type DesktopUsageResult = {
  readonly range: DesktopUsageRange;
  readonly bucketUnit: 'hour' | 'day';
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly current: DesktopUsageTotals;
  readonly previous: DesktopUsageTotals;
  readonly buckets: readonly ({ readonly start: string } & DesktopUsageSlice)[];
  readonly byModel: readonly ({ readonly modelId: string } & DesktopUsageSlice)[];
  readonly byProvider: readonly ({ readonly providerId: string } & DesktopUsageSlice)[];
};

export const DESKTOP_USAGE_MAX_MODELS = 20;

type Totals = {
  requests: bigint;
  failed: bigint;
  input: bigint;
  output: bigint;
  cost: bigint;
  priced: bigint;
  withUsage: bigint;
};

const emptyTotals = (): Totals => ({ requests: 0n, failed: 0n, input: 0n, output: 0n, cost: 0n, priced: 0n, withUsage: 0n });

// Failures follow the Dashboard overview: error and interrupted count, cancelled does not.
function add(totals: Totals, row: RootRow): void {
  const count = row.requestCount ?? 1n;
  totals.requests += count;
  if (row.terminationReason === 'failure' || row.terminationReason === 'interrupted') totals.failed += count;
  totals.input += row.inputTokens;
  totals.output += row.outputTokens;
  totals.cost += row.estimatedCostNanoUsd;
  totals.priced += BigInt(row.priced);
  totals.withUsage += BigInt(row.hasUsage);
}

const toTotals = (t: Totals): DesktopUsageTotals => ({
  requests: t.requests.toString(),
  failedRequests: t.failed.toString(),
  inputTokens: t.input.toString(),
  outputTokens: t.output.toString(),
  estimatedCostNanoUsd: t.cost.toString(),
  pricingCoverage: t.withUsage === 0n ? null : Number(t.priced) / Number(t.withUsage),
});

// Tokens are input + output everywhere in the panel, as the Dashboard's Provider table counts them.
const toSlice = (t: Totals): DesktopUsageSlice => ({
  requests: t.requests.toString(),
  failedRequests: t.failed.toString(),
  totalTokens: (t.input + t.output).toString(),
  estimatedCostNanoUsd: t.cost.toString(),
});

const byCostThenRequests = (a: Totals, b: Totals): number =>
  a.cost === b.cost ? Number(b.requests - a.requests) : b.cost > a.cost ? 1 : -1;

function totalsOf(rows: readonly RootRow[]): Totals {
  const totals = emptyTotals();
  for (const row of rows) add(totals, row);
  return totals;
}

type RawProviderRow = {
  readonly providerId: string;
  readonly requests: string;
  readonly failedRequests: string;
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly cost: string;
};

/**
 * `usage_daily` has no Provider dimension, so the per-Provider split always reads root spans, as the
 * Dashboard's Provider health table does. Trace retention (45 days) covers the 30-day window.
 * Requests that never reached a Provider (`final_provider_id` null) have no Provider to count under.
 */
function providerTotals(db: BunSQLiteDatabase, range: ResolvedRange): Map<string, Totals> {
  const sql = `select final_provider_id as providerId,
      cast(count(*) as text) as requests,
      cast(count(case when termination_reason in ('failure', 'interrupted') then 1 end) as text) as failedRequests,
      cast(coalesce(sum(input_tokens), 0) as text) as inputTokens,
      cast(coalesce(sum(output_tokens), 0) as text) as outputTokens,
      cast(coalesce(sum(estimated_cost_nano_usd), 0) as text) as cost
    from trace_span
    where parent_span_id is null and final_provider_id is not null and ended_at >= ? and ended_at <= ?
    group by final_provider_id`;
  const statement = (db as IterableDatabase).$client.query<RawProviderRow, SQLQueryBindings[]>(sql);
  const out = new Map<string, Totals>();
  for (const row of statement.all(range.start.getTime(), range.end.getTime())) {
    out.set(row.providerId, {
      requests: parseSqliteInteger(row.requests),
      failed: parseSqliteInteger(row.failedRequests),
      input: parseSqliteInteger(row.inputTokens),
      output: parseSqliteInteger(row.outputTokens),
      cost: parseSqliteInteger(row.cost),
      priced: 0n,
      withUsage: 0n,
    });
  }
  return out;
}

export function desktopUsage(db: BunSQLiteDatabase, query: DesktopUsageQuery): DesktopUsageResult {
  const now = query.now ?? new Date();
  const range = resolveRange(query.range, now);
  const rows = rangeRows(db, range);
  const previousRange = shiftRangeBack(range);

  const keys = bucketKeys(query.range, range.start, range.end);
  const byBucket = new Map<string | number, Totals>(keys.map((key) => [key.identity, emptyTotals()]));
  const byModel = new Map<string, Totals>();
  for (const row of rows) {
    const bucket = byBucket.get(row.bucket);
    if (bucket !== undefined) add(bucket, row);
    const model = byModel.get(row.dimension) ?? emptyTotals();
    add(model, row);
    byModel.set(row.dimension, model);
  }

  return {
    range: query.range,
    bucketUnit: range.bucketUnit,
    rangeStart: range.start.toISOString(),
    rangeEnd: range.end.toISOString(),
    current: toTotals(totalsOf(rows)),
    previous: toTotals(totalsOf(rangeRows(db, previousRange))),
    buckets: keys.map((key) => ({ start: key.key, ...toSlice(byBucket.get(key.identity) ?? emptyTotals()) })),
    byModel: [...byModel]
      .sort(([, a], [, b]) => byCostThenRequests(a, b))
      .slice(0, DESKTOP_USAGE_MAX_MODELS)
      .map(([modelId, totals]) => ({ modelId, ...toSlice(totals) })),
    byProvider: [...providerTotals(db, range)]
      .sort(([, a], [, b]) => byCostThenRequests(a, b))
      .map(([providerId, totals]) => ({ providerId, ...toSlice(totals) })),
  };
}
```

Create `packages/core/src/db/trace-store/desktop-usage/index.ts`:

```ts
export {
  DESKTOP_USAGE_MAX_MODELS,
  desktopUsage,
  type DesktopUsageQuery,
  type DesktopUsageResult,
  type DesktopUsageSlice,
  type DesktopUsageTotals,
} from './desktop-usage';
```

In `packages/core/src/db/trace-store/types.ts`:
1. Add this import below the existing imports:

   ```ts
   import type { DesktopUsageQuery, DesktopUsageResult } from './desktop-usage';
   ```

2. Add this member to `TraceStore` right after `overviewDashboardActivity`:

   ```ts
     readonly desktopUsage: (query: DesktopUsageQuery) => DesktopUsageResult;
   ```

In `packages/core/src/db/trace-store/trace-store.ts`:
1. Import `desktopUsage` from `./desktop-usage`.
2. Add `desktopUsage: (query) => desktopUsage(db, query),` after the `overviewDashboardActivity` entry.

In `packages/core/src/db/trace-store/index.ts`, add this line:

```ts
export type { DesktopUsageQuery, DesktopUsageResult, DesktopUsageSlice, DesktopUsageTotals } from './desktop-usage';
```

Check that the root `@aio-proxy/core/db` entry re-exports trace-store types the way it does for `TraceStore`. If it lists names explicitly, add these four there too.

If a type-only cycle appears between `types.ts` and `desktop-usage.ts`, move the four `DesktopUsage*` types into `types.ts` and import them back into `desktop-usage.ts`.

- [ ] **Step 6: Run the tests**

Run: `bun test packages/core/src/db/trace-store/desktop-usage packages/core/src/db/trace-store/overview`

Expected: PASS. The new tests pass, and the overview tests still pass, unchanged.

Run: `bun run check && bun run --filter @aio-proxy/core build`

Expected: clean.

- [ ] **Step 7: Measure `30d` cost (scratch only, not committed)**

Write a throwaway script in the session scratchpad, not in the repo:
1. Open a temp DB with the core's migrations, as `openTestDb()` does. Seed one trace with the Step 3 `seed` helper.
2. Read `PRAGMA table_info(trace_span)`.
3. Clone the template root span with one `INSERT INTO trace_span (<all columns>) SELECT <columns, overriding trace_id/span_id/started_at/ended_at/final_provider_id> FROM trace_span, (WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 1080000) SELECT i FROM n) WHERE span_id = <template>`. This gives:
   - ids: `printf('%032x', i)` and `printf('%016x', i)`;
   - `ended_at` spread evenly over the last 30 days;
   - `final_provider_id` cycling through six ids.
4. Run `desktopUsage({ range: '30d' })` and `desktopUsage({ range: '24h' })` five times each and record the median.

Report both numbers in the task report:
- `30d` must stay under **250 ms**. If it does not, say so prominently; the spec's upgrade path is a Provider dimension in `usage_daily`.
- `24h` must stay under **50 ms**.

Delete the script afterwards.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/db/trace-store packages/types/src/desktop-summary
git commit -m "feat(core): add the desktop usage query over the dashboard's row sources"
```

---

### Task 2: `desktop-summary` DTO, range, memo and new fields

**Files:**
- Modify: `packages/types/src/desktop-summary/desktop-summary.ts`, `index.ts`, `fixtures/v1.json`
- Modify: `packages/server/src/dashboard-routes/desktop-summary/desktop-summary.ts`, `route.ts`
- Test: `packages/server/src/dashboard-routes/desktop-summary/desktop-summary.test.ts`, `route.test.ts`

**Interfaces:**
- Consumes: `TraceStore.desktopUsage` and `DesktopUsageRange` (Task 1); `dashboardProviderSuggestedCommand` (`@aio-proxy/types`); `DashboardProviderSummary.accountLabel`; `OAuthQuotaSnapshot.plan`.
- Produces:
  - The new `DesktopSummaryV1Schema` (shape below) and the regenerated `fixtures/v1.json`, which Task 3's Rust golden test reads.
  - `createUsageMemo(): UsageMemo` and `USAGE_MEMO_MS = 60_000`.
  - `buildDesktopSummary(source, input & { range }, memo?)`.

- [ ] **Step 1: Replace the schema**

In `packages/types/src/desktop-summary/desktop-summary.ts`, make these changes:

1. Replace the `DesktopProviderSchema`'s `diagnostic` with:

   ```ts
       diagnostic: z
         .object({ code: z.string().min(1), summary: z.string().min(1), suggestedCommand: z.string().min(1).nullable() })
         .strict()
         .nullable(),
   ```

2. Add `accountLabel: z.string().min(1).nullable(),` to `DesktopProviderSchema` after `enabled`.

3. In `DesktopQuotaSchema`'s `ready` member, add `plan: DashboardLocalizedTextSchema.nullable(),` after `refreshFailed`.

4. Above `DesktopSummaryV1Schema`, add:

   ```ts
   const DesktopUsageTotalsSchema = z
     .object({
       requests: NonNegativeIntegerStringSchema,
       failedRequests: NonNegativeIntegerStringSchema,
       inputTokens: NonNegativeIntegerStringSchema,
       outputTokens: NonNegativeIntegerStringSchema,
       estimatedCostNanoUsd: NonNegativeIntegerStringSchema,
       pricingCoverage: z.number().min(0).max(1).nullable(),
     })
     .strict();

   const sliceShape = {
     requests: NonNegativeIntegerStringSchema,
     failedRequests: NonNegativeIntegerStringSchema,
     totalTokens: NonNegativeIntegerStringSchema,
     estimatedCostNanoUsd: NonNegativeIntegerStringSchema,
   };

   export const DesktopUsageSchema = z
     .object({
       range: DesktopUsageRangeSchema,
       bucketUnit: z.enum(['hour', 'day']),
       rangeStart: z.iso.datetime(),
       rangeEnd: z.iso.datetime(),
       current: DesktopUsageTotalsSchema,
       previous: DesktopUsageTotalsSchema,
       buckets: z.array(z.object({ start: z.iso.datetime(), ...sliceShape }).strict()),
       byModel: z.array(z.object({ modelId: z.string().min(1), ...sliceShape }).strict()).max(20),
       byProvider: z.array(z.object({ providerId: z.string().min(1), name: z.string().min(1), ...sliceShape }).strict()),
     })
     .strict();
   ```

5. In `DesktopSummaryV1Schema`, replace the `usage24h` and `trend7d` keys with `usage: DesktopUsageSchema,`.

6. Add `export type DesktopUsage = z.output<typeof DesktopUsageSchema>;`, and export `DesktopUsageSchema` and `type DesktopUsage` from `index.ts`.

- [ ] **Step 2: Regenerate the golden fixture**

Replace `packages/types/src/desktop-summary/fixtures/v1.json` with:

```json
{
  "protocolVersion": 1,
  "generatedAt": "2026-09-29T08:00:00.000Z",
  "server": { "version": "0.36.0", "pid": 4312, "ppid": 4310 },
  "usage": {
    "range": "7d",
    "bucketUnit": "day",
    "rangeStart": "2026-09-22T16:00:00.000Z",
    "rangeEnd": "2026-09-29T08:00:00.000Z",
    "current": {
      "requests": "257",
      "failedRequests": "53",
      "inputTokens": "14815402",
      "outputTokens": "44305",
      "estimatedCostNanoUsd": "20521353840",
      "pricingCoverage": 1
    },
    "previous": {
      "requests": "200",
      "failedRequests": "60",
      "inputTokens": "10000000",
      "outputTokens": "40000",
      "estimatedCostNanoUsd": "18000000000",
      "pricingCoverage": 0.5
    },
    "buckets": [
      { "start": "2026-09-28T16:00:00.000Z", "requests": "257", "failedRequests": "53", "totalTokens": "14859707", "estimatedCostNanoUsd": "20521353840" }
    ],
    "byModel": [
      { "modelId": "gpt-5.2-codex", "requests": "257", "failedRequests": "53", "totalTokens": "14859707", "estimatedCostNanoUsd": "20521353840" }
    ],
    "byProvider": [
      { "providerId": "codex", "name": "Codex", "requests": "257", "failedRequests": "53", "totalTokens": "14859707", "estimatedCostNanoUsd": "20521353840" }
    ]
  },
  "activity": [{ "date": "2026-09-29", "totalTokens": "14859707" }],
  "providers": [
    {
      "id": "codex",
      "name": "Codex",
      "enabled": true,
      "accountLabel": "you@example.com",
      "state": "ok",
      "diagnostic": null,
      "quota": {
        "status": "ready",
        "sampledAt": "2026-09-29T07:58:00.000Z",
        "refreshFailed": false,
        "plan": { "default": "Pro", "zh-Hans": "专业版" },
        "windows": [
          {
            "id": "primary",
            "label": { "default": "5 hours", "zh-Hans": "5 小时" },
            "remainingRatio": 0.4,
            "resetsAt": "2026-09-29T10:00:00.000Z",
            "windowMinutes": 300
          }
        ]
      }
    },
    {
      "id": "cursor",
      "name": "cursor",
      "enabled": true,
      "accountLabel": null,
      "state": "degraded",
      "diagnostic": {
        "code": "CREDENTIAL_REFRESH_FAILED",
        "summary": "Refresh token expired",
        "suggestedCommand": "aio-proxy provider login cursor"
      },
      "quota": { "status": "loading" }
    }
  ],
  "alerts": [{ "providerId": "cursor", "kind": "diagnostic", "message": "Refresh token expired" }]
}
```

Run: `bun test packages/types/src/desktop-summary`

Expected: PASS.

- [ ] **Step 3: Update the server tests first**

In `packages/server/src/dashboard-routes/desktop-summary/desktop-summary.test.ts`, do the following.

1. Replace the `traceStore` stub's `overview` and `overviewDashboard` members with a single `desktopUsage` stub that counts its calls:

   ```ts
   let usageCalls = 0;
   const usage = (range: '24h' | '7d' | '30d') => ({
     range,
     bucketUnit: range === '24h' ? ('hour' as const) : ('day' as const),
     rangeStart: '2026-09-28T08:00:00.000Z',
     rangeEnd: now.toISOString(),
     current: { requests: '10', failedRequests: '3', inputTokens: '600', outputTokens: '400', estimatedCostNanoUsd: '20', pricingCoverage: 0.5 },
     previous: { requests: '8', failedRequests: '1', inputTokens: '500', outputTokens: '300', estimatedCostNanoUsd: '10', pricingCoverage: null },
     buckets: [{ start: '2026-09-28T08:00:00.000Z', requests: '10', failedRequests: '3', totalTokens: '1000', estimatedCostNanoUsd: '20' }],
     byModel: [{ modelId: 'm', requests: '10', failedRequests: '3', totalTokens: '1000', estimatedCostNanoUsd: '20' }],
     byProvider: [
       { providerId: 'codex', requests: '9', failedRequests: '3', totalTokens: '900', estimatedCostNanoUsd: '20' },
       { providerId: 'gone', requests: '1', failedRequests: '0', totalTokens: '100', estimatedCostNanoUsd: '0' },
     ],
   });
   ```

   The stub's member becomes `desktopUsage: ({ range }) => { usageCalls += 1; return usage(range); },`. Keep the existing `overviewDashboardActivity` stub.

2. Replace every existing assertion that reads `usage24h` or `trend7d` with the matching `usage.current` or `usage.buckets` assertion. Pass `range: '24h'` in every existing `buildDesktopSummary` input.

3. Add these tests:

```ts
test('usage carries the requested range and names each Provider, falling back to its id', async () => {
  const summary = await buildDesktopSummary(source, { ...input, range: '7d' });
  expect(summary.usage.range).toBe('7d');
  expect(summary.usage.byProvider.map((p) => p.name)).toEqual(['Codex', 'gone']);
  expect(DesktopSummaryV1Schema.safeParse(summary).success).toBe(true);
});

test('7d and 30d usage is memoized for 60 s per range; 24h and refresh=true always recompute', async () => {
  const memo = createUsageMemo();
  usageCalls = 0;
  await buildDesktopSummary(source, { ...input, range: '30d' }, memo);
  await buildDesktopSummary(source, { ...input, range: '30d', now: new Date(now.getTime() + 59_000) }, memo);
  expect(usageCalls).toBe(1);
  await buildDesktopSummary(source, { ...input, range: '30d', now: new Date(now.getTime() + 61_000) }, memo);
  expect(usageCalls).toBe(2);
  await buildDesktopSummary(source, { ...input, range: '30d', refresh: true }, memo);
  expect(usageCalls).toBe(3);
  await buildDesktopSummary(source, { ...input, range: '24h' }, memo);
  await buildDesktopSummary(source, { ...input, range: '24h' }, memo);
  expect(usageCalls).toBe(5);
});

test('accountLabel, quota plan and the suggested command pass through as null when absent', async () => {
  const summary = await buildDesktopSummary(source, { ...input, range: '24h' });
  for (const provider of summary.providers) {
    expect(provider).toHaveProperty('accountLabel');
    if (provider.diagnostic !== null) expect(provider.diagnostic).toHaveProperty('suggestedCommand');
    if (provider.quota.status === 'ready') expect(provider.quota).toHaveProperty('plan');
  }
});
```

Here `source` and `input` are the file's existing fixtures. Rename them if the file uses other names.

Give one existing Provider summary fixture `accountLabel: 'you@example.com'` and one quota snapshot `plan: 'Pro'`, then assert both values appear in the output.

4. In `route.test.ts`, add:

```ts
test('an unknown range is a 400 and does not build a summary', async () => {
  const response = await app.request('/?range=90d', { headers: authorized });
  expect(response.status).toBe(400);
});
```

Use whatever names the file already uses for the app and the authorized headers.

Run: `bun test packages/server/src/dashboard-routes/desktop-summary`

Expected: FAIL. `createUsageMemo` is missing, and `desktopUsage` is not used yet.

- [ ] **Step 4: Implement the builder**

In `packages/server/src/dashboard-routes/desktop-summary/desktop-summary.ts`:

1. Update the imports:

   ```ts
   import type { DesktopUsageResult, TraceStore } from '@aio-proxy/core/db';
   import {
     DesktopQuotaSchema,
     dashboardProviderSuggestedCommand,
     type DashboardProviderSummary,
     type DesktopProvider,
     type DesktopQuota,
     type DesktopSummaryV1,
     type DesktopUsageRange,
   } from '@aio-proxy/types';
   ```

   If `@aio-proxy/core/db` does not export `DesktopUsageResult`, import it from wherever Task 1 placed the re-export.

2. Change `DesktopSummarySource.traceStore` to `Pick<TraceStore, 'desktopUsage' | 'overviewDashboardActivity'>`.

3. Add `readonly range: DesktopUsageRange;` to `DesktopSummaryInput`.

4. Delete `Bucket`, `sumValues` and `totalsByKey`.

5. Add:

   ```ts
   export const USAGE_MEMO_MS = 60_000;

   export type UsageMemo = { readonly entries: Map<DesktopUsageRange, { readonly at: number; readonly usage: DesktopUsageResult }> };

   export const createUsageMemo = (): UsageMemo => ({ entries: new Map() });

   // 7d/30d split usage by Provider by scanning a month of root spans; once a minute is affordable,
   // once per 15 s tick per open panel is not. 24h stays live, as rev 4 measured it.
   function usageFor(source: DesktopSummarySource, input: DesktopSummaryInput, memo: UsageMemo | undefined): DesktopUsageResult {
     const compute = () => source.traceStore.desktopUsage({ range: input.range, now: input.now });
     if (input.range === '24h' || memo === undefined) return compute();
     const hit = memo.entries.get(input.range);
     if (!input.refresh && hit !== undefined && input.now.getTime() - hit.at < USAGE_MEMO_MS) return hit.usage;
     const usage = compute();
     memo.entries.set(input.range, { at: input.now.getTime(), usage });
     return usage;
   }
   ```

6. In `readyQuota`, add `plan: entry.snapshot.plan ?? null,` after `refreshFailed`.

7. Replace the body of `toDesktopProvider` with:

   ```ts
     const diagnostic = summary.state.diagnostic;
     return {
       id: summary.id,
       // `name: ""` is valid config but the DTO requires a non-empty name.
       name: summary.name === undefined || summary.name === '' ? summary.id : summary.name,
       enabled: summary.enabled,
       accountLabel: summary.accountLabel === undefined || summary.accountLabel === '' ? null : summary.accountLabel,
       state: providerState(summary),
       diagnostic:
         diagnostic === undefined
           ? null
           : {
               code: diagnostic.code,
               summary: diagnostic.summary,
               suggestedCommand: dashboardProviderSuggestedCommand(summary) ?? null,
             },
       quota,
     };
   ```

8. Replace `buildDesktopSummary` with:

   ```ts
   export async function buildDesktopSummary(
     source: DesktopSummarySource,
     input: DesktopSummaryInput,
     memo?: UsageMemo,
   ): Promise<DesktopSummaryV1> {
     const usage = usageFor(source, input, memo);
     const activity = source.traceStore.overviewDashboardActivity({ now: input.now });
     const summaries = await source.providerSummaries({ probe: false });
     const names = new Map(summaries.map((summary) => [summary.id, summary.name === undefined || summary.name === '' ? summary.id : summary.name]));
     const providers = summaries.map((summary) =>
       toDesktopProvider(summary, quotaFor(source.quotaCache, summary, input.refresh)),
     );
     return {
       protocolVersion: 1,
       generatedAt: input.now.toISOString(),
       server: { version: input.version, pid: input.pid, ppid: input.ppid },
       usage: {
         ...usage,
         // A Provider removed from config still has history: it keeps its id as its name.
         byProvider: usage.byProvider.map((entry) => ({ ...entry, name: names.get(entry.providerId) ?? entry.providerId })),
       },
       activity: activity.items.map((item) => ({ date: item.date, totalTokens: item.totalTokens })),
       providers,
       alerts: alertsFor(providers),
     };
   }
   ```

   If `dashboardProviderSuggestedCommand`'s parameter type rejects a full `DashboardProviderSummary`, pass `{ id: summary.id, state: summary.state }`.

- [ ] **Step 5: Implement the route**

Replace `createDesktopSummaryRoute` in `route.ts` with:

```ts
export const createDesktopSummaryRoute = (state: ServerState, version: string) => {
  const memo = createUsageMemo();
  return new Hono().get('/', requireDesktopToken(() => state.desktopToken), async (context) => {
    const range = DesktopUsageRangeSchema.safeParse(context.req.query('range') ?? '24h');
    if (!range.success) return context.json({ error: 'invalid range' }, 400);
    return context.json(
      await buildDesktopSummary(
        state,
        {
          version,
          pid: process.pid,
          ppid: process.ppid,
          now: new Date(),
          refresh: context.req.query('refresh') === 'true',
          range: range.data,
        },
        memo,
      ),
    );
  });
};
```

Import `DesktopUsageRangeSchema` from `@aio-proxy/types`, and `createUsageMemo` from `./desktop-summary`. Keep the route's existing return type: if callers chain `.route(...)` on a typed Hono, the function must still return the Hono instance.

- [ ] **Step 6: Run the tests and checks**

Run: `bun test packages/server/src/dashboard-routes/desktop-summary packages/types/src/desktop-summary`

Expected: PASS.

Run: `bun run check && bun run build && bun run lint:types`

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/desktop-summary packages/server/src/dashboard-routes/desktop-summary
git commit -m "feat(server): serve range-driven desktop usage with plan, account and fix command"
```

---

### Task 3: Rust summary types for the new DTO

**Files:**
- Modify: `desktop/src/summary.rs`, `desktop/src/summary/tests.rs`
- Modify (only to compile): `desktop/src/panel/view.rs`, `desktop/src/panel/charts.rs`, `desktop/src/panel/charts/tests.rs`

**Interfaces:**
- Consumes: the Task 2 fixture.
- Produces:
  - `SummaryV1 { usage: Usage, … }`
  - `Usage { range: UsageRange, bucket_unit: BucketUnit, range_start: String, range_end: String, current: UsageTotals, previous: UsageTotals, buckets: Vec<UsageBucket>, by_model: Vec<ModelUsage>, by_provider: Vec<ProviderUsage> }`
  - `UsageRange::{H24, D7, D30}` with `query() -> &'static str` and `label() -> &'static str`, plus `UsageRange::ALL`
  - `BucketUnit::{Hour, Day}`
  - `UsageTotals { requests, failed_requests, input_tokens, output_tokens, estimated_cost_nano_usd: u128, pricing_coverage: Option<f64> }`
  - `UsageSlice { requests, failed_requests, total_tokens, estimated_cost_nano_usd: u128 }`
  - `UsageBucket { start: String, slice: UsageSlice }`
  - `ModelUsage { model_id: String, slice: UsageSlice }`
  - `ProviderUsage { provider_id: String, name: String, slice: UsageSlice }`
  - `Provider.account_label: Option<String>`
  - `Diagnostic.suggested_command: Option<String>`
  - `Quota::Ready { plan: Option<LocalizedText>, … }`

- [ ] **Step 1: Update the golden test first**

In `desktop/src/summary/tests.rs`, replace `the_golden_fixture_parses` with:

```rust
#[test]
fn the_golden_fixture_parses() {
    let summary = v1(GOLDEN);
    assert_eq!(summary.server.version, "0.36.0");
    assert_eq!(summary.server.ppid, Some(4310));
    let usage = &summary.usage;
    assert_eq!(usage.range, UsageRange::D7);
    assert_eq!(usage.bucket_unit, BucketUnit::Day);
    assert_eq!(usage.current.requests, 257);
    assert_eq!(usage.current.estimated_cost_nano_usd, 20_521_353_840);
    assert_eq!(usage.previous.pricing_coverage, Some(0.5));
    assert_eq!(usage.buckets[0].slice.failed_requests, 53);
    assert_eq!(usage.by_model[0].model_id, "gpt-5.2-codex");
    assert_eq!(usage.by_provider[0].name, "Codex");
    assert_eq!(summary.activity[0].date, "2026-09-29");
    let codex = &summary.providers[0];
    assert_eq!(codex.state, ProviderState::Ok);
    assert_eq!(codex.account_label.as_deref(), Some("you@example.com"));
    let Quota::Ready { windows, refresh_failed, plan, .. } = &codex.quota else {
        panic!("codex quota should be ready");
    };
    assert!(!refresh_failed);
    assert_eq!(plan.as_ref().map(LocalizedText::text), Some("Pro"));
    assert_eq!(windows[0].label.text(), "5 hours");
    let cursor = &summary.providers[1];
    assert_eq!(cursor.account_label, None);
    assert_eq!(
        cursor.diagnostic.as_ref().and_then(|d| d.suggested_command.as_deref()),
        Some("aio-proxy provider login cursor")
    );
    assert!(matches!(cursor.quota, Quota::Loading));
    assert_eq!(summary.alerts[0].kind, AlertKind::Diagnostic);
    assert!(summary.any_quota_loading());
}

#[test]
fn an_unknown_usage_range_is_an_invalid_summary() {
    let mut json: serde_json::Value = serde_json::from_str(GOLDEN).unwrap();
    json["usage"]["range"] = serde_json::json!("90d");
    assert!(matches!(parse(json.to_string().as_bytes()), Parsed::Invalid(_)));
}

#[test]
fn range_query_values_match_the_server() {
    assert_eq!(UsageRange::ALL.map(UsageRange::query), ["24h", "7d", "30d"]);
}
```

Replace any other test in the file that reads `usage24h` or `trend7d` with the `usage.current` or `usage.buckets` equivalent.

Run: `cd desktop && cargo test summary`

Expected: FAIL to compile. There are no `usage` fields yet.

- [ ] **Step 2: Implement the types**

In `desktop/src/summary.rs`:

1. Replace the `usage24h` and `trend7d` fields of `SummaryV1` with `pub usage: Usage,`.
2. Delete `Usage24h` and `TrendBucket`.
3. Add:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
pub enum UsageRange {
    #[serde(rename = "24h")]
    H24,
    #[serde(rename = "7d")]
    D7,
    #[serde(rename = "30d")]
    D30,
}

impl UsageRange {
    pub const ALL: [UsageRange; 3] = [UsageRange::H24, UsageRange::D7, UsageRange::D30];

    /// The `?range=` value; also the segmented control's label.
    pub fn query(self) -> &'static str {
        match self {
            UsageRange::H24 => "24h",
            UsageRange::D7 => "7d",
            UsageRange::D30 => "30d",
        }
    }

    pub fn label(self) -> &'static str {
        self.query()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BucketUnit {
    Hour,
    Day,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub range: UsageRange,
    pub bucket_unit: BucketUnit,
    pub range_start: String,
    pub range_end: String,
    pub current: UsageTotals,
    pub previous: UsageTotals,
    #[serde(default)]
    pub buckets: Vec<UsageBucket>,
    #[serde(default)]
    pub by_model: Vec<ModelUsage>,
    #[serde(default)]
    pub by_provider: Vec<ProviderUsage>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    #[serde(deserialize_with = "decimal")]
    pub requests: u128,
    #[serde(deserialize_with = "decimal")]
    pub failed_requests: u128,
    #[serde(deserialize_with = "decimal")]
    pub input_tokens: u128,
    #[serde(deserialize_with = "decimal")]
    pub output_tokens: u128,
    #[serde(deserialize_with = "decimal")]
    pub estimated_cost_nano_usd: u128,
    pub pricing_coverage: Option<f64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSlice {
    #[serde(deserialize_with = "decimal")]
    pub requests: u128,
    #[serde(deserialize_with = "decimal")]
    pub failed_requests: u128,
    #[serde(deserialize_with = "decimal")]
    pub total_tokens: u128,
    #[serde(deserialize_with = "decimal")]
    pub estimated_cost_nano_usd: u128,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UsageBucket {
    pub start: String,
    #[serde(flatten)]
    pub slice: UsageSlice,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model_id: String,
    #[serde(flatten)]
    pub slice: UsageSlice,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub provider_id: String,
    pub name: String,
    #[serde(flatten)]
    pub slice: UsageSlice,
}
```

4. Add `#[serde(default, rename = "accountLabel")] pub account_label: Option<String>,` to `Provider`.
5. Add `#[serde(default, rename = "suggestedCommand")] pub suggested_command: Option<String>,` to `Diagnostic`.
6. Add `#[serde(default)] plan: Option<LocalizedText>,` to `Quota::Ready`.

`decimal` with `#[serde(flatten)]` sometimes fails, because flatten buffers values as `Content`. If it does, give `UsageBucket`, `ModelUsage` and `ProviderUsage` the four counts as their own fields. Add a `pub fn slice(&self) -> UsageSlice` to each, and update the Step 1 test to call `.slice()`. Report the choice.

- [ ] **Step 3: Keep the current panel compiling**

This is a stop-gap only; Task 9 replaces both files.

In `desktop/src/panel/view.rs`, replace `fn cards`'s body with:

```rust
    let usage = &summary.usage.current;
    h_flex()
        .gap_2()
        .child(card("Requests", compact(usage.requests), cx))
        .child(card("Failed", compact(usage.failed_requests), cx))
        .child(card("Tokens", compact(usage.input_tokens + usage.output_tokens), cx))
        .child(card("Cost", usd(usage.estimated_cost_nano_usd), cx))
```

Change `charts::trend(&summary.trend7d, now, cx)` to `charts::trend(&summary.usage.buckets, now, cx)`.

In `desktop/src/panel/charts.rs`:
1. Change `TrendBucket` to `UsageBucket` in the import, in `trend_points`, and in `trend`.
2. In `trend_points`, read `b.slice.requests as f64`.

In `desktop/src/panel/charts/tests.rs`, build `UsageBucket { start, slice: UsageSlice { requests, ..Default::default() } }` wherever a `TrendBucket` was built.

- [ ] **Step 4: Run the tests**

Run: `cd desktop && cargo fmt && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked`

Expected: clean and all pass, with the new summary tests included.

- [ ] **Step 5: Commit**

```bash
git add desktop/src
git commit -m "feat(desktop): read the range-driven usage block, plan, account and fix command"
```

---

### Task 4: Usage model (metrics, deltas, breakdowns, bucket labels)

**Files:**
- Create: `desktop/src/panel/usage.rs`, `desktop/src/panel/usage/tests.rs`
- Modify: `desktop/src/panel.rs` (add `mod usage;`)

**Interfaces:**
- Consumes: `UsageTotals`, `UsageSlice`, `Usage`, `BucketUnit` (Task 3); `format::{compact, usd, civil_from_days, local_utc_offset, parse_utc}`.
- Produces:
  - `Metric::{Requests, Failed, Tokens, Cost}` with `Metric::ALL`, `label()` and `empty_text()`
  - `metric_total(&UsageTotals, Metric) -> u128`
  - `slice_value(&UsageSlice, Metric) -> u128`
  - `format_value(u128, Metric) -> String`
  - `Tone::{Neutral, Bad, Good}`
  - `delta(current: u128, previous: u128, metric) -> (String, Tone)`
  - `card_value(&UsageTotals, Metric) -> String`, which adds the `≈` prefix for partial pricing and returns `—` when pricing is null
  - `ranked<'a, T>(items: &'a [T], slice: impl Fn(&T) -> &UsageSlice, metric, limit: Option<usize>) -> Vec<(&'a T, u128, f64)>`, returning (item, value, share)
  - `bucket_label(start: &str, unit: BucketUnit, utc_offset: i64) -> String`

- [ ] **Step 1: Write the failing tests**

Create `desktop/src/panel/usage/tests.rs`:

```rust
use super::*;

fn totals(requests: u128, failed: u128, cost: u128, coverage: Option<f64>) -> UsageTotals {
    UsageTotals {
        requests,
        failed_requests: failed,
        input_tokens: 60,
        output_tokens: 40,
        estimated_cost_nano_usd: cost,
        pricing_coverage: coverage,
    }
}

#[test]
fn deltas_color_failed_and_cost_but_not_traffic() {
    assert_eq!(delta(112, 100, Metric::Requests), ("↑ 12%".to_string(), Tone::Neutral));
    assert_eq!(delta(90, 100, Metric::Tokens), ("↓ 10%".to_string(), Tone::Neutral));
    assert_eq!(delta(8, 5, Metric::Failed), ("+3".to_string(), Tone::Bad));
    assert_eq!(delta(3, 5, Metric::Failed), ("−2".to_string(), Tone::Good));
    assert_eq!(delta(105, 100, Metric::Cost), ("↑ 5%".to_string(), Tone::Bad));
    assert_eq!(delta(95, 100, Metric::Cost), ("↓ 5%".to_string(), Tone::Good));
}

#[test]
fn a_zero_previous_window_reads_new_or_dash() {
    assert_eq!(delta(4, 0, Metric::Requests), ("new".to_string(), Tone::Neutral));
    assert_eq!(delta(0, 0, Metric::Cost), ("—".to_string(), Tone::Neutral));
}

#[test]
fn cost_marks_partial_pricing_and_unknown_pricing() {
    assert_eq!(card_value(&totals(1, 0, 4_120_000_000, Some(1.0)), Metric::Cost), "$4.12");
    assert_eq!(card_value(&totals(1, 0, 4_120_000_000, Some(0.8)), Metric::Cost), "≈$4.12");
    assert_eq!(card_value(&totals(1, 0, 0, None), Metric::Cost), "—");
    assert_eq!(card_value(&totals(1_240, 0, 0, None), Metric::Requests), "1.2K");
    assert_eq!(card_value(&totals(1, 0, 0, None), Metric::Tokens), "100");
}

#[test]
fn ranking_follows_the_metric_and_puts_zeros_last() {
    let slices = [
        UsageSlice { requests: 10, failed_requests: 0, total_tokens: 5, estimated_cost_nano_usd: 0 },
        UsageSlice { requests: 2, failed_requests: 2, total_tokens: 50, estimated_cost_nano_usd: 9 },
        UsageSlice { requests: 5, failed_requests: 0, total_tokens: 0, estimated_cost_nano_usd: 1 },
    ];
    let order = |metric| ranked(&slices, |s| s, metric, None).iter().map(|(s, _, _)| s.requests).collect::<Vec<_>>();
    assert_eq!(order(Metric::Requests), [10, 5, 2]);
    assert_eq!(order(Metric::Cost), [2, 5, 10]);
    assert_eq!(order(Metric::Failed), [2, 10, 5]);
    let top = ranked(&slices, |s| s, Metric::Tokens, Some(2));
    assert_eq!(top.len(), 2);
    assert!((top[0].2 - 50.0 / 55.0).abs() < 1e-9);
}

#[test]
fn an_all_zero_metric_has_no_share() {
    let slices = [UsageSlice::default(), UsageSlice::default()];
    assert!(ranked(&slices, |s| s, Metric::Failed, None).iter().all(|(_, v, share)| *v == 0 && *share == 0.0));
    assert_eq!(Metric::Failed.empty_text(), "No failures in this window");
}

#[test]
fn bucket_labels_by_unit() {
    // 2026-09-29T14:00:00Z, UTC+8 → 22:00, Tue Sep 29.
    assert_eq!(bucket_label("2026-09-29T14:00:00.000Z", BucketUnit::Hour, 8 * 3_600), "22:00");
    assert_eq!(bucket_label("2026-09-28T16:00:00.000Z", BucketUnit::Day, 8 * 3_600), "Sep 29");
    assert_eq!(bucket_label("not a date", BucketUnit::Day, 0), "");
}
```

Add `mod usage;` to `desktop/src/panel.rs`.

Run: `cd desktop && cargo test usage`

Expected: FAIL to compile.

- [ ] **Step 2: Implement**

Create `desktop/src/panel/usage.rs`:

```rust
//! The Usage group's numbers: which metric is picked, how it compares with the previous window, and
//! how the breakdowns rank. Pure; the views only lay these out.

use super::format::{civil_from_days, compact, parse_utc, usd};
use crate::summary::{BucketUnit, UsageSlice, UsageTotals};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Metric {
    #[default]
    Requests,
    Failed,
    Tokens,
    Cost,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Neutral,
    Bad,
    Good,
}

impl Metric {
    pub const ALL: [Metric; 4] = [Metric::Requests, Metric::Failed, Metric::Tokens, Metric::Cost];

    pub fn label(self) -> &'static str {
        match self {
            Metric::Requests => "Requests",
            Metric::Failed => "Failed",
            Metric::Tokens => "Tokens",
            Metric::Cost => "Cost",
        }
    }

    pub fn empty_text(self) -> &'static str {
        match self {
            Metric::Requests => "No requests in this window",
            Metric::Failed => "No failures in this window",
            Metric::Tokens => "No tokens in this window",
            Metric::Cost => "No cost in this window",
        }
    }

    /// More failures or more spend is bad; more traffic is neither.
    fn rising_is_bad(self) -> bool {
        matches!(self, Metric::Failed | Metric::Cost)
    }
}

pub fn metric_total(t: &UsageTotals, metric: Metric) -> u128 {
    match metric {
        Metric::Requests => t.requests,
        Metric::Failed => t.failed_requests,
        Metric::Tokens => t.input_tokens + t.output_tokens,
        Metric::Cost => t.estimated_cost_nano_usd,
    }
}

pub fn slice_value(s: &UsageSlice, metric: Metric) -> u128 {
    match metric {
        Metric::Requests => s.requests,
        Metric::Failed => s.failed_requests,
        Metric::Tokens => s.total_tokens,
        Metric::Cost => s.estimated_cost_nano_usd,
    }
}

pub fn format_value(value: u128, metric: Metric) -> String {
    if metric == Metric::Cost { usd(value) } else { compact(value) }
}

pub fn card_value(t: &UsageTotals, metric: Metric) -> String {
    let value = format_value(metric_total(t, metric), metric);
    if metric != Metric::Cost {
        return value;
    }
    match t.pricing_coverage {
        None => "—".into(),
        Some(coverage) if coverage < 1.0 => format!("≈{value}"),
        Some(_) => value,
    }
}

pub fn delta(current: u128, previous: u128, metric: Metric) -> (String, Tone) {
    if previous == 0 {
        return (if current == 0 { "—" } else { "new" }.into(), Tone::Neutral);
    }
    let tone = match (metric.rising_is_bad(), current.cmp(&previous)) {
        (false, _) | (true, std::cmp::Ordering::Equal) => Tone::Neutral,
        (true, std::cmp::Ordering::Greater) => Tone::Bad,
        (true, std::cmp::Ordering::Less) => Tone::Good,
    };
    if metric == Metric::Failed {
        let text = if current >= previous { format!("+{}", current - previous) } else { format!("−{}", previous - current) };
        return (text, tone);
    }
    let change = (current as f64 - previous as f64) / previous as f64 * 100.0;
    let arrow = if change >= 0.0 { '↑' } else { '↓' };
    (format!("{arrow} {:.0}%", change.abs()), tone)
}

/// Sorted by the metric, zeros last; `share` is each item's part of the metric's total (0 when the
/// total is 0).
pub fn ranked<'a, T>(
    items: &'a [T],
    slice: impl Fn(&T) -> &UsageSlice,
    metric: Metric,
    limit: Option<usize>,
) -> Vec<(&'a T, u128, f64)> {
    let total: u128 = items.iter().map(|item| slice_value(slice(item), metric)).sum();
    let mut rows: Vec<_> = items
        .iter()
        .map(|item| {
            let value = slice_value(slice(item), metric);
            let share = if total == 0 { 0.0 } else { value as f64 / total as f64 };
            (item, value, share)
        })
        .collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1));
    if let Some(limit) = limit {
        rows.truncate(limit);
    }
    rows
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// `HH:00` for hourly buckets, `Mon D` for daily ones (the server's day bucket starts at local
/// midnight); empty when the timestamp does not parse.
pub fn bucket_label(start: &str, unit: BucketUnit, utc_offset: i64) -> String {
    let Some(unix) = parse_utc(start) else { return String::new() };
    let local = unix + utc_offset;
    match unit {
        BucketUnit::Hour => format!("{:02}:00", local.rem_euclid(86_400) / 3_600),
        BucketUnit::Day => {
            let (_, month, day) = civil_from_days(local.div_euclid(86_400));
            format!("{} {day}", MONTHS[(month - 1) as usize])
        }
    }
}

#[cfg(test)]
mod tests;
```

`format_value(_, Metric::Failed)` uses `compact`. The `+3`/`−2` form appears only in deltas.

- [ ] **Step 3: Run the tests**

Run: `cd desktop && cargo test usage && cargo clippy --locked --all-targets -- -D warnings`

Expected: PASS and clean. An unused-code warning for the not-yet-used functions is acceptable only if clippy lets it pass. If `dead_code` fails the build, add `#![allow(dead_code)]` at the top of `usage.rs` with the comment `// Removed by Task 9, which renders these.`. Task 9 deletes that line.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/panel.rs desktop/src/panel/usage.rs desktop/src/panel/usage
git commit -m "feat(desktop): add the usage metrics, deltas and breakdown ranking"
```

---

### Task 5: Quota model (pace, projections, block order)

**Files:**
- Create: `desktop/src/panel/quota.rs`, `desktop/src/panel/quota/tests.rs`
- Modify: `desktop/src/panel.rs` (add `mod quota;`)

**Interfaces:**
- Consumes: `Provider`, `Quota`, `QuotaWindow`, `LocalizedText` (Task 3); `format::{parse_utc, percent, until}`.
- Produces:
  - `duration_text(minutes: f64) -> String`
  - `Pace { expected: f64, behind: bool, note: String }`
  - `pace(remaining: f64, left_minutes: f64, length_minutes: f64) -> Pace`
  - `WindowView { label: String, remaining: Option<f64>, left_text: Option<String>, pace: Option<Pace>, low: bool }`
  - `QuotaBlock<'a> { provider: &'a Provider, windows: Vec<WindowView>, rank: u8, message: Option<String>, command: Option<String>, plan: Option<String>, sampled_at: Option<i64>, refresh_failed: bool, loading: bool }`
  - `quota_blocks(providers: &[Provider], now: i64) -> Vec<QuotaBlock<'_>>`, which filters, builds and sorts
  - `attention_count(blocks: &[QuotaBlock]) -> usize`
  - `relative(now: i64, at: i64) -> String`, giving "just now", "4 min ago", "3 h ago" or "2 d ago"

- [ ] **Step 1: Write the failing tests**

Create `desktop/src/panel/quota/tests.rs`:

```rust
use super::*;
use crate::summary::{Diagnostic, LocalizedText, ProviderState, QuotaWindow};

const NOW: i64 = 1_790_000_000;

fn iso(unix: i64) -> String {
    let (y, m, d) = crate::panel::format::civil_from_days(unix.div_euclid(86_400));
    let s = unix.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", s / 3600, s / 60 % 60, s % 60)
}

fn window(remaining: Option<f64>, left_min: Option<i64>, length: Option<u32>) -> QuotaWindow {
    QuotaWindow {
        id: "w".into(),
        label: LocalizedText::Plain("Weekly".into()),
        remaining_ratio: remaining,
        resets_at: left_min.map(|m| iso(NOW + m * 60)),
        window_minutes: length,
    }
}

fn provider(name: &str, quota: Quota, diagnostic: Option<&str>) -> Provider {
    Provider {
        id: name.to_lowercase(),
        name: name.into(),
        enabled: true,
        account_label: None,
        state: ProviderState::Ok,
        diagnostic: diagnostic.map(|summary| Diagnostic { code: "X".into(), summary: summary.into(), suggested_command: None }),
        quota,
    }
}

fn ready(windows: Vec<QuotaWindow>) -> Quota {
    Quota::Ready { sampled_at: iso(NOW - 240), refresh_failed: false, plan: None, windows }
}

#[test]
fn ahead_of_pace_reports_reserve() {
    // 5 h window, 133 min left, 70% left: an even burn would leave 44%.
    let p = pace(0.70, 133.0, 300.0);
    assert!((p.expected - 133.0 / 300.0).abs() < 1e-9);
    assert!(!p.behind);
    assert_eq!(p.note, "26% in reserve · lasts until reset");
}

#[test]
fn behind_and_running_out_reports_when() {
    // Weekly, 5820 min left of 10080, 41% left → 17% over pace, runs out in about 2d 1h.
    let p = pace(0.41, 5_820.0, 10_080.0);
    assert!(p.behind);
    assert_eq!(p.note, "17% over pace · runs out in 2d 1h");
}

#[test]
fn exactly_on_pace_reads_zero_reserve() {
    // Half the window left with half the quota left. With a constant burn, "behind pace" and
    // "runs out before reset" are the same condition (remaining < expected), so on-pace is the
    // only zero-reserve case.
    let p = pace(0.5, 720.0, 1_440.0);
    assert!(!p.behind);
    assert_eq!(p.note, "0% in reserve · lasts until reset");
}

#[test]
fn missing_fields_mean_no_projection() {
    let blocks = |w| quota_blocks(std::slice::from_ref(&provider("A", ready(vec![w]), None)), NOW);
    for w in [window(Some(0.5), None, Some(300)), window(Some(0.5), Some(60), None), window(None, Some(60), Some(300))] {
        let b = blocks(w);
        assert!(b[0].windows[0].pace.is_none());
    }
    let exhausted = blocks(window(Some(0.0), Some(60), Some(300)));
    assert!(exhausted[0].windows[0].low);
    assert!(exhausted[0].windows[0].pace.as_ref().is_some_and(|p| p.behind || p.note.contains("reserve")));
}

#[test]
fn only_quota_capable_providers_are_listed_and_ordered_by_attention() {
    let providers = vec![
        provider("Zed", ready(vec![window(Some(0.9), Some(600), Some(1_440))]), None),
        provider("Over", ready(vec![window(Some(0.41), Some(5_820), Some(10_080))]), None),
        provider("Low", ready(vec![window(Some(0.06), Some(4_560), Some(43_200))]), None),
        provider("Broken", Quota::Failed, Some("Credentials expired")),
        provider("NoQuota", Quota::None, None),
        provider("Unsupported", Quota::Unsupported, None),
        provider("Loading", Quota::Loading, None),
    ];
    let blocks = quota_blocks(&providers, NOW);
    let names: Vec<_> = blocks.iter().map(|b| b.provider.name.as_str()).collect();
    assert_eq!(names, ["Broken", "Low", "Over", "Loading", "Zed"]);
    assert_eq!(attention_count(&blocks), 2);
    assert_eq!(blocks[0].message.as_deref(), Some("Credentials expired"));
    assert!(blocks[3].loading);
}

#[test]
fn durations_and_relative_times() {
    assert_eq!(duration_text(45.0), "45m");
    assert_eq!(duration_text(125.0), "2h 5m");
    assert_eq!(duration_text(2_965.0), "2d 1h");
    assert_eq!(relative(NOW, NOW - 20), "just now");
    assert_eq!(relative(NOW, NOW - 240), "4 min ago");
    assert_eq!(relative(NOW, NOW - 3 * 3_600), "3 h ago");
    assert_eq!(relative(NOW, NOW - 2 * 86_400), "2 d ago");
}
```

The block order in that test follows the spec's ranks:
1. Broken: a diagnostic or a failed quota.
2. Low: below 15%.
3. Over: behind pace.
4. Loading and Zed, sorted by name.

Add `mod quota;` to `desktop/src/panel.rs`.

Run: `cd desktop && cargo test quota`

Expected: FAIL to compile.

- [ ] **Step 2: Implement**

Create `desktop/src/panel/quota.rs`:

```rust
//! The Quota group's model: which Providers appear, each window's pace against an even burn, and
//! the attention order. Pure; the view only lays these out.

use super::format::{parse_utc, until};
use crate::summary::{Provider, Quota, QuotaWindow};

/// Below this remaining ratio a window fills amber and its Provider needs attention.
pub const LOW: f64 = 0.15;

#[derive(Debug, Clone, PartialEq)]
pub struct Pace {
    /// Where an even burn would be now: the pace tick, as a remaining ratio.
    pub expected: f64,
    pub behind: bool,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowView {
    pub label: String,
    pub remaining: Option<f64>,
    /// "resets in 2h 13m".
    pub left_text: Option<String>,
    pub pace: Option<Pace>,
    pub low: bool,
}

pub struct QuotaBlock<'a> {
    pub provider: &'a Provider,
    pub windows: Vec<WindowView>,
    /// 0 failed or diagnostic, 1 a window below 15%, 2 a window behind pace, 3 the rest.
    pub rank: u8,
    pub message: Option<String>,
    pub command: Option<String>,
    pub plan: Option<String>,
    pub sampled_at: Option<i64>,
    pub refresh_failed: bool,
    pub loading: bool,
}

pub fn duration_text(minutes: f64) -> String {
    let minutes = minutes.max(0.0).round() as i64;
    match (minutes / 1_440, minutes / 60 % 24, minutes % 60) {
        (0, 0, m) => format!("{m}m"),
        (0, h, m) => format!("{h}h {m}m"),
        (d, h, _) => format!("{d}d {h}h"),
    }
}

pub fn relative(now: i64, at: i64) -> String {
    let seconds = (now - at).max(0);
    match seconds {
        0..60 => "just now".into(),
        60..3_600 => format!("{} min ago", seconds / 60),
        3_600..86_400 => format!("{} h ago", seconds / 3_600),
        _ => format!("{} d ago", seconds / 86_400),
    }
}

/// The spec's pace math. `left` and `length` are minutes; `remaining` is 0..=1.
pub fn pace(remaining: f64, left: f64, length: f64) -> Pace {
    let elapsed = (1.0 - left / length).clamp(0.01, 1.0);
    let expected = 1.0 - elapsed;
    let reserve = remaining - expected;
    let burn = (1.0 - remaining) / (elapsed * length);
    let runs_out_in = if burn > 0.0 { remaining / burn } else { f64::INFINITY };
    let behind = reserve < 0.0 && runs_out_in < left;
    let note = if behind {
        format!("{:.0}% over pace · runs out in {}", (-reserve * 100.0).round(), duration_text(runs_out_in))
    } else {
        format!("{:.0}% in reserve · lasts until reset", (reserve.max(0.0) * 100.0).round())
    };
    Pace { expected, behind, note }
}

fn window_view(window: &QuotaWindow, now: i64) -> WindowView {
    let reset = window.resets_at.as_deref().and_then(parse_utc);
    let projection = match (window.remaining_ratio, reset, window.window_minutes) {
        (Some(remaining), Some(at), Some(length)) if length > 0 => {
            Some(pace(remaining.clamp(0.0, 1.0), ((at - now).max(0) as f64) / 60.0, f64::from(length)))
        }
        _ => None,
    };
    WindowView {
        label: window.label.text().to_string(),
        remaining: window.remaining_ratio.map(|r| r.clamp(0.0, 1.0)),
        left_text: reset.map(|at| format!("resets {}", until(now, at))),
        pace: projection,
        low: window.remaining_ratio.is_some_and(|r| r < LOW),
    }
}

/// Providers with a quota capability, in attention order (spec ranks), then by name.
pub fn quota_blocks(providers: &[Provider], now: i64) -> Vec<QuotaBlock<'_>> {
    let mut blocks: Vec<_> = providers
        .iter()
        .filter(|p| matches!(p.quota, Quota::Loading | Quota::Failed | Quota::Ready { .. }))
        .map(|provider| {
            let (windows, plan, sampled_at, refresh_failed) = match &provider.quota {
                Quota::Ready { windows, plan, sampled_at, refresh_failed } => (
                    windows.iter().map(|w| window_view(w, now)).collect(),
                    plan.as_ref().map(|p| p.text().to_string()).filter(|p| !p.is_empty()),
                    parse_utc(sampled_at),
                    *refresh_failed,
                ),
                _ => (Vec::new(), None, None, false),
            };
            let failed = matches!(provider.quota, Quota::Failed);
            let message = provider
                .diagnostic
                .as_ref()
                .map(|d| d.summary.clone())
                .or_else(|| failed.then(|| "Quota unavailable".to_string()));
            let rank = if message.is_some() {
                0
            } else if windows.iter().any(|w: &WindowView| w.low) {
                1
            } else if windows.iter().any(|w| w.pace.as_ref().is_some_and(|p| p.behind)) {
                2
            } else {
                3
            };
            QuotaBlock {
                provider,
                windows,
                rank,
                message,
                command: provider.diagnostic.as_ref().and_then(|d| d.suggested_command.clone()),
                plan,
                sampled_at,
                refresh_failed,
                loading: matches!(provider.quota, Quota::Loading),
            }
        })
        .collect();
    blocks.sort_by(|a, b| a.rank.cmp(&b.rank).then_with(|| a.provider.name.cmp(&b.provider.name)));
    blocks
}

/// Failing or nearly exhausted counts; merely over pace only sorts higher.
pub fn attention_count(blocks: &[QuotaBlock]) -> usize {
    blocks.iter().filter(|b| b.rank <= 1).count()
}

#[cfg(test)]
mod tests;
```

Exclusive range patterns (`0..60`) are stable in Rust 1.80 and later. Before writing a `pace()` expectation into a test, check the numbers with a quick `cargo test` run. If a rounding edge makes one of the given strings differ by one point, keep the formula, which is the spec's, and correct the test's expected string. Note the change in the report.

- [ ] **Step 3: Run the tests**

Run: `cd desktop && cargo test quota && cargo clippy --locked --all-targets -- -D warnings`

Expected: PASS and clean. The same `#![allow(dead_code)]` note as Task 4 applies, and Task 9 removes it.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/panel.rs desktop/src/panel/quota.rs desktop/src/panel/quota
git commit -m "feat(desktop): add quota pace projections and attention order"
```

---

### Task 6: Activity grid (53 weeks, months, selection)

**Files:**
- Create: `desktop/src/panel/activity.rs`, `desktop/src/panel/activity/tests.rs`
- Modify: `desktop/src/panel.rs` (add `mod activity;`)

**Interfaces:**
- Consumes: `ActivityDay`; `format::{parse_date, civil_from_days}`.
- Produces:
  - `HeatCell { day: i64, tokens: u128, level: u8 }`
  - `HeatGrid { weeks: Vec<[Option<HeatCell>; 7]>, months: Vec<(usize, &'static str)>, active_days: usize, total_tokens: u128 }`
  - `heat_grid(activity: &[ActivityDay], today: i64) -> HeatGrid`
  - `day_label(day: i64) -> String`, giving "Tue Sep 29"
  - `WEEKS = 53`

- [ ] **Step 1: Write the failing tests**

Create `desktop/src/panel/activity/tests.rs`:

```rust
use super::*;
use crate::panel::format::days_from_civil;
use crate::summary::ActivityDay;

fn day(y: i64, m: u32, d: u32) -> i64 {
    days_from_civil(y, m, d)
}

#[test]
fn the_grid_is_53_sunday_first_weeks_ending_in_the_week_of_today() {
    let today = day(2026, 10, 1); // a Thursday
    let grid = heat_grid(&[], today);
    assert_eq!(grid.weeks.len(), WEEKS);
    let last = &grid.weeks[WEEKS - 1];
    assert_eq!(last[4].map(|c| c.day), Some(today));
    assert!(last[5].is_none() && last[6].is_none(), "days after today are empty");
    let first_sunday = grid.weeks[0][0].map(|c| c.day).unwrap();
    assert_eq!((first_sunday + 4).rem_euclid(7), 0, "column starts on a Sunday");
}

#[test]
fn levels_scale_to_the_busiest_day_and_count_active_days() {
    let today = day(2026, 10, 1);
    let activity = [
        ActivityDay { date: "2026-10-01".into(), total_tokens: 400 },
        ActivityDay { date: "2026-09-30".into(), total_tokens: 100 },
        ActivityDay { date: "2025-01-01".into(), total_tokens: 999_999 }, // older than the grid
    ];
    let grid = heat_grid(&activity, today);
    let cell = |d| grid.weeks.iter().flatten().flatten().find(|c| c.day == d).copied().unwrap();
    assert_eq!(cell(today).level, 4);
    assert_eq!(cell(today - 1).level, 1);
    assert_eq!(cell(today - 2).level, 0);
    assert_eq!(grid.active_days, 2);
    assert_eq!(grid.total_tokens, 500);
}

#[test]
fn month_labels_mark_the_column_where_a_month_starts() {
    let grid = heat_grid(&[], day(2026, 10, 1));
    assert!(grid.months.iter().any(|(_, name)| *name == "Oct"));
    let mut columns: Vec<_> = grid.months.iter().map(|(c, _)| *c).collect();
    columns.dedup();
    assert_eq!(columns.len(), grid.months.len(), "one label per column at most");
    assert_eq!(day_label(day(2026, 9, 29)), "Tue Sep 29");
}
```

Add `mod activity;` to `desktop/src/panel.rs`.

Run: `cd desktop && cargo test activity`

Expected: FAIL to compile.

- [ ] **Step 2: Implement**

Create `desktop/src/panel/activity.rs`:

```rust
//! The 12-month heatmap's layout: Sunday-first weekly columns ending in today's week, five levels
//! scaled to the busiest day, and the column where each month starts.

use super::format::{civil_from_days, parse_date};
use crate::summary::ActivityDay;

pub const WEEKS: usize = 53;

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HeatCell {
    pub day: i64,
    pub tokens: u128,
    pub level: u8,
}

pub struct HeatGrid {
    pub weeks: Vec<[Option<HeatCell>; 7]>,
    pub months: Vec<(usize, &'static str)>,
    pub active_days: usize,
    pub total_tokens: u128,
}

/// 0 = Sunday. Day 0 (1970-01-01) was a Thursday.
fn weekday(day: i64) -> usize {
    (day + 4).rem_euclid(7) as usize
}

pub fn day_label(day: i64) -> String {
    let (_, month, date) = civil_from_days(day);
    format!("{} {} {date}", WEEKDAYS[weekday(day)], MONTHS[(month - 1) as usize])
}

pub fn heat_grid(activity: &[ActivityDay], today: i64) -> HeatGrid {
    let first = today - weekday(today) as i64 - (WEEKS as i64 - 1) * 7;
    let mut tokens = vec![0_u128; WEEKS * 7];
    for entry in activity {
        let Some(date) = parse_date(&entry.date) else { continue };
        let index = date - first;
        if (0..=today - first).contains(&index) {
            tokens[index as usize] = entry.total_tokens;
        }
    }
    let max = tokens.iter().copied().max().unwrap_or(0);
    let level = |t: u128| if t == 0 || max == 0 { 0 } else { (1 + t * 3 / max).min(4) as u8 };
    let mut weeks = Vec::with_capacity(WEEKS);
    let mut months = Vec::new();
    let mut last_month = None;
    for week in 0..WEEKS {
        let mut column = [None; 7];
        for (slot, cell) in column.iter_mut().enumerate() {
            let day = first + (week * 7 + slot) as i64;
            if day <= today {
                let t = tokens[week * 7 + slot];
                *cell = Some(HeatCell { day, tokens: t, level: level(t) });
            }
        }
        let (_, month, _) = civil_from_days(first + (week * 7) as i64);
        if last_month != Some(month) {
            // The very first column is usually mid-month; label it only if the month starts there.
            if last_month.is_some() || civil_from_days(first).2 <= 7 {
                months.push((week, MONTHS[(month - 1) as usize]));
            }
            last_month = Some(month);
        }
        weeks.push(column);
    }
    HeatGrid {
        weeks,
        months,
        active_days: tokens.iter().filter(|&&t| t > 0).count(),
        total_tokens: tokens.iter().sum(),
    }
}

#[cfg(test)]
mod tests;
```

`level` reproduces the old `heatmap_levels` scale: `1 + t*3/max`, capped at 4. The busiest day therefore reads 4, and a day at a quarter of the maximum reads 1.

- [ ] **Step 3: Run the tests**

Run: `cd desktop && cargo test activity && cargo clippy --locked --all-targets -- -D warnings`

Expected: PASS and clean, with the same dead-code note as Task 4.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/panel.rs desktop/src/panel/activity.rs desktop/src/panel/activity
git commit -m "feat(desktop): lay out the 12-month heatmap as weekly columns"
```

---

### Task 7: Range selection in the scheduler and the app model

**Files:**
- Modify: `desktop/src/client/refresh.rs`, `desktop/src/client/refresh/tests.rs`
- Modify: `desktop/src/app.rs`, `desktop/src/app/refresh.rs`, `desktop/src/app/tests.rs`

**Interfaces:**
- Consumes: `UsageRange`, `Usage` (Task 3).
- Produces:
  - `FetchOrder.range: UsageRange`
  - `Scheduler::range() -> UsageRange`
  - `Scheduler::set_range(range, now) -> Option<FetchOrder>`
  - `AppModel.usage_range: UsageRange`
  - `AppModel::usage_for(range) -> Option<&Usage>`
  - `app::set_usage_range(cx, range)`
  - `summary_path(range, refresh_quota) -> String`

- [ ] **Step 1: Write the failing tests**

In `desktop/src/client/refresh/tests.rs`, add the following, adapting the clock helper to the file's existing `Instant` setup:

```rust
use crate::summary::UsageRange;

#[test]
fn switching_range_fetches_at_once_and_drops_the_old_request() {
    let start = Instant::now();
    let mut s = Scheduler::default();
    let first = s.open(start).unwrap();
    assert_eq!(first.range, UsageRange::H24);
    // A switch inside the 15 s floor still fetches, and the 24h response no longer counts.
    let second = s.set_range(UsageRange::D30, start + Duration::from_secs(1)).unwrap();
    assert_eq!(second.range, UsageRange::D30);
    let (accepted, _) = s.finished(first.tag, Finished::Summary { any_loading: false }, start + Duration::from_secs(2));
    assert!(!accepted);
    let (accepted, _) = s.finished(second.tag, Finished::Summary { any_loading: false }, start + Duration::from_secs(2));
    assert!(accepted);
}

#[test]
fn the_same_range_is_a_no_op_and_a_closed_panel_only_remembers() {
    let start = Instant::now();
    let mut s = Scheduler::default();
    assert!(s.set_range(UsageRange::D7, start).is_none());
    assert_eq!(s.range(), UsageRange::D7);
    let order = s.open(start).unwrap();
    assert_eq!(order.range, UsageRange::D7);
    assert!(s.set_range(UsageRange::D7, start).is_none());
}
```

In `desktop/src/app/refresh.rs`'s test module (`desktop/src/app/refresh/tests.rs`; create it if it does not exist, and add `#[cfg(test)] mod tests;` at the end of `refresh.rs`), add:

```rust
use super::summary_path;
use crate::summary::UsageRange;

#[test]
fn the_summary_path_carries_the_range_and_the_refresh_flag() {
    assert_eq!(summary_path(UsageRange::H24, false), "/dashboard/api/desktop-summary?range=24h");
    assert_eq!(summary_path(UsageRange::D30, true), "/dashboard/api/desktop-summary?range=30d&refresh=true");
}
```

Run: `cd desktop && cargo test refresh`

Expected: FAIL to compile.

- [ ] **Step 2: Implement the scheduler**

In `desktop/src/client/refresh.rs`:

1. Add `use crate::summary::UsageRange;`.
2. Add `pub range: UsageRange,` to `FetchOrder`.
3. Add `range: UsageRange,` to `Scheduler`. `UsageRange` needs a `Default` for `#[derive(Default)]`, so add `#[derive(Default)]` to `UsageRange` in `summary.rs` with `#[default]` on `H24`.
4. Add these methods:

```rust
    pub fn range(&self) -> UsageRange {
        self.range
    }

    /// The usage window changed: the in-flight request (for the old window) stops counting and an
    /// open panel fetches the new one at once, ignoring the 15 s floor. A closed panel only remembers.
    pub fn set_range(&mut self, range: UsageRange, now: Instant) -> Option<FetchOrder> {
        if range == self.range {
            return None;
        }
        self.range = range;
        self.session?;
        self.in_flight = None;
        self.dirty = None;
        self.retry_at = None;
        self.issue(now, false, false)
    }
```

5. In `issue`, return `Some(FetchOrder { tag, refresh_quota, range: self.range })`.

- [ ] **Step 3: Implement the app side**

In `desktop/src/app.rs`:
1. Import `std::collections::HashMap` and `crate::summary::{Usage, UsageRange}`.
2. Add these fields:

   ```rust
       /// The Usage group's window. Remembered across panel closes; `24h` at launch.
       pub usage_range: UsageRange,
       /// The last usage per window, so a switch back renders at once while a fetch runs.
       usage_cache: HashMap<UsageRange, Usage>,
   ```

3. Initialize them in `new` as `usage_range: UsageRange::H24` and `usage_cache: HashMap::new()`.
4. Add these methods to `impl AppModel`:

```rust
    pub fn usage_for(&self, range: UsageRange) -> Option<&Usage> {
        self.usage_cache.get(&range)
    }
```

5. Export `set_usage_range` from `refresh` alongside `manual_refresh`:

   ```rust
   pub use refresh::{manual_refresh, panel_closed, panel_opened, set_usage_range};
   ```

In `desktop/src/app/refresh.rs`:

1. Replace `summary_request`'s path construction with a call to a new pure function:

```rust
pub(crate) fn summary_path(range: UsageRange, refresh_quota: bool) -> String {
    let mut path = format!("{SUMMARY_PATH}?range={}", range.query());
    if refresh_quota {
        path.push_str("&refresh=true");
    }
    path
}
```

2. Change `summary_request(model: &AppModel, refresh_quota: bool)` to `summary_request(model: &AppModel, order: FetchOrder)`. Build the path with `summary_path(order.range, order.refresh_quota)`, and update the caller in `start_fetch`.

3. In `finish`, on `Ok(FetchOutcome::Summary(summary))`, store the usage before replacing the summary:

   ```rust
           model.usage_cache.insert(summary.usage.range, summary.usage.clone());
   ```

4. In `instance_maybe_changed`, clear `model.usage_cache` when the instance key changes: a different instance has different numbers.

5. Add:

```rust
pub fn set_usage_range(cx: &mut App, range: UsageRange) {
    let model = cx.global_mut::<AppModel>();
    model.usage_range = range;
    let order = model.scheduler.set_range(range, Instant::now());
    dispatch(cx, order);
    changed(cx);
}
```

In `panel_opened`, the scheduler already holds the remembered range, so `open()` fetches it. No change is needed there.

- [ ] **Step 4: Run the tests**

Run: `cd desktop && cargo fmt && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add desktop/src
git commit -m "feat(desktop): fetch the picked usage window and keep the last one per window"
```

---

### Task 8: Right-click menu carries the service actions

**Files:**
- Create: `desktop/src/tray/menu.rs`, `desktop/src/tray/menu/tests.rs`
- Modify: `desktop/src/tray.rs`, `desktop/src/app.rs` (`AppEvent`), `desktop/src/main.rs`, `desktop/src/app/lifecycle.rs` (login toggle helper)
- Delete: `desktop/src/panel/actions.rs`. `panel/footer.rs` is rewritten in Task 9; this task removes only the login switch from it.

**Interfaces:**
- Consumes: `offered_actions(&Discovery, persistent) -> Offered`, `UserAction`, `LoginItemStatus`, `app::{run_user_action, open_logs, open_dashboard, set_login_item}`, `login_item::open_settings`.
- Produces:
  - `MenuCommand::{OpenDashboard, Run(UserAction), OpenLogs, ToggleLogin, CheckForUpdates, Quit}` with `id() -> &'static str` and `from_id(&str) -> Option<Self>`
  - `MenuEntry::{Item { command, label, enabled }, Check { command, label, checked }, Separator }`
  - `menu_entries(offered: Offered, busy: bool, persistent: bool, login: LoginItemStatus) -> Vec<MenuEntry>`
  - `AppEvent::Menu(MenuCommand)`, replacing `OpenDashboard`, `CheckForUpdates` and `Quit`
  - `tray::sync(cx)` now also rebuilds the menu when its entries change

- [ ] **Step 1: Write the failing tests**

Create `desktop/src/tray/menu/tests.rs`:

```rust
use super::*;
use crate::connect::policy::Offered;

fn offered(install: bool, start: bool, restart: bool, stop: bool, reload: bool) -> Offered {
    Offered { install, start, restart, stop, reload }
}

fn labels(entries: &[MenuEntry]) -> Vec<String> {
    entries
        .iter()
        .map(|e| match e {
            MenuEntry::Item { label, .. } | MenuEntry::Check { label, .. } => label.clone(),
            MenuEntry::Separator => "---".into(),
        })
        .collect()
}

#[test]
fn a_running_desktop_service_offers_stop_restart_reload_and_login() {
    let entries = menu_entries(offered(false, false, true, true, true), false, true, LoginItemStatus::Enabled);
    assert_eq!(
        labels(&entries),
        [
            "Open Dashboard", "---", "Stop", "Restart", "Reload config", "Open logs", "---",
            "Open at login", "Check for Updates…", "---", "Quit AIO Proxy"
        ]
    );
    assert!(entries.iter().any(|e| matches!(e, MenuEntry::Check { checked: true, .. })));
}

#[test]
fn a_stopped_service_offers_start_and_a_fresh_one_install() {
    let stopped = labels(&menu_entries(offered(false, true, false, false, false), false, true, LoginItemStatus::NotRegistered));
    assert!(stopped.contains(&"Start".to_string()) && !stopped.contains(&"Stop".to_string()));
    let fresh = labels(&menu_entries(offered(true, false, false, false, false), false, true, LoginItemStatus::NotRegistered));
    assert!(fresh.contains(&"Install and start".to_string()));
}

#[test]
fn a_read_only_copy_has_no_login_item_and_only_what_it_may_do() {
    let entries = labels(&menu_entries(offered(false, false, false, false, true), false, false, LoginItemStatus::Unavailable));
    assert_eq!(
        entries,
        ["Open Dashboard", "---", "Reload config", "Open logs", "---", "Check for Updates…", "---", "Quit AIO Proxy"]
    );
}

#[test]
fn busy_disables_service_actions_and_approval_is_named() {
    let entries = menu_entries(offered(false, false, true, true, true), true, true, LoginItemStatus::RequiresApproval);
    for entry in &entries {
        if let MenuEntry::Item { command: MenuCommand::Run(_), enabled, .. } = entry {
            assert!(!enabled);
        }
    }
    assert!(labels(&entries).contains(&"Open at login (needs approval)".to_string()));
}

#[test]
fn ids_round_trip() {
    for command in [
        MenuCommand::OpenDashboard,
        MenuCommand::Run(UserAction::InstallAndStart),
        MenuCommand::Run(UserAction::Start),
        MenuCommand::Run(UserAction::Stop),
        MenuCommand::Run(UserAction::Restart),
        MenuCommand::Run(UserAction::Reload),
        MenuCommand::OpenLogs,
        MenuCommand::ToggleLogin,
        MenuCommand::CheckForUpdates,
        MenuCommand::Quit,
    ] {
        assert_eq!(MenuCommand::from_id(command.id()), Some(command));
    }
}
```

In `desktop/src/tray.rs`, add `mod menu;` and `pub use menu::{MenuCommand, MenuEntry, menu_entries};`.

Run: `cd desktop && cargo test menu`

Expected: FAIL to compile.

- [ ] **Step 2: Implement the pure menu**

Create `desktop/src/tray/menu.rs`:

```rust
//! The right-click menu's contents, from the same offer table the panel's action row used.

use crate::connect::policy::{Offered, UserAction};
use crate::login_item::LoginItemStatus;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuCommand {
    OpenDashboard,
    Run(UserAction),
    OpenLogs,
    ToggleLogin,
    CheckForUpdates,
    Quit,
}

impl MenuCommand {
    pub fn id(self) -> &'static str {
        match self {
            MenuCommand::OpenDashboard => "open-dashboard",
            MenuCommand::Run(UserAction::InstallAndStart) => "run-install",
            MenuCommand::Run(UserAction::Start) => "run-start",
            MenuCommand::Run(UserAction::Stop) => "run-stop",
            MenuCommand::Run(UserAction::Restart) => "run-restart",
            MenuCommand::Run(UserAction::Reload) => "run-reload",
            MenuCommand::OpenLogs => "open-logs",
            MenuCommand::ToggleLogin => "login",
            MenuCommand::CheckForUpdates => "check-updates",
            MenuCommand::Quit => "quit",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Some(match id {
            "open-dashboard" => MenuCommand::OpenDashboard,
            "run-install" => MenuCommand::Run(UserAction::InstallAndStart),
            "run-start" => MenuCommand::Run(UserAction::Start),
            "run-stop" => MenuCommand::Run(UserAction::Stop),
            "run-restart" => MenuCommand::Run(UserAction::Restart),
            "run-reload" => MenuCommand::Run(UserAction::Reload),
            "open-logs" => MenuCommand::OpenLogs,
            "login" => MenuCommand::ToggleLogin,
            "check-updates" => MenuCommand::CheckForUpdates,
            "quit" => MenuCommand::Quit,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuEntry {
    Item { command: MenuCommand, label: String, enabled: bool },
    Check { command: MenuCommand, label: String, checked: bool },
    Separator,
}

fn item(command: MenuCommand, label: &str, enabled: bool) -> MenuEntry {
    MenuEntry::Item { command, label: label.into(), enabled }
}

pub fn menu_entries(offered: Offered, busy: bool, persistent: bool, login: LoginItemStatus) -> Vec<MenuEntry> {
    let mut entries = vec![item(MenuCommand::OpenDashboard, "Open Dashboard", true), MenuEntry::Separator];
    let services = [
        (offered.install, UserAction::InstallAndStart, "Install and start"),
        (offered.start, UserAction::Start, "Start"),
        (offered.stop, UserAction::Stop, "Stop"),
        (offered.restart, UserAction::Restart, "Restart"),
        (offered.reload, UserAction::Reload, "Reload config"),
    ];
    for (shown, action, label) in services {
        if shown {
            entries.push(item(MenuCommand::Run(action), label, !busy));
        }
    }
    entries.push(item(MenuCommand::OpenLogs, "Open logs", true));
    entries.push(MenuEntry::Separator);
    if persistent {
        let label = if login == LoginItemStatus::RequiresApproval { "Open at login (needs approval)" } else { "Open at login" };
        let checked = matches!(login, LoginItemStatus::Enabled | LoginItemStatus::RequiresApproval);
        entries.push(MenuEntry::Check { command: MenuCommand::ToggleLogin, label: label.into(), checked });
    }
    entries.push(item(MenuCommand::CheckForUpdates, "Check for Updates…", true));
    entries.push(MenuEntry::Separator);
    entries.push(item(MenuCommand::Quit, "Quit AIO Proxy", true));
    entries
}

#[cfg(test)]
mod tests;
```

`Offered` needs to be constructible in tests. Its fields are already `pub`; if it lacks `Clone, Copy`, add `#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]`. If `UserAction` lacks `Copy, PartialEq, Eq`, add them too.

- [ ] **Step 3: Wire the menu into the tray and the event loop**

In `desktop/src/app.rs`'s `AppEvent`, replace `OpenDashboard`, `CheckForUpdates` and `Quit` with `Menu(crate::tray::MenuCommand),`.

In `desktop/src/main.rs`'s `handle`, replace the three removed arms with:

```rust
        AppEvent::Menu(command) => match command {
            MenuCommand::OpenDashboard => app::open_dashboard(cx),
            MenuCommand::Run(action) => app::run_user_action(cx, action),
            MenuCommand::OpenLogs => app::open_logs(cx),
            MenuCommand::ToggleLogin => app::toggle_login_item(cx),
            MenuCommand::CheckForUpdates => updater::check_now(),
            // Quitting leaves the proxy running: launchd owns it.
            MenuCommand::Quit => cx.quit(),
        },
```

Add `use crate::tray::MenuCommand;`, with the crate path adjusted to `aio_proxy_desktop::tray::MenuCommand` if `main.rs` uses the library crate.

In `desktop/src/app/lifecycle.rs`, add this next to `set_login_item`, and export it from `app.rs`:

```rust
/// The menu's check item. Approval pending → System Settings; otherwise flip the registration.
pub fn toggle_login_item(cx: &mut App) {
    let status = cx.global::<AppModel>().login_item;
    if status == crate::login_item::LoginItemStatus::RequiresApproval {
        crate::login_item::open_settings();
        return;
    }
    set_login_item(cx, status != crate::login_item::LoginItemStatus::Enabled);
}
```

In `desktop/src/tray.rs`:

1. `build` creates the icon **without** a menu. Remove `.with_menu(...)` and the static `Menu::with_items` list, and keep `.with_menu_on_left_click(false)`.

2. Add `entries: Vec<MenuEntry>` to `Tray`, initialized empty.

3. The `MenuEvent` handler becomes:

```rust
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        if let Some(command) = MenuCommand::from_id(event.id.0.as_str()) {
            let _ = events.unbounded_send(AppEvent::Menu(command));
        }
    }));
```

4. Add a pure-to-muda builder:

```rust
fn native_menu(entries: &[MenuEntry]) -> Menu {
    let menu = Menu::new();
    for entry in entries {
        let _ = match entry {
            MenuEntry::Item { command, label, enabled } => menu.append(&MenuItem::with_id(command.id(), label, *enabled, None)),
            MenuEntry::Check { command, label, checked } => {
                menu.append(&CheckMenuItem::with_id(command.id(), label, true, *checked, None))
            }
            MenuEntry::Separator => menu.append(&PredefinedMenuItem::separator()),
        };
    }
    menu
}
```

   Import `CheckMenuItem` from `tray_icon::menu`.

5. In `sync`, after the icon update, rebuild the menu when its entries changed:

```rust
    let entries = {
        let model = cx.global::<AppModel>();
        let offered = model
            .discovery
            .as_ref()
            .map(|d| crate::connect::policy::offered_actions(d, model.persistent()))
            .unwrap_or_default();
        menu_entries(offered, model.action.is_busy(), model.persistent(), model.login_item)
    };
    if cx.global::<Tray>().entries != entries {
        let tray = cx.global_mut::<Tray>();
        tray.icon.set_menu(Some(Box::new(native_menu(&entries))));
        tray.entries = entries;
    }
```

   This runs on every `changed(cx)`: after discovery, after actions, and when the panel opens, which re-reads the login status.

6. The early `return` in `sync` when the icon state is unchanged must not skip the menu rebuild. Restructure the function so it updates the icon only when changed, then always reaches the menu check.

7. Delete `desktop/src/panel/actions.rs` and its `mod actions;` line. In `panel/view.rs`, remove `.child(actions::row(model))`.

8. In `panel/footer.rs`, delete the login switch block, which Task 9 rewrites, and leave only the update button.

9. Delete `app::manual_refresh` callers that no longer exist. Keep the function: the Task 9 footer uses it.

- [ ] **Step 4: Run the tests**

Run: `cd desktop && cargo fmt && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked`

Expected: all pass.

Run: `bun run desktop:bundle --unsigned --sidecar desktop/target/bundle/sidecar/aio-proxy`. If that sidecar is missing, run it without `--sidecar`.

Expected: exit 0.

The right-click contents are a HUMAN-PENDING check (Task 10).

- [ ] **Step 5: Commit**

```bash
git add desktop/src
git commit -m "feat(desktop): move service actions into the menu-bar icon's right-click menu"
```

---

### Task 9: Panel views (header, three groups, footer)

**Files:**
- Rewrite: `desktop/src/panel/view.rs`, `desktop/src/panel/footer.rs`
- Create: `desktop/src/panel/groups.rs` (the three group renderers), `desktop/src/panel/header.rs`
- Delete: `desktop/src/panel/charts.rs`, `desktop/src/panel/charts/`, `desktop/src/panel/providers.rs`, `desktop/src/panel/providers/`. Their pure tests are superseded by Tasks 4–6.
- Modify: `desktop/src/panel.rs`, `desktop/src/panel/status.rs` (alert line)
- Remove the Task 4–6 `#![allow(dead_code)]` lines.

**Interfaces:**
- Consumes: everything from Tasks 3–8. It also uses gpui-kit's `div`, `h_flex`, `v_flex`, `.id()`, `.on_click`, `.overflow_y_scroll()`, `.overflow_x_scroll()`, `.track_scroll(&ScrollHandle)`, `ScrollHandle::{top_item, scroll_to_item, set_offset}` and `cx.theme()` tokens (`background`, `foreground`, `muted`, `muted_foreground`, `border`, `success`, `warning`, `danger`, `chart_1`).
- Produces: the panel UI. This task has no new pure API.

This task is view code. It has no unit tests: its logic was extracted and tested in Tasks 4–7. It is verified by building, by `cargo test`, and by the Task 10 human checks.

- [ ] **Step 1: Panel-local view state**

Replace `PanelView` in `view.rs` with:

```rust
pub struct PanelView {
    _activation: Subscription,
    /// The body's scroll; `top_item` names the group whose header sticks.
    body: ScrollHandle,
    /// The heatmap's horizontal scroll; opened at the latest week once per window.
    heat: ScrollHandle,
    heat_scrolled: bool,
    metric: Metric,
    bar: Option<usize>,
    day: Option<i64>,
}
```

Initialize it in `new` with `ScrollHandle::new()` twice, `heat_scrolled: false`, `metric: Metric::default()`, `bar: None` and `day: None`.

The metric, selected bar and selected day are panel-local. They reset when the window is destroyed (hybrid lifecycle), which the spec allows: the window selection is the only thing it remembers.

- [ ] **Step 2: Header**

Create `desktop/src/panel/header.rs`:

```rust
//! Status, endpoint, one alert line with Show, one notice line, and at most one promoted action.

use gpui_kit::component::button::*;
use gpui_kit::component::*;
use gpui_kit::*;

use super::status;
use crate::app::{self, AppModel, SummaryState};
use crate::connect::policy::{UserAction, offered_actions};

/// The single state-relevant action: Start when stopped, Install and start when a fresh install is offered.
fn promoted(model: &AppModel) -> Option<(UserAction, &'static str)> {
    let offered = offered_actions(model.discovery.as_ref()?, model.persistent());
    if offered.install {
        Some((UserAction::InstallAndStart, "Install and start"))
    } else if offered.start {
        Some((UserAction::Start, "Start"))
    } else {
        None
    }
}

/// `on_show` scrolls to the Quota group when the alerting Provider is listed there.
pub fn header(model: &AppModel, quota_ids: &[String], on_show: impl Fn(&mut Window, &mut App) + 'static, cx: &App) -> impl IntoElement {
    let muted = cx.theme().muted_foreground;
    let mut line = h_flex().gap_2().items_center().child(div().size(px(8.)).rounded_full().bg(status::dot(model, cx))).child(
        div().flex_1().text_base().font_semibold().child(status::headline(model)),
    );
    if let Some((action, label)) = promoted(model) {
        line = line.child(
            Button::new("promoted").small().primary().label(label).disabled(model.action.is_busy()).on_click(move |_, _, cx| app::run_user_action(cx, action)),
        );
    }
    let mut column = v_flex().px_3().pt_3().gap(px(2.)).child(line);
    if let Some(endpoint) = status::endpoint_line(model) {
        column = column.child(div().text_xs().text_color(muted).font_family("JetBrains Mono").child(endpoint));
    }
    if let SummaryState::Ready(summary) = &model.summary
        && let Some(first) = summary.alerts.first()
    {
        let more = summary.alerts.len() - 1;
        let text = if more > 0 { format!("{} · +{more} more", first.message) } else { first.message.clone() };
        let in_quota = quota_ids.contains(&first.provider_id);
        column = column.child(
            h_flex().gap_1().text_xs().text_color(cx.theme().danger).child(text).child(
                div().id("alert-show").underline().cursor_pointer().child("Show").on_click(move |_, window, cx| {
                    if in_quota { on_show(window, cx) } else { app::open_dashboard_providers(cx) }
                }),
            ),
        );
    }
    if let Some(notice) = status::notice(model) {
        column = column.child(div().text_xs().text_color(muted).child(notice));
    }
    column
}
```

In `status.rs`, add:
- `pub fn dot(model, cx) -> Hsla`: `success` when running with no alerts, `warning` when running with alerts, `muted_foreground` when stopped, `danger` when not responding.
- `pub fn endpoint_line(model) -> Option<String>`, which returns `"<control_url host:port> · <owner words>"`. The owner words are `started by AIO Proxy` (desktop owner), `managed by the aio-proxy CLI` (external), and `stopped by you` (desktop and `job.disabled`).

Strip `http://` from the control URL. Remove the owner sentences that `notice` used to produce, because `endpoint_line` now carries them. Keep the read-only and install notices. Update `status/tests.rs` to match.

Add `app::open_dashboard_providers(cx)` to `lifecycle.rs`, next to `open_dashboard`: it opens `<dashboard>/providers/`. Also add `app::open_dashboard_provider(cx, id)`, which opens `<dashboard>/providers/<id>/edit`. Both reuse `open_dashboard`'s URL building with a suffix.

- [ ] **Step 3: Groups**

Create `desktop/src/panel/groups.rs` with three renderers and a group header helper.

`fn group_header(title, right: impl IntoElement, cx) -> Div` is an `h_flex` with `justify_between` and `py(px(8.))`: the title is 12 pt semibold Lexend, and `right` is the second child.

**Usage**, `pub fn usage(view: &PanelView, model: &AppModel, now: i64, cx: &mut Context<PanelView>) -> impl IntoElement`:

- **Header right side:** a segmented control from `UsageRange::ALL`. Each segment is `div().id(range.query())`, and its `on_click` calls `app::set_usage_range(cx, range)`. The selected segment gets the `background` fill and a `foreground` label; the others get `muted_foreground`.
- **Data:** the usage is `model.usage_for(model.usage_range)`. When it is `None`, render the header, then four empty cards with `—` and a muted `Loading…` line, and return. This is the skeleton.
- **Cards:** four cards in an `h_flex` with `gap(px(5.))`, one per `Metric::ALL`.
  - Each card is `div().id(metric.label()).flex_1()`, and its `on_click` sets `view.metric = metric; view.bar = None; cx.notify()`.
  - It shows the label (10 pt muted), `card_value(&usage.current, metric)` (15 pt semibold monospace), and the `delta(metric_total(current), metric_total(previous), metric)` text, colored by `Tone`: `Neutral` uses `muted_foreground`, `Bad` uses `danger`, `Good` uses `success`.
  - The selected card gets a `success` border; the others a transparent one.
- **Comparison line:** a muted `Compared with the previous <range label>` line.
- **Trend:**
  - The caption uses the selected bar, which defaults to the last bucket: `<bucket_label> · <format_value(slice_value)> <metric unit word> (per hour|day)`.
  - Then an `h_flex` of height 96 with `items_end` and `gap(px(2.))`. It has one child per bucket: `div().id(("bar", i)).flex_1().h_full().flex().items_end()`, whose own child is a `div().w_full().h(relative(value / max))` filled `chart_1`, or `foreground` when selected. Clicking a bar sets `view.bar`.
  - Then an axis row with the first, middle and last `bucket_label`, using `local_utc_offset(now)`.
- **Top models:** a muted uppercase `TOP MODELS` label, then `ranked(&usage.by_model, |m| &m.slice, metric, Some(5))` rows. Each row is an `h_flex` of a monospace name (11 pt, `flex_1`, truncated), a 76 pt share bar, and the right-aligned value. When every value is 0, render `metric.empty_text()` instead.
- **By Provider:** a `BY PROVIDER` label, then the same rows from `ranked(&usage.by_provider, |p| &p.slice, metric, None)` using the Provider names.
  - If `by_provider` is empty while `usage.current.requests > 0`, show `No per-Provider data for this window`.

The share bar is `div().w(px(76.)).h(px(4.)).rounded_full().bg(muted).child(div().h_full().w(relative(share)).rounded_full().bg(chart_1))`.

**Quota**, `pub fn quota(blocks: &[QuotaBlock], now: i64, cx: &App) -> impl IntoElement`:

- **Header right side:** `<n> need attention · <m> Providers report quota`, where `n` (in `danger`) is shown only when it is above 0.
- **No blocks:** a muted `No Provider reports quota`.
- **Each block**, top to bottom, closed by a bottom border:
  1. A title row: `div().id(("quota", provider.id))` that opens `app::open_dashboard_provider(cx, id)`. It holds the name (semibold), the `account_label` (muted, truncated), and a `›` glyph.
  2. A meta row: `Updated <relative(now, sampled_at)>`, or `Last refresh failed · data from <relative>` when `refresh_failed`, at the left, and `plan` at the right.
  3. `Loading quota…` when `loading`.
  4. Per window:
     - A title line: `<label> · <percent(remaining)> left`, with `left_text` at the right.
     - A bar: a relative container `h(px(6.))` with a `muted` track.
       - Its fill is `w(relative(remaining))`, colored `warning` when `low` and `success` otherwise.
       - When `pace` is `Some`, it also has an absolutely positioned tick at `left(relative(expected))`, `w(px(2.))`, colored `danger` when `behind` and `success` otherwise.
     - The `pace.note`, in `danger` when behind and muted otherwise.
  5. When `message` is `Some`, the message in `danger`, followed by the `command` in monospace muted.

**Last 12 months**, `pub fn activity(view: &mut PanelView, summary: &SummaryV1, now: i64, cx: &mut Context<PanelView>) -> impl IntoElement`:

- **Grid data:** `let today = (now + local_utc_offset(now)).div_euclid(86_400); let grid = heat_grid(&summary.activity, today);`.
- **Header right side:** `<active_days> active days · <compact(total_tokens)> tokens`, or `<day_label(day)> · <compact(tokens)> tokens` when `view.day` is set.
- **Body:** `div().id("heatmap").overflow_x_scroll().track_scroll(&view.heat)` containing a fixed-width inner `v_flex`:
  - A month row: an `h_flex` of 53 slots, each `w(px(10.))` plus a 2 pt gap, with the month name placed at the slots in `grid.months`.
  - Then an `h_flex` of 53 columns, each a `v_flex` with `gap(px(2.))` of 7 cells. A cell is `div().id(("day", cell.day)).size(px(10.)).rounded(px(2.))`, colored `muted` at level 0 and `chart_1.opacity(level / 4)` otherwise. Its `on_click` toggles `view.day`. An empty slot is a transparent 10 pt box.
  - Then a Less/More legend.
- **Scroll position:** after building the element, `if !view.heat_scrolled { view.heat.set_offset(point(px(-100_000.), px(0.))); view.heat_scrolled = true; }`. A large negative offset is clamped to the far right edge.
  - If gpui's `set_offset` does not clamp, compute the offset from the content width: `53 × 12 − 2` pt minus the viewport width, which is 332 pt (360 minus 2 × 14 padding).

- [ ] **Step 4: Root view, sticky header and footer**

Rewrite `PanelView::render` in `view.rs`:

```rust
impl Render for PanelView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
        let model = cx.global::<AppModel>();
        let blocks = match &model.summary {
            SummaryState::Ready(summary) => quota::quota_blocks(&summary.providers, now),
            _ => Vec::new(),
        };
        let quota_ids: Vec<String> = blocks.iter().map(|b| b.provider.id.clone()).collect();
        let body_handle = self.body.clone();
        let header = header::header(model, &quota_ids, move |_, _| body_handle.scroll_to_item(1), cx);
        let content = match &model.summary {
            SummaryState::Ready(summary) => {
                let summary = summary.clone();
                let groups = div()
                    .id("panel-body")
                    .flex_1()
                    .overflow_y_scroll()
                    .track_scroll(&self.body)
                    .px_3()
                    .child(groups::usage(self, model, now, cx))
                    .child(groups::quota(&blocks, now, cx))
                    .child(groups::activity(self, &summary, now, cx));
                // GPUI has no `position: sticky`: overlay the header of the group scrolled under the top.
                let top = self.body.top_item();
                let sticky = (self.body.offset().y < px(0.)).then(|| groups::sticky_header(top, self, model, cx));
                div().relative().flex_1().min_h_0().child(groups).children(sticky).into_any_element()
            }
            other => states::body(other, cx).into_any_element(),
        };
        v_flex()
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(header)
            .child(div().mt_2().border_t_1().border_color(cx.theme().border))
            .child(content)
            .child(footer::footer(model, cx))
    }
}
```

`groups::sticky_header(index, view, model, cx)` renders the same `group_header` for group `index`: 0 Usage, 1 Quota, 2 Last 12 months. It is absolutely positioned at `top_0().left_0().right_0()`, with the `background` fill and a bottom border.

The borrow checker will reject passing `self` mutably while `model` borrows `cx`. If it does, clone what the groups need out of `model` (`summary`, `usage_for(range).cloned()`, `usage_range`) before building, and pass owned values. Report the shape you settle on.

If `top_item()` does not update while scrolling, because the view is not re-rendered on scroll, add `.on_scroll_wheel(cx.listener(|_, _, _, cx| cx.notify()))` to the body.

Move the non-`Ready` states into `fn body` from today's `view.rs`, under `states::body` (a small `panel/states.rs`):
- `Degraded` uses `degraded::body`;
- `AuthFailed` shows `Authentication failed. The desktop token was rejected.`;
- `Unavailable(error)` shows the error;
- `Waiting` shows `Loading…`;
- the Stopped case, when `status::headline` is `Stopped`, shows `The proxy is not running. It stays stopped until you start it.`.

Rewrite `footer.rs`:

```rust
//! Open Dashboard, the last refresh time, and the gentle update reminder.

use gpui_kit::component::button::*;
use gpui_kit::component::*;
use gpui_kit::*;

use crate::app::{self, AppModel, SummaryState};

pub fn footer(model: &AppModel, cx: &App) -> impl IntoElement {
    let mut row = h_flex().gap_2().items_center().px_3().py_2().border_t_1().border_color(cx.theme().border).child(
        Button::new("dashboard").small().primary().label("Open Dashboard").on_click(|_, _, cx| app::open_dashboard(cx)),
    );
    if let Some(version) = &model.update_pending {
        row = row.child(
            Button::new("update").small().label(format!("Update to {version}…")).on_click(|_, _, _| crate::updater::check_now()),
        );
    }
    let updated = matches!(model.summary, SummaryState::Ready(_)).then(|| model.updated_text());
    row.child(div().flex_1())
        .children(updated.map(|text| div().id("refresh").text_xs().text_color(cx.theme().muted_foreground).cursor_pointer().child(text).on_click(|_, _, cx| app::manual_refresh(cx))))
}
```

Add `pub fn updated_text(&self) -> String` to `AppModel`. It keeps `last_summary_at: Option<Instant>`, set in `refresh.rs` `finish` on success, and returns `Updated just now` under 60 s, otherwise `Updated <n> min ago`.

Clicking the updated text is the manual refresh. Rev 4's table keeps `?refresh=true` as a trigger, and this is now its only entry point.

Delete `charts.rs`, `charts/`, `providers.rs` and `providers/`. Remove their `mod` lines and add `mod groups; mod header; mod states;`. Delete the dead-code allows that Tasks 4–6 added.

- [ ] **Step 5: Build, lint, test and bundle**

Run: `cd desktop && cargo fmt && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked`

Expected: clean.

Run: `wc -l desktop/src/panel/*.rs`

Expected: every file under 400 lines. If `groups.rs` passes 400, split it into `groups/usage.rs`, `groups/quota.rs` and `groups/activity.rs` behind `groups.rs` (exports only).

Run: `bun run desktop:bundle --unsigned --sidecar desktop/target/bundle/sidecar/aio-proxy`

Expected: exit 0.

Do not launch the bundle against the real service beyond the read-only visual check that Task 10 lists.

- [ ] **Step 6: Commit**

```bash
git add desktop/src
git commit -m "feat(desktop): render the panel as usage, quota and 12-month groups"
```

---

### Task 10: Release note, spec sync and verification

**Files:**
- Modify: `.changeset/desktop-app.md`, `docs/superpowers/specs/2026-10-01-desktop-panel-design.md` (testing boundary wording only)

**Interfaces:**
- Consumes: the finished branch.
- Produces: the shipped-state release note, and the HUMAN-PENDING checklist, which goes in the report.

- [ ] **Step 1: Rewrite the pending release note**

Replace the body of `.changeset/desktop-app.md`. Keep its frontmatter (`'aio-proxy': minor`).

```markdown
New macOS menu-bar app for Apple Silicon (macOS 13 or later). It runs aio-proxy as a login service without a separate Bun or CLI install. Its panel shows proxy status, usage over 24 hours, 7 days or 30 days by model and Provider, quota left with a pace projection, and a 12-month activity heatmap. Start, stop, restart and reload live in the icon's right-click menu, and a service installed with the CLI is only changed when you click. Download `aio-proxy-<version>-arm64.dmg` from the release; later updates arrive in the app.
```

The server and core side of this release is internal to that note: the summary endpoint is unreleased. No other changeset needs a change. Confirm with `grep -rl "desktop" .changeset/`: `desktop-server-cli.md` mentions only "a local summary endpoint", which still holds.

- [ ] **Step 2: Align the spec's test wording with the implementation**

In the spec's Quota › Provider block, delete the bullet "Behind pace but still lasting until reset: …". With a constant burn rate, `behind` holds exactly when `remainingRatio < expected`, so that case never occurs. Task 5's `exactly_on_pace_reads_zero_reserve` test covers the zero-reserve case instead.

In `docs/superpowers/specs/2026-10-01-desktop-panel-design.md`, Testing › Server, replace `at the boundary millisecond for \`24h\`` with `one minute before \`rangeStart\` for \`24h\` (the exact boundary millisecond belongs to both windows, as in the Dashboard overview)`.

- [ ] **Step 3: Full verification**

Run: `bun run preflight`

Expected: passes. If `lint:types` reports unresolved workspace types, run `bun run build` first.

Run: `(cd desktop && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked)`

Expected: clean.

Run: `bun run desktop:bundle --unsigned`

Expected: exit 0, with both smokes passing.

- [ ] **Step 4: HUMAN-PENDING checklist (copy into the report; do not perform)**

- [ ] **P1 · Read-only layout check.** Open the bundled app from `desktop/target/bundle`, which is read-only against the real service.
  - The header, the three groups and the footer render.
  - Group headers stick while scrolling.
  - The heatmap scrolls sideways and opens at the latest week.
- [ ] **P2 · Usage group.** In a test macOS user running this branch's sidecar (Phase 2's acceptance setup):
  - Switching 24h/7d/30d updates the cards, trend, Top models and By Provider.
  - Switching back to a window seen this session shows its numbers at once.
  - The Quota group and the heatmap do not blank during a switch.
- [ ] **P3 · Cards as metric picker.** Clicking each card re-charts the trend and re-ranks both lists. Failed and Cost deltas are colored; Requests and Tokens are not.
- [ ] **P4 · Quota group.** A quota-capable Provider shows:
  - the account and plan;
  - "Updated N min ago";
  - one bar per window, with a pace tick and the reserve or over-pace line.

  A non-quota Provider (OpenRouter) is absent from the group. Its diagnostic still reaches the header alert line, where **Show** opens the Dashboard's Providers page.
- [ ] **P5 · Right-click menu.**
  - It shows only state-relevant actions, matching the Phase 2 offer table.
  - Open at login toggles, and reads "(needs approval)" when macOS asks.
  - Each action's outcome appears in the panel's notice line.
- [ ] **P6 · 30d cost.** Task 1's measurement held: under 250 ms at 36k requests per day. With the 30d window open for two minutes, the proxy log shows at most one usage scan per minute.

- [ ] **Step 5: Commit**

```bash
git add .changeset/desktop-app.md docs/superpowers/specs/2026-10-01-desktop-panel-design.md
git commit -m "docs(desktop): describe the shipped panel in the release note"
```

---

## Self-review notes

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| Intent and Layout | Task 9 |
| Header: alert, Show, promoted action | Task 9 (Step 2) |
| Footer: Open Dashboard, Updated, Update to | Task 9 |
| Usage window switch and remembered window | Task 7 |
| Cards as metric picker, coloring, pricing coverage | Tasks 4 and 9 |
| Trend, Top models, By Provider | Tasks 4 and 9 |
| Quota: filter, block, pace math, ranks and attention | Tasks 5 and 9 |
| Heatmap | Tasks 6 and 9 |
| Right-click menu | Task 8 |
| Panel states | Task 9 (`states.rs`) |
| DTO changes and sources | Tasks 1 and 2 |
| Usage memo | Task 2 |
| 30d measurement | Task 1 Step 7 and Task 10 P6 |
| Refresh policy (range switch, per-range cache, range-tagged discard) | Task 7 |
| Error handling | Task 9: the cached range keeps showing via `show()`; a first failure shows the error; empty `byProvider` gets its line |
| Testing | Tasks 1, 2, 4, 5, 6, 7 and 8 |
| Changeset follow-up | Task 10 |

**Deliberate deviations, each recorded:**

- The 24h boundary test uses one minute rather than the exact millisecond, matching the Dashboard's inclusive window ends (Task 10 Step 2).
- Manual refresh moves to clicking the footer's "Updated …" text, because the action row that held Refresh is gone.
- The per-panel metric resets when the window is destroyed; only the window selection is remembered.

**Out of scope:** `90d`; a Provider dimension in `usage_daily` (only if P6 fails); latency and cache hit rate; menu-bar title text.
