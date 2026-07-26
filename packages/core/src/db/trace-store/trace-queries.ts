import type {
  DashboardTraceDetail,
  DashboardTraceSpan,
  DashboardTraceSummary,
  DashboardTracesResponse,
  TraceTerminationReason,
} from '@aio-proxy/types';
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { nanoUsdToUsd } from '../../usage-numbers';
import { traceSpan } from '../schema';
import { mergeAttributes } from './span-projection';
import type { TracesQuery } from './types';
import { hasAnyUsage } from './usage-fields';

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
  const usage = !hasAnyUsage(row)
    ? undefined
    : ({
        ...(row.finalProviderId !== null ? { providerId: row.finalProviderId } : {}),
        ...(row.finalModelId !== null ? { modelId: row.finalModelId } : {}),
        ...(row.priceModelId !== null ? { priceModelId: row.priceModelId } : {}),
        ...(row.inputTokens !== null ? { inputTokens: row.inputTokens } : {}),
        ...(row.outputTokens !== null ? { outputTokens: row.outputTokens } : {}),
        ...(row.totalTokens !== null ? { totalTokens: row.totalTokens } : {}),
        ...(row.cacheReadTokens !== null ? { cacheReadTokens: row.cacheReadTokens } : {}),
        ...(row.cacheWriteTokens !== null ? { cacheWriteTokens: row.cacheWriteTokens } : {}),
        ...(row.reasoningTokens !== null ? { reasoningTokens: row.reasoningTokens } : {}),
        ...(row.estimatedCostNanoUsd !== null ? { estimatedCostUsd: nanoUsdToUsd(row.estimatedCostNanoUsd) } : {}),
      } as DashboardTraceSummary['usage']);

  return {
    traceId: row.traceId,
    rootSpanId: row.spanId,
    requestId: row.requestId ?? '',
    startedAt: row.startedAt.toISOString(),
    endedAt: toIso(row.endedAt),
    durationMs: durationMs(row.startedAt, row.endedAt),
    otelStatusCode: STATUS_CODE_TO_OTEL[row.statusCode] ?? 'UNSET',
    ...(row.terminationReason !== null ? { terminationReason: row.terminationReason as TraceTerminationReason } : {}),
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
  const columns: Record<string, string | number> = {};
  const setStr = (key: string, value: string | null): void => {
    if (value !== null) columns[key] = value;
  };
  const setNum = (key: string, value: number | null): void => {
    if (value !== null) columns[key] = value;
  };
  setStr('requestId', row.requestId);
  setStr('sessionSource', row.sessionSource);
  setStr('sessionId', row.sessionId);
  setStr('sessionResolvedBy', row.sessionResolvedBy);
  setStr('inboundProtocol', row.inboundProtocol);
  setStr('requestedModelId', row.requestedModelId);
  setStr('finalProviderId', row.finalProviderId);
  setStr('finalModelId', row.finalModelId);
  setStr('priceModelId', row.priceModelId);
  setNum('inputTokens', row.inputTokens);
  setNum('outputTokens', row.outputTokens);
  setNum('totalTokens', row.totalTokens);
  setNum('cacheReadTokens', row.cacheReadTokens);
  setNum('cacheWriteTokens', row.cacheWriteTokens);
  setNum('reasoningTokens', row.reasoningTokens);
  setNum('estimatedCostUsd', row.estimatedCostNanoUsd === null ? null : nanoUsdToUsd(row.estimatedCostNanoUsd));
  setNum('attemptIndex', row.attemptIndex);
  setStr('providerId', row.providerId);
  setStr('providerKind', row.providerKind);
  setNum('providerWeight', row.providerWeight);
  setStr('modelId', row.modelId);
  setStr('transport', row.transport);
  setStr('sourceProtocol', row.sourceProtocol);
  setStr('targetProtocol', row.targetProtocol);
  setStr('selectionReason', row.selectionReason);
  setStr('terminationReason', row.terminationReason);
  setStr('errorType', row.errorType);
  setStr('errorCode', row.errorCode);

  const attributes = mergeAttributes(columns as Parameters<typeof mergeAttributes>[0], row.attributes, isRoot);

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
    ...(row.terminationReason !== null ? { terminationReason: row.terminationReason as TraceTerminationReason } : {}),
    ...(row.errorType !== null ? { errorType: row.errorType } : {}),
    ...(row.errorCode !== null ? { errorCode: row.errorCode } : {}),
    attributes: attributes as DashboardTraceSpan['attributes'],
    events: row.events.map((event) => ({
      name: event.name,
      timestamp: new Date(event.timeMs).toISOString(),
      attributes: (event.attributes ?? {}) as DashboardTraceSpan['events'][number]['attributes'],
    })),
    links: row.links.map((link) => ({
      traceId: link.traceId,
      spanId: link.spanId,
      attributes: (link.attributes ?? {}) as DashboardTraceSpan['links'][number]['attributes'],
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
