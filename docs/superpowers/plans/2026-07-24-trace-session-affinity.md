# Trace, Usage, and Session Affinity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Replace request_log and per-request usage persistence with local OpenTelemetry traces, permanent day/model usage rollups, persisted logical sessions, and Provider affinity while keeping Hono, SQLite, routing semantics, and the existing usage response contract.

**Architecture:** One process-wide OpenTelemetry SDK owns span IDs, context, lifecycle, links, events, and status. A request-scoped recorder buffers ended spans and asks one synchronous SQLite TraceStore transaction to commit the root summary, child spans, usage_daily, response-chain state, and affinity CAS. LogicalSessionStore remains the routing-facing semantic layer; TraceStore is only its SQLite persistence boundary. Dashboard list/detail APIs read root spans and span trees directly.

**Tech Stack:** Bun 1.3.14, TypeScript 7, Hono 4, Drizzle ORM 0.45, SQLite WAL, React 19, TanStack Query/Router/Table, OpenTelemetry API 1.9.1, OpenTelemetry SDK Trace Node 2.10.0, OpenTelemetry semantic conventions 1.43.0, bun:test.

## Global Constraints

- One inbound model request creates one local Trace; a logical Session groups multiple Traces.
- Existing token-count routes also produce a lightweight local Trace so request totals do not change when request_log is removed; they never establish affinity or response-chain state.
- Keep the Hono service and existing model-first candidate loop. Affinity may move one eligible Provider ID to the front; all remaining candidates retain Provider weight and configuration order.
- Store 100% of local spans. Add no Collector, OTLP exporter, upstream trace propagation, response Trace ID header, sampling, background writer, batching queue, or third-party React Trace Viewer.
- A valid inbound W3C traceparent is a Link on a new local root. Strip inbound traceparent and tracestate before raw upstream invocation.
- Root insertion and terminal persistence are synchronous and fail-open. A persistence failure changes neither the upstream attempt nor the client response.
- The terminal transaction is the only write of terminal root facts, child spans, usage_daily, successful response-chain state, and affinity refresh/rebind.
- usage_daily has primary key (local_day, model_dimension), has no Provider ID column or Provider dimension, and is retained permanently.
- A request that terminates before a model can be parsed keeps requestedModelId absent and contributes to the reserved usage model dimension "unknown"; never invent a requested model on the Trace.
- The existing GET /dashboard/api/usage contract, including model and Provider grouping, remains stable by querying completed root spans retained for 45 days.
- Use completion time for usage and usage_daily; use start time for Trace list ranges and ordering.
- Store raw normalized Session IDs up to 512 characters with a separate source. Hash response IDs before persistence.
- Session affinity key is (session_source, session_id, requested_model_id), has a sliding one-hour TTL, and uses optimistic compare-and-swap without locks or retries.
- Detailed errors and bounded wire snapshots remain LogTape-only. Trace storage keeps error type, error code, HTTP status, and correlation IDs, but no request/response body, exception message, or stack.
- Keep source and test files at or below 300 lines. Do not grow packages/server/src/routes/pipeline/attempt.ts beyond its current size; move instrumentation mechanics into focused collaborators.
- Do not modify packages/dashboard/src/route-tree.gen.ts by hand; regenerate it through the Dashboard build.
- Do not touch the user's in-progress wire/token-count test edits unless a merge conflict makes that unavoidable.

---

### Task 1: Add the four SQLite tables without changing runtime behavior

**Files:**
- Create: packages/core/src/db/schema/trace-span.ts
- Create: packages/core/src/db/schema/usage-daily.ts
- Create: packages/core/src/db/schema/session-affinity.ts
- Create: packages/core/src/db/schema/session-response.ts
- Modify: packages/core/src/db/schema/index.ts
- Move: packages/core/_test/migrations.test.ts to packages/core/src/db/migrations/migrations.test.ts
- Modify: packages/core/src/db/migrations/migrations.test.ts
- Generate: packages/core/src/db/migrations/0001_*.sql
- Generate: packages/core/src/db/migrations/meta/0001_snapshot.json
- Generate: packages/core/src/db/migrations/meta/_journal.json
- Generate: packages/core/src/db/migrations.manifest.ts

**Interfaces:**
- Produces Drizzle tables traceSpan, usageDaily, sessionAffinity, and sessionResponse.
- Keeps requestLog and usage temporarily so each intermediate commit remains runnable. Task 10 removes them after all readers switch.
- trace_span uses composite primary key (trace_id, span_id), one partial unique root index per trace_id, unique request_id, and a cascading same-Trace parent foreign key.

- [ ] **Step 1: Move and extend the migration behavior test**

Keep the existing manifest/journal assertion, then open a temporary database and assert the deployed contract:

~~~ts
const handle = openDb({ home });
try {
  const tables = handle.sqlite
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map(({ name }) => name);
  expect(tables).toEqual(
    expect.arrayContaining(["trace_span", "usage_daily", "session_affinity", "session_response"]),
  );

  const dailyColumns = handle.sqlite
    .query<{ name: string }, []>("PRAGMA table_info(usage_daily)")
    .all()
    .map(({ name }) => name);
  expect(dailyColumns).toContain("local_day");
  expect(dailyColumns).toContain("model_dimension");
  expect(dailyColumns.some((name) => name.includes("provider"))).toBeFalse();
} finally {
  handle.close();
}
~~~

- [ ] **Step 2: Verify RED**

Run: rtk bun test packages/core/src/db/migrations/migrations.test.ts

Expected: FAIL because the four tables do not exist.

- [ ] **Step 3: Define the Trace schema**

Use typed columns for root/attempt fields and JSON only for long-tail OpenTelemetry data. The schema must include these columns:

~~~ts
export const traceSpan = sqliteTable(
  "trace_span",
  {
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").notNull(),
    parentSpanId: text("parent_span_id"),
    name: text("name").notNull(),
    kind: integer("kind").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    statusCode: integer("status_code").notNull(),
    terminationReason: text("termination_reason"),
    errorType: text("error_type"),
    errorCode: text("error_code"),

    requestId: text("request_id").unique(),
    sessionSource: text("session_source"),
    sessionId: text("session_id"),
    sessionResolvedBy: text("session_resolved_by"),
    inboundProtocol: text("inbound_protocol"),
    requestedModelId: text("requested_model_id"),
    finalProviderId: text("final_provider_id"),
    finalModelId: text("final_model_id"),
    finalHttpStatus: integer("final_http_status"),

    priceModelId: text("price_model_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    estimatedCostUsd: real("estimated_cost_usd"),

    attemptIndex: integer("attempt_index"),
    providerId: text("provider_id"),
    providerKind: text("provider_kind"),
    providerWeight: real("provider_weight"),
    modelId: text("model_id"),
    transport: text("transport"),
    sourceProtocol: text("source_protocol"),
    targetProtocol: text("target_protocol"),
    selectionReason: text("selection_reason"),

    attributes: text("attributes_json", { mode: "json" }).$type<SpanAttributesJson>().notNull(),
    events: text("events_json", { mode: "json" }).$type<SpanEventJson[]>().notNull(),
    links: text("links_json", { mode: "json" }).$type<SpanLinkJson[]>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.traceId, table.spanId] }),
    foreignKey({
      columns: [table.traceId, table.parentSpanId],
      foreignColumns: [table.traceId, table.spanId],
    }).onDelete("cascade"),
    uniqueIndex("trace_span_one_root_idx")
      .on(table.traceId)
      .where(sql.raw("parent_span_id IS NULL")),
    index("trace_span_root_started_idx").on(table.parentSpanId, table.startedAt),
    index("trace_span_root_status_started_idx").on(table.parentSpanId, table.statusCode, table.startedAt),
    index("trace_span_root_provider_started_idx").on(table.parentSpanId, table.finalProviderId, table.startedAt),
    index("trace_span_root_model_started_idx").on(table.parentSpanId, table.requestedModelId, table.finalModelId, table.startedAt),
    index("trace_span_root_protocol_started_idx").on(table.parentSpanId, table.inboundProtocol, table.startedAt),
    index("trace_span_root_session_started_idx").on(
      table.parentSpanId,
      table.sessionSource,
      table.sessionId,
      table.requestedModelId,
      table.startedAt,
    ),
    index("trace_span_trace_started_idx").on(table.traceId, table.startedAt),
  ],
);
~~~

Define SpanAttributesJson, SpanEventJson, and SpanLinkJson next to the table. Store event/link timestamps as epoch milliseconds and link trace/span IDs as lowercase hex.

- [ ] **Step 4: Define permanent usage and Session state**

usageDaily must contain exactly the day/model key and additive counters:

~~~ts
export const usageDaily = sqliteTable(
  "usage_daily",
  {
    localDay: text("local_day").notNull(),
    modelDimension: text("model_dimension").notNull(),
    requestCount: integer("request_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    cancelledCount: integer("cancelled_count").notNull().default(0),
    interruptedCount: integer("interrupted_count").notNull().default(0),
    usageRequestCount: integer("usage_request_count").notNull().default(0),
    pricedRequestCount: integer("priced_request_count").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    estimatedCostUsd: real("estimated_cost_usd").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.localDay, table.modelDimension] })],
);
~~~

Use these exact Session tables; the expiry indexes are only for pruning:

~~~ts
export const sessionAffinity = sqliteTable(
  "session_affinity",
  {
    sessionSource: text("session_source").notNull(),
    sessionId: text("session_id").notNull(),
    requestedModelId: text("requested_model_id").notNull(),
    providerId: text("provider_id").notNull(),
    revision: integer("revision").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionSource, table.sessionId, table.requestedModelId] }),
    index("session_affinity_expires_idx").on(table.expiresAt),
  ],
);

export const sessionResponse = sqliteTable(
  "session_response",
  {
    responseIdSha256: text("response_id_sha256").primaryKey(),
    sessionSource: text("session_source").notNull(),
    sessionId: text("session_id").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("session_response_expires_idx").on(table.expiresAt)],
);
~~~

- [ ] **Step 5: Generate and verify the migration**

Run:

~~~bash
rtk bun run build:migrations
rtk bun test packages/core/src/db/migrations/migrations.test.ts
rtk bun run --filter @aio-proxy/core test:unit
~~~

Expected: migration generation reports two migrations; both test commands PASS.

- [ ] **Step 6: Commit**

~~~bash
rtk git add packages/core/src/db/schema packages/core/src/db/migrations packages/core/src/db/migrations.manifest.ts packages/core/src/db/migrations/migrations.test.ts packages/core/_test/migrations.test.ts
rtk git commit -m "feat(core): add trace persistence schema" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

---

### Task 2: Implement the atomic SQLite TraceStore

