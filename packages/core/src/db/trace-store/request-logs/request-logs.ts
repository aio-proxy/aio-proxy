import type {
  DashboardRequestAttempt,
  DashboardRequestLog,
  DashboardRequestLogsResponse,
  RequestOutcome,
  UsageRow,
} from '@aio-proxy/types';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { nanoUsdToUsd } from '../../../usage-numbers';
import { traceSpan } from '../../schema';
import type { RequestLogsQuery } from '../types';
import { hasAnyUsage } from '../usage-fields';

type Row = typeof traceSpan.$inferSelect;

// Must match the pipeline's provider-attempt span name (server semantic.ts).
const ATTEMPT_SPAN_NAME = 'aio_proxy.provider.attempt';
const HTTP_STATUS_ATTR = 'http.status_code';

// Trace stores 'interrupted' for unclean-shutdown recovery; the legacy Logs
// contract only knows success/failure/cancelled, so interrupted folds into
// failure.
function outcomeOf(terminationReason: string | null, errorCode: string | null): RequestOutcome {
  if (terminationReason === 'cancelled') return 'cancelled';
  if (terminationReason === 'failure' || terminationReason === 'interrupted' || errorCode !== null) return 'failure';
  return 'success';
}

function durationMs(row: Row): number {
  return row.endedAt === null ? 0 : Math.max(0, row.endedAt.getTime() - row.startedAt.getTime());
}

