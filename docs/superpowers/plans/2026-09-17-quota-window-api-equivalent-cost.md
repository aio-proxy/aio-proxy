# Quota-window API-equivalent cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show **Used $x** on each OAuth quota dialog window: this aio-proxy instance's API-price equivalent of successful priced requests for that Provider in that window.

**Architecture:** Host-only join. `TraceStore.providerWindowCost` returns one SQLite `SUM`. The quota route attaches host `estimates` keyed by `itemId` using the snapshot's `sampledAt` as `end`. The dialog renders a compact row under each window; it never extrapolates a total and never special-cases a plugin.

**Tech Stack:** Bun, drizzle-orm/bun-sqlite, Hono QUERY `/providers/:id/quota`, TanStack Query, Paraglide i18n, rstest (dashboard), bun:test (core/server).

**Spec:** `docs/superpowers/specs/2026-09-16-quota-window-api-equivalent-cost-design.md`

## Global Constraints

- Used $x only. No `Est. total`, no `used / consumed%`, no dollars on the ring.
- Do not edit `packages/plugin-sdk` or `packages/plugins/*`.
- Do not branch on `@aio-proxy/plugin-openai-chatgpt` or ChatGPT item IDs / model names.
- SQLite returns one aggregated row. Do not `.all()` matching traces into JS.
- `end = sampledAt`. Do not extend the window to `Date.now()`.
- Hide the row when bounds are unusable or there is no priced cost. Unpriced must not become `$0.00`. A real priced sum of `0` may show `$0.00`.
- Overlapping windows share overlapping dollars and must not be added together. Copy must say this is all-model local API equivalent, not lane spend.
- A throwing cost query logs and omits `estimates`; the quota snapshot still returns 200.
- i18n: Paraglide, all five locales (`en`, `ja`, `ko`, `zh-Hans`, `zh-Hant`). Keys: `cost_used`, `cost_note`, `cost_less_than`. Run `bun run i18n:compile` after editing messages.
- One `minor` changeset targeting `aio-proxy`, `@aio-proxy/core`, `@aio-proxy/server`, `@aio-proxy/dashboard`, `@aio-proxy/i18n`. No `@aio-proxy/plugin-sdk`.
- Handwritten non-test implementation files stay under 500 lines.
- Do not add a `ServerLog` event for cost-query failures (closed union). Use `console.error`.

## File structure

```
packages/core/src/db/trace-store/
  types.ts                                      # ProviderWindowCostQuery + TraceStore.providerWindowCost
  trace-store.ts                                # wire the method
  provider-window-cost/
    index.ts                                    # re-export
    provider-window-cost.ts                     # SQLite SUM
    provider-window-cost.test.ts

packages/server/src/dashboard-routes/
  provider-quota-estimates/
    index.ts
    provider-quota-estimates.ts                 # bounds + dedupe + estimates DTO
    provider-quota-estimates.test.ts
  provider-routes/provider-routes.ts            # attach estimates; catch cost failures
  provider-routes/provider-routes.test.ts       # HTTP: generic plugin, cutoff, no 502

packages/dashboard/src/
  lib/nano-usd/nano-usd.ts                      # compact vs sub-cent
  lib/nano-usd/nano-usd.test.ts
  modules/providers/services/provider-quota-service/provider-quota-service.ts  # poll comment: snapshot only
  modules/providers/components/provider-quota-ring/
    provider-quota-item.tsx                     # Used $x row
    provider-quota-dialog.tsx                   # pass estimate by itemId
    provider-quota-cost.tsx                     # compact Used $x line
    provider-quota-ring.test.tsx

packages/i18n/messages/{en,ja,ko,zh-Hans,zh-Hant}.json

.changeset/quota-window-api-equivalent-cost.md
```

No plugin-layer files. `usage_daily` is not a source.

---

### Task 1: `TraceStore.providerWindowCost`

SQLite `SUM` of successful priced root spans for one Provider in `[start, end]`.

**Files:**
- Create: `packages/core/src/db/trace-store/provider-window-cost/index.ts`
- Create: `packages/core/src/db/trace-store/provider-window-cost/provider-window-cost.ts`
- Test: `packages/core/src/db/trace-store/provider-window-cost/provider-window-cost.test.ts`
- Modify: `packages/core/src/db/trace-store/types.ts` (append query type + method on `TraceStore`)
- Modify: `packages/core/src/db/trace-store/trace-store.ts` (wire the method)

**Interfaces:**
- Consumes: `trace_span` (`parentSpanId`, `terminationReason`, `finalProviderId`, `endedAt`, `estimatedCostNanoUsd`), `parseSqliteInteger` from `packages/core/src/usage-numbers/usage-numbers.ts`.
- Produces: `providerWindowCost(db, query) => string | undefined` and `TraceStore.providerWindowCost(query) => string | undefined`, where `query` is `{ providerId: string; start: Date; end: Date }`. The string is non-negative decimal nano-USD. `undefined` means no priced row. Task 2 calls `state.traceStore.providerWindowCost`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/db/trace-store/provider-window-cost/provider-window-cost.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { traceSpan } from '../../schema';
import { createTraceStore } from '../index';
import { openTestDb } from '../test-support';
import { completion, rootSpan, rootStart } from '../trace-store.test-support';
import type { TraceCompletion } from '../types';

const START = new Date('2026-07-24T10:00:00.000Z');
const MID = new Date('2026-07-24T12:00:00.000Z');
const END = new Date('2026-07-24T14:00:00.000Z');

function makeStore() {
  const handle = openTestDb();
  return { handle, store: createTraceStore(handle.db) };
}