**Files:**
- Modify: packages/types/src/trace.ts
- Create: packages/core/src/db/trace-store/index.ts
- Create: packages/core/src/db/trace-store/types.ts
- Create: packages/core/src/db/trace-store/span-projection/index.ts
- Create: packages/core/src/db/trace-store/span-projection/span-projection.ts
- Create: packages/core/src/db/trace-store/span-projection/span-projection.test.ts
- Create: packages/core/src/db/trace-store/trace-store.ts
- Create: packages/core/src/db/trace-store/trace-lifecycle.ts
- Create: packages/core/src/db/trace-store/trace-queries.ts
- Create: packages/core/src/db/trace-store/session-state/index.ts
- Create: packages/core/src/db/trace-store/session-state/session-state.ts
- Create: packages/core/src/db/trace-store/session-state/session-state.test.ts
- Create: packages/core/src/db/trace-store/usage-overview/index.ts
- Create: packages/core/src/db/trace-store/usage-overview/usage-overview.ts
- Create: packages/core/src/db/trace-store/test-support.ts
- Create: packages/core/src/db/trace-store/trace-store.test.ts
- Create: packages/core/src/db/trace-store/usage-overview/usage-overview.test.ts
- Modify: packages/core/src/db/index.ts

**Interfaces:**
- Produces createTraceStore(db): TraceStore.
- Produces synchronous startRoot, complete, list, find, overview, resolveResponse, findAffinity, recover, and prune methods.
- complete returns true only for the first running-to-terminal transition. A repeated call is a no-op and cannot increment usage_daily or Session state twice.
- trace-store.ts only assembles the public object; trace-lifecycle.ts owns root/terminal/recovery/pruning writes, trace-queries.ts owns list/detail reads, and session-state/session-state.ts owns response/affinity reads plus transaction helpers. These are plain functions, not another interface or class layer.

- [ ] **Step 1: Write failing store lifecycle tests**

Use a fixed root and two child spans. Protect four behaviors in one focused suite:

~~~ts
const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
store.startRoot(rootStart);
expect(store.find(traceId)?.trace.endedAt).toBeNull();

expect(store.complete(completion)).toBeTrue();
expect(store.complete(completion)).toBeFalse();

expect(store.find(traceId)).toMatchObject({
  trace: {
    traceId,
    requestId: "request-a",
    finalProviderId: "provider-b",
    finalModelId: "model-b",
  },
  spans: [
    { name: "aio_proxy.request" },
    { name: "aio_proxy.provider.attempt" },
    { name: "gen_ai.client.inference" },
  ],
});

expect(db.select().from(usageDaily).all()).toEqual([
  expect.objectContaining({
    localDay: "2026-07-24",
    modelDimension: "model-b",
    requestCount: 1,
    successCount: 1,
    inputTokens: 10,
    outputTokens: 5,
  }),
]);
~~~

Also make a child insert violate the parent foreign key and assert that the root remains running, no child remains, and usage_daily is unchanged. This proves terminal atomicity rather than individual inserts. Add one mismatched UsageRow Provider/model case and one sessionState-without-session case; each must throw before changing the root or counters.

In span-projection/span-projection.test.ts, persist one root and one attempt with every controlled typed attribute plus one allowed long-tail attribute. Assert the raw attributes_json contains only the long-tail key, while find() reconstructs every controlled attribute exactly once with its original number/string value.

In session-state/session-state.test.ts, cover hashed response persistence/sliding expiry, expired response rejection, two long response IDs with the same first 512 characters remaining distinct, concurrent missing-binding first-wins, matching-revision refresh, fallback rebind, expired-row rebind, and CAS loss without retry.

- [ ] **Step 2: Verify RED**

Run:

~~~bash
rtk bun test packages/core/src/db/trace-store/trace-store.test.ts
rtk bun test packages/core/src/db/trace-store/span-projection/span-projection.test.ts
rtk bun test packages/core/src/db/trace-store/session-state/session-state.test.ts
~~~

Expected: all three commands FAIL because createTraceStore, projection, and Session persistence do not exist.

- [ ] **Step 3: Define the public store contract**

Keep the storage contract independent from OpenTelemetry SDK classes:

First add shared Zod DTOs in packages/types/src/trace.ts:

~~~ts
export const OtelSpanStatusCodeSchema = z.enum(["UNSET", "OK", "ERROR"]);
export const TraceTerminationReasonSchema = z.enum(["failure", "cancelled", "interrupted"]);
export const TraceSpanKindSchema = z.enum(["INTERNAL", "SERVER", "CLIENT", "PRODUCER", "CONSUMER"]);
export const DashboardTracePageSizeSchema = z.union([
  z.literal(10),
  z.literal(20),
  z.literal(50),
  z.literal(100),
]);

export const DashboardTraceSummarySchema = z.object({
  traceId: z.string().regex(/^[0-9a-f]{32}$/u),
  rootSpanId: z.string().regex(/^[0-9a-f]{16}$/u),
  requestId: z.string().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  durationMs: z.number().min(0),
  otelStatusCode: OtelSpanStatusCodeSchema,
  terminationReason: TraceTerminationReasonSchema.optional(),
  errorType: z.string().optional(),
  errorCode: z.string().optional(),
  session: z.object({ source: z.string().min(1), id: z.string().min(1) }).optional(),
  sessionResolvedBy: z.string().optional(),
  inboundProtocol: z.string().min(1),
  requestedModelId: z.string().min(1).optional(),
  finalProviderId: z.string().optional(),
  finalModelId: z.string().optional(),
  finalHttpStatus: z.number().int().optional(),
  usage: UsageRowSchema.optional(),
});

const SpanAttributeValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number().finite()),
  z.array(z.boolean()),
]);
const SpanAttributesSchema = z.record(z.string(), SpanAttributeValueSchema);

export const DashboardTraceSpanSchema = z.object({
  traceId: z.string().regex(/^[0-9a-f]{32}$/u),
  spanId: z.string().regex(/^[0-9a-f]{16}$/u),
  parentSpanId: z.string().regex(/^[0-9a-f]{16}$/u).optional(),
  name: z.string().min(1),
  kind: TraceSpanKindSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  durationMs: z.number().min(0),
  otelStatusCode: OtelSpanStatusCodeSchema,
  terminationReason: TraceTerminationReasonSchema.optional(),
  errorType: z.string().optional(),
  errorCode: z.string().optional(),
  attributes: SpanAttributesSchema,
  events: z.array(
    z.object({
      name: z.string().min(1),
      timestamp: z.string().datetime(),
      attributes: SpanAttributesSchema,
    }),
  ),
  links: z.array(
    z.object({
      traceId: z.string().regex(/^[0-9a-f]{32}$/u),
      spanId: z.string().regex(/^[0-9a-f]{16}$/u),
      attributes: SpanAttributesSchema,
    }),
  ),
});

export const DashboardTracesResponseSchema = z.object({
  items: z.array(DashboardTraceSummarySchema),
  page: z.number().int().min(1),
  pageSize: DashboardTracePageSizeSchema,
  total: z.number().int().min(0),
  pageCount: z.number().int().min(0),
});

export const DashboardTraceDetailSchema = z.object({
  trace: DashboardTraceSummarySchema,
  spans: z.array(DashboardTraceSpanSchema),
});
~~~

Export the inferred input/output types for every public schema above; DashboardTraceDetail.spans are ordered by startedAt/spanId by TraceStore rather than by the schema.

Then define the SQLite-facing contracts in packages/core/src/db/trace-store/types.ts, importing the shared Dashboard/usage/session types rather than exporting storage internals from @aio-proxy/types:

~~~ts
export type StoredSpan = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly statusCode: number;
  readonly attributes: SpanAttributesJson;
  readonly events: readonly SpanEventJson[];
  readonly links: readonly SpanLinkJson[];
};

export type SessionIdentity = {
  readonly source: LogicalSessionSource;
  readonly id: string;
};

export type SessionAffinityObservation = {
  readonly providerId: string;
  readonly revision: number;
  readonly active: boolean;
};

export type TraceRootStart = {
  readonly traceId: string;
  readonly spanId: string;
  readonly requestId: string;
  readonly inboundProtocol: string;
  readonly name: string;
  readonly kind: number;
  readonly startedAt: Date;
  readonly statusCode: number;
  readonly attributes: SpanAttributesJson;
  readonly events: readonly SpanEventJson[];
  readonly links: readonly SpanLinkJson[];
};

export type TraceTerminalSummary = {
  readonly finalProviderId?: string;
  readonly finalModelId?: string;
  readonly finalHttpStatus?: number;
  readonly terminationReason?: TraceTerminationReason;
  readonly errorType?: string;
  readonly errorCode?: string;
  readonly usage?: UsageRow;
};

export type TraceCompletion = {
  readonly traceId: string;
  readonly rootSpanId: string;
  readonly spans: readonly StoredSpan[];
  readonly summary: TraceTerminalSummary;
  readonly session?: {
    readonly identity: SessionIdentity;
    readonly requestedModelId: string;
    readonly resolvedBy: LogicalSessionSource;
  };
  readonly sessionState?: {
    readonly observedAffinity?: SessionAffinityObservation;
    readonly responseId?: string;
  };
};

export type TracesQuery = {
  readonly page: number;
  readonly pageSize: DashboardTracePageSize;
  readonly startedAfter?: Date;
  readonly startedBefore?: Date;
  readonly traceId?: string;
  readonly requestId?: string;
  readonly sessionSource?: string;
  readonly sessionId?: string;
  readonly otelStatusCode?: OtelSpanStatusCode;
  readonly terminationReason?: TraceTerminationReason;
  readonly inboundProtocol?: string;
  readonly requestedModelId?: string;
  readonly finalProviderId?: string;
  readonly finalModelId?: string;
  readonly finalHttpStatus?: number;
};

export type UsageOverviewQuery = {
  readonly range: UsageOverviewRange;
  readonly metric: UsageOverviewMetric;
  readonly groupBy: UsageOverviewGroupBy;
  readonly now?: Date;
};

export type TraceStore = {
  readonly startRoot: (input: TraceRootStart) => void;
  readonly complete: (input: TraceCompletion) => boolean;
  readonly list: (query: TracesQuery) => DashboardTracesResponse;
  readonly find: (traceId: string, now?: Date) => DashboardTraceDetail | undefined;
  readonly overview: (query: UsageOverviewQuery) => DashboardUsageOverviewResponse;
  readonly resolveResponse: (responseId: string, now: Date) => SessionIdentity | undefined;
  readonly findAffinity: (
    identity: SessionIdentity,
    requestedModelId: string,
    now: Date,
  ) => SessionAffinityObservation | undefined;
  readonly recover: (now: Date) => number;
  readonly prune: (traceCutoff: Date, sessionCutoff: Date) => void;
};
~~~