function attemptHttpStatus(row: Row): number | undefined {
  const value = (row.attributes as Record<string, unknown>)[HTTP_STATUS_ATTR];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function usageOf(row: Row): UsageRow | undefined {
  if (!hasAnyUsage(row) || row.finalProviderId === null || row.finalModelId === null) return undefined;
  return {
    providerId: row.finalProviderId,
    modelId: row.finalModelId,
    ...(row.priceModelId !== null ? { priceModelId: row.priceModelId } : {}),
    ...(row.inputTokens !== null ? { inputTokens: row.inputTokens } : {}),
    ...(row.outputTokens !== null ? { outputTokens: row.outputTokens } : {}),
    ...(row.totalTokens !== null ? { totalTokens: row.totalTokens } : {}),
    ...(row.cacheReadTokens !== null ? { cacheReadTokens: row.cacheReadTokens } : {}),
    ...(row.cacheWriteTokens !== null ? { cacheWriteTokens: row.cacheWriteTokens } : {}),
    ...(row.reasoningTokens !== null ? { reasoningTokens: row.reasoningTokens } : {}),
    ...(row.estimatedCostNanoUsd !== null ? { estimatedCostUsd: nanoUsdToUsd(row.estimatedCostNanoUsd) } : {}),
  };
}

function toAttempt(row: Row): DashboardRequestAttempt {
  const httpStatus = attemptHttpStatus(row);
  return {
    index: row.attemptIndex ?? 0,
    providerId: row.providerId ?? '',
    modelId: row.finalModelId ?? '',
    providerKind: (row.providerKind ?? '') as DashboardRequestAttempt['providerKind'],
    outcome: outcomeOf(row.terminationReason, row.errorCode),
    durationMs: durationMs(row),
    ...(row.targetProtocol !== null ? { protocol: row.targetProtocol as DashboardRequestAttempt['protocol'] } : {}),
    ...(httpStatus !== undefined ? { statusCode: httpStatus } : {}),
    ...(row.errorCode !== null ? { errorCode: row.errorCode } : {}),
  };
}

function outcomeFilter(outcome: RequestOutcome) {
  if (outcome === 'cancelled') return eq(traceSpan.terminationReason, 'cancelled');
  if (outcome === 'failure') return inArray(traceSpan.terminationReason, ['failure', 'interrupted']);
  return isNull(traceSpan.terminationReason);
}

function loadAttempts(db: BunSQLiteDatabase, traceIds: readonly string[]): Map<string, DashboardRequestAttempt[]> {
  const byTrace = new Map<string, DashboardRequestAttempt[]>();
  if (traceIds.length === 0) return byTrace;
  const rows = db
    .select()
    .from(traceSpan)
    .where(and(inArray(traceSpan.traceId, [...traceIds]), eq(traceSpan.name, ATTEMPT_SPAN_NAME)))
    .orderBy(asc(traceSpan.attemptIndex), asc(traceSpan.startedAt))
    .all();
  for (const row of rows) {
    const list = byTrace.get(row.traceId) ?? [];
    list.push(toAttempt(row));
    byTrace.set(row.traceId, list);
  }
  return byTrace;
}

function toRequestLog(row: Row, attempts: readonly DashboardRequestAttempt[]): DashboardRequestLog {
  const usage = usageOf(row);
  return {
    requestId: row.requestId ?? '',
    inboundProtocol: row.inboundProtocol ?? '',
    requestedModelId: row.requestedModelId ?? '<unparsed>',
    outcome: outcomeOf(row.terminationReason, row.errorCode),
    ...(row.finalProviderId !== null ? { finalProviderId: row.finalProviderId } : {}),
    ...(row.finalModelId !== null ? { finalModelId: row.finalModelId } : {}),
    ...(row.finalHttpStatus !== null ? { finalStatusCode: row.finalHttpStatus } : {}),
    ...(row.errorCode !== null ? { errorCode: row.errorCode } : {}),
    attempts: [...attempts],
    startedAt: row.startedAt.toISOString(),
    completedAt: (row.endedAt ?? row.startedAt).toISOString(),
    durationMs: durationMs(row),
    ...(usage !== undefined ? { usage } : {}),
  };
}

// Projects trace roots plus their attempt child spans into the legacy
// DashboardRequestLog shape so the /logs page keeps working after the pipeline
// stopped writing the request_log table. Only completed roots (endedAt set)
// are listed, matching the old "final row only" behavior. Attempts load in one
// IN query per page to avoid an N+1 detail lookup.
export function listRequestLogs(db: BunSQLiteDatabase, query: RequestLogsQuery): DashboardRequestLogsResponse {
  const filter = and(
    isNull(traceSpan.parentSpanId),
    isNotNull(traceSpan.endedAt),
    query.startedAfter === undefined ? undefined : gte(traceSpan.startedAt, query.startedAfter),
    query.completedBefore === undefined ? undefined : lte(traceSpan.endedAt, query.completedBefore),
    query.requestId === undefined ? undefined : eq(traceSpan.requestId, query.requestId),
    query.inboundProtocol === undefined ? undefined : eq(traceSpan.inboundProtocol, query.inboundProtocol),
    query.requestedModelId === undefined
      ? undefined
      : query.requestedModelId === '<unparsed>'
        ? isNull(traceSpan.requestedModelId)
        : eq(traceSpan.requestedModelId, query.requestedModelId),
    query.finalProviderId === undefined ? undefined : eq(traceSpan.finalProviderId, query.finalProviderId),
    query.finalModelId === undefined ? undefined : eq(traceSpan.finalModelId, query.finalModelId),
    query.finalStatusCode === undefined ? undefined : eq(traceSpan.finalHttpStatus, query.finalStatusCode),
    query.outcome === undefined ? undefined : outcomeFilter(query.outcome),
  );

  const total =
    db
      .select({ value: sql<number>`count(*)`.mapWith(Number) })
      .from(traceSpan)
      .where(filter)
      .get()?.value ?? 0;

  const roots = db
    .select()
    .from(traceSpan)
    .where(filter)
    .orderBy(desc(traceSpan.endedAt), desc(traceSpan.traceId))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .all();

  const attemptsByTrace = loadAttempts(
    db,
    roots.map((row) => row.traceId),
  );

  return {
    items: roots.map((row) => toRequestLog(row, attemptsByTrace.get(row.traceId) ?? [])),
    page: query.page,
    pageSize: query.pageSize,
    total,
    pageCount: Math.ceil(total / query.pageSize),
  };
}