function complete(
  store: ReturnType<typeof createTraceStore>,
  traceId: string,
  endedAt: Date,
  summary: TraceCompletion['summary'],
): void {
  const spanId = traceId.slice(0, 16);
  const attrs: Record<string, unknown> = { 'aio_proxy.protocol.inbound': 'openai-compatible' };
  if (summary.finalProviderId !== undefined) attrs['aio_proxy.route.final_provider_id'] = summary.finalProviderId;
  if (summary.finalModelId !== undefined) attrs['gen_ai.response.model'] = summary.finalModelId;
  if (summary.usage?.estimatedCostUsd !== undefined)
    attrs['gen_ai.usage.estimated_cost_usd'] = summary.usage.estimatedCostUsd;
  store.startRoot(rootStart({ traceId, spanId, requestId: `req-${traceId}`, startedAt: START, attributes: attrs }));
  store.complete(
    completion({
      traceId,
      rootSpanId: spanId,
      spans: [rootSpan({ traceId, spanId, startedAt: START, endedAt, attributes: attrs })],
      summary,
    }),
  );
}

describe('providerWindowCost', () => {
  test('sums successful priced roots for this Provider in the window', () => {
    const { handle, store } = makeStore();
    try {
      complete(store, 'a'.repeat(32), MID, {
        finalProviderId: 'person',
        finalModelId: 'gpt-5',
        finalHttpStatus: 200,
        usage: { providerId: 'person', modelId: 'gpt-5', estimatedCostUsd: 0.1 },
      });
      complete(store, 'b'.repeat(32), MID, {
        finalProviderId: 'person',
        finalModelId: 'codex-auto-review',
        finalHttpStatus: 200,
        usage: { providerId: 'person', modelId: 'codex-auto-review', estimatedCostUsd: 0.2 },
      });
      complete(store, 'c'.repeat(32), MID, {
        finalProviderId: 'other',
        finalModelId: 'gpt-5',
        finalHttpStatus: 200,
        usage: { providerId: 'other', modelId: 'gpt-5', estimatedCostUsd: 9 },
      });

      expect(store.providerWindowCost({ providerId: 'person', start: START, end: END })).toBe('300000000');
    } finally {
      handle.close();
    }
  });

  test('returns undefined when nothing priced matched, not zero', () => {
    const { handle, store } = makeStore();
    try {
      complete(store, 'a'.repeat(32), MID, {
        finalProviderId: 'person',
        finalModelId: 'gpt-5',
        finalHttpStatus: 200,
        usage: { providerId: 'person', modelId: 'gpt-5', totalTokens: 10 },
      });
      store.startRoot(rootStart({ traceId: 'd'.repeat(32), spanId: 'd'.repeat(16), requestId: 'running' }));

      expect(store.providerWindowCost({ providerId: 'person', start: START, end: END })).toBeUndefined();
    } finally {
      handle.close();
    }
  });

  test('excludes priced failed, cancelled, and interrupted roots for this Provider', () => {
    const { handle, store } = makeStore();
    try {
      complete(store, 'a'.repeat(32), MID, {
        finalProviderId: 'person',
        finalModelId: 'gpt-5',
        finalHttpStatus: 500,
        terminationReason: 'failure',
        usage: { providerId: 'person', modelId: 'gpt-5', estimatedCostUsd: 0.4 },
      });
      complete(store, 'b'.repeat(32), MID, {
        finalProviderId: 'person',
        finalModelId: 'gpt-5',
        terminationReason: 'cancelled',
        usage: { providerId: 'person', modelId: 'gpt-5', estimatedCostUsd: 0.4 },
      });
      complete(store, 'c'.repeat(32), MID, {
        finalProviderId: 'person',
        finalModelId: 'gpt-5',
        terminationReason: 'interrupted',
        usage: { providerId: 'person', modelId: 'gpt-5', estimatedCostUsd: 0.4 },
      });

      expect(store.providerWindowCost({ providerId: 'person', start: START, end: END })).toBeUndefined();
    } finally {
      handle.close();
    }
  });

  test('a real priced sum of zero is not treated as missing', () => {
    const { handle, store } = makeStore();
    try {
      handle.db
        .insert(traceSpan)
        .values({
          traceId: '0'.repeat(32),
          spanId: 'f'.repeat(16),
          name: 'aio_proxy.request',
          kind: 1,
          startedAt: START,
          endedAt: MID,
          statusCode: 0,
          finalProviderId: 'person',
          estimatedCostNanoUsd: 0,
          attributes: {},
          events: [],
          links: [],
        })
        .run();

      expect(store.providerWindowCost({ providerId: 'person', start: START, end: END })).toBe('0');
    } finally {
      handle.close();
    }
  });

  test('excludes endedAt outside the inclusive window and ignores child spans', () => {
    const { handle, store } = makeStore();
    try {
      complete(store, 'a'.repeat(32), new Date(START.getTime() - 1), {
        finalProviderId: 'person',
        finalModelId: 'gpt-5',
        finalHttpStatus: 200,
        usage: { providerId: 'person', modelId: 'gpt-5', estimatedCostUsd: 0.1 },
      });
      complete(store, 'b'.repeat(32), new Date(END.getTime() + 1), {
        finalProviderId: 'person',
        finalModelId: 'gpt-5',
        finalHttpStatus: 200,
        usage: { providerId: 'person', modelId: 'gpt-5', estimatedCostUsd: 0.1 },
      });
      complete(store, 'c'.repeat(32), START, {
        finalProviderId: 'person',
        finalModelId: 'gpt-5',
        finalHttpStatus: 200,
        usage: { providerId: 'person', modelId: 'gpt-5', estimatedCostUsd: 0.05 },
      });
      complete(store, 'e'.repeat(32), END, {
        finalProviderId: 'person',
        finalModelId: 'gpt-5',
        finalHttpStatus: 200,
        usage: { providerId: 'person', modelId: 'gpt-5', estimatedCostUsd: 0.05 },
      });
      handle.db
        .insert(traceSpan)
        .values({
          traceId: 'c'.repeat(32),
          spanId: '1'.repeat(16),
          parentSpanId: 'c'.repeat(16),
          name: 'aio_proxy.provider.attempt',
          kind: 2,
          startedAt: START,
          endedAt: START,
          statusCode: 0,
          finalProviderId: 'person',
          estimatedCostNanoUsd: 9_000_000_000,
          attributes: {},
          events: [],
          links: [],
        })
        .run();

      expect(store.providerWindowCost({ providerId: 'person', start: START, end: END })).toBe('100000000');
    } finally {
      handle.close();
    }
  });
});
```

Do **not** add an int64-overflow test. This query uses SQL `SUM` on purpose; overflow would need the usage-overview per-row bigint fold, which is out of scope (`# ponytail` in the spec).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/db/trace-store/provider-window-cost`

