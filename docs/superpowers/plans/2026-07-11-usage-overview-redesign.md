# Usage Overview Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the standalone Usage page with a Dashboard overview that reports request health, successful usage, estimated cost, average rates, and a range-aware stacked trend chart.

**Architecture:** Keep successful token/cost facts in the existing `usage` table and add one `request_log` row per routed inbound request. A deep request-observability module owns request IDs, ordered attempt metadata, terminal classification, successful usage capture, and failure isolation; protocol routes only report lifecycle events through that interface. The database module owns range calculation, aggregation, Top 5 + Other series selection, pricing coverage, and 45-day retention, while the Dashboard consumes one typed overview endpoint.

**Tech Stack:** TypeScript, Bun 1.3.14, Zod 4, Hono, Drizzle ORM with Bun SQLite, React 19, TanStack Query 5, TanStack Router, Recharts 3, Jotai 2, date-fns 4, and existing shadcn/Base UI chart/tabs/card components.

## Global Constraints

- Use `rtk` before every shell command in this repo.
- Do not add runtime dependencies except the user-directed `date-fns` and `jotai` Dashboard dependencies; otherwise reuse `recharts`, `@tanstack/react-query`, Drizzle ORM, and existing shadcn components.
- Remove the standalone `/dashboard/usage` route and Usage side-menu item; the root Dashboard route becomes the only Usage UI.
- Count one request only after it enters model routing. Authentication failures, malformed requests, unmatched routes, health checks, and dashboard requests are outside the metric boundary.
- Persist exactly one `request_log` row per routed inbound request. Retries and fallback attempts never increase the request count.
- Request outcomes are `success`, `failure`, or `cancelled`. Success requires a normal non-stream completion or a stream that reaches its normal finish event.
- Success rate is `success / (success + failure)`. Cancelled requests remain visible in Requests and charts but are excluded from the success-rate denominator.
- Token, Average TPM, and estimated-cost metrics use only the final successful attempt. Failed attempts remain in request-log metadata and never contribute usage or cost.
- TPM and token totals are `inputTokens + outputTokens`. Do not add cache or reasoning tokens to TPM.
- Default range is `24h`. `24h` is a rolling window with hourly buckets; `7d`, `14d`, and `30d` use server-system-timezone calendar-day buckets including today.
- Average RPM and Average TPM divide range totals by the actual elapsed minutes between `rangeStart` and `now`.
- Range selection affects every summary card and the chart. Refresh the active query every 60 seconds; do not poll while the page is unfocused.
- The chart switches among `cost`, `tokens`, and `requests`, defaulting to `cost`; it switches between final upstream `model` and final `provider`, defaulting to `model`.
- Chart series are Top 5 by the selected metric plus `Other`. `Failed` and `Cancelled` are pinned special series for the request metric and do not consume Top 5 slots.
- Estimated cost displays known cost plus pricing coverage. Unknown prices must never be silently presented as zero coverage.
- Store request/attempt metadata only. Do not persist prompts, response bodies, request headers, response headers, or credentials.
- Keep raw request logs and successful usage rows for 45 days. Prune once at server startup and at most once per 24 hours during later writes; do not add a scheduler.
- Accounting, logging, pricing, and cleanup failures must never change the client response.
- All Dashboard copy comes from `packages/i18n/messages/*.json`.
- Do not edit `packages/dashboard/src/route-tree.gen.ts` by hand; regenerate it through the Dashboard build.

---

## File Structure

- Modify `docs/superpowers/specs/2026-07-09-model-usage-billing-design.md`: replace standalone-page and successful-only-request assumptions with the confirmed overview contract.
- Modify `packages/types/src/usage.ts`, `packages/types/src/dashboard.ts`, and `packages/types/_test/schemas.test.ts`: shared outcome, query, summary, series, and bucket schemas.
- Create `packages/core/src/db/schema/request-log.ts` and `packages/core/src/db/migrations/0002_request_log.sql`; modify schema/db exports and the usage schema to use `requestId`.
- Create `packages/core/src/db/request-log.ts`; delete the shallow `usage-ledger.ts` module and move successful-usage insertion into the request-log transaction.
- Create `packages/core/_test/request-log.test.ts`; delete `packages/core/_test/usage-ledger.test.ts` after moving its storage assertions.
- Replace `packages/server/src/usage-recorder.ts` with capture-only `packages/server/src/usage-capture.ts`; create `packages/server/src/request-recorder.ts` as the deep request-observability module.
- Modify `packages/server/src/runtime.ts`, `packages/server/src/server-state.ts`, and all four protocol route files to use one request session per inbound request.
- Add lifecycle coverage under `packages/server/_test/request-recorder.test.ts` and extend the four existing protocol route test files.
- Replace the old `/dashboard/api/usage?limit=` behavior in `packages/server/src/dashboard-routes/config.ts`; rewrite `packages/server/_test/usage-dashboard.test.ts` around range/metric/grouping queries.
- Delete `packages/dashboard/src/routes/usage.tsx` and `packages/dashboard/src/modules/usage/templates/usage-page.tsx`.
- Create `packages/dashboard/src/modules/usage/components/usage-summary-grid.tsx`, `usage-trend-chart.tsx`, `usage-range-tabs.tsx`, and `usage-trend-tabs.tsx`; create `stores/usage-overview-filters.ts` and `templates/usage-overview.tsx`.
- Modify `packages/dashboard/src/routes/index.tsx`, the usage service/hook, side menu, i18n messages, and Dashboard tests.
- Keep `docs/research/usage-metrics-comparison.md` as the source-backed rationale for metric semantics.

---

### Task 1: Update The Design Contract And Shared Schemas

**Files:**
- Add: `docs/research/usage-metrics-comparison.md`
- Modify: `docs/superpowers/specs/2026-07-09-model-usage-billing-design.md`
- Modify: `packages/types/src/usage.ts`
- Modify: `packages/types/src/dashboard.ts`
- Modify: `packages/types/_test/schemas.test.ts`

**Interfaces:**
- Produces: `RequestOutcome`, `UsageOverviewRange`, `UsageOverviewMetric`, and `UsageOverviewGroupBy`.
- Produces: `DashboardUsageOverviewResponse` containing one summary, an ordered series list, and ordered time buckets.
- Consumers: core database aggregation, Hono query validation, TanStack Query keys, and Dashboard controls.

- [ ] **Step 1: Rewrite the design requirements before changing code**

Replace the old Scope, Storage, Dashboard, and Testing statements with these exact invariants:

```md
- One routed inbound request produces one request-log row, regardless of fallback count.
- Successful final attempts may additionally produce one usage row keyed by request id.
- Failed attempts are retained only in ordered request-log metadata and do not contribute token or cost metrics.
- Dashboard ranges are 24h, 7d, 14d, and 30d; 24h uses hourly buckets and the remaining ranges use server-local calendar-day buckets.
- The Dashboard root shows known estimated cost plus pricing coverage, requests, input+output tokens, Average RPM, Average TPM, success rate, and a metric/grouping-switchable stacked chart.
- The standalone Usage route and recent-request table are removed.
```

Add the pinned research note as a design reference:

```md
Metric naming and retry semantics were compared against `docs/research/usage-metrics-comparison.md`.
```

- [ ] **Step 2: Write failing schema tests**

Add to `packages/types/_test/schemas.test.ts`:

```ts
import {
  DashboardUsageOverviewResponseSchema,
  RequestOutcomeSchema,
  UsageOverviewGroupBySchema,
  UsageOverviewMetricSchema,
  UsageOverviewRangeSchema,
} from "../src/index";

test("parses usage overview controls and request outcomes", () => {
  expect(UsageOverviewRangeSchema.parse("24h")).toBe("24h");
  expect(UsageOverviewMetricSchema.parse("cost")).toBe("cost");
  expect(UsageOverviewGroupBySchema.parse("model")).toBe("model");
  expect(RequestOutcomeSchema.parse("cancelled")).toBe("cancelled");
});

test("roundtrips the usage overview response", () => {
  const response = {
    range: "24h",
    metric: "cost",
    groupBy: "model",
    rangeStart: "2026-07-10T08:00:00.000Z",
    rangeEnd: "2026-07-11T08:00:00.000Z",
    bucketUnit: "hour",
    summary: {
      estimatedCostUsd: 1.25,
      pricingCoverage: 0.8,
      pricedRequestCount: 8,
      usageRequestCount: 10,
      requestCount: 12,
      successCount: 10,
      failureCount: 1,
      cancelledCount: 1,
      successRate: 10 / 11,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      averageRpm: 12 / 1440,
      averageTpm: 150 / 1440,
    },
    series: [
      { key: "openai/gpt-5", kind: "dimension" },
      { key: "__other__", kind: "other" },
    ],
    buckets: [
      {
        key: "2026-07-11 08:00",
        values: { "openai/gpt-5": 1.25, __other__: 0 },
      },
    ],
  } as const;

  expect(DashboardUsageOverviewResponseSchema.parse(response)).toEqual(response);
});
```

Run:

```bash
rtk bun test packages/types/_test/schemas.test.ts
```

Expected: FAIL because the overview schemas do not exist.

- [ ] **Step 3: Replace the public usage overview schemas**

Add to `packages/types/src/usage.ts`:

```ts
export const RequestOutcomeSchema = z.enum(["success", "failure", "cancelled"]);
export const UsageOverviewRangeSchema = z.enum(["24h", "7d", "14d", "30d"]);
export const UsageOverviewMetricSchema = z.enum(["cost", "tokens", "requests"]);
export const UsageOverviewGroupBySchema = z.enum(["model", "provider"]);

export type RequestOutcome = z.output<typeof RequestOutcomeSchema>;
export type UsageOverviewRange = z.output<typeof UsageOverviewRangeSchema>;
export type UsageOverviewMetric = z.output<typeof UsageOverviewMetricSchema>;
export type UsageOverviewGroupBy = z.output<typeof UsageOverviewGroupBySchema>;
```

Replace the old Dashboard usage response in `packages/types/src/dashboard.ts` with:

```ts
export const DashboardUsageSummarySchema = z.object({
  estimatedCostUsd: z.number().min(0),
  pricingCoverage: z.number().min(0).max(1).nullable(),
  pricedRequestCount: z.number().int().min(0),
  usageRequestCount: z.number().int().min(0),
  requestCount: z.number().int().min(0),
  successCount: z.number().int().min(0),
  failureCount: z.number().int().min(0),
  cancelledCount: z.number().int().min(0),
  successRate: z.number().min(0).max(1).nullable(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  averageRpm: z.number().min(0),
  averageTpm: z.number().min(0),
});

export const DashboardUsageSeriesSchema = z.object({
  key: z.string().min(1),
  kind: z.enum(["dimension", "other", "failed", "cancelled"]),
});

export const DashboardUsageBucketSchema = z.object({
  key: z.string().min(1),
  values: z.record(z.string(), z.number().min(0)),
});

export const DashboardUsageOverviewResponseSchema = z.object({
  range: UsageOverviewRangeSchema,
  metric: UsageOverviewMetricSchema,
  groupBy: UsageOverviewGroupBySchema,
  rangeStart: z.string().datetime(),
  rangeEnd: z.string().datetime(),
  bucketUnit: z.enum(["hour", "day"]),
  summary: DashboardUsageSummarySchema,
  series: z.array(DashboardUsageSeriesSchema),
  buckets: z.array(DashboardUsageBucketSchema),
});
```

Export the matching inferred types and ensure `packages/types/src/index.ts` re-exports them.

- [ ] **Step 4: Run schema tests**

Run:

```bash
rtk bun test packages/types/_test/schemas.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the contract**

```bash
rtk git add docs/research/usage-metrics-comparison.md docs/superpowers/specs/2026-07-09-model-usage-billing-design.md packages/types/src/usage.ts packages/types/src/dashboard.ts packages/types/src/index.ts packages/types/_test/schemas.test.ts
rtk git commit -m "docs(usage): define dashboard overview metrics" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Add Request Logs, Retention, And Overview Aggregation

**Files:**
- Create: `packages/core/src/db/migrations/0002_request_log.sql`
- Create: `packages/core/src/db/schema/request-log.ts`
- Modify: `packages/core/src/db/schema/usage.ts`
- Modify: `packages/core/src/db/schema/index.ts`
- Create: `packages/core/src/db/request-log.ts`
- Delete: `packages/core/src/db/usage-ledger.ts`
- Modify: `packages/core/src/db/index.ts`
- Create: `packages/core/_test/request-log.test.ts`
- Delete: `packages/core/_test/usage-ledger.test.ts`

**Interfaces:**
- Produces: `RequestLogStore.insertFinal(input)`, `RequestLogStore.overview(query)`, and `RequestLogStore.prune(cutoff)`.
- Produces: one transaction that inserts the terminal request row and optional successful usage row.
- Consumes: the shared range/metric/grouping types from Task 1.

- [ ] **Step 1: Write failing persistence and aggregation tests**

Create `packages/core/_test/request-log.test.ts` with a fixed `now = new Date("2026-07-11T08:00:00.000Z")`. Seed:

```ts
const rows = [
  {
    requestId: "request-success-a",
    inboundProtocol: "openai-compatible",
    requestedModelId: "mini",
    outcome: "success",
    finalProviderId: "openrouter",
    finalModelId: "openai/gpt-5",
    attempts: [
      {
        index: 0,
        providerId: "primary",
        modelId: "gpt-5",
        providerKind: ProviderKind.Api,
        protocol: "openai-compatible",
        outcome: "failure",
        statusCode: 429,
        durationMs: 20,
      },
      {
        index: 1,
        providerId: "openrouter",
        modelId: "openai/gpt-5",
        providerKind: ProviderKind.Api,
        protocol: "openai-compatible",
        outcome: "success",
        statusCode: 200,
        durationMs: 80,
      },
    ],
    startedAt: new Date("2026-07-11T07:00:00.000Z"),
    completedAt: new Date("2026-07-11T07:00:00.100Z"),
  },
  {
    requestId: "request-failure",
    inboundProtocol: "openai-compatible",
    requestedModelId: "mini",
    outcome: "failure",
    attempts: [],
    startedAt: new Date("2026-07-11T07:30:00.000Z"),
    completedAt: new Date("2026-07-11T07:30:00.050Z"),
  },
  {
    requestId: "request-cancelled",
    inboundProtocol: "openai-compatible",
    requestedModelId: "mini",
    outcome: "cancelled",
    attempts: [],
    startedAt: new Date("2026-07-11T07:45:00.000Z"),
    completedAt: new Date("2026-07-11T07:45:00.010Z"),
  },
] as const;
```

Insert usage only for `request-success-a`: input 100, output 50, known cost 0.25. Assert:

```ts
expect(store.overview({ range: "24h", metric: "requests", groupBy: "model", now }).summary).toEqual({
  estimatedCostUsd: 0.25,
  pricingCoverage: 1,
  pricedRequestCount: 1,
  usageRequestCount: 1,
  requestCount: 3,
  successCount: 1,
  failureCount: 1,
  cancelledCount: 1,
  successRate: 0.5,
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  averageRpm: 3 / 1440,
  averageTpm: 150 / 1440,
});
```

Also assert request-series keys include `openai/gpt-5`, `__failed__`, and `__cancelled__`; token/cost queries exclude failed and cancelled rows; six successful models collapse to Top 5 + `__other__`; and `prune()` removes both request and usage rows older than 45 days.

Run:

```bash
TZ=Asia/Shanghai rtk bun test packages/core/_test/request-log.test.ts
```

Expected: FAIL because the request-log schema/store do not exist.

- [ ] **Step 2: Add the migration**

Create `packages/core/src/db/migrations/0002_request_log.sql`:

```sql
ALTER TABLE `usage` RENAME COLUMN `trace_id` TO `request_id`;

CREATE UNIQUE INDEX `usage_request_id_unique`
  ON `usage` (`request_id`);

CREATE TABLE `request_log` (
  `request_id` text PRIMARY KEY NOT NULL,
  `inbound_protocol` text NOT NULL,
  `requested_model_id` text NOT NULL,
  `outcome` text NOT NULL CHECK (`outcome` IN ('success', 'failure', 'cancelled')),
  `final_provider_id` text,
  `final_model_id` text,
  `final_status_code` integer,
  `error_code` text,
  `attempts_json` text DEFAULT '[]' NOT NULL,
  `started_at` integer NOT NULL,
  `completed_at` integer NOT NULL,
  `duration_ms` integer NOT NULL
);

CREATE INDEX `request_log_completed_at_idx`
  ON `request_log` (`completed_at`);

CREATE INDEX `request_log_outcome_completed_at_idx`
  ON `request_log` (`outcome`, `completed_at`);

INSERT INTO `request_log` (
  `request_id`,
  `inbound_protocol`,
  `requested_model_id`,
  `outcome`,
  `final_provider_id`,
  `final_model_id`,
  `attempts_json`,
  `started_at`,
  `completed_at`,
  `duration_ms`
)
SELECT
  `request_id`,
  'legacy',
  `model_id`,
  'success',
  `provider_id`,
  `model_id`,
  '[]',
  `created_at`,
  `created_at`,
  0
FROM `usage`;
```

The backfill keeps already-created development databases valid after the migration.

- [ ] **Step 3: Add typed Drizzle schemas**

Create `packages/core/src/db/schema/request-log.ts`:

```ts
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ProviderKind, ProviderProtocol, RequestOutcome } from "@aio-proxy/types";

export type RequestAttemptLog = {
  readonly index: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly providerKind: ProviderKind;
  readonly protocol?: ProviderProtocol;
  readonly outcome: "success" | "failure" | "cancelled";
  readonly statusCode?: number;
  readonly errorCode?: string;
  readonly durationMs: number;
};

export const requestLog = sqliteTable(
  "request_log",
  {
    requestId: text("request_id").primaryKey(),
    inboundProtocol: text("inbound_protocol").notNull(),
    requestedModelId: text("requested_model_id").notNull(),
    outcome: text("outcome").$type<RequestOutcome>().notNull(),
    finalProviderId: text("final_provider_id"),
    finalModelId: text("final_model_id"),
    finalStatusCode: integer("final_status_code"),
    errorCode: text("error_code"),
    attempts: text("attempts_json", { mode: "json" }).$type<RequestAttemptLog[]>().notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }).notNull(),
    durationMs: integer("duration_ms").notNull(),
  },
  (table) => [
    index("request_log_completed_at_idx").on(table.completedAt),
    index("request_log_outcome_completed_at_idx").on(table.outcome, table.completedAt),
  ],
);
```

Change `packages/core/src/db/schema/usage.ts` from `traceId`/`trace_id` to `requestId`/`request_id`, and export both schemas from `schema/index.ts`.

- [ ] **Step 4: Implement the store interface**

Create `packages/core/src/db/request-log.ts` with this public interface:

```ts
export type RequestLogInsert = typeof requestLog.$inferInsert;

export type RequestLogFinal = RequestLogInsert & {
  readonly usage?: UsageRow;
};

export type UsageOverviewQuery = {
  readonly range: UsageOverviewRange;
  readonly metric: UsageOverviewMetric;
  readonly groupBy: UsageOverviewGroupBy;
  readonly now?: Date;
};

export type RequestLogStore = {
  readonly insertFinal: (input: RequestLogFinal) => void;
  readonly overview: (query: UsageOverviewQuery) => DashboardUsageOverviewResponse;
  readonly prune: (cutoff: Date) => void;
};
```

Implement `insertFinal` as one Bun SQLite transaction: insert the request row, then insert the optional usage row with the same `requestId` and `createdAt: completedAt`.

Implement range resolution exactly as:

```ts
function resolveRange(range: UsageOverviewRange, now: Date) {
  if (range === "24h") {
    return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now, bucketUnit: "hour" as const };
  }

  const days = range === "7d" ? 7 : range === "14d" ? 14 : 30;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return { start, end: now, bucketUnit: "day" as const };
}
```

