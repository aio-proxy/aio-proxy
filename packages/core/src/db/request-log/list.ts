import type { DashboardRequestLogsResponse } from '@aio-proxy/types';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { requestLog } from '../schema/request-log';
import { usage } from '../schema/usage';
import type { RequestLogsQuery } from './types';

export function listRequestLogs(db: BunSQLiteDatabase, query: RequestLogsQuery): DashboardRequestLogsResponse {
  const filter = and(
    query.startedAfter === undefined ? undefined : gte(requestLog.startedAt, query.startedAfter),
    query.completedBefore === undefined ? undefined : lte(requestLog.completedAt, query.completedBefore),
    query.requestId === undefined ? undefined : eq(requestLog.requestId, query.requestId),
    query.outcome === undefined ? undefined : eq(requestLog.outcome, query.outcome),
    query.inboundProtocol === undefined ? undefined : eq(requestLog.inboundProtocol, query.inboundProtocol),
    query.requestedModelId === undefined ? undefined : eq(requestLog.requestedModelId, query.requestedModelId),
    query.finalProviderId === undefined ? undefined : eq(requestLog.finalProviderId, query.finalProviderId),
    query.finalModelId === undefined ? undefined : eq(requestLog.finalModelId, query.finalModelId),
    query.finalStatusCode === undefined ? undefined : eq(requestLog.finalStatusCode, query.finalStatusCode),
  );
  const total =
    db
      .select({ value: sql<number>`count(*)`.mapWith(Number) })
      .from(requestLog)
      .where(filter)
      .get()?.value ?? 0;
  const rows = db
    .select({ request: requestLog, usage })
    .from(requestLog)
    .leftJoin(usage, eq(usage.requestId, requestLog.requestId))
    .where(filter)
    .orderBy(desc(requestLog.completedAt), desc(requestLog.requestId))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .all();

  return {
    items: rows.map(({ request, usage: usageRow }) => ({
      requestId: request.requestId,
      inboundProtocol: request.inboundProtocol,
      requestedModelId: request.requestedModelId,
      outcome: request.outcome,
      ...(request.finalProviderId === null ? {} : { finalProviderId: request.finalProviderId }),
      ...(request.finalModelId === null ? {} : { finalModelId: request.finalModelId }),
      ...(request.finalStatusCode === null ? {} : { finalStatusCode: request.finalStatusCode }),
      ...(request.errorCode === null ? {} : { errorCode: request.errorCode }),
      attempts: request.attempts,
      startedAt: request.startedAt.toISOString(),
      completedAt: request.completedAt.toISOString(),
      durationMs: request.durationMs,
      ...(usageRow === null
        ? {}
        : {
            usage: {
              providerId: usageRow.providerId,
              modelId: usageRow.modelId,
              ...(usageRow.priceModelId === null ? {} : { priceModelId: usageRow.priceModelId }),
              ...(usageRow.inputTokens === null ? {} : { inputTokens: usageRow.inputTokens }),
              ...(usageRow.outputTokens === null ? {} : { outputTokens: usageRow.outputTokens }),
              ...(usageRow.totalTokens === null ? {} : { totalTokens: usageRow.totalTokens }),
              ...(usageRow.cacheReadTokens === null ? {} : { cacheReadTokens: usageRow.cacheReadTokens }),
              ...(usageRow.cacheWriteTokens === null ? {} : { cacheWriteTokens: usageRow.cacheWriteTokens }),
              ...(usageRow.reasoningTokens === null ? {} : { reasoningTokens: usageRow.reasoningTokens }),
              ...(usageRow.estimatedCostUsd === null ? {} : { estimatedCostUsd: usageRow.estimatedCostUsd }),
            },
          }),
    })),
    page: query.page,
    pageSize: query.pageSize,
    total,
    pageCount: Math.ceil(total / query.pageSize),
  };
}