The optional session object is the single source for requestedModelId, raw Session identity, and resolvedBy; it remains absent for a parse failure that never yielded a model. sessionState is a separate opt-in mutation signal: normal model requests include it (even when observedAffinity is undefined), while token-count requests omit it so TraceStore cannot create affinity or response mappings. TraceTerminalSummary owns only terminal outcome/route/usage facts, avoiding duplicated Provider, model, or Session values inside TraceCompletion.

span-projection/span-projection.ts owns one controlled attribute map. On write it separates root/attempt/usage attributes into typed columns and leaves only long-tail keys in attributes_json. On read it merges the typed values back under the same OTel/aio_proxy attribute names. StoredSpan carries the complete SDK attribute object; no projection key is discarded before TraceStore persists it.

- [ ] **Step 4: Implement first-transition terminal semantics**

Validate before opening the transaction: the ended root IDs match traceId/rootSpanId, UsageRow Provider/model match the final route, and sessionState is absent unless session exists. These are internal invariant failures; RequestTraceRecorder's persistence guard converts them to fail-open correlated logs.

Inside one db.transaction:

1. Select the root by traceId/rootSpanId.
2. Return false if it already has ended_at.
3. If no root exists because startRoot failed, insert the terminal root from the ended root span.
4. Otherwise update the running root with terminal projection columns.
5. Insert non-root spans in parent-first order.
6. Upsert one usage_daily delta.
7. Upsert the response hash to the successful request's Session only when sessionState.responseId exists; a reused response ID follows the current last-successful-mapping behavior instead of aborting the terminal transaction.
8. Apply the affinity insert/refresh/rebind CAS only when sessionState exists and the request completed through a successful final Provider.
9. Return true after commit.

Build the delta from the completion timestamp and root summary. The exact counter rules are:

- modelDimension = summary.finalModelId ?? session?.requestedModelId ?? "unknown";
- requestCount is always 1;
- successCount is 1 only with no termination reason;
- errorCount, cancelledCount, and interruptedCount correspond only to their same-named termination states;
- usageRequestCount is 1 only when UsageRow exists, and pricedRequestCount only when estimatedCostUsd exists;
- absent token/cost values contribute zero;
- UsageRow.providerId is never copied into usage_daily.

The daily upsert must remain Provider-free:

~~~ts
tx.insert(usageDaily)
  .values(delta)
  .onConflictDoUpdate({
    target: [usageDaily.localDay, usageDaily.modelDimension],
    set: {
      requestCount: sql.raw("request_count + excluded.request_count"),
      successCount: sql.raw("success_count + excluded.success_count"),
      errorCount: sql.raw("error_count + excluded.error_count"),
      cancelledCount: sql.raw("cancelled_count + excluded.cancelled_count"),
      interruptedCount: sql.raw("interrupted_count + excluded.interrupted_count"),
      usageRequestCount: sql.raw("usage_request_count + excluded.usage_request_count"),
      pricedRequestCount: sql.raw("priced_request_count + excluded.priced_request_count"),
      inputTokens: sql.raw("input_tokens + excluded.input_tokens"),
      outputTokens: sql.raw("output_tokens + excluded.output_tokens"),
      cacheReadTokens: sql.raw("cache_read_tokens + excluded.cache_read_tokens"),
      cacheWriteTokens: sql.raw("cache_write_tokens + excluded.cache_write_tokens"),
      reasoningTokens: sql.raw("reasoning_tokens + excluded.reasoning_tokens"),
      estimatedCostUsd: sql.raw("estimated_cost_usd + excluded.estimated_cost_usd"),
    },
  })
  .run();
~~~

For response IDs, trim and reject an empty value, then hash the entire trimmed value with Bun.CryptoHasher("sha256"); do not call normalizeSessionValue because its 512-character Session-ID truncation would create prefix collisions. Use the same private hash function on insert and lookup, and never store the original response ID.

- [ ] **Step 5: Implement affinity CAS and sliding response lookup**

Use the observation captured at request start:

~~~ts
if (observed === undefined) {
  tx.insert(sessionAffinity)
    .values({ ...key, providerId, revision: 1, expiresAt, updatedAt: now })
    .onConflictDoNothing()
    .run();
} else {
  tx.update(sessionAffinity)
    .set({
      providerId,
      revision: observed.revision + 1,
      expiresAt,
      updatedAt: now,
    })
    .where(
      and(
        affinityKey(key),
        eq(sessionAffinity.revision, observed.revision),
      ),
    )
    .run();
}
~~~

findAffinity returns expired rows with active: false so a successful request can replace them by revision CAS. resolveResponse returns undefined for an expired row; for an active row one synchronous transaction updates expires_at to now plus one hour before returning the stored raw Session identity.

- [ ] **Step 6: Port short-range usage aggregation to root spans**

Move the current chart bucketing, top-five grouping, reserved-key escaping, local-day handling, and DST tests into usage-overview/usage-overview.ts. Replace request_log/usage joins with root trace_span columns:

- request time: ended_at;
- model dimension: coalesce(final_model_id, requested_model_id, 'unknown');
- Provider dimension: coalesce(final_provider_id, 'unknown');
- usage values: root input/output/cost columns;
- failureCount: termination_reason in ('failure', 'interrupted');
- cancelledCount: termination_reason = 'cancelled'.

The response DTO must remain byte-compatible with DashboardUsageOverviewResponseSchema.

- [ ] **Step 7: Add recovery, list/detail, and retention tests**

Cover:

- recover marks every running root ERROR/interrupted at the supplied completion time and increments its day/model usage_daily bucket once, using "unknown" because a minimal running root has no durable parsed model;
- list orders roots by started_at descending and supports running roots;
- list filters Trace/request/Session identity, OTel status, termination reason, protocol, requested/final model, final Provider ID, and final HTTP status;
- find returns root plus all spans ordered by started_at/span_id;
- prune deletes completed root trees older than 45 days through cascade, keeps newer/running roots, and removes expired affinity/response rows without touching usage_daily.

Implement recover as one synchronous transaction: select roots with ended_at IS NULL, update only those rows to ERROR/interrupted at now, and add their count once to the completion-day "unknown" usage_daily bucket. A second recover sees no running roots and returns zero.

- [ ] **Step 8: Verify and commit**

Run:

~~~bash
rtk bun test packages/core/src/db/trace-store
rtk bun run --filter @aio-proxy/core test:unit
~~~

Expected: both commands PASS.

~~~bash
rtk git add packages/types/src/trace.ts packages/core/src/db/trace-store packages/core/src/db/index.ts
rtk git commit -m "feat(core): persist local traces atomically" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

---

### Task 3: Make logical Sessions persistent and affinity-aware

**Files:**
- Move: packages/server/src/logical-session-store.ts to packages/server/src/logical-session-store/logical-session-store.ts
- Move: packages/server/src/logical-session-store.test.ts to packages/server/src/logical-session-store/logical-session-store.test.ts
- Create: packages/server/src/logical-session-store/index.ts
- Modify: packages/server/src/runtime.ts
- Modify: packages/server/src/server-state/index.ts
- Modify: packages/server/src/server-state/types.ts
- Modify: packages/server/src/server-log.ts
- Modify: packages/server/src/logging/bridge/bridge.ts
- Modify: packages/server/src/logging/bridge/bridge.test.ts

**Interfaces:**
- LogicalSessionStore.begin now accepts requestId and requestedModelId and returns LogicalSessionResolution.
- LogicalSessionResolution contains provider-facing LogicalRequestContext, raw Session identity, resolvedBy, and optional affinity observation.
- LogicalSessionStore reads SQLite state but never writes affinity or response chains; the terminal TraceStore transaction owns those writes.

- [ ] **Step 1: Rewrite tests around the persistent contract**

Protect precedence and restart behavior:

~~~ts
const resolution = store.begin({
  requestId: "request-a",
  requestedModelId: "gpt",
  hints: {
    candidates: [{ source: "openai-prompt-cache", value: " cache-key " }],
    previousResponseId: "resp-older",
    transcript: {},
  },
  headers: new Headers({ "x-session-id": "header-session" }),
});

expect(resolution).toMatchObject({
  identity: { source: "openai-prompt-cache", id: "cache-key" },
  resolvedBy: "openai-prompt-cache",
  context: {
    requestId: "request-a",
    session: { source: "openai-prompt-cache" },
  },
});
~~~

Close/reopen the DB after committing a successful response mapping through TraceStore, then assert previous_response_id resolves to the original source/raw ID with resolvedBy: "previous-response".

Seed an active affinity and assert it is returned. Seed an expired affinity and assert the observation remains available for CAS but has active: false.

- [ ] **Step 2: Verify RED**

Run: rtk bun test packages/server/src/logical-session-store/logical-session-store.test.ts

Expected: FAIL because begin still creates an in-memory response map and returns only LogicalRequestContext.

- [ ] **Step 3: Define the routing-facing resolution**

~~~ts
export type LogicalSessionInput = {
  readonly requestId: string;
  readonly requestedModelId: string;
  readonly hints: ProtocolSessionHints;
  readonly headers: Headers;
  readonly internalSessionId?: string;
};

export type LogicalSessionResolution = {
  readonly context: LogicalRequestContext;
  readonly identity: SessionIdentity;
  readonly resolvedBy: LogicalSessionSource;
  readonly affinity?: SessionAffinityObservation;
};

export type LogicalSessionRepository = {
  readonly resolveResponse: (responseId: string, now: Date) => SessionIdentity | undefined;
  readonly findAffinity: (
    identity: SessionIdentity,
    requestedModelId: string,
    now: Date,
  ) => SessionAffinityObservation | undefined;
};

export type LogicalSessionStoreOptions = {
  readonly repository?: LogicalSessionRepository;
  readonly logger?: ServerLogSink;
  readonly now?: () => Date;
};
~~~

Keep raw IDs out of plugin-facing LogicalRequestContext. Build its existing hash from identity.source and identity.id, and preserve the requestId generated by the Trace recorder. When repository is omitted, use a module-local no-op repository that returns undefined for both reads; production always injects TraceStore, while existing isolated route fixtures can remain persistence-free.

- [ ] **Step 4: Implement selection and fail-open reads**

Use this precedence:

1. internalSessionId;
2. protocol candidates, including openai-prompt-cache and Claude Code;
3. supported session/conversation headers;
4. persisted previous_response_id mapping;
5. generated UUID.

Normalize every selected Session identity through normalizeSessionValue. previous_response_id is a lookup key rather than a Session identity: pass its full trimmed value to resolveResponse so TraceStore applies the response hash without 512-character truncation. For a previous response, identity is the persisted original Session while resolvedBy is "previous-response".