Use Drizzle `sql<number>\`...\`.mapWith(Number)` expressions for `SUM(CASE ...)`, `COUNT(*)`, token sums, and cost sums. For `24h`, aggregate by the absolute interval index `0..23` from `rangeStart`, not by a formatted local-time string. Return each hourly bucket key as the UTC ISO timestamp of its interval start; presentation formatting belongs to the Dashboard. For day ranges, use SQLite `strftime(..., 'unixepoch', 'localtime')` for server-local calendar-day grouping, but return the corresponding server-local day-start instant as a UTC ISO bucket key:

```ts
const bucket = sql<string>`strftime('%Y-%m-%d', ${requestLog.completedAt} / 1000, 'unixepoch', 'localtime')`;
```

An hourly key may look like `2026-11-01T05:30:00.000Z`; after a DST rollback the following absolute-hour key is the next unique instant. Add a regression test under a DST-observing timezone proving the response still has 24 unique buckets and chart totals equal summary totals. The Dashboard formats the ISO key with `date-fns`, including a numeric UTC offset in hourly labels so repeated local wall-clock hours remain distinguishable.

Calculate:

```ts
const elapsedMinutes = Math.max(1, (end.getTime() - start.getTime()) / 60_000);
const successRate = successCount + failureCount === 0 ? null : successCount / (successCount + failureCount);
const pricingCoverage = usageRequestCount === 0 ? null : pricedRequestCount / usageRequestCount;
const totalTokens = inputTokens + outputTokens;
const averageRpm = requestCount / elapsedMinutes;
const averageTpm = totalTokens / elapsedMinutes;
```

For request chart rows, successful requests use `finalModelId` or `finalProviderId`; terminal failures use `__failed__`; cancelled requests use `__cancelled__`. For cost/token rows, join `usage.requestId = requestLog.requestId`, filter successful request rows, and group by final model/provider. Rank dimension totals over the full selected range, retain five, fold the rest into `__other__`, and append pinned Failed/Cancelled series after normal series.

Generate the complete ordered bucket sequence for the selected range and zero-fill missing bucket/series pairs before returning the response. The chart must always receive 24 hourly buckets for `24h` and one bucket per server-local calendar day for `7d`, `14d`, or `30d`, even when no rows exist.

Implement pruning in one transaction:

```ts
db.delete(usage).where(lt(usage.createdAt, cutoff)).run();
db.delete(requestLog).where(lt(requestLog.completedAt, cutoff)).run();
```

- [ ] **Step 5: Remove the shallow usage-ledger module**

Move the existing usage insert/read assertions into `request-log.test.ts`, delete `packages/core/src/db/usage-ledger.ts` and `packages/core/_test/usage-ledger.test.ts`, and stop exporting their types. `RequestLogStore.insertFinal()` is the only persistence interface for terminal request metadata plus optional successful usage. Export `createRequestLogStore`, request-log types, and both schemas from `packages/core/src/db/index.ts`.

- [ ] **Step 6: Run persistence tests**

```bash
TZ=Asia/Shanghai rtk bun test packages/core/_test/request-log.test.ts
rtk bun run --filter @aio-proxy/core build
```

Expected: all tests pass and the migration manifest rebuild includes `0002_request_log.sql`.

- [ ] **Step 7: Commit persistence**

```bash
rtk git add packages/core/src/db packages/core/_test/request-log.test.ts packages/core/_test/usage-ledger.test.ts
rtk git commit -m "feat(core): add request overview ledger" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Build The Deep Request-Observability Module

**Files:**
- Create: `packages/server/src/usage-capture.ts`
- Create: `packages/server/src/request-recorder.ts`
- Delete: `packages/server/src/usage-recorder.ts`
- Modify: `packages/server/src/runtime.ts`
- Modify: `packages/server/src/server-state.ts`
- Create: `packages/server/_test/request-recorder.test.ts`
- Modify: `packages/server/_test/usage-recorder.test.ts` (rename coverage into the new test, then delete the old file)

**Interfaces:**
- Produces: capture-only wrappers that preserve response/stream bytes and return terminal completion promises.
- Produces: `RequestRecorder.begin()` returning one request session with `attempt()`, `finish()`, and `finishFrom()`.
- Hides: price lookup, usage normalization, attempt ordering, insert-once guards, retention throttling, and accounting error swallowing.

- [ ] **Step 1: Write failing lifecycle tests**

Create `packages/server/_test/request-recorder.test.ts` covering:

```ts
test("records one request with failed fallback and one successful final usage row", async () => {
  const handle = openDb({ home: tempHome() });
  const recorder = createRequestRecorder({
    store: createRequestLogStore(handle.db),
    now: () => new Date("2026-07-11T08:00:00.000Z"),
  });
  const request = recorder.begin({
    inboundProtocol: "openai-compatible",
    requestedModelId: "mini",
  });

  request.attempt({
    providerId: "primary",
    modelId: "gpt-5",
    providerKind: ProviderKind.Api,
    protocol: ProviderProtocol.OpenAICompatible,
    outcome: "failure",
    statusCode: 429,
    durationMs: 10,
  });

  request.finish({
    outcome: "success",
    finalProviderId: "backup",
    finalModelId: "openai/gpt-5",
    finalStatusCode: 200,
    attempt: {
      providerId: "backup",
      modelId: "openai/gpt-5",
      providerKind: ProviderKind.Api,
      protocol: ProviderProtocol.OpenAICompatible,
      outcome: "success",
      statusCode: 200,
      durationMs: 20,
    },
    usage: {
      providerId: "backup",
      modelId: "openai/gpt-5",
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
    },
  });

  expect(handle.db.select().from(requestLog).all()).toEqual([
    expect.objectContaining({
      outcome: "success",
      finalProviderId: "backup",
      finalModelId: "openai/gpt-5",
      attempts: [
        expect.objectContaining({ providerId: "primary", providerKind: ProviderKind.Api, outcome: "failure" }),
        expect.objectContaining({ providerId: "backup", providerKind: ProviderKind.Api, outcome: "success" }),
      ],
    }),
  ]);
  expect(handle.db.select().from(usage).all()).toEqual([
    expect.objectContaining({ requestId: request.requestId, inputTokens: 4, outputTokens: 6 }),
  ]);
});
```

Add tests proving: a failed request inserts no usage; cancelled requests insert no usage; a stream that sends data then errors is failure; a stream without a `finish` part is failure; a normal finish is success; persistence/pricing failures never alter the returned stream/response; and calling `finish()` twice inserts once.

Before implementation, also add focused failing regression tests proving:

- OpenAI Responses SSE reads usage from the nested `response.usage` object.
- SSE event parsing accepts CRLF (`\r\n`) framing as well as LF framing.
- Empty or unparseable usage objects do not create successful usage rows.
- Raw OpenAI, Anthropic, and Gemini passthrough capture preserves cache-token and reasoning-token dimensions needed by pricing, while TPM remains input plus output tokens only.

Run each focused regression test before changing production code and record the expected RED output in the task report.

Run:

```bash
rtk bun test packages/server/_test/request-recorder.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 2: Implement capture-only usage helpers**