Expected: FAIL — `store.providerWindowCost is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/core/src/db/trace-store/types.ts` next to `DashboardOverviewQuery`:

```ts
export type ProviderWindowCostQuery = {
  readonly providerId: string;
  readonly start: Date;
  readonly end: Date;
};
```

Add this method to `TraceStore` before `recover`:

```ts
  readonly providerWindowCost: (query: ProviderWindowCostQuery) => string | undefined;
```

Create `packages/core/src/db/trace-store/provider-window-cost/provider-window-cost.ts`:

```ts
import { and, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { parseSqliteInteger } from '../../../usage-numbers';
import { traceSpan } from '../../schema';
import type { ProviderWindowCostQuery } from '../types';

// ponytail: SQLite SUM then CAST TEXT. Per-row bigint fold if a window exceeds int64.
export function providerWindowCost(db: BunSQLiteDatabase, query: ProviderWindowCostQuery): string | undefined {
  const row = db
    .select({
      cost: sql<string | null>`cast(sum(${traceSpan.estimatedCostNanoUsd}) as text)`.as('cost'),
    })
    .from(traceSpan)
    .where(
      and(
        isNull(traceSpan.parentSpanId),
        isNull(traceSpan.terminationReason),
        eq(traceSpan.finalProviderId, query.providerId),
        gte(traceSpan.endedAt, query.start),
        lte(traceSpan.endedAt, query.end),
        isNotNull(traceSpan.estimatedCostNanoUsd),
      ),
    )
    .get();
  if (row?.cost == null) return undefined;
  return parseSqliteInteger(row.cost).toString();
}
```

Create `packages/core/src/db/trace-store/provider-window-cost/index.ts`:

```ts
export { providerWindowCost } from './provider-window-cost';
```

Wire `packages/core/src/db/trace-store/trace-store.ts`:

```ts
import { providerWindowCost } from './provider-window-cost';
```

Inside `createTraceStore`, next to `overview:`:

```ts
    providerWindowCost: (query) => providerWindowCost(db, query),
```

Do not export `ProviderWindowCostQuery` from `packages/core/src/db/index.ts`. Server only needs the method on `TraceStore`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/db/trace-store/provider-window-cost`

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/db/trace-store/provider-window-cost packages/core/src/db/trace-store/types.ts packages/core/src/db/trace-store/trace-store.ts
git commit -m "feat(core): sum priced provider cost for a quota window"
```

---

### Task 2: Attach host `estimates` on `/providers/:id/quota`

Bound check (the validity half of `quotaPace`), dedupe identical `[start, end]`, attach `estimates`. Cost failures must not become quota 502.

**Files:**
- Create: `packages/server/src/dashboard-routes/provider-quota-estimates/index.ts`
- Create: `packages/server/src/dashboard-routes/provider-quota-estimates/provider-quota-estimates.ts`
- Test: `packages/server/src/dashboard-routes/provider-quota-estimates/provider-quota-estimates.test.ts`
- Modify: `packages/server/src/dashboard-routes/provider-routes/provider-routes.ts` (quota handler)
- Modify: `packages/server/src/dashboard-routes/provider-routes/provider-routes.test.ts` (return `state`; HTTP cases)

**Interfaces:**
- Consumes: Task 1 `state.traceStore.providerWindowCost({ providerId, start, end }) => string | undefined`. Snapshot items: `{ id, remainingRatio?, resetsAt?, windowMinutes? }`. `OAuthQuotaCacheEntry.sampledAt`.
- Produces: `quotaWindowEstimates(entry, cost) => readonly QuotaWindowEstimate[] | undefined` where

```ts
type QuotaWindowEstimate = {
  readonly itemId: string;
  readonly usedNanoUsd: string;
  readonly basis: 'local-api-equivalent';
};
```

Route JSON keeps `snapshot`, `sampledAt`, `stale`, `error` and adds `estimates` only when the array is non-empty. Task 3 reads `result.estimates`.

- [ ] **Step 1: Write the failing unit tests**

Create `packages/server/src/dashboard-routes/provider-quota-estimates/provider-quota-estimates.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { quotaWindowEstimates } from './provider-quota-estimates';

const HOUR = 60 * 60 * 1000;
const sampledAt = Date.parse('2026-01-10T12:00:00.000Z');
const fiveHour = {
  id: 'five-hour',
  displayName: 'Five hour',
  remainingRatio: 0.5,
  resetsAt: sampledAt + 4 * HOUR,
  windowMinutes: 300,
} as const;
const weekly = {
  id: 'weekly',
  displayName: 'Weekly',
  remainingRatio: 0.8,
  resetsAt: sampledAt + 6 * 24 * HOUR,
  windowMinutes: 7 * 24 * 60,
} as const;

test('emits usedNanoUsd for windows with usable bounds and skips the rest', () => {
  const costs = new Map<string, string | undefined>();
  const estimates = quotaWindowEstimates(
    {
      sampledAt,
      snapshot: {
        items: [
          fiveHour,
          weekly,
          { id: 'unrated', displayName: 'Unrated', resetsAt: fiveHour.resetsAt, windowMinutes: 300 },
          { id: 'no-window', displayName: 'No window', remainingRatio: 0.2 },
          { id: 'past', displayName: 'Past', remainingRatio: 0.2, resetsAt: sampledAt - HOUR, windowMinutes: 300 },
        ],
      },
    },
    (range) => {
      const key = `${range.start.getTime()}:${range.end.getTime()}`;
      costs.set(key, key === `${sampledAt - HOUR}:${sampledAt}` ? '100000000' : '500000000');
      return costs.get(key);
    },
  );

  expect(estimates).toEqual([
    { itemId: 'five-hour', usedNanoUsd: '100000000', basis: 'local-api-equivalent' },
    { itemId: 'weekly', usedNanoUsd: '500000000', basis: 'local-api-equivalent' },
  ]);
  expect(costs.size).toBe(2);
});

test('reuses one cost query when two items share bounds', () => {
  let calls = 0;
  const estimates = quotaWindowEstimates(
    {
      sampledAt,
      snapshot: {
        items: [
          fiveHour,
          { ...fiveHour, id: 'five-hour-copy', displayName: 'Copy' },
        ],
      },
    },
    () => {
      calls += 1;
      return '1';
    },
  );

  expect(calls).toBe(1);
  expect(estimates?.map((row) => row.itemId)).toEqual(['five-hour', 'five-hour-copy']);
});

test('omits estimates when no priced cost exists', () => {
  expect(
    quotaWindowEstimates(
      { sampledAt, snapshot: { items: [fiveHour] } },
      () => undefined,
    ),
  ).toBeUndefined();
});

test('a priced zero is kept', () => {
  expect(
    quotaWindowEstimates({ sampledAt, snapshot: { items: [fiveHour] } }, () => '0'),
  ).toEqual([{ itemId: 'five-hour', usedNanoUsd: '0', basis: 'local-api-equivalent' }]);
});
```

