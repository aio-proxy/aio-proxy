import { sql } from 'drizzle-orm';
import { foreignKey, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export type SpanAttributesJson = Record<string, unknown>;

export type SpanEventJson = {
  /** Event name. */
  readonly name: string;
  /** Event timestamp as epoch milliseconds. */
  readonly timeMs: number;
  readonly attributes?: SpanAttributesJson;
};

export type SpanLinkJson = {
  /** Linked trace id as lowercase hex. */
  readonly traceId: string;
  /** Linked span id as lowercase hex. */
  readonly spanId: string;
  readonly attributes?: SpanAttributesJson;
};

export const traceSpan = sqliteTable(
  'trace_span',
  {
    traceId: text('trace_id').notNull(),
    spanId: text('span_id').notNull(),
    parentSpanId: text('parent_span_id'),
    name: text('name').notNull(),
    kind: integer('kind').notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
    statusCode: integer('status_code').notNull(),
    terminationReason: text('termination_reason'),
    errorType: text('error_type'),
    errorCode: text('error_code'),

    requestId: text('request_id').unique(),
    sessionSource: text('session_source'),
    sessionId: text('session_id'),
    sessionResolvedBy: text('session_resolved_by'),
    inboundProtocol: text('inbound_protocol'),
    requestedModelId: text('requested_model_id'),
    finalProviderId: text('final_provider_id'),
    finalModelId: text('final_model_id'),
    finalHttpStatus: integer('final_http_status'),

    priceModelId: text('price_model_id'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    totalTokens: integer('total_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    estimatedCostNanoUsd: integer('estimated_cost_nano_usd'),

    attemptIndex: integer('attempt_index'),
    providerId: text('provider_id'),
    providerKind: text('provider_kind'),
    providerWeight: real('provider_weight'),
    modelId: text('model_id'),
    transport: text('transport'),
    sourceProtocol: text('source_protocol'),
    targetProtocol: text('target_protocol'),
    selectionReason: text('selection_reason'),

    attributes: text('attributes_json', { mode: 'json' }).$type<SpanAttributesJson>().notNull(),
    events: text('events_json', { mode: 'json' }).$type<SpanEventJson[]>().notNull(),
    links: text('links_json', { mode: 'json' }).$type<SpanLinkJson[]>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.traceId, table.spanId] }),
    foreignKey({
      columns: [table.traceId, table.parentSpanId],
      foreignColumns: [table.traceId, table.spanId],
    }).onDelete('cascade'),
    uniqueIndex('trace_span_one_root_idx').on(table.traceId).where(sql.raw('parent_span_id IS NULL')),
    index('trace_span_root_started_idx').on(table.parentSpanId, table.startedAt),
    // Keep the parent equality so SQLite prefers this range lookup over the Provider index.
    index('trace_span_root_ended_idx').on(table.parentSpanId, table.endedAt).where(sql.raw('parent_span_id IS NULL')),
    index('trace_span_root_status_started_idx').on(table.parentSpanId, table.statusCode, table.startedAt),
    index('trace_span_root_provider_started_idx').on(table.parentSpanId, table.finalProviderId, table.startedAt),
    index('trace_span_root_model_started_idx').on(
      table.parentSpanId,
      table.requestedModelId,
      table.finalModelId,
      table.startedAt,
    ),
    index('trace_span_root_protocol_started_idx').on(table.parentSpanId, table.inboundProtocol, table.startedAt),
    index('trace_span_root_session_started_idx').on(
      table.parentSpanId,
      table.sessionSource,
      table.sessionId,
      table.requestedModelId,
      table.startedAt,
    ),
    index('trace_span_trace_started_idx').on(table.traceId, table.startedAt),
  ],
);