Create `packages/server/src/usage-capture.ts` with:

```ts
export type UsageCompletion =
  | { readonly outcome: "success"; readonly usage?: UsageRow; readonly statusCode?: number }
  | { readonly outcome: "failure"; readonly statusCode?: number; readonly errorCode?: string }
  | { readonly outcome: "cancelled" };

export type Captured<T> = {
  readonly value: T;
  readonly completion: Promise<UsageCompletion>;
};

export type UsageCapture = {
  readonly stream: (options: StreamUsageOptions) => Captured<ReadableStream<TextStreamPart<ToolSet>>>;
  readonly passthrough: (options: PassthroughUsageOptions) => Captured<Response>;
};
```

Move AI SDK normalization and passthrough parsing from `usage-recorder.ts` into this module. The stream wrapper resolves `success` only after a `finish` part followed by normal stream close; resolves `cancelled` on abort/cancel; resolves `failure` on error or close without finish. The passthrough wrapper treats status `200 <= status < 400` as success, returns every other status as immediate failure, tees successful bodies unchanged, and resolves after the tracing branch completes.

The passthrough parsers must read OpenAI Responses usage from `response.usage`, accept both LF and CRLF SSE framing, ignore empty or unparseable usage objects instead of emitting usage, and retain the raw OpenAI/Anthropic/Gemini cache and reasoning dimensions used by cost calculation.

Price captured usage before resolving success. A missing price returns usage without `priceModelId`/`estimatedCostUsd`. Do not write the database from this module.

- [ ] **Step 3: Implement the request recorder interface**

Create `packages/server/src/request-recorder.ts`:

```ts
export type RequestRecorder = {
  readonly begin: (input: {
    readonly inboundProtocol: string;
    readonly requestedModelId: string;
  }) => RequestSession;
};

export type RequestAttemptInput = Omit<RequestAttemptLog, "index">;

export type RequestFinishInput = {
  readonly outcome: RequestOutcome;
  readonly attempt?: RequestAttemptInput;
  readonly finalProviderId?: string;
  readonly finalModelId?: string;
  readonly finalStatusCode?: number;
  readonly errorCode?: string;
  readonly usage?: UsageRow;
};

export type RequestSession = {
  readonly requestId: string;
  readonly attempt: (input: RequestAttemptInput) => void;
  readonly finish: (input: RequestFinishInput) => void;
  readonly finishFrom: (
    attempt: Omit<RequestAttemptInput, "outcome" | "statusCode" | "errorCode">,
    completion: Promise<UsageCompletion>,
  ) => void;
};
```

`begin()` captures `startedAt`, returns a session with a monotonically increasing attempt index, and guards terminal insertion with one `finished` boolean. `finishFrom()` maps completion to a final attempt and calls `finish()`. Only successful completion passes usage to `RequestLogStore.insertFinal`.

Inject `now: () => Date` for tests. Swallow store/pricing errors after optional internal logging. Trigger `store.prune(new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000))` at construction and no more than once per 24 hours afterward.

- [ ] **Step 4: Wire server state through one seam**

Replace `ProviderRouteSource.usageRecorder` with:

```ts
export type ProviderRouteSource = {
  readonly currentProviderSnapshot: () => ProviderRouteSnapshot;
  readonly requestRecorder: RequestRecorder;
  readonly usageCapture: UsageCapture;
};
```

In `createServerState`, create `RequestLogStore`, `UsageCapture`, then `RequestRecorder`; expose all three only where needed. Keep the store on `ServerState` as `requestLog` for the Dashboard route.

- [ ] **Step 5: Run lifecycle tests**

```bash
rtk bun test packages/server/_test/request-recorder.test.ts packages/server/_test/passthrough-usage.test.ts
rtk bun run --filter @aio-proxy/server build
```

Expected: PASS.

- [ ] **Step 6: Commit the observability module**

```bash
rtk git add packages/server/src/usage-capture.ts packages/server/src/request-recorder.ts packages/server/src/runtime.ts packages/server/src/server-state.ts packages/server/_test/request-recorder.test.ts packages/server/_test/passthrough-usage.test.ts packages/server/src/usage-recorder.ts packages/server/_test/usage-recorder.test.ts
rtk git commit -m "feat(server): record terminal model requests" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Integrate Request Sessions Into All Protocol Routes

**Files:**
- Modify: `packages/server/src/routes/openai-completions.ts`
- Modify: `packages/server/src/routes/openai-responses.ts`
- Modify: `packages/server/src/routes/anthropic-messages.ts`
- Modify: `packages/server/src/routes/gemini-generate-content.ts`
- Modify: corresponding files under `packages/server/_test/`

**Interfaces:**
- Consumes: `RequestRecorder.begin()`, `RequestSession.attempt()/finish()/finishFrom()`, and `UsageCapture`.
- Produces: one terminal request row per routed request with ordered fallback attempts.

- [ ] **Step 1: Extend route tests before integration**

For each protocol test file, use an isolated `dbHome`, open the same database after the response completes, and inspect `handle.db.select().from(requestLog).all()` plus `handle.db.select().from(usage).all()`. Add one success test asserting the inbound protocol, requested model, final provider/model, and one attempt. Extend one fallback test per protocol to assert two ordered attempts but one request row. Add a streaming test where the stream emits a text delta and then errors; assert outcome `failure`, not `success`.

Run:

```bash
rtk bun test packages/server/_test/openai-completions.test.ts packages/server/_test/openai-responses.test.ts packages/server/_test/anthropic-messages.test.ts packages/server/_test/gemini-generate-content.test.ts
```

Expected: FAIL because routes do not start request sessions.

- [ ] **Step 2: Start observations only after the routing boundary**

In each route, create the session after request parsing, feature validation, and `resolveCandidates()` succeed, immediately before the candidate loop:

```ts
const requestSession = source.requestRecorder.begin({
  inboundProtocol: ProviderProtocol.OpenAICompatible,
  requestedModelId: request.model,
});
```

Use these exact inbound values:

- OpenAI Completions: `ProviderProtocol.OpenAICompatible`, `request.model`
- OpenAI Responses: `ProviderProtocol.OpenAIResponse`, `request.model`
- Anthropic Messages: `ProviderProtocol.Anthropic`, `request.model`
- Gemini generateContent: `ProviderProtocol.Gemini`, `target.model`

- [ ] **Step 3: Record fallback attempts without finalizing**

Capture `const attemptStartedAt = performance.now()` at the top of each candidate loop. When a passthrough response is retryable or a caught provider/stream error will continue to the next candidate, call:

```ts
requestSession.attempt({
  providerId: provider.id,
  modelId: route.modelId,
  providerKind: provider.kind,
  ...(provider.kind === ProviderKind.Api ? { protocol: provider.protocol } : {}),
  outcome: "failure",
  ...(response === undefined ? {} : { statusCode: response.status }),
  ...(errorCode === undefined ? {} : { errorCode }),
  durationMs: Math.max(0, Math.round(performance.now() - attemptStartedAt)),
});
```

Do not pass failed-attempt usage to the request recorder.

- [ ] **Step 4: Finalize raw passthrough attempts**

After deciding not to fallback:

```ts
const captured = source.usageCapture.passthrough({
  response,
  protocol: provider.protocol,
  providerId: provider.id,
  modelId: route.modelId,
});