- [ ] **Step 2: Run unit tests to verify they fail**

Run: `bun test packages/server/src/dashboard-routes/provider-quota-estimates`

Expected: FAIL — `Cannot find module './provider-quota-estimates'`.

- [ ] **Step 3: Write the estimates helper**

Create `packages/server/src/dashboard-routes/provider-quota-estimates/provider-quota-estimates.ts`:

```ts
import type { OAuthQuotaItem, OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';

export type QuotaWindowEstimate = {
  readonly itemId: string;
  readonly usedNanoUsd: string;
  readonly basis: 'local-api-equivalent';
};

export type QuotaWindowCostQuery = {
  readonly start: Date;
  readonly end: Date;
};

export function quotaWindowBounds(
  item: Pick<OAuthQuotaItem, 'remainingRatio' | 'resetsAt' | 'windowMinutes'>,
  sampledAt: number,
): QuotaWindowCostQuery | undefined {
  if (item.remainingRatio === undefined) return undefined;
  const { resetsAt, windowMinutes } = item;
  if (resetsAt === undefined || windowMinutes === undefined || windowMinutes <= 0) return undefined;
  const durationMs = windowMinutes * 60_000;
  const remainingMs = resetsAt - sampledAt;
  if (remainingMs <= 0 || remainingMs > durationMs) return undefined;
  return { start: new Date(resetsAt - durationMs), end: new Date(sampledAt) };
}

export function quotaWindowEstimates(
  entry: { readonly snapshot: OAuthQuotaSnapshot; readonly sampledAt: number },
  cost: (range: QuotaWindowCostQuery) => string | undefined,
): readonly QuotaWindowEstimate[] | undefined {
  const cache = new Map<string, string | undefined>();
  const estimates: QuotaWindowEstimate[] = [];
  for (const item of entry.snapshot.items) {
    const bounds = quotaWindowBounds(item, entry.sampledAt);
    if (bounds === undefined) continue;
    const key = `${bounds.start.getTime()}:${bounds.end.getTime()}`;
    if (!cache.has(key)) cache.set(key, cost(bounds));
    const usedNanoUsd = cache.get(key);
    if (usedNanoUsd === undefined) continue;
    estimates.push({ itemId: item.id, usedNanoUsd, basis: 'local-api-equivalent' });
  }
  return estimates.length === 0 ? undefined : estimates;
}
```

Create `packages/server/src/dashboard-routes/provider-quota-estimates/index.ts`:

```ts
export { quotaWindowEstimates, type QuotaWindowEstimate } from './provider-quota-estimates';
```

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `bun test packages/server/src/dashboard-routes/provider-quota-estimates`

Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing route tests**

In `packages/server/src/dashboard-routes/provider-routes/provider-routes.test.ts`:

1. Change the bun:test import to `import { expect, spyOn, test } from 'bun:test';`.
2. Add `state` to the fixture return: `return { routes, state, reads: () => reads, cleanup: ... }`.
3. Keep `SNAPSHOT` as-is (no window bounds) so existing tests still expect no `estimates`.
4. Append:

```ts
const HOUR = 60 * 60 * 1000;

test('attaches local API-equivalent estimates for any OAuth plugin, not ChatGPT', async () => {
  const fixture = await createQuotaFixture({
    read: async () => ({
      items: [
        {
          id: 'five-hour',
          displayName: 'Five hour',
          remainingRatio: 0.5,
          resetsAt: Date.now() + 4 * HOUR,
          windowMinutes: 300,
        },
        { id: 'unrated', displayName: 'Unrated', resetsAt: Date.now() + 4 * HOUR, windowMinutes: 300 },
      ],
    }),
  });
  try {
    fixture.state.traceStore.startRoot({
      traceId: 'a'.repeat(32),
      spanId: 'a'.repeat(16),
      requestId: 'priced',
      inboundProtocol: 'openai-compatible',
      name: 'aio_proxy.request',
      kind: 1,
      startedAt: new Date(Date.now() - HOUR),
      statusCode: 0,
      attributes: {
        'aio_proxy.request.id': 'priced',
        'aio_proxy.protocol.inbound': 'openai-compatible',
        'aio_proxy.route.final_provider_id': 'person',
        'gen_ai.usage.estimated_cost_usd': 0.1,
      },
      events: [],
      links: [],
    });
    fixture.state.traceStore.complete({
      traceId: 'a'.repeat(32),
      rootSpanId: 'a'.repeat(16),
      spans: [
        {
          traceId: 'a'.repeat(32),
          spanId: 'a'.repeat(16),
          name: 'aio_proxy.request',
          kind: 1,
          startedAt: new Date(Date.now() - HOUR),
          endedAt: new Date(),
          statusCode: 0,
          attributes: {
            'aio_proxy.request.id': 'priced',
            'aio_proxy.protocol.inbound': 'openai-compatible',
            'aio_proxy.route.final_provider_id': 'person',
            'gen_ai.usage.estimated_cost_usd': 0.1,
          },
          events: [],
          links: [],
        },
      ],
      summary: {
        finalProviderId: 'person',
        finalModelId: 'codex-auto-review',
        finalHttpStatus: 200,
        usage: { providerId: 'person', modelId: 'codex-auto-review', estimatedCostUsd: 0.1 },
      },
    });

    const payload = await (await quota(fixture.routes, 'person')).json();
    expect(payload.estimates).toEqual([
      { itemId: 'five-hour', usedNanoUsd: '100000000', basis: 'local-api-equivalent' },
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('a later trace does not enter estimates until the next quota sample', async () => {
  const now = spyOn(Date, 'now');
  const sampledAt = Date.parse('2026-01-10T12:00:00.000Z');
  now.mockReturnValue(sampledAt);
  let fixture: Awaited<ReturnType<typeof createQuotaFixture>> | undefined;
  try {
  fixture = await createQuotaFixture({
    read: async () => ({
      items: [
        {
          id: 'five-hour',
          displayName: 'Five hour',
          remainingRatio: 0.5,
          resetsAt: sampledAt + 4 * HOUR,
          windowMinutes: 300,
        },
      ],
    }),
  });
  try {
    fixture.state.traceStore.startRoot({
      traceId: 'a'.repeat(32),
      spanId: 'a'.repeat(16),
      requestId: 'before',
      inboundProtocol: 'openai-compatible',
      name: 'aio_proxy.request',
      kind: 1,
      startedAt: new Date(sampledAt - HOUR),
      statusCode: 0,
      attributes: {
        'aio_proxy.request.id': 'before',
        'aio_proxy.protocol.inbound': 'openai-compatible',
        'aio_proxy.route.final_provider_id': 'person',
        'gen_ai.usage.estimated_cost_usd': 0.1,
      },
      events: [],
      links: [],
    });
    fixture.state.traceStore.complete({
      traceId: 'a'.repeat(32),
      rootSpanId: 'a'.repeat(16),
      spans: [
        {
          traceId: 'a'.repeat(32),
          spanId: 'a'.repeat(16),
          name: 'aio_proxy.request',
          kind: 1,
          startedAt: new Date(sampledAt - HOUR),
          endedAt: new Date(sampledAt - 1),
          statusCode: 0,
          attributes: {
            'aio_proxy.request.id': 'before',
            'aio_proxy.protocol.inbound': 'openai-compatible',
            'aio_proxy.route.final_provider_id': 'person',
            'gen_ai.usage.estimated_cost_usd': 0.1,
          },
          events: [],
          links: [],
        },
      ],
      summary: {
        finalProviderId: 'person',
        finalModelId: 'codex-auto-review',
        finalHttpStatus: 200,
        usage: { providerId: 'person', modelId: 'codex-auto-review', estimatedCostUsd: 0.1 },
      },
    });

    const first = await (await quota(fixture.routes, 'person')).json();
    expect(first.sampledAt).toBe(sampledAt);
    expect(first.estimates).toEqual([
      { itemId: 'five-hour', usedNanoUsd: '100000000', basis: 'local-api-equivalent' },
    ]);

    now.mockReturnValue(sampledAt + HOUR);
    fixture.state.traceStore.startRoot({
      traceId: 'b'.repeat(32),
      spanId: 'b'.repeat(16),
      requestId: 'after',
      inboundProtocol: 'openai-compatible',
      name: 'aio_proxy.request',
      kind: 1,
      startedAt: new Date(sampledAt + 1),
      statusCode: 0,
      attributes: {
        'aio_proxy.request.id': 'after',
        'aio_proxy.protocol.inbound': 'openai-compatible',
        'aio_proxy.route.final_provider_id': 'person',
        'gen_ai.usage.estimated_cost_usd': 0.4,
      },
      events: [],
      links: [],
    });
    fixture.state.traceStore.complete({
      traceId: 'b'.repeat(32),
      rootSpanId: 'b'.repeat(16),
      spans: [
        {
          traceId: 'b'.repeat(32),
          spanId: 'b'.repeat(16),
          name: 'aio_proxy.request',
          kind: 1,
          startedAt: new Date(sampledAt + 1),
          endedAt: new Date(sampledAt + 1),
          statusCode: 0,
          attributes: {
            'aio_proxy.request.id': 'after',
            'aio_proxy.protocol.inbound': 'openai-compatible',
            'aio_proxy.route.final_provider_id': 'person',
            'gen_ai.usage.estimated_cost_usd': 0.4,
          },
          events: [],
          links: [],
        },
      ],
      summary: {
        finalProviderId: 'person',
        finalModelId: 'gpt-5',
        finalHttpStatus: 200,
        usage: { providerId: 'person', modelId: 'gpt-5', estimatedCostUsd: 0.4 },
      },
    });

    const cached = await (await quota(fixture.routes, 'person')).json();
    expect(cached.sampledAt).toBe(sampledAt);
    expect(cached.estimates).toEqual([
      { itemId: 'five-hour', usedNanoUsd: '100000000', basis: 'local-api-equivalent' },
    ]);

    const refreshed = await (await quota(fixture.routes, 'person', { refresh: true })).json();
    expect(refreshed.sampledAt).toBe(sampledAt + HOUR);
    expect(refreshed.estimates).toEqual([
      { itemId: 'five-hour', usedNanoUsd: '500000000', basis: 'local-api-equivalent' },
    ]);
  } finally {
    fixture?.cleanup();
  }
  } finally {
    now.mockRestore();
  }
});

test('a throwing cost query still returns the quota snapshot', async () => {
  const fixture = await createQuotaFixture({
    read: async () => ({
      items: [
        {
          id: 'five-hour',
          displayName: 'Five hour',
          remainingRatio: 0.5,
          resetsAt: Date.now() + 4 * HOUR,
          windowMinutes: 300,
        },
      ],
    }),
  });
  const cost = spyOn(fixture.state.traceStore, 'providerWindowCost').mockImplementation(() => {
    throw new Error('sqlite exploded');
  });
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await quota(fixture.routes, 'person');
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.snapshot.items[0]?.id).toBe('five-hour');
    expect(payload.estimates).toBeUndefined();
    expect(cost).toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
  } finally {
    cost.mockRestore();
    logged.mockRestore();
    fixture.cleanup();
  }
});
```