Catch resolveResponse and findAffinity independently. Emit a structured persistence failure through the supplied ServerLogSink and continue with no mapping/affinity; never reject the request.

Add trace.persistence_failed to ServerLog and SERVER_LOG_LEVEL in this task so the intermediate commit compiles:

~~~ts
export type TracePersistenceFailedLog = {
  readonly event: "trace.persistence_failed";
  readonly operation:
    | "root_start"
    | "complete"
    | "recover"
    | "prune"
    | "resolve_response"
    | "find_affinity";
  readonly requestId?: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly errorType: string;
};
~~~

Map it to error. Task 4 uses root_start/complete/prune and Task 5 uses recover. RequestTraceRecorder supplies the root traceId/spanId explicitly for root_start and complete because root_start can fail before the root context becomes active; the bridge may add or override correlation from active context for all other in-request failures.

- [ ] **Step 5: Wire one store into ServerState**

Create TraceStore from the existing DB handle and inject its two Session read methods:

~~~ts
const logger = options.logger ?? defaultLogger;
const traceStore = createTraceStore(dbHandle.db);
const logicalSessionStore = new LogicalSessionStore({
  repository: traceStore,
  logger,
});
~~~

Expose traceStore on ServerState. Do not remove requestLog yet; the old Dashboard endpoints still need it until Tasks 7–10.

- [ ] **Step 6: Verify and commit**

Run:

~~~bash
rtk bun test packages/server/src/logical-session-store
rtk bun test packages/server/src/server-state
rtk bun run --filter @aio-proxy/server test:unit
~~~

Expected: all commands PASS.

~~~bash
rtk git add packages/server/src/logical-session-store packages/server/src/logical-session-store.ts packages/server/src/logical-session-store.test.ts packages/server/src/runtime.ts packages/server/src/server-state/index.ts packages/server/src/server-state/types.ts packages/server/src/server-log.ts packages/server/src/logging/bridge/bridge.ts packages/server/src/logging/bridge/bridge.test.ts
rtk git commit -m "feat(server): persist logical session state" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

---

### Task 4: Add the OpenTelemetry runtime and request recorder

**Files:**
- Modify: packages/server/package.json
- Modify: bun.lock
- Create: packages/server/src/request-tracing/index.ts
- Create: packages/server/src/request-tracing/semantic.ts
- Create: packages/server/src/request-tracing/buffering-span-processor/index.ts
- Create: packages/server/src/request-tracing/buffering-span-processor/buffering-span-processor.ts
- Create: packages/server/src/request-tracing/span-record.ts
- Create: packages/server/src/request-tracing/runtime.ts
- Create: packages/server/src/request-tracing/request-trace-recorder/index.ts
- Create: packages/server/src/request-tracing/request-trace-recorder/request-trace-recorder.ts
- Create: packages/server/src/request-tracing/buffering-span-processor/buffering-span-processor.test.ts
- Create: packages/server/src/request-tracing/request-trace-recorder/request-trace-recorder.test.ts

**Interfaces:**
- Produces one lazy process-wide NodeTracerProvider and Tracer.
- Produces BufferingSpanProcessor.register(traceId), take(traceId), and abandon(traceId).
- Produces RequestTraceRecorder.begin and RequestTraceSession with requestId, traceId, rootContext, identify, finish, and finishFrom.
- The processor buffers only registered local Trace IDs and never writes SQLite or exports OTLP.

~~~ts
export type TraceRuntime = {
  readonly processor: BufferingSpanProcessor;
  readonly tracer: Tracer;
};

export type RequestTraceIdentityInput = {
  readonly requestedModelId: string;
  readonly resolution: LogicalSessionResolution;
  readonly mutateSessionState: boolean;
};

type RequestTraceFinishBase = {
  readonly finalProviderId?: string;
  readonly finalModelId?: string;
  readonly finalHttpStatus?: number;
};

export type RequestTraceFinishInput =
  | (RequestTraceFinishBase & {
      readonly outcome: "success";
      readonly usage?: UsageRow;
      readonly responseId?: string;
    })
  | (RequestTraceFinishBase & {
      readonly outcome: "failure";
      readonly errorType?: string;
      readonly errorCode?: string;
      readonly usage?: never;
      readonly responseId?: never;
    })
  | (RequestTraceFinishBase & {
      readonly outcome: "cancelled";
      readonly usage?: never;
      readonly responseId?: never;
    });

export type RequestTraceSession = {
  readonly requestId: string;
  readonly traceId: string;
  readonly rootSpanId: string;
  readonly rootContext: Context;
  readonly identify: (input: RequestTraceIdentityInput) => void;
  readonly finish: (input: RequestTraceFinishInput) => boolean;
  readonly finishFrom: (completion: Promise<RequestTraceFinishInput>) => void;
};

export type RequestTraceRecorder = {
  readonly begin: (input: {
    readonly headers: Headers;
    readonly inboundProtocol: string;
    readonly operation?: "model" | "token_count";
  }) => RequestTraceSession;
};

export type RequestTraceWriteStore = Pick<TraceStore, "startRoot" | "complete" | "prune">;
~~~

createRequestTraceRecorder accepts RequestTraceWriteStore rather than the full query/session repository. identify projects resolution.identity/resolvedBy/requestedModelId into TraceCompletion.session. mutateSessionState=true creates the otherwise-empty TraceCompletion.sessionState opt-in and carries the observed affinity; token-count passes false. A second identical identify is a no-op, while a conflicting identity emits the existing recorder invariant log and keeps the first value.

- [ ] **Step 1: Add exact dependencies**

Add only to @aio-proxy/server:

~~~json
"@opentelemetry/api": "1.9.1",
"@opentelemetry/sdk-trace-node": "2.10.0",
"@opentelemetry/semantic-conventions": "1.43.0"
~~~

Run: rtk bun install

Expected: bun.lock updates without unrelated dependency upgrades.

semantic.ts defines the stable local names and imports only non-content GenAI constants from @opentelemetry/semantic-conventions/incubating:

~~~ts
export const spanName = {
  request: "aio_proxy.request",
  parse: "aio_proxy.request.parse",
  session: "aio_proxy.session.resolve",
  route: "aio_proxy.route.resolve",
  attempt: "aio_proxy.provider.attempt",
  prepare: "aio_proxy.request.prepare",
  inference: "gen_ai.client.inference",
  tokenCount: "aio_proxy.token_count",
  egress: "aio_proxy.response.egress",
  usage: "aio_proxy.usage.resolve",
} as const;

export const eventName = {
  firstUpstreamResponse: "aio_proxy.response.first_upstream",
  firstClientResponse: "aio_proxy.response.first_client",
} as const;

export const attributeName = {
  requestId: "aio_proxy.request.id",
  operation: "aio_proxy.operation",
  inboundProtocol: "aio_proxy.protocol.inbound",
  sessionSource: "aio_proxy.session.source",
  sessionId: "aio_proxy.session.id",
  sessionResolvedBy: "aio_proxy.session.resolved_by",
  finalProviderId: "aio_proxy.route.final_provider_id",
  attemptIndex: "aio_proxy.attempt.index",
  providerId: "aio_proxy.provider.id",
  providerKind: "aio_proxy.provider.kind",
  providerWeight: "aio_proxy.provider.weight",
  transport: "aio_proxy.transport",
  sourceProtocol: "aio_proxy.protocol.source",
  targetProtocol: "aio_proxy.protocol.target",
  selectionReason: "aio_proxy.route.selection_reason",
  prepareMode: "aio_proxy.prepare.mode",
  egressMode: "aio_proxy.egress.mode",
  errorCode: "aio_proxy.error.code",
  terminationReason: "aio_proxy.termination.reason",
} as const;
~~~

Use ATTR_GEN_AI_REQUEST_MODEL, ATTR_GEN_AI_RESPONSE_MODEL, ATTR_GEN_AI_USAGE_INPUT_TOKENS, ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, cache/reasoning usage constants, and stable ATTR_ERROR_TYPE. Never set prompt, completion, input-message, output-message, tool argument, or tool result attributes.

- [ ] **Step 2: Write failing processor and recorder tests**

Processor test:

~~~ts
processor.register(traceId);
child.end();
root.end();
expect(processor.take(traceId).map(({ name }) => name)).toEqual([
  "child",
  "aio_proxy.request",
]);
expect(processor.take(traceId)).toEqual([]);
~~~

Recorder tests must assert:

- startRoot is called synchronously before begin returns;
- a valid inbound traceparent is stored as one root Link while the local traceId differs;
- malformed traceparent/tracestate produces no Link and never prevents root creation;
- root remains running until finishFrom settles;
- success leaves OTel status UNSET;
- failure/cancelled set ERROR plus termination reason;
- a start or terminal DB exception emits a persistence event containing the root traceId/spanId and does not throw;
- prompt/output/tool/exception message or stack attributes are absent from the StoredSpan snapshot while controlled routing/model/usage attributes remain;
- completing the same session twice has no effect.

- [ ] **Step 3: Verify RED**

Run:

~~~bash
rtk bun test packages/server/src/request-tracing/buffering-span-processor/buffering-span-processor.test.ts
rtk bun test packages/server/src/request-tracing/request-trace-recorder/request-trace-recorder.test.ts
~~~

Expected: both commands FAIL because request-tracing does not exist.

- [ ] **Step 4: Implement the singleton OpenTelemetry runtime**

~~~ts
let runtime: TraceRuntime | undefined;

export function getTraceRuntime(): TraceRuntime {
  if (runtime !== undefined) return runtime;
  const processor = new BufferingSpanProcessor();
  const provider = new NodeTracerProvider({
    sampler: new AlwaysOnSampler(),
    spanProcessors: [processor],
  });
  provider.register();
  runtime = {
    processor,
    tracer: provider.getTracer("@aio-proxy/server", "0.0.0"),
  };
  return runtime;
}
~~~

Do not tie the singleton to a database or ServerState. This avoids competing global registrations in tests and lets each RequestTraceRecorder register only its own trace buffer.

- [ ] **Step 5: Snapshot ended SDK spans**

BufferingSpanProcessor implements the complete SpanProcessor contract: onStart is a no-op; onEnd immediately converts only registered Trace IDs; take atomically returns/removes one buffer; abandon removes it; forceFlush resolves immediately; shutdown clears every buffer and resolves. It never retains unregistered spans.

span-record.ts converts ReadableSpan into StoredSpan. Convert HrTime with:

~~~ts
const epochMilliseconds = ([seconds, nanoseconds]: HrTime) =>
  seconds * 1_000 + nanoseconds / 1_000_000;
~~~