requestSession.finishFrom(
  {
    providerId: provider.id,
    modelId: route.modelId,
    providerKind: provider.kind,
    protocol: provider.protocol,
    durationMs: Math.max(0, Math.round(performance.now() - attemptStartedAt)),
  },
  captured.completion,
);

return captured.value;
```

For a final non-success response, call `finish({ outcome: "failure", ... })` immediately and return the original response; do not parse usage.

- [ ] **Step 5: Finalize AI SDK attempts**

Wrap the provider stream with `source.usageCapture.stream(...)`. Preserve existing `preflightStream` behavior. Attach `finishFrom()` only after preflight succeeds for streaming routes. For non-stream writers, consume the captured stream first; after the writer and `captured.completion` both resolve successfully, call `finish()` with the successful attempt and usage. If consumption throws and another candidate exists, record only a failed attempt and continue. If no candidate remains, finalize failure. Never attach terminal completion before the route has committed to returning that candidate.

Classify `AbortError` caused by the inbound request signal as `cancelled`; all other terminal provider/stream errors are `failure`. Keep existing protocol-specific client error envelopes and fallback decisions unchanged.

- [ ] **Step 6: Run all route tests**

```bash
rtk bun test packages/server/_test/openai-completions.test.ts packages/server/_test/openai-responses.test.ts packages/server/_test/anthropic-messages.test.ts packages/server/_test/gemini-generate-content.test.ts packages/server/_test/request-recorder.test.ts
```

Expected: PASS, including stream-after-headers failures recorded as failure.

- [ ] **Step 7: Commit route integration**

```bash
rtk git add packages/server/src/routes packages/server/_test/openai-completions.test.ts packages/server/_test/openai-responses.test.ts packages/server/_test/anthropic-messages.test.ts packages/server/_test/gemini-generate-content.test.ts
rtk git commit -m "feat(server): observe routed request outcomes" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Replace The Dashboard Usage Endpoint

**Files:**
- Modify: `packages/server/src/dashboard-routes/config.ts`
- Modify: `packages/server/src/server-state.ts`
- Rewrite: `packages/server/_test/usage-dashboard.test.ts`

**Interfaces:**
- Produces: `GET /dashboard/api/usage?range=24h&metric=cost&groupBy=model`.
- Consumes: `RequestLogStore.overview()`.

- [ ] **Step 1: Write failing endpoint tests**

Rewrite `usage-dashboard.test.ts` to seed request/usage rows through `RequestLogStore`, then assert:

```ts
const response = await app.request(
  "/dashboard/api/usage?range=24h&metric=requests&groupBy=provider",
);

expect(response.status).toBe(200);
expect(await response.json()).toEqual({
  range: "24h",
  metric: "requests",
  groupBy: "provider",
  rangeStart: expect.any(String),
  rangeEnd: expect.any(String),
  bucketUnit: "hour",
  summary: expect.objectContaining({
    requestCount: 3,
    successCount: 1,
    failureCount: 1,
    cancelledCount: 1,
    successRate: 0.5,
  }),
  series: expect.arrayContaining([
    expect.objectContaining({ key: "openrouter" }),
    expect.objectContaining({ key: "__failed__", kind: "failed" }),
    expect.objectContaining({ key: "__cancelled__", kind: "cancelled" }),
  ]),
  buckets: expect.any(Array),
});
```

Also assert invalid `range`, `metric`, or `groupBy` returns 400 rather than silently defaulting.

Run:

```bash
rtk bun test packages/server/_test/usage-dashboard.test.ts
```

Expected: FAIL against the old `limit` endpoint.

- [ ] **Step 2: Add strict query validation**

In `config.ts` define:

```ts
const UsageOverviewQuerySchema = z.object({
  range: UsageOverviewRangeSchema.default("24h"),
  metric: UsageOverviewMetricSchema.default("cost"),
  groupBy: UsageOverviewGroupBySchema.default("model"),
});

const usageOverviewValidator = validator("query", (raw, context) => {
  const parsed = UsageOverviewQuerySchema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : context.json({ error: "validation failed", details: parsed.error.issues }, 400);
});
```

Replace the old route with:

```ts
.get("/usage", usageOverviewValidator, (context) => {
  const query = context.req.valid("query");
  return context.json(state.requestLog.overview(query));
})
```

Remove `usageLimit()` and the old list/summary response.

- [ ] **Step 3: Run endpoint tests and type build**

```bash
rtk bun test packages/server/_test/usage-dashboard.test.ts
rtk bun run --filter @aio-proxy/server build
```

Expected: PASS.

- [ ] **Step 4: Commit the endpoint**