Existing test `serves a quota snapshot once...` already asserts `payload.snapshot` / `stale` / `sampledAt`. After this change it must still omit `estimates` (the default `SNAPSHOT` has no window bounds).

- [ ] **Step 6: Run route tests to verify the new ones fail**

Run: `bun test packages/server/src/dashboard-routes/provider-routes/provider-routes.test.ts`

Expected: FAIL — `payload.estimates` is undefined on the happy path, and the throwing-cost spy is never called because the route does not attach estimates.

- [ ] **Step 7: Attach estimates on the quota route**

In `packages/server/src/dashboard-routes/provider-routes/provider-routes.ts`:

Add import:

```ts
import { quotaWindowEstimates } from '../provider-quota-estimates';
```

Keep the existing `const entry = await state.quotaCache.read(...)`. Replace only the `return context.json({ snapshot, sampledAt, stale, error })` that follows it. Do not redeclare `entry`.

```ts
        let estimates: ReturnType<typeof quotaWindowEstimates>;
        try {
          estimates = quotaWindowEstimates(entry, (range) =>
            state.traceStore.providerWindowCost({ providerId: id, ...range }),
          );
        } catch (error) {
          console.error('quota window cost aggregation failed', { providerId: id, error });
          estimates = undefined;
        }
        return context.json({
          snapshot: entry.snapshot,
          sampledAt: entry.sampledAt,
          stale: entry.stale,
          ...(estimates === undefined ? {} : { estimates }),
          ...(entry.error === undefined ? {} : { error: entry.error }),
        });
```

Do not read `provider.plugin`. Do not import ChatGPT helpers. The cost `try/catch` stays inside the quota `try` so a thrown `providerWindowCost` cannot hit the outer 502.

- [ ] **Step 8: Run route tests to verify they pass**

Run: `bun test packages/server/src/dashboard-routes/provider-routes packages/server/src/dashboard-routes/provider-quota-estimates`

Expected: PASS, including the original quota cache/404/502 cases.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/dashboard-routes/provider-quota-estimates packages/server/src/dashboard-routes/provider-routes/provider-routes.ts packages/server/src/dashboard-routes/provider-routes/provider-routes.test.ts
git commit -m "feat(server): attach local API-equivalent quota window spend"
```

---

### Task 3: Dialog row + i18n

Compact **Used $x** under each window. Hide when that item has no estimate. No Est. total.

**Files:**
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/ja.json`
- Modify: `packages/i18n/messages/ko.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Modify: `packages/i18n/messages/zh-Hant.json`
- Modify: `packages/dashboard/src/lib/nano-usd/nano-usd.ts`
- Test: `packages/dashboard/src/lib/nano-usd/nano-usd.test.ts`
- Modify: `packages/dashboard/src/modules/providers/components/provider-quota-ring/provider-quota-item.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-quota-ring/provider-quota-cost.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/provider-quota-ring/provider-quota-dialog.tsx`
- Modify: `packages/dashboard/src/modules/providers/services/provider-quota-service/provider-quota-service.ts`
- Test: `packages/dashboard/src/modules/providers/components/provider-quota-ring/provider-quota-ring.test.tsx`

**Interfaces:**
- Consumes: Task 2 `ProviderQuotaResult.estimates?: readonly { itemId: string; usedNanoUsd: string; basis: 'local-api-equivalent' }[]` (Hono-inferred). `formatNanoUsd`.
- Produces: user-visible row `data-testid="provider-quota-cost-{id}"`. No new dashboard service; the existing quota query already returns the extra field.

- [ ] **Step 1: Add i18n keys and compile**

In each locale file, inside `dashboard.providers.quota`, after `"loading"`:

`en.json`:

```json
        "cost_used": "Used {amount} · API equivalent",
        "cost_note": "Local API-equivalent spend for this Provider's successful priced requests in this window, across all models. Not this window's lane, not an account balance, and not Cursor or Grok credits. Outside clients, other instances, downtime, unpriced models, and 45-day prune undercount. Not a full bill. Do not add overlapping windows.",
        "cost_less_than": "<$0.01"
```

`zh-Hans.json`:

```json
        "cost_used": "已用 {amount} · API 等价",
        "cost_note": "本实例按 API 价估算的花费：该 Provider 在此窗口内成功且已定价的全部模型请求。不是该窗口自己的车道消耗，不是账户余额，也不是 Cursor / Grok 积分。外部客户端、其他实例、宕机、未定价模型和 45 天清理都会少计。不是完整账单。重叠窗口的金额不要相加。",
        "cost_less_than": "<$0.01"
```

`zh-Hant.json`:

```json
        "cost_used": "已用 {amount} · API 等價",
        "cost_note": "本實例按 API 價估算的花費：該 Provider 在此窗口內成功且已定價的全部模型請求。不是該窗口自己的車道消耗，不是帳戶餘額，也不是 Cursor / Grok 點數。外部用戶端、其他實例、停機、未定價模型和 45 天清理都會少計。不是完整帳單。重疊窗口的金額不要相加。",
        "cost_less_than": "<$0.01"
```

`ja.json`:

```json
        "cost_used": "使用 {amount} · API 換算",
        "cost_note": "このウィンドウで、この Provider の成功かつ価格付きリクエストを全モデル分、API 価格に換算したローカル集計です。レーン別消費でも口座残高でも、Cursor / Grok のクレジットでもありません。外部クライアント、他インスタンス、停止、未価格モデル、45 日の削除で過小になります。請求書ではありません。重なるウィンドウの金額は足し合わせないでください。",
        "cost_less_than": "$0.01 未満"
```

`ko.json`:

```json
        "cost_used": "사용 {amount} · API 환산",
        "cost_note": "이 창에서 이 Provider의 성공하고 가격이 매겨진 요청을 모든 모델에 대해 API 가격으로 환산한 로컬 합계입니다. 해당 창의 레인 소모도, 계정 잔액도, Cursor / Grok 크레딧도 아닙니다. 외부 클라이언트, 다른 인스턴스, 중단, 미가격 모델, 45일 정리로 과소 집계됩니다. 전체 청구서가 아닙니다. 겹치는 창의 금액을 더하지 마세요.",
        "cost_less_than": "<$0.01"