Copy attributes/events/links immediately, but keep only the explicit attributeName values plus the imported non-content GenAI model/usage, HTTP status, and error.type constants. Sanitize event/link attributes through the same allowlist and never copy resource attributes, unknown attributes, status.message, exception message/stack, prompts, outputs, tool definitions/arguments/results, or request/response bodies. TraceStore's span-projection/span-projection.ts removes controlled keys from attributes_json while writing typed columns; the read path rebuilds the complete controlled attribute object.

- [ ] **Step 6: Implement root lifecycle and incoming Link extraction**

Use propagation.extract against ROOT_CONTEXT and Headers. Create a new SERVER root with the incoming context only in links:

~~~ts
const extracted = propagation.extract(ROOT_CONTEXT, headers, {
  get: (carrier, key) => carrier.get(key) ?? undefined,
  keys: (carrier) => [...carrier.keys()],
});
const incoming = trace.getSpanContext(extracted);
const root = tracer.startSpan(
  "aio_proxy.request",
  {
    kind: SpanKind.SERVER,
    links: incoming !== undefined && isSpanContextValid(incoming) ? [{ context: incoming }] : [],
    attributes: {
      "aio_proxy.request.id": requestId,
      "aio_proxy.protocol.inbound": inboundProtocol,
      "aio_proxy.operation": operation ?? "model",
    },
  },
  ROOT_CONTEXT,
);
const rootContext = trace.setSpan(ROOT_CONTEXT, root);
~~~

Register the trace buffer before any child work, then call store.startRoot inside a fail-open guard. Pass the root traceId/spanId explicitly to persistence-failure logs; do not assume begin is already running inside rootContext.

At terminal:

1. derive final Provider/model from explicit fields or successful UsageRow, then set root summary/usage/error attributes;
2. set ERROR only for failure/cancelled;
3. end the root;
4. take buffered spans;
5. call TraceStore.complete once;
6. abandon the buffer in finally.

Run prune at startup and at most once per 24 hours, using a 45-day Trace cutoff and current time for expired Session rows.

- [ ] **Step 7: Verify and commit**

Run:

~~~bash
rtk bun test packages/server/src/request-tracing
rtk bun run --filter @aio-proxy/server test:unit
~~~

Expected: both commands PASS.

~~~bash
rtk git add packages/server/package.json bun.lock packages/server/src/request-tracing
rtk git commit -m "feat(server): record request traces with opentelemetry" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

---

### Task 5: Instrument the Pipeline and apply Provider affinity

**Files:**
- Modify: packages/server/src/runtime.ts
- Modify: packages/server/src/routes/pipeline/index.ts
- Modify: packages/server/src/routes/pipeline/attempt.ts
- Modify: packages/server/src/routes/pipeline/attempt-base.ts
- Modify: packages/server/src/routes/pipeline/failure.ts
- Modify: packages/server/src/routes/pipeline/stream.ts
- Modify: packages/server/src/routes/token-count.ts
- Create: packages/server/src/routes/token-count-tracing/index.ts
- Create: packages/server/src/routes/token-count-tracing/token-count-tracing.ts
- Create: packages/server/src/routes/token-count-tracing/token-count-tracing.test.ts
- Create: packages/server/src/routes/pipeline/affinity/index.ts
- Create: packages/server/src/routes/pipeline/affinity/affinity.ts
- Create: packages/server/src/routes/pipeline/affinity/affinity.test.ts
- Create: packages/server/src/routes/pipeline/tracing.ts
- Create: packages/server/src/routes/pipeline/trace-tree.test.ts
- Modify: packages/server/src/usage-capture/usage-capture.ts
- Modify: packages/server/src/usage-capture/usage-capture.stream.test.ts
- Modify: packages/server/_test/pipeline-helpers/recording.ts
- Modify: packages/server/_test/pipeline-helpers/providers.ts
- Modify: packages/server/_test/pipeline-helpers/types.ts
- Modify: packages/server/src/server-state/index.ts
- Modify: packages/server/src/server-state/types.ts

**Interfaces:**
- ProviderRouteSource keeps its existing requestRecorder slot but changes that slot's contract and production value to RequestTraceRecorder. Do not rename the route dependency solely because its persisted representation changed.
- Pipeline starts parse, Session resolution, route resolution, Provider attempt, request prepare, inference, egress, and usage resolution spans.
- Token-count routes start the same root/parse/Session/route/attempt structure with aio_proxy.token_count as the CLIENT operation; they do not create inference/usage spans or mutate affinity/response chains.
- prioritizeAffinity(candidates, activeProviderId) returns a new candidate array with at most one Provider moved to index zero.
- Provider weight Trace attributes are read from the leased snapshot config by Provider ID; RuntimeProviderInstance and routing remain unchanged.

- [ ] **Step 1: Write affinity ordering tests**

~~~ts
expect(prioritizeAffinity([a, b, c], "b")).toEqual([b, a, c]);
expect(prioritizeAffinity([a, b, c], "missing")).toEqual([a, b, c]);
expect(prioritizeAffinity([a, b, c], undefined)).toEqual([a, b, c]);
~~~

Also assert the input array is not mutated.

- [ ] **Step 2: Write end-to-end Trace tree tests**

Use a temporary TraceStore and the real RequestTraceRecorder. Cover:

1. raw success;
2. AI SDK stream success;
3. first Provider failure followed by fallback success;
4. client cancellation;
5. parse rejection.

For streaming, assert find(traceId).trace.endedAt is null before consuming the Response body, then consume/cancel and assert terminal state.

The fallback tree must contain two aio_proxy.provider.attempt spans and both raw/AI SDK paths must use the same semantic names with different attributes:

~~~ts
expect(spanNames(detail)).toEqual(
  expect.arrayContaining([
    "aio_proxy.request",
    "aio_proxy.request.parse",
    "aio_proxy.session.resolve",
    "aio_proxy.route.resolve",
    "aio_proxy.provider.attempt",
    "aio_proxy.request.prepare",
    "gen_ai.client.inference",
    "aio_proxy.response.egress",
    "aio_proxy.usage.resolve",
  ]),
);
expect(attempt.attributes).toMatchObject({
  "aio_proxy.provider.id": "provider-a",
  "aio_proxy.route.selection_reason": "affinity",
  "aio_proxy.transport": "raw",
});
~~~

Assert the inference and egress spans contain first-upstream and first-client events respectively. Assert no upstream Request and no client Response contains traceparent or tracestate.

In token-count-tracing/token-count-tracing.test.ts, protect a Provider success, Provider fallback, local estimate, and parse rejection. Each produces one terminal root; Provider calls use aio_proxy.provider.attempt/aio_proxy.token_count spans, the local estimate has no Provider attempt, request totals remain represented, and no session_affinity/session_response row is written.

- [ ] **Step 3: Verify RED**

Run:

~~~bash
rtk bun test packages/server/src/routes/pipeline/affinity/affinity.test.ts
rtk bun test packages/server/src/routes/pipeline/trace-tree.test.ts
rtk bun test packages/server/src/routes/token-count-tracing/token-count-tracing.test.ts
~~~

Expected: all three commands FAIL because affinity ordering and Trace instrumentation do not exist.

- [ ] **Step 4: Activate the root before request logging**

Replace RequestRecorder.begin with RequestTraceRecorder.begin. Make the OTel root active outside the existing LogTape scope:

~~~ts
const requestTrace = source.requestRecorder.begin({
  headers: options.rawRequest.headers,
  inboundProtocol: options.adapter.protocol,
});
return await context.with(requestTrace.rootContext, () =>
  withRequestLogContext(
    {
      requestId: requestTrace.requestId,
      debug: options.source.debugLogging === true,
      logger: options.source.logger,
    },
    () => handleProtocolRequestInContext(options, requestTrace),
  ),
);
~~~

Wrap parse, Session resolution, and router.resolve in INTERNAL spans. Extract requestedModelId before Session resolution, pass requestTrace.requestId/requestedModelId into LogicalSessionStore.begin, then call requestTrace.identify({ requestedModelId, resolution, mutateSessionState: true }).

- [ ] **Step 5: Apply affinity without changing the Router**

~~~ts
export function prioritizeAffinity<T extends { readonly provider: { readonly id: string } }>(
  candidates: readonly T[],
  providerId: string | undefined,
): readonly T[] {
  if (providerId === undefined) return candidates;
  const index = candidates.findIndex((candidate) => candidate.provider.id === providerId);
  return index <= 0
    ? candidates
    : [candidates[index]!, ...candidates.slice(0, index), ...candidates.slice(index + 1)];
}
~~~

Use resolution.affinity only when active is true and its Provider remains eligible. Mark that bound Provider's attempt selection_reason=affinity whether it was already first or had to move; mark every other attempt selection_reason=weight.

Build a read-only weight map from lease.snapshot.config?.providers and pass it to attemptCandidates. Use weight ?? 0 for a configured Provider and omit the attribute only in tests/snapshots that have no config. Do not add weight to RuntimeProviderInstance or re-sort candidates.

- [ ] **Step 6: Add explicit attempt/inference/egress lifecycles**

tracing.ts owns small mechanics so attempt.ts remains under 300 lines:

~~~ts
export type SpanTerminal = {
  readonly outcome: "success" | "failure" | "cancelled";
  readonly errorType?: string;
  readonly errorCode?: string;
  readonly httpStatus?: number;
};

export type OpenSpan = {
  readonly context: Context;
  readonly span: Span;
  readonly run: <T>(operation: () => T) => T;
  readonly end: (terminal?: SpanTerminal) => void;
};

export function startPipelineSpan(
  parent: Context,
  name: string,
  options: SpanOptions,
): OpenSpan {
  const span = tracer.startSpan(name, options, parent);
  const active = trace.setSpan(parent, span);
  let ended = false;
  return {
    context: active,
    span,
    run: (operation) => context.with(active, operation),
    end(terminal) {
      if (ended) return;
      ended = true;
      applySpanTerminal(span, terminal);
      span.end();
    },
  };
}
~~~

applySpanTerminal leaves successful spans UNSET. For failure/cancelled it sets SpanStatusCode.ERROR plus the controlled error type/code, HTTP status, and termination-reason attributes; it never sets a status message or records an exception object.

Set attempt index, Provider ID/kind/weight, target model, transport (raw or ai_sdk), source/target protocols, and selection reason on each attempt. Set prepare mode to raw_rewrite or model_messages and egress mode to raw_passthrough or protocol_encode on their respective children. Use GenAI request/response model and usage constants plus HTTP response status/error.type wherever standards exist; use only attributeName for the local fields above.

Start inference before raw.invoke/model.invoke and end it only when upstream capture completes or fails. Start egress before protocol encoding and end it only when the returned body completes, errors, or is cancelled. The attempt ends after both terminal promises settle.

Add optional Trace hooks to both UsageCapture option types so usage-capture does not import Pipeline modules:

