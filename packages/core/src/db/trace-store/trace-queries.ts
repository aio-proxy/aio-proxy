import type {
  DashboardTraceDetail,
  DashboardTraceSpan,
  DashboardTraceSummary,
  TraceTerminationReason,
} from '@aio-proxy/types';
import { and, asc, desc, eq, gt, gte, isNull, lt, lte, or } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { z } from 'zod';

import { nanoUsdToUsd } from '../../usage-numbers';
import { traceSpan } from '../schema';
import { mergeAttributes } from './span-projection';
import type { TraceCursor, TracesPage, TracesQuery } from './types';
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

const TRACE_CURSOR_VERSION = 1;
const TraceCursorPayloadSchema = z
  .object({
    version: z.literal(TRACE_CURSOR_VERSION),
    direction: z.enum(['older', 'newer']),
    startedAt: z.iso.datetime(),
    traceId: z.string().regex(/^[0-9a-f]{32}$/u),
  })
  .strict();

export function encodeTraceCursor(cursor: TraceCursor): string {
  return Buffer.from(
    JSON.stringify({
      version: TRACE_CURSOR_VERSION,
      direction: cursor.direction,
      startedAt: cursor.startedAt.toISOString(),
      traceId: cursor.traceId,
    }),
  ).toString('base64url');
}

export function decodeTraceCursor(token: string): TraceCursor | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(token)) {
    return undefined;
  }
  try {
    const parsed = TraceCursorPayloadSchema.safeParse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
    if (!parsed.success) {
      return undefined;
    }
    return {
      direction: parsed.data.direction,
      startedAt: new Date(parsed.data.startedAt),
      traceId: parsed.data.traceId,
    };
  } catch {
    return undefined;
  }
}

function toIso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

function durationMs(startedAt: Date, endedAt: Date | null, now: Date): number {
  return Math.max(0, (endedAt ?? now).getTime() - startedAt.getTime());
}

function rowToSummary(row: typeof traceSpan.$inferSelect, now: Date): DashboardTraceSummary {
  const stream = row.attributes['aio_proxy.request.stream'];
  const ttftMs = row.attributes['aio_proxy.response.ttft_ms'];
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
    durationMs: durationMs(row.startedAt, row.endedAt, now),
    ...(typeof stream === 'boolean' ? { stream } : {}),
    ...(typeof ttftMs === 'number' && Number.isFinite(ttftMs) && ttftMs >= 0 ? { ttftMs } : {}),
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

function rowToSpan(row: typeof traceSpan.$inferSelect, isRoot: boolean, now: Date): DashboardTraceSpan {
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
    durationMs: durationMs(row.startedAt, row.endedAt, now),
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

export function list(db: BunSQLiteDatabase, query: TracesQuery): TracesPage {
  let cursorFilter;
  if (query.cursor !== undefined) {
    const compare = query.cursor.direction === 'older' ? lt : gt;
    cursorFilter = or(
      compare(traceSpan.startedAt, query.cursor.startedAt),
      and(eq(traceSpan.startedAt, query.cursor.startedAt), compare(traceSpan.traceId, query.cursor.traceId)),
    );
  }
  const filter = and(
    isNull(traceSpan.parentSpanId),
    cursorFilter,
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

  const queryingNewer = query.cursor?.direction === 'newer';
  const selectedRows = db
    .select()
    .from(traceSpan)
    .where(filter)
    .orderBy(
      queryingNewer ? asc(traceSpan.startedAt) : desc(traceSpan.startedAt),
      queryingNewer ? asc(traceSpan.traceId) : desc(traceSpan.traceId),
    )
    .limit(query.pageSize + 1)
    .all();
  const hasMore = selectedRows.length > query.pageSize;
  const pageRows = selectedRows.slice(0, query.pageSize);
  if (queryingNewer) {
    pageRows.reverse();
  }
  const now = new Date();
  const firstRow = pageRows[0];
  const lastRow = pageRows.at(-1);
  if (firstRow === undefined || lastRow === undefined) {
    return { items: [] };
  }

  const hasNewer = query.cursor?.direction === 'older' || (queryingNewer && hasMore);
  const hasOlder = query.cursor?.direction === 'newer' || (!queryingNewer && hasMore);

  return {
    items: pageRows.map((row) => rowToSummary(row, now)),
    ...(hasOlder ? { nextCursor: rowToCursor(lastRow, 'older') } : {}),
    ...(hasNewer ? { previousCursor: rowToCursor(firstRow, 'newer') } : {}),
  };
}

function rowToCursor(row: typeof traceSpan.$inferSelect, direction: TraceCursor['direction']): TraceCursor {
  return { direction, startedAt: row.startedAt, traceId: row.traceId };
}

export function find(db: BunSQLiteDatabase, traceId: string, now = new Date()): DashboardTraceDetail | undefined {
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
    trace: rowToSummary(root, now),
    spans: rows.map((row) => rowToSpan(row, row.parentSpanId === null, now)),
  };
}

function statusCodeFromOtel(otel: 'UNSET' | 'OK' | 'ERROR'): number {
  if (otel === 'OK') return 1;
  if (otel === 'ERROR') return 2;
  return 0;
}