```

Run: `bun run i18n:compile`

Expected: Paraglide regenerates; no error.

- [ ] **Step 2: Write the failing compact-label test**

Append to `packages/dashboard/src/lib/nano-usd/nano-usd.test.ts`:

```ts
import { compactNanoUsdDisplay } from './nano-usd';

test('compact display uses <$0.01 when two-decimal USD would round to zero', () => {
  expect(compactNanoUsdDisplay(2n, 'en-US')).toEqual({
    exact: '$0.000000002',
    compact: undefined,
    subCent: true,
  });
  expect(compactNanoUsdDisplay(10_000_000n, 'en-US')).toEqual({
    exact: '$0.01',
    compact: '$0.01',
    subCent: false,
  });
  expect(compactNanoUsdDisplay(0n, 'en-US').subCent).toBe(false);
});
```

- [ ] **Step 3: Run compact-label test to verify it fails**

Run: `bun run --filter @aio-proxy/dashboard test:unit -- src/lib/nano-usd/nano-usd.test.ts`

Expected: FAIL — `compactNanoUsdDisplay is not exported`.

- [ ] **Step 4: Add compactNanoUsdDisplay**

In `packages/dashboard/src/lib/nano-usd/nano-usd.ts` after `formatNanoUsd`:

```ts
export const compactNanoUsdDisplay = (value: bigint, locale: string) => {
  const exact = formatNanoUsd(value, locale);
  const compact = formatNanoUsd(value, locale, 'compact');
  const subCent = value > 0n && compact === formatNanoUsd(0n, locale, 'compact');
  return { exact, compact: subCent ? undefined : compact, subCent };
};
```

`index.ts` already does `export * from './nano-usd'`.

- [ ] **Step 5: Run compact-label test to verify it passes**

Run: `bun run --filter @aio-proxy/dashboard test:unit -- src/lib/nano-usd/nano-usd.test.ts`

Expected: PASS.

- [ ] **Step 6: Write the failing dialog tests**

Append to `packages/dashboard/src/modules/providers/components/provider-quota-ring/provider-quota-ring.test.tsx`:

```ts
test('shows Used API-equivalent spend under a window that has an estimate', () => {
  queryMocks.data = {
    sampledAt: 1_700_000_000_000,
    stale: false,
    snapshot: {
      items: [
        {
          id: 'five-hour',
          displayName: 'Five hour',
          remainingRatio: 0.5,
          resetsAt: 1_700_000_000_000 + 4 * 60 * 60 * 1000,
          windowMinutes: 300,
        },
        { id: 'unrated', displayName: 'Unrated' },
      ],
    },
    estimates: [
      { itemId: 'five-hour', usedNanoUsd: '100000000', basis: 'local-api-equivalent' },
      { itemId: 'unrated', usedNanoUsd: '100000000', basis: 'local-api-equivalent' },
    ],
  };

  render(<ProviderQuotaRing provider={provider} />);
  fireEvent.click(screen.getByTestId('provider-quota-ring'));

  const row = screen.getByTestId('provider-quota-cost-five-hour');
  expect(row).toHaveTextContent(/API/u);
  expect(row).toHaveTextContent(/\$0\.10/u);
  expect(row).toHaveAttribute('title', '$0.10');
  expect(row).toHaveAttribute('aria-description', expect.stringMatching(/all models|全部模型|全モデル|모든 모델/u));
  expect(screen.queryByTestId('provider-quota-cost-unrated')).not.toBeInTheDocument();
  expect(screen.queryByText(/Est\. total|预估总额|推定合計/u)).not.toBeInTheDocument();
});

test('hides the cost row when the window has no estimate', () => {
  queryMocks.data = {
    sampledAt: 1_700_000_000_000,
    stale: false,
    snapshot: {
      items: [{ id: 'weekly', displayName: 'Weekly', remainingRatio: 0.8, windowMinutes: 10080, resetsAt: 1_700_000_000_000 + 6 * 24 * 60 * 60 * 1000 }],
    },
  };

  render(<ProviderQuotaRing provider={provider} />);
  fireEvent.click(screen.getByTestId('provider-quota-ring'));

  expect(screen.queryByTestId('provider-quota-cost-weekly')).not.toBeInTheDocument();
});

test('renders <$0.01 for a positive sub-cent estimate', () => {
  queryMocks.data = {
    sampledAt: 1,
    stale: false,
    snapshot: { items: [{ id: 'weekly', displayName: 'Weekly', remainingRatio: 0.5, resetsAt: 2, windowMinutes: 60 }] },
    estimates: [{ itemId: 'weekly', usedNanoUsd: '2', basis: 'local-api-equivalent' }],
  };

  render(<ProviderQuotaRing provider={provider} />);
  fireEvent.click(screen.getByTestId('provider-quota-ring'));

  expect(screen.getByTestId('provider-quota-cost-weekly')).toHaveTextContent(/<\$0\.01|\$0\.01 未満/u);
});
```

The `unrated` estimate in the first test must not render: `applicableQuotaItems` drops items without `remainingRatio`, so the dialog never mounts that row.

- [ ] **Step 7: Run dialog tests to verify they fail**

Run: `bun run --filter @aio-proxy/dashboard test:unit -- src/modules/providers/components/provider-quota-ring/provider-quota-ring.test.tsx`

Expected: FAIL — `Unable to find an element by: [data-testid="provider-quota-cost-five-hour"]`.

- [ ] **Step 8: Render the row**

Update `ProviderQuotaItemProps` in `provider-quota-item.tsx`:

```ts
interface ProviderQuotaCostEstimate {
  readonly usedNanoUsd: string;
}

interface ProviderQuotaItemProps {
  readonly item: ApplicableQuotaItem;
  readonly sampledAt: number;
  readonly estimate?: ProviderQuotaCostEstimate;
}
```

Destructure the new prop: `({ item, sampledAt, estimate })`. Do **not** import `compactNanoUsdDisplay` here; only `provider-quota-cost.tsx` formats the amount. After the resets line, add:

```tsx
      {estimate === undefined ? null : <ProviderQuotaCost estimate={estimate} itemId={item.id} />}
