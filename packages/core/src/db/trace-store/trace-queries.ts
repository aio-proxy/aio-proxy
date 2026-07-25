import type {
  DashboardTraceDetail,
  DashboardTraceSpan,
  DashboardTraceSummary,
  DashboardTracesResponse,
} from '@aio-proxy/types';
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { traceSpan } from '../schema';
import { mergeAttributes } from './span-projection';
import type { TracesQuery } from './types';

const STATUS_CODE_TO_OTEL: Record<number, 'UNSET' | 'OK' | 'ERROR'> = {
  0: 'UNSET',
  1: 'OK',
  2: 'ERROR',
};

const KIND_TO_ENUM: Record<number, 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER'> = {
  0: 'INTERNAL',
  1: 'SERVER',
  2: 'CLIENT',
  3: 'PRODUCER',
  4: 'CONSUMER',
};

function toIso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

function durationMs(startedAt: Date, endedAt: Date | null): number {
  if (endedAt === null) {
    return 0;
  }
  return Math.max(0, endedAt.getTime() - startedAt.getTime());
}

function rowToSummary(row: typeof traceSpan.$inferSelect): DashboardTraceSummary {
  const usage =
    row.inputTokens === null && row.estimatedCostUsd === null
      ? undefined
      : {
          ...(row.finalProviderId !== null ? { providerId: row.finalProviderId } : {}),
          ...(row.finalModelId !== null ? { modelId: row.finalModelId } : {}),
          ...(row.priceModelId !== null ? { priceModelId: row.priceModelId } : {}),
          ...(row.inputTokens !== null ? { inputTokens: row.inputTokens } : {}),
          ...(row.outputTokens !== null ? { outputTokens: row.outputTokens } : {}),
          ...(row.totalTokens !== null ? { totalTokens: row.totalTokens } : {}),
          ...(row.cacheReadTokens !== null ? { cacheReadTokens: row.cacheReadTokens } : {}),
          ...(row.cacheWriteTokens !== null ? { cacheWriteTokens: row.cacheWriteTokens } : {}),
          ...(row.reasoningTokens !== null ? { reasoningTokens: row.reasoningTokens } : {}),
          ...(row.estimatedCostUsd !== null ? { estimatedCostUsd: row.estimatedCostUsd } : {}),
        };

  return {
    traceId: row.traceId,
    rootSpanId: row.spanId,
    requestId: row.requestId ?? '',
    startedAt: row.startedAt.toISOString(),
    endedAt: toIso(row.endedAt),
    durationMs: durationMs(row.startedAt, row.endedAt),
    otelStatusCode: STATUS_CODE_TO_OTEL[row.statusCode] ?? 'UNSET',
    ...(row.terminationReason !== null ? { terminationReason: row.terminationReason } : {}),
    ...(row.errorType !== null ? { errorType: row.errorType } : {}),
    ...(row.errorCode !== null ? { errorCode: row.errorCode } : {}),
    ...(row.sessionSource !== null && row.sessionId !== null
      ? { session: { source: row.sessionSource, id: row.sessionId } }
      : {}),
    ...(row.sessionResolvedBy !== null ? { sessionResolvedBy: row.sessionResolvedBy } : {}),
    inboundProtocol: row.inboundProtocol ?? '',
    ...(row.requestedModelId !== null ? { requestedModelId: row.requestedModelId } : {}),
    ...(row.finalProviderId !== null ? { finalProviderId: row.finalProviderId } : {}),
    ...(row.finalModelId !== null ? { finalModelId: row.finalModelId } : {}),
    ...(row.finalHttpStatus !== null ? { finalHttpStatus: row.finalHttpStatus } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

function rowToSpan(row: typeof traceSpan.$inferSelect, isRoot: boolean): DashboardTraceSpan {
  const attributes = mergeAttributes(
    {
      requestId: row.requestId ?? undefined,
      sessionSource: row.sessionSource ?? undefined,
      sessionId: row.sessionId ?? undefined,
      sessionResolvedBy: row.sessionResolvedBy ?? undefined,
      inboundProtocol: row.inboundProtocol ?? undefined,
      requestedModelId: row.requestedModelId ?? undefined,
      finalProviderId: row.finalProviderId ?? undefined,
      finalModelId: row.finalModelId ?? undefined,
      priceModelId: row.priceModelId ?? undefined,
      inputTokens: row.inputTokens ?? undefined,
      outputTokens: row.outputTokens ?? undefined,
      totalTokens: row.totalTokens ?? undefined,
      cacheReadTokens: row.cacheReadTokens ?? undefined,
      cacheWriteTokens: row.cacheWriteTokens ?? undefined,
      reasoningTokens: row.reasoningTokens ?? undefined,
      estimatedCostUsd: row.estimatedCostUsd ?? undefined,
      attemptIndex: row.attemptIndex ?? undefined,
      providerId: row.providerId ?? undefined,
      providerKind: row.providerKind ?? undefined,
      providerWeight: row.providerWeight ?? undefined,
      modelId: row.modelId ?? undefined,
      transport: row.transport ?? undefined,
      sourceProtocol: row.sourceProtocol ?? undefined,
      targetProtocol: row.targetProtocol ?? undefined,
      selectionReason: row.selectionReason ?? undefined,
      terminationReason: row.terminationReason ?? undefined,
      errorType: row.errorType ?? undefined,
      errorCode: row.errorCode ?? undefined,
    },
    row.attributes,
    isRoot,
  );

  return {
    traceId: row.traceId,
    spanId: row.spanId,
    ...(row.parentSpanId !== null ? { parentSpanId: row.parentSpanId } : {}),
    name: row.name,
    kind: KIND_TO_ENUM[row.kind] ?? 'INTERNAL',
    startedAt: row.startedAt.toISOString(),
    endedAt: toIso(row.endedAt),
    durationMs: durationMs(row.startedAt, row.endedAt),
    otelStatusCode: STATUS_CODE_TO_OTEL[row.statusCode] ?? 'UNSET',
    ...(row.terminationReason !== null ? { terminationReason: row.terminationReason } : {}),
    ...(row.errorType !== null ? { errorType: row.errorType } : {}),
    ...(row.errorCode !== null ? { errorCode: row.errorCode } : {}),
    attributes,
    events: row.events.map((event) => ({
      name: event.name,
      timestamp: new Date(event.timeMs).toISOString(),
      attributes: event.attributes ?? {},
    })),
    links: row.links.map((link) => ({
      traceId: link.traceId,
      spanId: link.spanId,
      attributes: link.attributes ?? {},
    })),
  };
}

export function list(db: BunSQLiteDatabase, query: TracesQuery): DashboardTracesResponse {
  const filter = and(
    isNull(traceSpan.parentSpanId),
    query.startedAfter === undefined ? undefined : gte(traceSpan.startedAt, query.startedAfter),
    query.startedBefore === undefined ? undefined : lte(traceSpan.startedAt, query.startedBefore),
    query.traceId === undefined ? undefined : eq(traceSpan.traceId, query.traceId),
    query.requestId === undefined ? undefined : eq(traceSpan.requestId, query.requestId),
    query.sessionSource === undefined ? undefined : eq(traceSpan.sessionSource, query.sessionSource),
    query.sessionId === undefined ? undefined : eq(traceSpan.sessionId, query.sessionId),
    query.otelStatusCode === undefined ? undefined : eq(traceSpan.statusCode, statusCodeFromOtel(query.otelStatusCode)),
    query.terminationReason === undefined ? undefined : eq(traceSpan.terminationReason, query.terminationReason),
    query.inboundProtocol === undefined ? undefined : eq(traceSpan.inboundProtocol, query.inboundProtocol),
    query.requestedModelId === undefined ? undefined : eq(traceSpan.requestedModelId, query.requestedModelId),
    query.finalProviderId === undefined ? undefined : eq(traceSpan.finalProviderId, query.finalProviderId),
    query.finalModelId === undefined ? undefined : eq(traceSpan.finalModelId, query.finalModelId),
    query.finalHttpStatus === undefined ? undefined : eq(traceSpan.finalHttpStatus, query.finalHttpStatus),
  );

  const total =
    db
      .select({ value: sql<number>`count(*)`.mapWith(Number) })
      .from(traceSpan)
      .where(filter)
      .get()?.value ?? 0;

  const rows = db
    .select()
    .from(traceSpan)
    .where(filter)
    .orderBy(desc(traceSpan.startedAt), desc(traceSpan.traceId))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .all();

  return {
    items: rows.map((row) => rowToSummary(row)),
    page: query.page,
    pageSize: query.pageSize,
    total,
    pageCount: Math.ceil(total / query.pageSize),
  };
}

export function find(db: BunSQLiteDatabase, traceId: string): DashboardTraceDetail | undefined {
  const rows = db
    .select()
    .from(traceSpan)
    .where(eq(traceSpan.traceId, traceId))
    .orderBy(asc(traceSpan.startedAt), asc(traceSpan.spanId))
    .all();
  if (rows.length === 0) {
    return undefined;
  }
  const root = rows.find((row) => row.parentSpanId === null);
  if (root === undefined) {
    return undefined;
  }
  return {
    trace: rowToSummary(root),
    spans: rows.map((row) => rowToSpan(row, row.parentSpanId === null)),
  };
}

function statusCodeFromOtel(otel: 'UNSET' | 'OK' | 'ERROR'): number {
  if (otel === 'OK') return 1;
  if (otel === 'ERROR') return 2;
  return 0;
}
