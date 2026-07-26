import type { DashboardUsageOverviewResponse } from '@aio-proxy/types';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { requestLog } from '../schema/request-log';
import { usage } from '../schema/usage';
import { bucketKeys, buildChart, chartRows, resolveRange } from './chart';
import type { UsageOverviewQuery } from './types';

export function overviewRequestLogs(db: BunSQLiteDatabase, query: UsageOverviewQuery): DashboardUsageOverviewResponse {
  const now = query.now ?? new Date();
  const { start, end, bucketUnit } = resolveRange(query.range, now);
  const rangeFilter = and(gte(requestLog.completedAt, start), lte(requestLog.completedAt, end));
  const summaryRow = db
    .select({
      estimatedCostUsd: sql<number>`coalesce(sum(${usage.estimatedCostUsd}), 0)`.mapWith(Number),
      pricedRequestCount:
        sql<number>`coalesce(sum(case when ${usage.estimatedCostUsd} is not null then 1 else 0 end), 0)`.mapWith(
          Number,
        ),
      usageRequestCount:
        sql<number>`coalesce(sum(case when ${usage.requestId} is not null then 1 else 0 end), 0)`.mapWith(Number),
      requestCount: sql<number>`count(*)`.mapWith(Number),
      successCount:
        sql<number>`coalesce(sum(case when ${requestLog.outcome} = 'success' then 1 else 0 end), 0)`.mapWith(Number),
      failureCount:
        sql<number>`coalesce(sum(case when ${requestLog.outcome} = 'failure' then 1 else 0 end), 0)`.mapWith(Number),
      cancelledCount:
        sql<number>`coalesce(sum(case when ${requestLog.outcome} = 'cancelled' then 1 else 0 end), 0)`.mapWith(Number),
      inputTokens: sql<number>`coalesce(sum(${usage.inputTokens}), 0)`.mapWith(Number),
      outputTokens: sql<number>`coalesce(sum(${usage.outputTokens}), 0)`.mapWith(Number),
    })
    .from(requestLog)
    .leftJoin(usage, and(eq(usage.requestId, requestLog.requestId), eq(requestLog.outcome, 'success')))
    .where(rangeFilter)
    .get()!;

  const elapsedMinutes = Math.max(1, (end.getTime() - start.getTime()) / 60_000);
  const successRate =
    summaryRow.successCount + summaryRow.failureCount === 0
      ? null
      : summaryRow.successCount / (summaryRow.successCount + summaryRow.failureCount);
  const pricingCoverage =
    summaryRow.usageRequestCount === 0 ? null : summaryRow.pricedRequestCount / summaryRow.usageRequestCount;
  const totalTokens = summaryRow.inputTokens + summaryRow.outputTokens;
  const rows = chartRows(db, query.metric, query.groupBy, bucketUnit, start, rangeFilter);
  const { series, buckets } = buildChart(rows, query.metric, bucketKeys(query.range, start, end));

  return {
    range: query.range,
    metric: query.metric,
    groupBy: query.groupBy,
    rangeStart: start.toISOString(),
    rangeEnd: end.toISOString(),
    bucketUnit,
    summary: {
      estimatedCostUsd: summaryRow.estimatedCostUsd,
      pricingCoverage,
      pricedRequestCount: summaryRow.pricedRequestCount,
      usageRequestCount: summaryRow.usageRequestCount,
      requestCount: summaryRow.requestCount,
      successCount: summaryRow.successCount,
      failureCount: summaryRow.failureCount,
      cancelledCount: summaryRow.cancelledCount,
      successRate,
      inputTokens: summaryRow.inputTokens,
      outputTokens: summaryRow.outputTokens,
      totalTokens,
      averageRpm: summaryRow.requestCount / elapsedMinutes,
      averageTpm: totalTokens / elapsedMinutes,
    },
    series,
    buckets,
  };
}