~~~ts
export type UsageTraceHooks = {
  readonly onFirstUpstreamPart?: () => void;
  readonly resolveUsage: <T>(operation: () => Promise<T>) => Promise<T>;
};
~~~

The Pipeline supplies hooks bound to the inference/attempt context. UsageCapture invokes onFirstUpstreamPart once and calls trace.resolveUsage(() => priceUsage(...)) around the actual catalog/pricing work, producing aio_proxy.usage.resolve rather than timing an already-resolved Promise.

The egress response wrapper exposes its own completion Promise. RequestTraceSession.finishFrom receives a terminal Promise that waits for both usage/inference completion and egress completion, ensuring the attempt/root cannot end before an open egress child.

- [ ] **Step 7: Capture successful response IDs for the terminal transaction**

For raw passthrough, include responseId on successful UsageCompletion instead of writing Session state in onResponseId.

For AI SDK egress, capture ModelEgressContext.onResponseId into a request-local variable and merge it into the successful completion before RequestTraceSession.finishFrom. Failed/cancelled requests must discard the observed ID.

- [ ] **Step 8: Strip trace context at network boundaries**

Before raw.invoke:

~~~ts
const headers = new Headers(upstream.headers);
headers.delete("traceparent");
headers.delete("tracestate");
const unpropagated = new Request(upstream, { headers });
~~~

Do not inject any replacement trace headers. Before returning the client Response, also remove traceparent and tracestate from copied upstream/encoded response headers so an upstream value cannot appear to be aio-proxy's local Trace context. Apply this at the shared egress boundary rather than separately in each protocol.

- [ ] **Step 9: Wire recorder, recovery, and shutdown-safe DB ordering**

In createServerState:

1. create TraceStore;
2. call recover(now) inside a fail-open persistence guard before accepting requests;
3. create LogicalSessionStore with TraceStore reads;
4. create RequestTraceRecorder with TraceStore/logger;
5. expose the RequestTraceRecorder through the existing ProviderRouteSource.requestRecorder slot.

Keep requestLog only for the old Dashboard logs endpoint until Task 10. Do not dual-write new requests to it.

Keep dbHandle.close() last in ServerState.close. Add no asynchronous flush/drain protocol: a process exit with active streams intentionally leaves their minimal roots running, and the next startup recover transaction marks them interrupted.

Adapt token-count.ts to begin with operation: "token_count", activate the same root before LogTape request context, pass requestTrace.requestId/requestedModelId into LogicalSessionStore, and finish every success/failure/cancellation/parse-rejection path. Keep token-count.ts below 300 lines by putting only the tracing lifecycle wrappers in the private token-count-tracing directory. Instrument Provider counting with attempt plus aio_proxy.token_count spans and keep candidate order unchanged. Call identify with mutateSessionState: false so the root retains Session/model correlation while TraceStore cannot create/refresh affinity or response mappings.

Rework createRecording in the shared Pipeline test helper around a narrow in-memory RequestTraceWriteStore plus the real RequestTraceRecorder. Preserve its begins/identities/attempts/finals observations by projecting captured Trace completions and attempt spans, so existing Pipeline and token-count tests keep asserting routing behavior without touching the user's in-progress test-support/debug files.

- [ ] **Step 10: Verify all Pipeline behavior and commit**

Run:

~~~bash
rtk bun test packages/server/src/routes/pipeline
rtk bun test packages/server/src/usage-capture
rtk bun run --filter @aio-proxy/server test:unit
~~~

Expected: all commands PASS, including existing raw/model/fallback/debug logging tests.

~~~bash
rtk git add packages/server/src/runtime.ts packages/server/src/routes/pipeline/index.ts packages/server/src/routes/pipeline/attempt.ts packages/server/src/routes/pipeline/attempt-base.ts packages/server/src/routes/pipeline/failure.ts packages/server/src/routes/pipeline/stream.ts packages/server/src/routes/pipeline/affinity packages/server/src/routes/pipeline/tracing.ts packages/server/src/routes/pipeline/trace-tree.test.ts packages/server/src/routes/token-count.ts packages/server/src/routes/token-count-tracing packages/server/src/usage-capture/usage-capture.ts packages/server/src/usage-capture/usage-capture.stream.test.ts packages/server/src/server-state/index.ts packages/server/src/server-state/types.ts packages/server/_test/pipeline-helpers/recording.ts packages/server/_test/pipeline-helpers/providers.ts packages/server/_test/pipeline-helpers/types.ts
rtk git commit -m "feat(server): trace the provider pipeline" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

---

### Task 6: Correlate LogTape entries with the active Trace and Span

**Files:**
- Move: packages/server/src/server-log.ts to packages/server/src/server-log/server-log.ts
- Move: packages/server/src/server-log.test.ts to packages/server/src/server-log/server-log.test.ts
- Create: packages/server/src/server-log/index.ts
- Modify: packages/server/src/logging/bridge/bridge.ts
- Modify: packages/server/src/logging/bridge/bridge.test.ts

**Interfaces:**
- Every configured and fallback LogTape entry emitted in an active OTel context gains trusted traceId and current spanId.
- Background logs remain unchanged.
- Keeps the trace.persistence_failed event introduced in Task 3 and moves it without changing its contract.

- [ ] **Step 1: Extend bridge tests with an active Span context**

Initialize the Trace runtime, then nest a valid SpanContext around the existing request/attempt scope:

~~~ts
const active = trace.setSpanContext(ROOT_CONTEXT, {
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  traceFlags: TraceFlags.SAMPLED,
});

context.with(active, () =>
  withRequestLogContext(
    { requestId: "trusted-request", debug: false, logger: () => {} },
    () => sink(entry),
  ),
);

expect(call.messageOrProps).toMatchObject({
  requestId: "trusted-request",
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
});
~~~

Assert caller-supplied traceId/spanId are overwritten and a background entry has neither field.

- [ ] **Step 2: Verify RED**

Run: rtk bun test packages/server/src/logging/bridge/bridge.test.ts

Expected: FAIL because contextual() only merges the existing request scope.

- [ ] **Step 3: Merge active OTel correlation at the bridge**

~~~ts
const activeTraceContext = () => {
  const span = trace.getSpanContext(context.active());
  return span === undefined || !isSpanContextValid(span)
    ? {}
    : { traceId: span.traceId, spanId: span.spanId };
};

const contextual = <Entry extends object>(entry: Entry) => ({
  ...entry,
  ...currentRequestLogContext(),
  ...activeTraceContext(),
});
~~~

Spread trusted ambient fields last for both server and plugin bridges. This automatically gives stream/wire logs the span active in their callback without changing wire payload code.

- [ ] **Step 4: Move ServerLog into the required colocated-test layout**

Move the implementation and test into packages/server/src/server-log, add an export-only index.ts, and update the implementation's relative request-metadata import. Existing imports ending in /server-log continue resolving through the directory entry point.

Keep trace.persistence_failed and its operation union byte-for-byte unchanged. Preserve requestId when it exists; the bridge supplies traceId/spanId from the active context.

- [ ] **Step 5: Verify and commit**

Run:

~~~bash
rtk bun test packages/server/src/server-log
rtk bun test packages/server/src/logging/bridge
rtk bun run --filter @aio-proxy/server test:unit
~~~

Expected: all commands PASS.

~~~bash
rtk git add -A packages/server/src/server-log.ts packages/server/src/server-log.test.ts packages/server/src/server-log
rtk git add packages/server/src/logging/bridge/bridge.ts packages/server/src/logging/bridge/bridge.test.ts
rtk git commit -m "feat(server): correlate logs with active spans" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

---

### Task 7: Add Trace list/detail APIs and switch short-range usage reads

**Files:**
- Create: packages/server/src/dashboard-routes/traces/index.ts
- Create: packages/server/src/dashboard-routes/traces/traces.ts
- Create: packages/server/src/dashboard-routes/traces/traces.test.ts
- Modify: packages/server/src/dashboard-routes/config.ts
- Modify: packages/server/src/server-state/types.ts
- Modify: packages/server/_test/usage-dashboard.test.ts

**Interfaces:**
- Adds GET /dashboard/api/traces.
- Adds GET /dashboard/api/traces/:traceId.
- Keeps GET /dashboard/api/logs temporarily for Dashboard compatibility; Task 10 removes it with no redirect.
- GET /dashboard/api/usage now calls TraceStore.overview with its current response schema unchanged.

- [ ] **Step 1: Write failing API behavior tests**

Seed a running root and a terminal root with children. Cover:

~~~ts
const list = await app.request(
  "/dashboard/api/traces?page=1&pageSize=10&sessionSource=header-session&sessionId=session-a",
  undefined,
  loopbackServer,
);
expect(list.status).toBe(200);
expect(DashboardTracesResponseSchema.parse(await list.json())).toMatchObject({
  total: 1,
  items: [{ traceId: terminalTraceId, session: { source: "header-session", id: "session-a" } }],
});

const detail = await app.request(
  "/dashboard/api/traces/" + terminalTraceId,
  undefined,
  loopbackServer,
);
expect(detail.status).toBe(200);
expect(DashboardTraceDetailSchema.parse(await detail.json()).spans).toHaveLength(3);

const missing = await app.request(
  "/dashboard/api/traces/00000000000000000000000000000000",
  undefined,
  loopbackServer,
);
expect(missing.status).toBe(404);
~~~

Also reject invalid page sizes, dates, status, termination reasons, HTTP status, and malformed Trace IDs with 400.

- [ ] **Step 2: Verify RED**

Run: rtk bun test packages/server/src/dashboard-routes/traces/traces.test.ts

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Define the list query validator**

Accept:

~~~ts
const TracesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().pipe(DashboardTracePageSizeSchema).default(50),
  startedAfter: z.iso.datetime().transform((value) => new Date(value)).optional(),
  startedBefore: z.iso.datetime().transform((value) => new Date(value)).optional(),
  traceId: z.string().regex(/^[0-9a-f]{32}$/u).optional(),
  requestId: z.string().trim().min(1).optional(),
  sessionSource: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).max(512).optional(),
  otelStatusCode: OtelSpanStatusCodeSchema.optional(),
  terminationReason: TraceTerminationReasonSchema.optional(),
  inboundProtocol: z.string().trim().min(1).optional(),
  requestedModelId: z.string().trim().min(1).optional(),
  finalProviderId: z.string().trim().min(1).optional(),
  finalModelId: z.string().trim().min(1).optional(),
  finalHttpStatus: z.coerce.number().int().min(100).max(599).optional(),
});
~~~

Time filters and ordering use started_at. Do not add JSON attribute filtering.

- [ ] **Step 4: Register thin Hono routes**

traces.ts owns validation and handlers. config.ts only imports and mounts:

~~~ts
.route("/traces", createDashboardTraceRoutes(state))
~~~