```bash
rtk git add packages/server/src/dashboard-routes/config.ts packages/server/src/server-state.ts packages/server/_test/usage-dashboard.test.ts
rtk git commit -m "feat(server): expose usage overview metrics" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 6: Move Usage Into The Dashboard Home

**Files:**
- Delete: `packages/dashboard/src/routes/usage.tsx`
- Delete: `packages/dashboard/src/modules/usage/templates/usage-page.tsx`
- Create: `packages/dashboard/src/modules/usage/components/usage-summary-grid.tsx`
- Delete: `packages/dashboard/src/modules/usage/components/usage-overview-controls.tsx`
- Create: `packages/dashboard/src/modules/usage/components/usage-range-tabs.tsx`
- Create: `packages/dashboard/src/modules/usage/components/usage-trend-tabs.tsx`
- Create: `packages/dashboard/src/modules/usage/components/usage-trend-chart.tsx`
- Create: `packages/dashboard/src/modules/usage/templates/usage-overview.tsx`
- Create: `packages/dashboard/src/modules/usage/stores/usage-overview-filters.ts`
- Add through shadcn CLI: `packages/dashboard/src/components/ui/tabs.tsx`
- Modify: `packages/dashboard/src/modules/usage/services/usage-service.ts`
- Modify: `packages/dashboard/src/modules/usage/hooks/use-usage-query.ts`
- Modify: `packages/dashboard/src/routes/index.tsx`
- Modify: `packages/dashboard/src/components/side-menu/side-menu.tsx`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Modify: `packages/dashboard/package.json`
- Modify: `bun.lock`
- Create: `packages/dashboard/_test/usage-overview.test.ts`
- Generated by build: `packages/dashboard/src/route-tree.gen.ts`

**Interfaces:**
- Consumes: the typed overview endpoint from Task 5.
- Produces: `usageOverviewFiltersAtom`, the single Jotai source of truth for range/metric/grouping, plus one responsive overview.

- [ ] **Step 1: Write failing Dashboard tests**

Create `packages/dashboard/_test/usage-overview.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createStore } from "jotai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { usageQueryOptions } from "../src/modules/usage/services/usage-service";
import { usageOverviewFiltersAtom } from "../src/modules/usage/stores/usage-overview-filters";

const dashboardRoot = join(import.meta.dir, "../src");

describe("usage overview query", () => {
  test("keys cache and polling by all selected controls", () => {
    const options = usageQueryOptions({ range: "7d", metric: "tokens", groupBy: "provider" });

    expect(options.queryKey).toEqual(["dashboard", "usage", "7d", "tokens", "provider"]);
    expect(options.refetchInterval).toBe(60_000);
    expect(options.refetchIntervalInBackground).toBe(false);
  });

  test("renders usage on the root route without a standalone usage navigation item", () => {
    const indexRoute = readFileSync(join(dashboardRoot, "routes/index.tsx"), "utf8");
    const sideMenu = readFileSync(join(dashboardRoot, "components/side-menu/side-menu.tsx"), "utf8");

    expect(indexRoute).toContain("<UsageOverview />");
    expect(existsSync(join(dashboardRoot, "routes/usage.tsx"))).toBe(false);
    expect(sideMenu).not.toContain('to: "/usage"');
  });

  test("stores all overview filters in one Jotai atom", () => {
    const store = createStore();

    expect(store.get(usageOverviewFiltersAtom)).toEqual({ range: "24h", metric: "cost", groupBy: "model" });
    store.set(usageOverviewFiltersAtom, (current) => ({ ...current, metric: "requests", groupBy: "provider" }));
    expect(store.get(usageOverviewFiltersAtom)).toEqual({ range: "24h", metric: "requests", groupBy: "provider" });
  });

  test("uses range tabs globally and metric/grouping tabs inside the chart", () => {
    const overview = readFileSync(join(dashboardRoot, "modules/usage/templates/usage-overview.tsx"), "utf8");
    const chart = readFileSync(join(dashboardRoot, "modules/usage/components/usage-trend-chart.tsx"), "utf8");

    expect(overview).toContain("<UsageRangeTabs />");
    expect(chart).toContain("<UsageTrendTabs />");
    expect(overview).not.toContain("<Select");
  });
});
```

Run:

```bash
rtk bun test packages/dashboard/_test/usage-overview.test.ts
```

Expected: FAIL against the old service and route structure.

- [ ] **Step 2: Replace the usage service query**

Define:

```ts
export type UsageQueryInput = {
  readonly range: UsageOverviewRange;
  readonly metric: UsageOverviewMetric;
  readonly groupBy: UsageOverviewGroupBy;
};