```

`provider-quota-item.tsx` may declare only one React component. Put the cost line in `packages/dashboard/src/modules/providers/components/provider-quota-ring/provider-quota-cost.tsx`:

```tsx
import { getLocale, m } from '@aio-proxy/i18n';
import type React from 'react';

import { compactNanoUsdDisplay } from '@/lib/nano-usd';

interface ProviderQuotaCostProps {
  readonly itemId: string;
  readonly estimate: { readonly usedNanoUsd: string };
}

export const ProviderQuotaCost: React.FC<ProviderQuotaCostProps> = ({ itemId, estimate }) => {
  const locale = getLocale();
  const display = compactNanoUsdDisplay(BigInt(estimate.usedNanoUsd), locale);
  const amount = display.subCent ? m['dashboard.providers.quota.cost_less_than']() : display.compact;
  if (amount === undefined) return null;
  const note = m['dashboard.providers.quota.cost_note']();
  return (
    <p
      className="text-xs text-muted-foreground"
      data-testid={`provider-quota-cost-${itemId}`}
      title={display.exact}
      aria-description={note}
    >
      {m['dashboard.providers.quota.cost_used']({ amount })}
    </p>
  );
};
```

In `provider-quota-item.tsx` import and render `ProviderQuotaCost`.

In `provider-quota-dialog.tsx`, pass the matching estimate:

```tsx
                {items.map((item) => (
                  <ProviderQuotaItem
                    key={item.id}
                    item={item}
                    sampledAt={result.sampledAt}
                    estimate={result.estimates?.find((row) => row.itemId === item.id)}
                  />
                ))}
```

Do not add `cost_total`. Do not change the ring.

In `packages/dashboard/src/modules/providers/services/provider-quota-service/provider-quota-service.ts`, keep the 60s poll. Narrow the existing comment so "in-memory cache hit" refers only to the **upstream quota snapshot**. Each poll still runs local SQL for `estimates`.

- [ ] **Step 9: Run dashboard tests to verify they pass**

Run: `bun run --filter @aio-proxy/dashboard test:unit -- src/modules/providers/components/provider-quota-ring src/lib/nano-usd/nano-usd.test.ts`

Expected: PASS, including existing ring/pace/stale tests.

- [ ] **Step 10: Commit**

```bash
git add packages/i18n/messages packages/i18n/src/paraglide packages/dashboard/src/lib/nano-usd packages/dashboard/src/modules/providers/components/provider-quota-ring packages/dashboard/src/modules/providers/services/provider-quota-service/provider-quota-service.ts
git commit -m "feat(dashboard): show API-equivalent spend on quota windows"
```

If `i18n:compile` also touches generated paraglide files, include those in the same commit.

---

### Task 4: Changeset

**Files:**
- Create: `.changeset/quota-window-api-equivalent-cost.md`

**Interfaces:**
- Consumes: Tasks 1–3 user-facing behavior.
- Produces: release note. No further tasks.

- [ ] **Step 1: Write the changeset**

Create `.changeset/quota-window-api-equivalent-cost.md`:

```md
---
'aio-proxy': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/i18n': minor
---

Quota details show this instance's API-equivalent spend for each OAuth window. It is not the vendor balance.
```

Do not list `@aio-proxy/plugin-sdk`. Do not prefix the body with `core:` / `dashboard:`.

- [ ] **Step 2: Format and preflight the slice**

Run:

```bash
bun run check
bun test packages/core/src/db/trace-store/provider-window-cost packages/server/src/dashboard-routes/provider-quota-estimates packages/server/src/dashboard-routes/provider-routes/provider-routes.test.ts
bun run --filter @aio-proxy/dashboard test:unit -- src/modules/providers/components/provider-quota-ring src/lib/nano-usd/nano-usd.test.ts
```

Expected: check + those tests pass. Full `bun run preflight` if time allows.

- [ ] **Step 3: Commit**

```bash
git add .changeset/quota-window-api-equivalent-cost.md
git commit -m "chore: add quota-window API-equivalent cost changeset"
```

---

## Spec coverage

| Spec requirement | Task |
| --- | --- |
| SQLite one-row SUM, no JS `.all()` | 1 |
| Successful priced roots only; unpriced → hide; priced 0 → `$0.00` | 1 |
| Inclusive `[resetsAt - windowMinutes, sampledAt]` | 1 + 2 |
| Host `estimates` on existing quota JSON, keyed by `itemId` | 2 |
| No plugin package / item-id / model regex | 2 |
| Dedupe identical bounds; overlapping windows not added | 2 |
| Cost throw → omit estimates, quota 200 | 2 |
| Dialog Used $x; hide otherwise; no Est. total | 3 |
| Compact / `<$0.01` / exact on hover; all-model copy | 3 |
| Five-locale i18n | 3 |
| Ring stays percent | 3 (no ring edit) |
| Changeset `aio-proxy` + internals, no plugin-sdk | 4 |
| Do not raise 45-day retention / use `usage_daily` | none (out of scope) |

## Self-review

- No TBD/TODO. Names match across tasks: `providerWindowCost`, `quotaWindowEstimates`, `QuotaWindowEstimate`, `compactNanoUsdDisplay`, `cost_used` / `cost_note` / `cost_less_than`.
- Dashboard has one component per `.tsx` file (`ProviderQuotaCost` is its own file). `ProviderQuotaItem` destructures `estimate` and does not import `compactNanoUsdDisplay`.
- `aria-description` carries the note; `title` is the exact amount (hover), matching the spec after Oracle's copy fix.
- Route tests spy `providerWindowCost` and `console.error` instead of assigning a readonly method. The cutoff test has a before/after/refresh sequence with a frozen `Date.now()`.
- Quota-route patch keeps the existing `entry` binding. The dashboard quota query's "in-memory cache hit" comment still describes the *upstream snapshot*; local SQL still runs on each poll.