Return { error: "trace not found" } with 404 for a valid missing ID. Keep detail response uncached; Dashboard owns manual refresh.

Switch the existing usage handler:

~~~ts
return context.json(state.traceStore.overview(query));
~~~

- [ ] **Step 5: Update usage API tests without changing expectations**

Seed completed root spans through TraceStore and keep the current provider-grouping assertion:

~~~ts
expect(body).toMatchObject({
  range: "24h",
  metric: "requests",
  groupBy: "provider",
  summary: {
    requestCount: 3,
    successCount: 1,
    failureCount: 1,
    cancelledCount: 1,
  },
});
expect(body.series[0]).toEqual({ key: "openrouter", kind: "dimension" });
~~~

- [ ] **Step 6: Verify and commit**

Run:

~~~bash
rtk bun test packages/server/src/dashboard-routes/traces
rtk bun test packages/server/_test/usage-dashboard.test.ts
rtk bun run --filter @aio-proxy/server test:unit
~~~

Expected: all commands PASS.

~~~bash
rtk git add packages/server/src/dashboard-routes/traces packages/server/src/dashboard-routes/config.ts packages/server/src/server-state/types.ts packages/server/_test/usage-dashboard.test.ts
rtk git commit -m "feat(server): expose local trace queries" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

---

### Task 8: Replace the Dashboard Logs page with a Trace list

**Files:**
- Delete: packages/dashboard/src/routes/logs.tsx
- Create: packages/dashboard/src/routes/traces/index.tsx
- Create: packages/dashboard/src/routes/traces/$traceId.tsx
- Move/rename: packages/dashboard/src/modules/logs/log-date-range to packages/dashboard/src/modules/traces/trace-date-range
- Move/rename: packages/dashboard/src/modules/logs/log-formatters.ts to packages/dashboard/src/modules/traces/trace-formatters/trace-formatters.ts
- Move/rename: packages/dashboard/src/modules/logs/log-formatters.test.ts to packages/dashboard/src/modules/traces/trace-formatters/trace-formatters.test.ts
- Create: packages/dashboard/src/modules/traces/trace-formatters/index.ts
- Create: packages/dashboard/src/modules/traces/trace-search/index.ts
- Create: packages/dashboard/src/modules/traces/trace-search/trace-search.ts
- Create: packages/dashboard/src/modules/traces/trace-search/trace-search.test.ts
- Create: packages/dashboard/src/modules/traces/services/traces-service/index.ts
- Create: packages/dashboard/src/modules/traces/services/traces-service/traces-service.ts
- Create: packages/dashboard/src/modules/traces/services/traces-service/traces-service.test.ts
- Create: packages/dashboard/src/modules/traces/hooks/use-traces-query.ts
- Create: packages/dashboard/src/modules/traces/hooks/use-trace-query.ts
- Create: packages/dashboard/src/modules/traces/components/traces-filters.tsx
- Create: packages/dashboard/src/modules/traces/components/traces-advanced-filters.tsx
- Create: packages/dashboard/src/modules/traces/components/traces-table.tsx
- Create: packages/dashboard/src/modules/traces/templates/traces-page/index.ts
- Create: packages/dashboard/src/modules/traces/templates/traces-page/traces-page.tsx
- Create: packages/dashboard/src/modules/traces/templates/traces-page/traces-page.test.tsx
- Create: packages/dashboard/src/modules/traces/templates/trace-detail-page/index.ts
- Create: packages/dashboard/src/modules/traces/templates/trace-detail-page/trace-detail-page.tsx
- Create: packages/dashboard/src/modules/traces/templates/trace-detail-page/trace-detail-page.test.tsx
- Modify: packages/dashboard/src/components/side-menu/side-menu.tsx
- Delete after moves: remaining packages/dashboard/src/modules/logs files
- Modify: packages/i18n/messages/en.json
- Modify: packages/i18n/messages/zh-Hans.json
- Generate: packages/dashboard/src/route-tree.gen.ts

**Interfaces:**
- /traces owns URL search state and server pagination.
- /traces/$traceId is a dedicated page, not a drawer. Task 8 renders a complete summary and ordered span list; Task 9 upgrades it to the interactive tree/waterfall.
- Services use the typed Hono client and TanStack Query; components never call fetch.

- [ ] **Step 1: Write Trace search parsing tests**

Use start-time bounds and Trace-specific filters:

~~~ts
expect(
  parseTraceSearch({
    page: "2",
    pageSize: "20",
    otelStatusCode: "ERROR",
    terminationReason: "cancelled",
    sessionSource: "openai-prompt-cache",
    sessionId: "cache-a",
  }, now),
).toMatchObject({
  page: 2,
  pageSize: 20,
  otelStatusCode: "ERROR",
  terminationReason: "cancelled",
  sessionSource: "openai-prompt-cache",
  sessionId: "cache-a",
});
~~~

Invalid dates, page values, status, termination reason, and HTTP status reset to the default current-day range. withTraceFilters resets page to one and removes undefined fields.

- [ ] **Step 2: Write service and page behavior tests**

Mock the typed client's methods, not global fetch. Assert:

- list sends startedAfter/startedBefore and all active filters;
- detail calls /traces/:traceId;
- list query refreshes every five seconds only on page one when auto-refresh is enabled;
- detail query has no refetchInterval;
- non-2xx responses throw DashboardTracesRequestError with status.

In traces-page.test.tsx, protect server pagination, running/terminal row rendering, filter callbacks, and row navigation. In trace-detail-page.test.tsx, protect running/terminal summaries, ordered Span rendering, manual refetch, and 404/error states. Mock service/query boundaries rather than global fetch.

- [ ] **Step 3: Verify RED**

Run:

~~~bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/traces/trace-search/trace-search.test.ts src/modules/traces/services/traces-service/traces-service.test.ts src/modules/traces/templates/traces-page/traces-page.test.tsx src/modules/traces/templates/trace-detail-page/trace-detail-page.test.tsx
~~~

Expected: the targeted test command FAILS because the traces module does not exist.

- [ ] **Step 4: Implement URL state and typed services**

~~~ts
export type TraceSearch = {
  readonly page: number;
  readonly pageSize: DashboardTracePageSize;
  readonly startedAfter: string;
  readonly startedBefore: string;
  readonly traceId?: string;
  readonly requestId?: string;
  readonly sessionSource?: string;
  readonly sessionId?: string;
  readonly otelStatusCode?: OtelSpanStatusCode;
  readonly terminationReason?: TraceTerminationReason;
  readonly inboundProtocol?: string;
  readonly requestedModelId?: string;
  readonly finalProviderId?: string;
  readonly finalModelId?: string;
  readonly finalHttpStatus?: number;
};
~~~

Use query keys ["dashboard", "traces", search] and ["dashboard", "traces", traceId].

- [ ] **Step 5: Build the server-paginated Trace list**

Use TanStack Form for filters and TanStack Table with manual pagination. Expose no client sorting, current-page filtering, or column-visibility controls. Render root columns:

- started time;
- running/terminal OTel status and termination reason;
- Session source/ID;
- protocol;
- requested model;
- final Provider ID/model;
- final HTTP status;
- duration;
- total tokens and estimated cost.

Rows navigate to /traces/$traceId with the typed router. Preserve list search in the browser history so Back returns to the same filters/page.

Keep current list auto-refresh behavior on page one. Running durations update only when the query refreshes; add no client timer.

- [ ] **Step 6: Add the first complete detail route**

Load the detail query, render root summary fields, usage, and every ordered span name/kind/start/end/status. Provide a manual Refresh button wired to query.refetch. Handle loading, 404/error, and running root states with existing shadcn primitives and i18n copy.

This is the working detail baseline for Task 9, not a mock or fallback response.

- [ ] **Step 7: Replace navigation and localized copy**

Replace Dashboard menu Logs with Traces and make /traces plus /traces/$traceId active. Replace the dashboard.logs message group with dashboard.traces keys for filters, status, termination reasons, summary, Span fields, attributes, events, links, loading/empty/error states, refresh, and unavailable values in both locales.

Run: rtk bun run i18n:compile

Expected: generated i18n code compiles.

- [ ] **Step 8: Build, test, and commit**

Run:

~~~bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/traces
rtk bun run --filter @aio-proxy/dashboard build
rtk bun run --filter @aio-proxy/dashboard test:unit
~~~

Expected: all commands PASS and the generated route tree contains /traces and /traces/$traceId but no /logs.

~~~bash
rtk git add -A packages/dashboard/src/routes/logs.tsx packages/dashboard/src/routes/traces packages/dashboard/src/modules/logs packages/dashboard/src/modules/traces
rtk git add packages/dashboard/src/components/side-menu/side-menu.tsx packages/dashboard/src/route-tree.gen.ts packages/i18n/messages/en.json packages/i18n/messages/zh-Hans.json packages/i18n/src
rtk git commit -m "feat(dashboard): replace logs with traces" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

---

### Task 9: Build the interactive Span tree, waterfall, and detail panel

**Files:**
- Create: packages/dashboard/src/modules/traces/trace-layout/index.ts
- Create: packages/dashboard/src/modules/traces/trace-layout/trace-layout.ts
- Create: packages/dashboard/src/modules/traces/trace-layout/trace-layout.test.ts
- Create: packages/dashboard/src/modules/traces/components/span-waterfall/index.ts
- Create: packages/dashboard/src/modules/traces/components/span-waterfall/span-waterfall.tsx
- Create: packages/dashboard/src/modules/traces/components/span-waterfall/span-waterfall.test.tsx
- Create: packages/dashboard/src/modules/traces/components/span-detail-panel/index.ts
- Create: packages/dashboard/src/modules/traces/components/span-detail-panel/span-detail-panel.tsx
- Create: packages/dashboard/src/modules/traces/components/span-detail-panel/span-detail-panel.test.tsx
- Create: packages/dashboard/src/modules/traces/components/trace-summary.tsx
- Modify: packages/dashboard/src/modules/traces/templates/trace-detail-page/trace-detail-page.tsx
- Modify: packages/dashboard/src/modules/traces/templates/trace-detail-page/trace-detail-page.test.tsx

**Interfaces:**
- layoutTraceSpans(spans, now) returns stable rows with depth, offsetRatio, widthRatio, and durationMs.
- SpanWaterfall owns only selection callbacks; TraceDetailPage owns selectedSpanId because the selection controls the sibling detail panel.
- Session identity links back to /traces with source/ID filters and page one.

- [ ] **Step 1: Write layout tests for nesting and overlap**

~~~ts
expect(layoutTraceSpans(spans, now)).toEqual([
  expect.objectContaining({ spanId: "root", depth: 0, offsetRatio: 0, widthRatio: 1 }),
  expect.objectContaining({ spanId: "attempt", depth: 1 }),
  expect.objectContaining({ spanId: "inference", depth: 2 }),
  expect.objectContaining({ spanId: "egress", depth: 2 }),
]);
~~~