export const usageQueryOptions = (input: UsageQueryInput) =>
  queryOptions({
    queryKey: ["dashboard", "usage", input.range, input.metric, input.groupBy],
    queryFn: () => getUsage(input),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
```

Call the typed Hono client with exact query strings. Keep the existing typed request error for non-2xx responses. `useUsageQuery(input)` remains the only hook and calls `useQuery(usageQueryOptions(input))`.

- [ ] **Step 3: Add Jotai filter state and scoped Tabs controls**

Add `jotai` as a direct Dashboard dependency. Define one primitive atom in `stores/usage-overview-filters.ts`:

```ts
export type UsageOverviewFilters = {
  readonly range: UsageOverviewRange;
  readonly metric: UsageOverviewMetric;
  readonly groupBy: UsageOverviewGroupBy;
};

export const usageOverviewFiltersAtom = atom<UsageOverviewFilters>({
  range: "24h",
  metric: "cost",
  groupBy: "model",
});
```

Install the Base UI-backed shadcn Tabs component through the shadcn CLI; do not hand-edit `components/ui`. Create `UsageRangeTabs` above the summary cards. It reads and updates only `filters.range` through Jotai, and renders exactly `24h/7d/14d/30d` in one horizontally scrollable segmented tab list.

Create `UsageTrendTabs` for the chart header. It renders two independent segmented tab lists: metric (`cost/tokens/requests`) and group-by (`model/provider`). It reads the atom with `useAtomValue` and updates only the changed field with `useSetAtom`.

All visible labels and ARIA labels come from i18n. Tabs use the shared semantic surfaces, a white/card active pill, muted inactive text, and restrained focus styling matching the approved Base UI reference. They stay on one line and scroll horizontally on narrow screens; never fall back to a Select. Because these controls are immediate filters rather than submitted fields, they do not use TanStack Form.

- [ ] **Step 4: Add the six-card summary grid**

Create one `UsageSummaryGrid` component. Render six shadcn Cards in a responsive `md:grid-cols-2 xl:grid-cols-3` grid:

1. Known estimated cost, with pricing coverage text or `N/A` when coverage is null.
2. Requests, with success/failure/cancelled counts in the description.
3. Tokens, displaying input + output and both subtotals.
4. Average RPM.
5. Average TPM.
6. Success rate, displaying `N/A` when the denominator is empty.

Do not use `text-primary` on decorative icons; use semantic muted foreground styling. Use the shared Card title typography without overriding it to `text-sm`.

- [ ] **Step 5: Add the stacked chart**

Use existing `ChartContainer`, `ChartTooltip`, `ChartTooltipContent`, `ChartLegend`, and `ChartLegendContent` from `components/ui/chart.tsx`, plus Recharts `AreaChart`, `Area`, `CartesianGrid`, `XAxis`, and `YAxis`.

Place `<UsageTrendTabs />` in the chart header beside/below the translated chart title and description. Metric and group-by are chart-scoped controls and must not appear in the global range-control row.

Derive labels in the Dashboard so special series remain translated:

```ts
const seriesLabel = (series: DashboardUsageSeries) => {
  if (series.kind === "dimension") return series.key;
  if (series.kind === "other") return m["dashboard.usage.series_other"]();
  if (series.kind === "failed") return m["dashboard.usage.series_failed"]();
  return m["dashboard.usage.series_cancelled"]();
};
```

Build the `ChartContainer` config from the returned series:

```ts
const seriesColor = (series: DashboardUsageSeries, index: number) => {
  if (series.kind === "failed") return "var(--destructive)";
  if (series.kind === "cancelled") return "var(--muted-foreground)";
  if (series.kind === "other") return "var(--chart-5)";
  return `var(--chart-${(index % 5) + 1})`;
};

const chartConfig = Object.fromEntries(
  data.series.map((series, index) => [
    series.key,
    { label: seriesLabel(series), color: seriesColor(series, index) },
  ]),
) satisfies ChartConfig;
```

Render one dynamic `Area` per response series. Reserve semantic colors for special series and use chart colors only for dimensions:

```tsx
{data.series.map((series, index) => (
  <Area
    key={series.key}
    dataKey={series.key}
    name={seriesLabel(series)}
    stackId="usage"
    type="monotone"
    stroke={seriesColor(series, index)}
    fill={seriesColor(series, index)}
    fillOpacity={0.35}
  />
))}
```

Pass `chartConfig` to `<ChartContainer config={chartConfig}>` and render the `AreaChart` inside it.

Map API buckets to Recharts rows as `{ bucket: bucket.key, ...bucket.values }`. Format Y-axis and tooltip values according to the selected metric: USD for cost, compact integers for tokens/requests. Use the same `Intl.NumberFormat` options with `notation: "compact"` for both the Y-axis and tooltip token/request paths so they cannot drift. Keep the chart keyboard-accessible through Recharts 3's default accessibility layer and include a translated chart title/description outside the SVG.

Add `date-fns` as a direct Dashboard dependency and use it for bucket-axis and tooltip time formatting. Parse canonical ISO keys with `parseISO`; for hourly buckets use a format containing the numeric offset (for example `MMM d, HH:mm xxx`) so DST rollback hours remain distinguishable. Use the active locale's date-fns locale where available. Do not perform date-label formatting in the server.

- [ ] **Step 6: Assemble the overview and root route**

Create `UsageOverview` using the single Jotai filter atom:

```ts
const filters = useAtomValue(usageOverviewFiltersAtom);
const usage = useUsageQuery(filters);
```

Render `UsageRangeTabs` above every loading/error/empty/success state so range remains globally available. Render summary cards and pass the response to `UsageTrendChart`; the chart owns the placement of `UsageTrendTabs`. Do not render a recent-request table.

Replace `routes/index.tsx` with one arrow-function `React.FC` route component that renders:

```tsx
<PageContainer title={m["dashboard.menus.dashboard"]()}>
  <UsageOverview />
</PageContainer>
```

Delete `routes/usage.tsx`, delete the old `UsagePage`, and remove the Usage side-menu item/import.

- [ ] **Step 7: Add and compile translations**

Remove obsolete recent-table keys and add English/Simplified Chinese keys for:

- range, metric, and grouping labels/options
- six summary cards
- pricing coverage and `N/A`
- chart title/description/Other/Failed/Cancelled
- loading, empty, and error states

Run:

```bash
rtk bun run --filter @aio-proxy/i18n build
```

Expected: Paraglide compilation succeeds.

- [ ] **Step 8: Build to regenerate the route tree and run tests**

```bash
rtk bun test packages/dashboard/_test/usage-overview.test.ts
rtk bun run --filter @aio-proxy/dashboard build
rtk git diff --check
```

Expected: tests pass; generated route tree no longer contains `/usage`; Dashboard build succeeds.

- [ ] **Step 9: Commit the Dashboard redesign**

```bash
rtk git add packages/dashboard packages/i18n/messages/en.json packages/i18n/messages/zh-Hans.json
rtk git commit -m "feat(dashboard): move usage into overview" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 7: End-To-End Verification And PR Documentation

**Files:**
- Modify: PR description/validation notes only after local verification.

**Interfaces:**
- Verifies: request lifecycle, migration compatibility, aggregation semantics, Dashboard rendering, and generated assets.

- [ ] **Step 1: Run focused red/green regression coverage**

```bash
TZ=Asia/Shanghai rtk bun test \
  packages/core/_test/request-log.test.ts \
  packages/server/_test/request-recorder.test.ts \
  packages/server/_test/usage-dashboard.test.ts \
  packages/server/_test/openai-completions.test.ts \
  packages/server/_test/openai-responses.test.ts \
  packages/server/_test/anthropic-messages.test.ts \
  packages/server/_test/gemini-generate-content.test.ts \
  packages/dashboard/_test/usage-overview.test.ts
```

Expected: all focused tests pass with zero failures.

- [ ] **Step 2: Run repository verification**

```bash
rtk bun run check
rtk bun run build
rtk bun run test:unit
rtk git diff --check
rtk git status --short
```

Expected: check/build/test exit 0, diff check is empty, and status contains only the intended feature changes before commit (then clean after commit).

- [ ] **Step 3: Perform manual Dashboard QA**

Run the server with a temporary home and generate:

- one direct success with usage and known price
- one success without usage
- one fallback success after a failed provider attempt
- one terminal provider failure
- one client-cancelled stream
- six successful distinct models to exercise Top 5 + Other

Verify:

- `/dashboard/` has no placeholder content and no Usage side-menu item.
- Default controls are global Range `24h`, chart Metric `cost`, and chart Group by `model`.
- Range uses global segmented Tabs above the cards; Metric and Group by use segmented Tabs in the chart header, with complete tab/tabpanel associations and keyboard navigation.
- Changing any tab updates the shared Jotai filter atom and the active query key; no Select controls remain.
- 24h buckets are hourly; 7d/14d/30d buckets are server-local calendar days.
- Requests includes success/failure/cancelled; success rate excludes cancelled.
- Token/cost excludes failed attempts and successful requests without usage.
- Pricing coverage changes when an unknown model is present.
- Request chart includes Failed and Cancelled; cost/token charts do not.
- Provider/model and cost/token/request switches update the chart.
- Polling refreshes after 60 seconds and does not continue while the page is unfocused.
- Desktop and mobile layouts have no horizontal overflow or console errors.

- [ ] **Step 4: Update the PR validation section**

Record the exact successful commands and manual QA scenarios above. Remove claims about the standalone Usage page and recent ledger table.

- [ ] **Step 5: Commit final documentation if it changed**

```bash
rtk git add docs/superpowers/specs/2026-07-09-model-usage-billing-design.md
rtk git commit -m "docs(usage): record overview validation" -m "Co-authored-by: Codex <noreply@openai.com>"
```

Skip this commit when the design spec already contains the final wording and no tracked documentation changed.