Use overlapping inference/egress timestamps and assert both bars overlap numerically. Include an orphaned parent ID and a two-Span parent cycle; both render at depth zero instead of recursing forever. A running span uses now for duration.

- [ ] **Step 2: Write component behavior tests**

Protect:

- keyboard and pointer selection of a Span row;
- selected row exposes name, IDs, status, attributes, events, and links;
- manual refresh calls refetch once and no interval is scheduled;
- clicking Session identity navigates to /traces with sessionSource/sessionId and page: 1.

- [ ] **Step 3: Verify RED**

Run:

~~~bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/traces/trace-layout/trace-layout.test.ts src/modules/traces/components/span-waterfall/span-waterfall.test.tsx src/modules/traces/components/span-detail-panel/span-detail-panel.test.tsx src/modules/traces/templates/trace-detail-page/trace-detail-page.test.tsx
~~~

Expected: the targeted test command FAILS because the interactive components do not exist.

- [ ] **Step 4: Implement deterministic layout**

Build a map by spanId and calculate depth by walking parentSpanId with a visited set. Use the root start and max(root end, latest child end, now for running) as the scale:

~~~ts
const minimumBarRatio = 0.002;
const scaleDurationMs = Math.max(1, traceEnd - traceStart);
const offsetRatio = clamp((startedAt - traceStart) / scaleDurationMs, 0, 1 - minimumBarRatio);
const widthRatio = clamp(durationMs / scaleDurationMs, minimumBarRatio, 1 - offsetRatio);
~~~

Use a local clamp expression with Math.min/Math.max; add no generic utility. Keep durationMs as the real zero-capable duration; scaleDurationMs only prevents division by zero and keeps the lower bound valid for a zero-duration Span beginning at the Trace end.

- [ ] **Step 5: Render the waterfall with existing primitives**

Use CSS grid for label/status/duration and one relative div for bars. Indent labels by depth, render status with Badge, and use a minimum visible width for zero/very short spans. Do not introduce a charting or tree package.

Make each row a real button or keyboard-operable table row with an i18n ARIA label. Preserve server start-time order rather than adding client sorting.

- [ ] **Step 6: Render selected Span data without duplicating typed attributes**

Use Tabs for Attributes, Events, and Links. The API already returns merged attributes; the panel renders that object once. Show event name/time/attributes and link traceId/spanId/attributes. Never render status.message or exception stack because storage does not contain them.

- [ ] **Step 7: Assemble the dedicated detail page**

Use a two-column responsive layout:

- main column: TraceSummary plus SpanWaterfall;
- side column: SpanDetailPanel;
- small screens: stack the selected Span panel below the waterfall.

Initialize selection to the root Span. Preserve selection across manual refresh when that Span ID still exists; otherwise select the root.

- [ ] **Step 8: Verify and commit**

Run:

~~~bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/traces
rtk bun run --filter @aio-proxy/dashboard build
rtk bun run --filter @aio-proxy/dashboard test:unit
~~~

Expected: all commands PASS.

~~~bash
rtk git add packages/dashboard/src/modules/traces
rtk git commit -m "feat(dashboard): visualize trace span trees" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

---

### Task 10: Remove legacy request storage, benchmark final SQLite writes, and verify

**Files:**
- Delete: packages/core/src/db/request-log.ts
- Delete: packages/core/src/db/schema/request-log.ts
- Delete: packages/core/src/db/schema/usage.ts
- Delete: packages/core/_test/request-log-list.test.ts
- Delete: packages/core/_test/request-log-summary.test.ts
- Delete: packages/core/_test/request-log-write.test.ts
- Delete: packages/core/_test/request-log.test-support.ts
- Modify: packages/core/src/db/index.ts
- Modify: packages/core/src/db/schema/index.ts
- Modify: packages/server/src/server-state/index.ts
- Modify: packages/server/src/server-state/types.ts
- Modify: packages/server/src/dashboard-routes/config.ts
- Delete: packages/server/_test/dashboard-request-logs.test.ts
- Delete: packages/server/src/request-recorder.ts
- Delete: packages/server/src/request-recorder/lifecycle.test.ts
- Delete: packages/server/_test/request-recorder.test.ts
- Modify: packages/server/src/server-log/server-log.ts
- Modify: packages/server/src/server-log/server-log.test.ts
- Modify: packages/types/src/dashboard.ts
- Create: packages/core/scripts/benchmark-trace-store.ts
- Modify: packages/core/package.json
- Generate: packages/core/src/db/migrations/0002_*.sql
- Generate: packages/core/src/db/migrations/meta/0002_snapshot.json
- Generate: packages/core/src/db/migrations/meta/_journal.json
- Generate: packages/core/src/db/migrations.manifest.ts

**Interfaces:**
- Removes GET /dashboard/api/logs with no redirect and no compatibility DTO.
- Removes request_log and usage tables/history.
- Leaves usage_daily permanent and Provider-free.
- Adds a directional, non-CI TraceStore benchmark.

- [ ] **Step 1: Strengthen the final migration test**

Extend packages/core/src/db/migrations/migrations.test.ts:

~~~ts
expect(tables).not.toContain("request_log");
expect(tables).not.toContain("usage");
expect(tables).toEqual(
  expect.arrayContaining(["trace_span", "usage_daily", "session_affinity", "session_response"]),
);
expect(dailyColumns.some((name) => name.includes("provider"))).toBeFalse();
~~~

- [ ] **Step 2: Verify RED**

Run: rtk bun test packages/core/src/db/migrations/migrations.test.ts

Expected: FAIL because the legacy tables still exist.

- [ ] **Step 3: Remove all legacy readers, writers, DTOs, and tests**

Delete RequestLogStore/createRequestLogStore and schema exports. Remove requestLog from ServerState. Remove the logs validator/route from Dashboard routes so /dashboard/api/logs returns 404.

Delete DashboardRequestAttempt, DashboardRequestLog, DashboardRequestLogsResponse, and DashboardRequestLogsPageSize schemas/types. Keep UsageRow and usage overview schemas because the public usage contract remains.

Delete the old RequestRecorder implementation and tests after confirming every production/test ProviderRouteSource uses RequestTraceRecorder. Remove the now-dead request.recorder_persistence_failed log type/level; keep request.recorder_invariant because RequestTraceRecorder still uses it for conflicting identify calls.

- [ ] **Step 4: Generate the destructive migration**

Remove request-log.ts and usage.ts from the Drizzle schema, then run:

~~~bash
rtk bun run build:migrations
rtk bun test packages/core/src/db/migrations/migrations.test.ts
~~~

Expected: migration 0002 drops request_log and usage; the test PASS confirms new and upgraded databases expose only the new observability tables.

- [ ] **Step 5: Add and run the final synchronous SQLite benchmark**

benchmark-trace-store.ts must:

- create a temporary local database;
- warm up 1,000 requests;
- measure at least 10,000 startRoot calls and 10,000 complete calls with ten child spans;
- report p50/p95/p99 for root start, terminal transaction, and combined requests/second;
- remove its temporary directory in finally;
- set no pass/fail threshold.

Add:

~~~json
"benchmark:trace-store": "bun scripts/benchmark-trace-store.ts"
~~~

Run: rtk bun run --filter @aio-proxy/core benchmark:trace-store

Expected: output contains root-start p50/p95/p99, terminal p50/p95/p99, and combined requests/s. Record the observed numbers in the final handoff; do not add an asynchronous writer based on a directional result.

- [ ] **Step 6: Search for forbidden leftovers**

Run:

~~~bash
if rtk rg -n "createRequestLogStore|RequestLogStore|RequestRecorderPersistenceFailedLog|request\.recorder_persistence_failed|dashboard/api/logs|/logs" packages; then exit 1; fi
if rtk rg -n "request_log" packages --glob '!packages/core/src/db/migrations/**' --glob '!packages/core/src/db/migrations.manifest.ts'; then exit 1; fi
if rtk rg -ni "provider" packages/core/src/db/schema/usage-daily.ts; then exit 1; fi
~~~

Expected: all three guards exit successfully with no production/test legacy reference and no Provider field in usage-daily.ts. The migration behavior test remains the authoritative deployed-column check.

- [ ] **Step 7: Run full verification**

Run:

~~~bash
rtk bun run i18n:compile
rtk bun run check
rtk bun run preflight
~~~

Expected: formatting/lint, every unit test, type/artifact tests, and task-graph tests PASS.

- [ ] **Step 8: Commit the cleanup**

~~~bash
rtk git add -A packages/core/src/db/request-log.ts packages/core/src/db/schema/request-log.ts packages/core/src/db/schema/usage.ts packages/core/_test/request-log-list.test.ts packages/core/_test/request-log-summary.test.ts packages/core/_test/request-log-write.test.ts packages/core/_test/request-log.test-support.ts packages/server/_test/dashboard-request-logs.test.ts packages/server/src/request-recorder.ts packages/server/src/request-recorder packages/server/_test/request-recorder.test.ts
rtk git add packages/core/src/db/index.ts packages/core/src/db/schema/index.ts packages/core/src/db/migrations packages/core/src/db/migrations.manifest.ts packages/core/scripts/benchmark-trace-store.ts packages/core/package.json packages/server/src/server-state/index.ts packages/server/src/server-state/types.ts packages/server/src/dashboard-routes/config.ts packages/server/src/server-log/server-log.ts packages/server/src/server-log/server-log.test.ts packages/types/src/dashboard.ts
rtk git commit -m "refactor: retire request log storage" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

## Final Acceptance Checklist

- One request produces one local root Trace and complete raw/AI SDK pipeline spans.
- A valid inbound traceparent appears only as a root Link and is absent upstream/client-side.
- Running roots are visible immediately; terminal children/summary/usage/Session state commit atomically after actual stream termination.
- In-request Trace persistence and Session reads fail open with traceId/spanId-correlated LogTape errors; startup recover/prune errors remain structured but do not fabricate request correlation IDs.
- Session signals include prompt_cache_key and previous_response_id continuity survives restart.
- Affinity honors one-hour sliding TTL and optimistic CAS while preserving the remaining Provider weight order.
- usage_daily primary key is exactly (local_day, model_dimension), contains no Provider dimension, and survives Trace pruning.
- GET /dashboard/api/usage keeps existing model/Provider grouping for the retained 45-day window.
- /logs and /dashboard/api/logs are 404 with no redirect; /traces and /traces/$traceId work.
- Trace detail refresh is manual; Session identity returns to a filtered Trace list.
- No OTLP, Collector, upstream propagation, Trace response header, background writer, or third-party Trace viewer was added.
